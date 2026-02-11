// ============================================================
// UDP TRANSPORT via geckos.io (WebRTC DataChannels)
// ============================================================
// Provides unreliable, low-latency messaging for high-frequency
// game state updates (positions, projectiles, terrain, sounds, etc.)
// while Socket.IO continues handling reliable events (auth, inventory, teams).
//
// geckos.io v3 is ESM-only, so we use dynamic import() from CJS.
// ============================================================

let geckosIO = null;       // geckos server factory (loaded async)
let udpServer = null;      // geckos server instance
const channels = new Map(); // socketId → geckos channel
const tokenMap = new Map(); // auth token → socketId (for handshake)
const channelRooms = new Map(); // channelId → Set<roomName>

// High-frequency events routed over UDP (server → client)
const UDP_SERVER_EVENTS = new Set([
    'UPDATE_POS',
    'UPDATE_PLAYER',
    'ABILITY_VISUAL',
    'UPDATE_NODE',
    'UPDATE_IRON_NODE',
    'UPDATE_NODES',
    'UPDATE_IRON_NODES',
    'NEW_PROJECTILE',
    'DELETE_PROJ',
    'NEW_SOUND',
    'EXPLOSION',
    'WANDER_TARGET',
    'sync_time',
    'HEAL_PLANTS',
    'ENTITY_LEVEL_UPDATE',
    'PLAYER_COLOR_CHANGED',
    'PLAYERS_SYNC',
    'PLAYER_MARKED_DEAD',
]);

// High-frequency events routed over UDP (client → server)
const UDP_CLIENT_EVENTS = new Set([
    'update_player',
    'update_node',
    'update_iron_node',
    'update_nodes',
    'update_iron_nodes',
    'new_proj',
    'delete_proj',
    'new_sound',
    'delete_sound',
    'EXPLOSION',
    'wander_request',
]);

/**
 * Initialize the UDP transport layer.
 * Attaches geckos.io signaling routes to the existing HTTP server.
 * @param {http.Server} httpServer - The Express/HTTP server instance
 * @param {Function} onChannelReady - Callback(socketId, channel) when a UDP channel is linked
 * @param {Object} handlers - Map of event name → handler(data, socketId) for client→server UDP messages
 * @returns {Promise<boolean>} true if initialized successfully
 */
async function initUdpTransport(httpServer, onChannelReady, handlers = {}) {
    try {
        const geckosModule = await import('@geckos.io/server');
        geckosIO = geckosModule.default;

        udpServer = geckosIO({
            // Authorization: client sends its Socket.IO ID as auth token
            authorization: async (auth, req, res) => {
                if (!auth) return false;
                const socketId = tokenMap.get(auth);
                if (!socketId) return false;
                // Return the socketId so we can access it via channel.userData
                return { socketId };
            },
            cors: { allowAuthorization: true, origin: '*' },
            // Use multiplexed single port for all connections
            multiplex: true,
            // Port range for the WebRTC data — constrained for firewall friendliness
            portRange: { min: 10000, max: 11000 },
            label: 'holes-udp',
        });

        // Attach signaling routes to the existing Express HTTP server
        udpServer.addServer(httpServer);

        udpServer.onConnection((channel) => {
            const socketId = channel.userData?.socketId;
            if (!socketId) {
                console.warn('[UDP] Channel connected without valid socketId, closing');
                channel.close();
                return;
            }

            console.log(`[UDP] Channel linked to socket ${socketId}`);
            channels.set(socketId, channel);
            channelRooms.set(channel.id, new Set());

            // Clean up token
            for (const [token, sid] of tokenMap.entries()) {
                if (sid === socketId) {
                    tokenMap.delete(token);
                    break;
                }
            }

            // Register client→server event handlers
            for (const [event, handler] of Object.entries(handlers)) {
                channel.on(event, (data) => {
                    try {
                        handler(data, socketId);
                    } catch (e) {
                        console.error(`[UDP] Error handling "${event}":`, e);
                    }
                });
            }

            channel.onDisconnect((reason) => {
                console.log(`[UDP] Channel disconnected for socket ${socketId}: ${reason}`);
                channels.delete(socketId);
                channelRooms.delete(channel.id);
            });

            channel.onDrop((drop) => {
                // Silently ignore dropped messages — this is expected for UDP
            });

            if (typeof onChannelReady === 'function') {
                onChannelReady(socketId, channel);
            }
        });

        console.log('[UDP] Transport initialized successfully');
        return true;
    } catch (e) {
        console.error('[UDP] Failed to initialize transport:', e);
        return false;
    }
}

