// ============================================================
// UDP TRANSPORT via geckos.io (WebRTC DataChannels)
// ============================================================
// Scalable, per-client-aware transport layer.  Each player is
// tracked for UDP-readiness so the server never double-sends
// to clients that already have a working DataChannel, and never
// drops messages for clients that do not.
//
// Key design:
//   • `channels` Map tracks socketId → geckos channel
//   • Send helpers return whether the send succeeded so the
//     caller can decide whether to also use Socket.IO.
//   • `getConnectedSocketIds()` exposes which sockets have UDP
//     so the server can exclude them from Socket.IO broadcasts.
// ============================================================

let geckosIO = null;
let udpServer = null;

/** @type {Map<string, object>} socketId → geckos channel */
const channels = new Map();

/** @type {Map<string, string>} auth token → socketId */
const tokenMap = new Map();

/** @type {Map<string, Set<string>>} channel.id → Set<roomName> */
const channelRooms = new Map();

/** @type {Map<string, NodeJS.Timeout>} token → expiry timer */
const tokenTimers = new Map();

// ── Event catalogs ──

const UDP_SERVER_EVENTS = new Set([
  'UPDATE_POS', 'UPDATE_PLAYER', 'ABILITY_VISUAL',
  'UPDATE_NODE', 'UPDATE_IRON_NODE', 'UPDATE_NODES', 'UPDATE_IRON_NODES',
  'NEW_PROJECTILE', 'DELETE_PROJ', 'NEW_SOUND',
  'EXPLOSION', 'WANDER_TARGET', 'sync_time',
  'HEAL_PLANTS', 'ENTITY_LEVEL_UPDATE', 'PLAYER_COLOR_CHANGED',
  'PLAYERS_SYNC', 'PLAYER_MARKED_DEAD',
]);

const UDP_CLIENT_EVENTS = new Set([
  'update_player', 'update_node', 'update_iron_node',
  'update_nodes', 'update_iron_nodes',
  'new_proj', 'delete_proj',
  'new_sound', 'delete_sound',
  'EXPLOSION', 'wander_request',
]);

// ── Lightweight metrics ──
const metrics = {
  channelsOpened: 0,
  channelsClosed: 0,
  messagesSent: 0,
  messagesReceived: 0,
  errors: 0,
};

// ────────────────────────────────────────────────────────────
//  INIT
// ────────────────────────────────────────────────────────────

async function initUdpTransport(httpServer, onChannelReady, handlers = {}) {
  try {
    const geckosModule = await import('@geckos.io/server');
    geckosIO = geckosModule.default;

    udpServer = geckosIO({
      authorization: async (auth) => {
        if (!auth) return false;
        const socketId = tokenMap.get(auth);
        if (!socketId) return false;
        return { socketId };
      },
      cors: { allowAuthorization: true, origin: '*' },
      multiplex: true,
      portRange: { min: 10000, max: 11000 },
      label: 'holes-udp',
    });

    udpServer.addServer(httpServer);

    udpServer.onConnection((channel) => {
      const socketId = channel.userData?.socketId;
      if (!socketId) {
        try { channel.close(); } catch (_) {}
        return;
      }

      // Replace any stale channel for the same socket
      if (channels.has(socketId)) {
        const old = channels.get(socketId);
        try { old.close(); } catch (_) {}
        channelRooms.delete(old.id);
      }

      channels.set(socketId, channel);
      channelRooms.set(channel.id, new Set());
      metrics.channelsOpened++;

      // Consume the token
      for (const [token, sid] of tokenMap.entries()) {
        if (sid === socketId) {
          const t = tokenTimers.get(token);
          if (t) { clearTimeout(t); tokenTimers.delete(token); }
          tokenMap.delete(token);
          break;
        }
      }

      // Register client→server handlers
      const entries = Object.entries(handlers);
      for (let i = 0; i < entries.length; i++) {
        const [event, handler] = entries[i];
        channel.on(event, (data) => {
          metrics.messagesReceived++;
          try {
            handler(data, socketId);
          } catch (e) {
            metrics.errors++;
            console.error(`[UDP] Handler error "${event}":`, e.message);
          }
        });
      }

      channel.onDisconnect((reason) => {
        channels.delete(socketId);
        channelRooms.delete(channel.id);
        metrics.channelsClosed++;
      });

      channel.onDrop(() => { /* expected for unreliable */ });

      console.log(`[UDP] Channel ready: ${socketId}`);
      if (typeof onChannelReady === 'function') onChannelReady(socketId, channel);
    });

    console.log('[UDP] Transport initialized');
    return true;
  } catch (e) {
    console.error('[UDP] Init failed:', e.message);
    return false;
  }
}

// ────────────────────────────────────────────────────────────
//  TOKEN MANAGEMENT
// ────────────────────────────────────────────────────────────

