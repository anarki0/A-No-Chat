# Build standard lightweight node alpine container
FROM node:20-alpine

# Set production environment
ENV NODE_ENV=production

# Set up app directory
WORKDIR /app

# Copy dependency manifest
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy source files
COPY server.js ./
COPY index.html ./
COPY style.css ./
COPY app.js ./

# Create data directory for persistent SQLite database and set ownership to node user
RUN mkdir -p /app/data && chown -R node:node /app/data

# Persist the sqlite database path
VOLUME [ "/app/data" ]

# Set non-privileged container user
USER node

# Expose server websocket port
EXPOSE 3000

# Start server
CMD [ "node", "server.js" ]