/**
 * Generate a unique auth token for a Socket.IO client so it can link its UDP channel.
 * @param {string} socketId - The Socket.IO socket ID
 * @returns {string} The auth token to send to the client
 */
function generateUdpToken(socketId) {
    const token = socketId + '_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now();
    tokenMap.set(token, socketId);
    // Expire token after 30 seconds if not used
    setTimeout(() => tokenMap.delete(token), 30000);
    return token;
}

/**
 * Send a message to a specific player's UDP channel.
 * Falls back silently if the channel doesn't exist or is closed.
 * @param {string} socketId
 * @param {string} event
 * @param {*} data
 */
function sendToPlayer(socketId, event, data) {
    const channel = channels.get(socketId);
    if (channel) {
        try {
            channel.emit(event, data);
        } catch (e) {
            // Channel may have closed — ignore
        }
    }
}

/**
 * Join a player's UDP channel to a room (mirrors Socket.IO room system).
 * @param {string} socketId
 * @param {string} roomName
 */
function joinRoom(socketId, roomName) {
    const channel = channels.get(socketId);
    if (channel) {
        channel.join(roomName);
        const rooms = channelRooms.get(channel.id);
        if (rooms) rooms.add(roomName);
    }
}

/**
 * Remove a player's UDP channel from a room.
 * @param {string} socketId
 * @param {string} roomName
 */
function leaveRoom(socketId, roomName) {
    const channel = channels.get(socketId);
    if (channel) {
        channel.leave(roomName);
        const rooms = channelRooms.get(channel.id);
        if (rooms) rooms.delete(roomName);
    }
}

/**
 * Broadcast a message to all UDP channels in a specific room.
 * @param {string} roomName
 * @param {string} event
 * @param {*} data
 */
function broadcastToRoom(roomName, event, data) {
    if (!udpServer) return;
    try {
        udpServer.room(roomName).emit(event, data);
    } catch (e) {
        // Ignore errors — channels may have closed
    }
}

/**
 * Broadcast from a specific player to their room (excluding self).
 * @param {string} socketId - The sender's socket ID
 * @param {string} roomName
 * @param {string} event
 * @param {*} data
 */
function broadcastToRoomExcludingSender(socketId, roomName, event, data) {
    const senderChannel = channels.get(socketId);
    if (!senderChannel) {
        // Fallback: just broadcast to whole room
        broadcastToRoom(roomName, event, data);
        return;
    }
    // Use forward to broadcast to room excluding sender
    try {
        senderChannel.broadcast.emit(event, data);
    } catch (e) {
        // Ignore
    }
}

/**
 * Emit a message to ALL connected UDP channels.
 * @param {string} event
 * @param {*} data
 */
function emitAll(event, data) {
    if (!udpServer) return;
    try {
        udpServer.emit(event, data);
    } catch (e) {
        // Ignore
    }
}

/**
 * Check if a player has a connected UDP channel.
 * @param {string} socketId
 * @returns {boolean}
 */
function hasChannel(socketId) {
    return channels.has(socketId);
}

/**
 * Remove a player's UDP channel mapping (e.g., on disconnect).
 * @param {string} socketId
 */
function removeChannel(socketId) {
    const channel = channels.get(socketId);
    if (channel) {
        try { channel.close(); } catch (e) { /* ignore */ }
        channelRooms.delete(channel.id);
    }
    channels.delete(socketId);
}

/**
 * Get the set of events that should be routed over UDP (server→client).
 * @returns {Set<string>}
 */
function getUdpServerEvents() {
    return UDP_SERVER_EVENTS;
}

/**
 * Get the set of events that should be routed over UDP (client→server).
 * @returns {Set<string>}
 */
function getUdpClientEvents() {
    return UDP_CLIENT_EVENTS;
}

module.exports = {
    initUdpTransport,
    generateUdpToken,
    sendToPlayer,
    joinRoom,
    leaveRoom,
    broadcastToRoom,
    broadcastToRoomExcludingSender,
    emitAll,
    hasChannel,
    removeChannel,
    getUdpServerEvents,
    getUdpClientEvents,
};
