/**
 * Retro Minimal Black & White Terminal Chat - Client Socket.io Logic
 */

document.addEventListener('DOMContentLoaded', () => {
    // State management
    const state = {
        accessToken: '',
        alias: '',
        currentLoginStep: 1, // 1 = Token, 2 = Alias, 3 = Logged In
        isPrinting: false,
        roomMode: ''
    };

    // Dynamic Backend URL resolution for static deployments (Vercel, GitHub Pages)
    // Checks query parameter ?backend=https://your-backend.com, saves to localStorage, falls back to same origin
    const urlParams = new URLSearchParams(window.location.search);
    const queryBackend = urlParams.get('backend');
    if (queryBackend) {
        localStorage.setItem('BACKEND_URL', queryBackend.trim());
    }

    const backendUrl = localStorage.getItem('BACKEND_URL') || window.location.origin;

    // Initialize Socket.io Connection to dynamic endpoint
    const socket = io(backendUrl, {
        autoConnect: true,
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity
    });

    // DOM Elements
    const loginScreen = document.getElementById('login-screen');
    const chatScreen = document.getElementById('chat-screen');
    const loginLog = document.getElementById('login-log');
    const loginPrompt = document.getElementById('login-prompt');
    const loginInput = document.getElementById('login-input');
    const loginDisplayText = document.getElementById('login-display-text');
    const chatLog = document.getElementById('chat-log');
    const chatInput = document.getElementById('chat-input');
    const chatDisplayText = document.getElementById('chat-display-text');
    const headerClock = document.getElementById('header-clock');

    // Focus management - make clicking anywhere focus the active input
    document.addEventListener('click', () => {
        if (state.currentLoginStep < 3) {
            loginInput.focus();
        } else {
            chatInput.focus();
        }
    });

    // Update system header clock
    function updateClock() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const date = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        headerClock.textContent = `${year}-${month}-${date} ${hours}:${minutes}:${seconds}`;
    }
    setInterval(updateClock, 1000);
    updateClock();

    // Basic XOR Encryption/Decryption Helper
    // Encrypts/decrypts using the 6-character room token as the key
    function xorEncryptDecrypt(str, key) {
        let result = '';
        for (let i = 0; i < str.length; i++) {
            result += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
        return result;
    }

    // Convert plain text to base64 encrypted payload
    function encryptPayload(text, token) {
        const encrypted = xorEncryptDecrypt(text, token);
        // window.btoa encodes binary to Base64 in browser
        return btoa(encrypted);
    }

    // Convert base64 payload back to plain text
    function decryptPayload(base64Text, token) {
        // window.atob decodes Base64 to binary in browser
        const encrypted = atob(base64Text);
        return xorEncryptDecrypt(encrypted, token);
    }

    // Custom Typewriter printer
    function typeWrite(text, container, callback = null, className = 'log-line') {
        state.isPrinting = true;
        const line = document.createElement('div');
        line.className = className;
        container.appendChild(line);
        container.scrollTop = container.scrollHeight;

        let index = 0;
        function nextChar() {
            if (index < text.length) {
                line.textContent += text.charAt(index);
                index++;
                container.scrollTop = container.scrollHeight;
                setTimeout(nextChar, 20); // 20ms per character
            } else {
                state.isPrinting = false;
                if (callback) callback();
            }
        }
        nextChar();
    }

    // Input handlers to sync hidden input with visual terminal display
    loginInput.addEventListener('input', (e) => {
        const val = e.target.value;
        if (state.currentLoginStep === 1) {
            // Mask access token
            loginDisplayText.textContent = '*'.repeat(val.length);
        } else {
            loginDisplayText.textContent = val;
        }
    });

    chatInput.addEventListener('input', (e) => {
        chatDisplayText.textContent = e.target.value;
    });

    // Enter key handlers
    loginInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const val = loginInput.value.trim();
            if (state.isPrinting) return; // Prevent input while terminal is printing

            if (state.currentLoginStep === 1) {
                // Front-end sanity check: must be exactly 6 characters
                if (val.length !== 6) {
                    typeWrite('ERROR: ACCESS TOKEN MUST BE EXACTLY 6 CHARACTERS.', loginLog, null, 'log-line error');
                    return;
                }
                state.accessToken = val;
                
                // Append input line into log
                const enteredLine = document.createElement('div');
                enteredLine.className = 'log-line user';
                enteredLine.textContent = `ENTER ACCESS TOKEN: ${'*'.repeat(val.length)}`;
                loginLog.appendChild(enteredLine);
                
                // Clear input
                loginInput.value = '';
                loginDisplayText.textContent = '';
                
                // Move to step 2
                state.currentLoginStep = 2;
                loginPrompt.textContent = 'ENTER ALIAS:';
                loginLog.scrollTop = loginLog.scrollHeight;
            } else if (state.currentLoginStep === 2) {
                if (!val) {
                    typeWrite('ERROR: ALIAS CANNOT BE EMPTY.', loginLog, null, 'log-line error');
                    return;
                }
                state.alias = val;
                // Append input line into log
                const enteredLine = document.createElement('div');
                enteredLine.className = 'log-line user';
                enteredLine.textContent = `ENTER ALIAS: ${val}`;
                loginLog.appendChild(enteredLine);

                // Clear input
                loginInput.value = '';
                loginDisplayText.textContent = '';
                
                // Trigger connection sequence to Server
                startConnecting();
            }
        }
    });

    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const val = chatInput.value;
            if (!val.trim()) return;

            // Clear input
            chatInput.value = '';
            chatDisplayText.textContent = '';

            // Process slash commands locally or transmit encrypted messages
            if (val.startsWith('/')) {
                handleCommand(val.trim());
            } else {
                // Encrypt payload before sending to server
                const encrypted = encryptPayload(val, state.accessToken);
                socket.emit('msg_send', { text: encrypted });
            }
            chatLog.scrollTop = chatLog.scrollHeight;
        }
    });

    function getCurrentTime() {
        const now = new Date();
        return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    }

    // Connect to server and request room entry
    function startConnecting() {
        state.currentLoginStep = 3; // Setting state to logged in transitioning
        loginInput.disabled = true;
        
        typeWrite('INITIATING SECURE ENCRYPTED SOCKET CONNECTION...', loginLog, () => {
            // Emit join room request to server
            socket.emit('join_room', {
                token: state.accessToken,
                alias: state.alias
            });
        });
    }

    // Socket.io listeners
    
    // Automatically re-authenticate on reconnection
    socket.on('connect', () => {
        console.log('Socket transport connected.');
        if (state.currentLoginStep === 3) {
            addLogLine(`[${getCurrentTime()}] SYSTEM: Re-establishing encryption tunnel...`, 'system');
            socket.emit('join_room', {
                token: state.accessToken,
                alias: state.alias
            });
        }
    });

    socket.on('disconnect', () => {
        console.warn('Socket transport disconnected.');
        if (state.currentLoginStep === 3) {
            addLogLine(`[${getCurrentTime()}] SYSTEM: Transmission lost. Attempting reconnection...`, 'error');
        }
    });

    socket.on('join_error', (data) => {
        // If rejected on initial login, fall back to login state
        if (state.currentLoginStep === 3 && !state.roomMode) {
            state.currentLoginStep = 1;
            loginInput.disabled = false;
            loginPrompt.textContent = 'ENTER ACCESS TOKEN:';
            loginScreen.classList.add('active');
            chatScreen.classList.remove('active');
            typeWrite(`REJECTED: ${data.message}`, loginLog, null, 'log-line error');
        } else {
            addLogLine(`[${getCurrentTime()}] SERVER ERROR: ${data.message}`, 'error');
        }
    });

    socket.on('room_joined', (data) => {
        state.roomMode = data.roomMode;
        
        // Transition screen if we haven't already
        if (loginScreen.classList.contains('active')) {
            loginScreen.classList.remove('active');
            chatScreen.classList.add('active');
            chatInput.focus();
        }

        chatLog.innerHTML = '';
        
        // Print welcome header in flat text
        addLogLine(`MATRIX SECURE COMM PORTAL`, 'system');
        addLogLine(`ROOM: ${data.roomId} [MODE: ${data.roomMode}]`, 'system');
        addLogLine(`ALIAS: ${data.alias}`, 'system');
        addLogLine(`STATUS: SECURE_TUNNEL_ESTABLISHED`, 'system');
        addLogLine(`TYPE '/help' TO LIST AVAILABLE SYSTEM COMMANDS.`, 'system');
        addLogLine(``, 'system');

        // Print history log instantly (messages are encrypted in WS payload, we decrypt locally)
        if (data.history && data.history.length > 0) {
            data.history.forEach(msg => {
                try {
                    const plainText = decryptPayload(msg.text, state.accessToken);
                    const isMe = msg.alias === state.alias;
                    addLogLine(`[${msg.timestamp}] <${msg.alias}> ${plainText}`, isMe ? 'user' : 'incoming');
                } catch (e) {
                    console.error("Error decrypting message from history", e);
                }
            });
        }
    });

    // Listen to real-time chat messages
    socket.on('msg_receive', (data) => {
        try {
            // Decrypt message locally using token
            const plainText = decryptPayload(data.text, state.accessToken);
            const isMe = data.alias === state.alias;
            addLogLine(`[${data.timestamp}] <${data.alias}> ${plainText}`, isMe ? 'user' : 'incoming');
        } catch (e) {
            console.error("Failed to decrypt received message payload:", e);
        }
    });

    // Listen to system alerts
    socket.on('sys_message', (data) => {
        addLogLine(`[${data.timestamp}] SYSTEM: ${data.text}`, 'system');
    });

    function addLogLine(text, type = 'incoming') {
        const line = document.createElement('div');
        line.className = `log-line ${type}`;
        line.textContent = text;
        chatLog.appendChild(line);
        chatLog.scrollTop = chatLog.scrollHeight;
    }

    // Command Parser
    function handleCommand(cmdStr) {
        const parts = cmdStr.split(' ');
        const mainCmd = parts[0].toLowerCase();
        
        switch (mainCmd) {
            case '/help':
                addLogLine('AVAILABLE TERMINAL COMMANDS:', 'system');
                addLogLine('/help         - Tampilkan bantuan ini', 'system');
                addLogLine('/clear        - Bersihkan log layar obrolan', 'system');
                addLogLine('/status       - Tampilkan status koneksi saat ini', 'system');
                addLogLine('/exit         - Keluar dari terminal dan putuskan koneksi', 'system');
                break;
            case '/clear':
                chatLog.innerHTML = '';
                addLogLine('SYSTEM LOGS PURGED.', 'system');
                break;
            case '/status':
                addLogLine(`CONNECTION STATUS:`, 'system');
                addLogLine(`SOCKET ID: ${socket.id}`, 'system');
                addLogLine(`ALIAS: ${state.alias}`, 'system');
                addLogLine(`TOKEN/ROOM: ${state.accessToken}`, 'system');
                addLogLine(`ROOM MODE: ${state.roomMode}`, 'system');
                addLogLine(`STATUS: ${socket.connected ? 'CONNECTED' : 'DISCONNECTED'}`, 'system');
                break;
            case '/exit':
                addLogLine('TERMINATING SECURE SOCKET...', 'system');
                setTimeout(() => {
                    // Reset State
                    state.accessToken = '';
                    state.alias = '';
                    state.currentLoginStep = 1;
                    state.roomMode = '';
                    loginInput.disabled = false;
                    loginPrompt.textContent = 'ENTER ACCESS TOKEN:';
                    loginLog.innerHTML = `
                        <div class="log-line">LEGACY SYSTEM BOOT INITIATED...</div>
                        <div class="log-line">LOADING COGNITIVE INTERFACE PROTOCOLS...</div>
                        <div class="log-line">ESTABLISHING CONNECTION THROUGH DEEP COGNITIVE CHANNELS...</div>
                        <div class="log-line">SYSTEM STATUS: ONLINE</div>
                    `;
                    chatLog.innerHTML = '';
                    chatScreen.classList.remove('active');
                    loginScreen.classList.add('active');
                    
                    // Disconnect socket temporarily
                    socket.disconnect();
                    // Reconnect clean for next user session
                    socket.connect();
                    loginInput.focus();
                }, 1000);
                break;
            default:
                addLogLine(`UNKNOWN COMMAND: ${mainCmd}. TYPE '/help' FOR VALID COMMANDS.`, 'error');
        }
    }

    // Auto-focus input on startup
    loginInput.focus();
});
