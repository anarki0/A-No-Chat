const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'chat.db');

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 1. Initialize SQLite Database for Permanent Rooms
const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        console.error('Error opening SQLite database:', err.message);
    } else {
        console.log(`Connected to the SQLite database at: ${DB_FILE}`);
        // Create messages table if it doesn't exist
        db.run(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            roomId TEXT,
            alias TEXT,
            timestamp TEXT,
            text TEXT
        )`, (err) => {
            if (err) {
                console.error('Error creating messages table:', err.message);
            } else {
                console.log('SQLite messages table initialized.');
            }
        });
    }
});

// Ephemeral (temporary) rooms in-memory store
// Format: { roomId: { messages: [ { alias, timestamp, text } ], timer: Timeout } }
const ephemeralDb = {};

// Enforce HTTPS redirection in production (Checks x-forwarded-proto header behind reverse proxies)
app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') {
        return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
});

// Static files server
app.use(express.static(__dirname));

// Basic XOR Encryption/Decryption Helper
function xorEncryptDecrypt(str, key) {
    let result = '';
    for (let i = 0; i < str.length; i++) {
        result += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return result;
}

// Convert encrypted string to base64 for safe transit
function encryptPayload(text, token) {
    const encrypted = xorEncryptDecrypt(text, token);
    return Buffer.from(encrypted, 'binary').toString('base64');
}

// Convert base64 payload back to plain text
function decryptPayload(base64Text, token) {
    const encrypted = Buffer.from(base64Text, 'base64').toString('binary');
    return xorEncryptDecrypt(encrypted, token);
}

// 2. Anti-XSS Sanitizer: Escape HTML characters to prevent XSS injections
function sanitizeInput(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
}

// Load message history from SQLite (Permanent Room)
function loadPermanentHistory(roomId, callback) {
    db.all(`SELECT alias, timestamp, text FROM messages WHERE roomId = ? ORDER BY id ASC`, [roomId], (err, rows) => {
        if (err) {
            console.error('Error loading permanent history from SQLite:', err.message);
            callback([]);
        } else {
            callback(rows || []);
        }
    });
}

// Save message to SQLite database (Permanent Room)
function savePermanentMessage(roomId, alias, timestamp, text) {
    db.run(`INSERT INTO messages (roomId, alias, timestamp, text) VALUES (?, ?, ?, ?)`,
        [roomId, alias, timestamp, text], (err) => {
            if (err) {
                console.error('Error saving permanent message to SQLite:', err.message);
            }
        }
    );
}

// Save message to in-memory temporary store (Ephemeral Room)
function saveEphemeralMessage(roomId, messageObj) {
    if (!ephemeralDb[roomId]) {
        ephemeralDb[roomId] = { messages: [], timer: null };
    }
    ephemeralDb[roomId].messages.push(messageObj);
}

// Socket.io Real-time connection handlers
io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Track state on socket session
    socket.authenticated = false;
    socket.roomId = null;
    socket.alias = null;

    // Handle Join Room request
    socket.on('join_room', (data) => {
        const { token, alias } = data;

        // Validation Rule: Token must be exactly 6 characters
        if (!token || token.trim().length !== 6) {
            socket.emit('join_error', { message: 'ACCESS DENIED: Token must be exactly 6 characters.' });
            return;
        }

        if (!alias || !alias.trim()) {
            socket.emit('join_error', { message: 'ACCESS DENIED: Alias cannot be empty.' });
            return;
        }

        const roomId = token.trim();
        const userAlias = alias.trim();
        const isPermanent = roomId.startsWith('1');
        const roomMode = isPermanent ? 'PERMANEN' : 'SEMENTARA';

        // Join room channel
        socket.join(roomId);
        socket.authenticated = true;
        socket.roomId = roomId;
        socket.alias = userAlias;
        socket.roomMode = roomMode;

        console.log(`User <${userAlias}> joined room <${roomId}> [Mode: ${roomMode}]`);

        // EPHEMERAL KILL SWITCH RESET:
        // Cancel the destruction timer if a user joins the empty temporary room
        if (!isPermanent && ephemeralDb[roomId]) {
            if (ephemeralDb[roomId].timer) {
                clearTimeout(ephemeralDb[roomId].timer);
                ephemeralDb[roomId].timer = null;
                console.log(`[KILL SWITCH] Cancelled destruction timer for ephemeral room: ${roomId}`);
            }
        }

        // Load History and send it to user
        if (isPermanent) {
            loadPermanentHistory(roomId, (history) => {
                const encryptedHistory = history.map(msg => ({
                    alias: msg.alias,
                    timestamp: msg.timestamp,
                    text: encryptPayload(msg.text, roomId)
                }));
                socket.emit('room_joined', {
                    roomId,
                    alias: userAlias,
                    roomMode,
                    history: encryptedHistory
                });
            });
        } else {
            const history = (ephemeralDb[roomId] && ephemeralDb[roomId].messages) ? ephemeralDb[roomId].messages : [];
            const encryptedHistory = history.map(msg => ({
                alias: msg.alias,
                timestamp: msg.timestamp,
                text: encryptPayload(msg.text, roomId)
            }));
            socket.emit('room_joined', {
                roomId,
                alias: userAlias,
                roomMode,
                history: encryptedHistory
            });
        }

        // Broadcast to other users in the room that a user connected
        const sysTime = new Date().toLocaleTimeString('en-US', { hour12: false });
        const systemMsgText = `User <${userAlias}> connected to the grid.`;
        
        socket.to(roomId).emit('sys_message', {
            timestamp: sysTime,
            text: systemMsgText
        });
    });

    // Handle outbound message from client
    socket.on('msg_send', (data) => {
        if (!socket.authenticated) {
            socket.emit('join_error', { message: 'UNAUTHORIZED: Please join a room first.' });
            return;
        }

        const { text } = data; // Received as base64 encrypted payload
        if (!text) return;

        try {
            // 1. Decrypt payload
            const plainText = decryptPayload(text, socket.roomId);
            
            // 2. Anti-XSS Sanitization (escapes HTML tags)
            const sanitizedText = sanitizeInput(plainText);
            
            const sysTime = new Date().toLocaleTimeString('en-US', { hour12: false });
            const messageObj = {
                alias: socket.alias,
                timestamp: sysTime,
                text: sanitizedText
            };

            // 3. Store message based on room mode
            if (socket.roomMode === 'PERMANEN') {
                savePermanentMessage(socket.roomId, socket.alias, sysTime, sanitizedText);
            } else {
                saveEphemeralMessage(socket.roomId, messageObj);
            }

            // 4. Re-encrypt the sanitized payload using token to broadcast it securely
            const broadcastPayload = encryptPayload(sanitizedText, socket.roomId);

            // Broadcast the encrypted sanitized payload to the room
            io.in(socket.roomId).emit('msg_receive', {
                alias: socket.alias,
                timestamp: sysTime,
                text: broadcastPayload
            });
        } catch (err) {
            console.error('Error processing socket message:', err);
        }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log(`Socket disconnected: ${socket.id}`);
        const roomId = socket.roomId;
        const roomMode = socket.roomMode;
        const userAlias = socket.alias;

        if (socket.authenticated && roomId) {
            const sysTime = new Date().toLocaleTimeString('en-US', { hour12: false });
            const systemMsgText = `User <${userAlias}> lost transmission signal.`;
            
            // Broadcast connection loss
            socket.to(roomId).emit('sys_message', {
                timestamp: sysTime,
                text: systemMsgText
            });

            // EPHEMERAL KILL SWITCH ENGAGEMENT:
            // Check if the temporary room has 0 active users. If so, start 5-minute kill timer.
            if (roomMode === 'SEMENTARA') {
                const roomClients = io.sockets.adapter.rooms.get(roomId);
                const activeCount = roomClients ? roomClients.size : 0;
                
                if (activeCount === 0) {
                    if (!ephemeralDb[roomId]) {
                        ephemeralDb[roomId] = { messages: [], timer: null };
                    }
                    
                    if (ephemeralDb[roomId].timer) {
                        clearTimeout(ephemeralDb[roomId].timer);
                    }

                    console.log(`[KILL SWITCH] Ephemeral room ${roomId} is empty. Scheduling memory deletion in 5 minutes.`);
                    
                    ephemeralDb[roomId].timer = setTimeout(() => {
                        console.log(`[KILL SWITCH ACTIVATED] Deleting ephemeral room ${roomId} memory.`);
                        // Clear reference entirely from RAM to trigger Garbage Collection
                        delete ephemeralDb[roomId];
                    }, 5 * 60 * 1000); // 5 minutes
                }
            }
        }
    });
});

// Run server
server.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`MATRIX SECURE TERMINAL SERVER ACTIVE`);
    console.log(`PORT: http://localhost:${PORT}`);
    console.log(`DATABASE: SQLite Persistent`);
    console.log(`=========================================`);
});