function generateUdpToken(socketId) {
  // Revoke any prior token for this socket
  for (const [token, sid] of tokenMap.entries()) {
    if (sid === socketId) {
      tokenMap.delete(token);
      const t = tokenTimers.get(token);
      if (t) { clearTimeout(t); tokenTimers.delete(token); }
      break;
    }
  }

  const token = socketId + '_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now();
  tokenMap.set(token, socketId);

  const timer = setTimeout(() => {
    tokenMap.delete(token);
    tokenTimers.delete(token);
  }, 30_000);
  tokenTimers.set(token, timer);

  return token;
}

// ────────────────────────────────────────────────────────────
//  SEND HELPERS
// ────────────────────────────────────────────────────────────

/** Send to one player. Returns true if sent via UDP. */
function sendToPlayer(socketId, event, data) {
  const ch = channels.get(socketId);
  if (!ch) return false;
  try {
    ch.emit(event, data);
    metrics.messagesSent++;
    return true;
  } catch (_) {
    metrics.errors++;
    return false;
  }
}

/** Broadcast to all UDP channels in a room. */
function broadcastToRoom(roomName, event, data) {
  if (!udpServer) return;
  try {
    udpServer.room(roomName).emit(event, data);
    metrics.messagesSent++;
  } catch (_) { metrics.errors++; }
}

/**
 * Broadcast to all UDP channels in a room EXCEPT a specific socket.
 * Necessary for "broadcast from sender" semantics — the sender already
 * knows their own state and shouldn't receive their own update back.
 */
function broadcastToRoomExcluding(roomName, event, data, excludeSocketId) {
  if (!udpServer) return;
  for (const [sid, ch] of channels.entries()) {
    if (sid === excludeSocketId) continue;
    const rooms = channelRooms.get(ch.id);
    if (rooms && rooms.has(roomName)) {
      try {
        ch.emit(event, data);
        metrics.messagesSent++;
      } catch (_) { metrics.errors++; }
    }
  }
}

/**
 * Emit to ALL connected UDP channels, optionally excluding one socket.
 */
function emitAll(event, data, excludeSocketId) {
  if (!udpServer) return;
  if (!excludeSocketId) {
    try {
      udpServer.emit(event, data);
      metrics.messagesSent++;
    } catch (_) { metrics.errors++; }
  } else {
    for (const [sid, ch] of channels.entries()) {
      if (sid === excludeSocketId) continue;
      try {
        ch.emit(event, data);
        metrics.messagesSent++;
      } catch (_) { metrics.errors++; }
    }
  }
}

// ────────────────────────────────────────────────────────────
//  ROOM MANAGEMENT
// ────────────────────────────────────────────────────────────

function joinRoom(socketId, roomName) {
  const ch = channels.get(socketId);
  if (!ch) return;
  try {
    ch.join(roomName);
    const rooms = channelRooms.get(ch.id);
    if (rooms) rooms.add(roomName);
  } catch (_) {}
}

function leaveRoom(socketId, roomName) {
  const ch = channels.get(socketId);
  if (!ch) return;
  try {
    ch.leave(roomName);
    const rooms = channelRooms.get(ch.id);
    if (rooms) rooms.delete(roomName);
  } catch (_) {}
}

// ────────────────────────────────────────────────────────────
//  CHANNEL QUERIES
// ────────────────────────────────────────────────────────────

function hasChannel(socketId) {
  return channels.has(socketId);
}

/** Return the Map of socketId → channel (read-only usage). */
function getConnectedSocketIds() {
  return channels;
}

function channelCount() {
  return channels.size;
}

// ────────────────────────────────────────────────────────────
//  CLEANUP
// ────────────────────────────────────────────────────────────

function removeChannel(socketId) {
  const ch = channels.get(socketId);
  if (ch) {
    try { ch.close(); } catch (_) {}
    channelRooms.delete(ch.id);
    metrics.channelsClosed++;
  }
  channels.delete(socketId);
}

/** Remove channels whose socketId is no longer valid. */
function pruneStaleChannels(validSocketIds) {
  const valid = validSocketIds instanceof Set ? validSocketIds : new Set(validSocketIds);
  for (const [sid, ch] of channels.entries()) {
    if (!valid.has(sid)) {
      try { ch.close(); } catch (_) {}
      channelRooms.delete(ch.id);
      channels.delete(sid);
      metrics.channelsClosed++;
    }
  }
}

// ────────────────────────────────────────────────────────────
//  METRICS
// ────────────────────────────────────────────────────────────

function getMetrics() {
  return { ...metrics, activeChannels: channels.size, pendingTokens: tokenMap.size };
}

module.exports = {
  initUdpTransport,
  generateUdpToken,
  sendToPlayer,
  joinRoom,
  leaveRoom,
  broadcastToRoom,
  broadcastToRoomExcluding,
  emitAll,
  hasChannel,
  getConnectedSocketIds,
  channelCount,
  removeChannel,
  pruneStaleChannels,
  getMetrics,
  getUdpServerEvents: () => UDP_SERVER_EVENTS,
  getUdpClientEvents: () => UDP_CLIENT_EVENTS,
};
