const express = require('express');
const socket = require('socket.io');
const cors = require('cors');
const { validColors } = require('./utils/color');
const { Map: GameMap, Chunk, Placeable, TILESIZE, CHUNKSIZE } = require('./utils/map');
const { loadState, clearState, enqueueSave } = require('./utils/persistence');
const { logger, DATA_DIR } = require('./utils/logger');
const fs = require('fs');
const { getGlobals } = require('./globals'); // Ensure correct import
const { exec } = require('child_process');
const bcrypt = require('bcryptjs');
const udp = require('./utils/udpTransport');
const globals = getGlobals(); // Shared state object
let { players, serverMap, chatMessages, teams } = globals;
var kills_deaths = {};
// Persisted player snapshots keyed by name
let savedPlayersByName = {};
let summaryCache = globals.summaryCache;
let playerSnapshotCache = globals.playerSnapshotCache;

// Password hashing configuration
const PASSWORD_SALT_ROUNDS = Math.min(14, Math.max(4, parseInt(process.env.PASSWORD_SALT_ROUNDS || '10', 10)));

function hashPassword(plain = '') {
  if (!plain || typeof plain !== 'string') return null;
  try {
    return bcrypt.hashSync(plain, PASSWORD_SALT_ROUNDS);
  } catch (e) {
    console.warn('[Auth] Failed to hash password', e);
    return null;
  }
}

function verifyPassword(plain = '', hashed = '') {
  if (!plain || !hashed || typeof plain !== 'string' || typeof hashed !== 'string') return false;
  try {
    return bcrypt.compareSync(plain, hashed);
  } catch (e) {
    console.warn('[Auth] Failed to verify password', e);
    return false;
  }
}

// Async save tuning
const PLAYER_SAVE_DEBOUNCE_MS = parseInt(process.env.PLAYER_SAVE_DEBOUNCE_MS || '400', 10);
const pendingPlayerSaveTimers = new Map();

function queueWorldSave(reason = 'unspecified') {
  return enqueueSave({ players, serverMap, chatMessages, teams, playersSnapshot: savedPlayersByName })
    .catch((e) => {
      console.error(`[Persistence] Async save failed (${reason}):`, e);
      return false;
    });
}

function schedulePlayerSnapshotPersist(playerName) {
  if (!playerName) return;
  const existing = pendingPlayerSaveTimers.get(playerName);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingPlayerSaveTimers.delete(playerName);
    queueWorldSave('player-snapshot');
  }, PLAYER_SAVE_DEBOUNCE_MS);
  pendingPlayerSaveTimers.set(playerName, timer);
}

const chunkRoom = (cx, cy) => `chunk_${cx}_${cy}`;
const socketChunkRooms = new Map();

function chunkCoordsFromPos(pos) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return null;
  const cx = Math.floor(pos.x / (TILESIZE * CHUNKSIZE));
  const cy = Math.floor(pos.y / (TILESIZE * CHUNKSIZE));
  return { cx, cy };
}

function isValidPos(pos) {
  return pos && Number.isFinite(pos.x) && Number.isFinite(pos.y);
}

// Returns all room names in the 3x3 grid around a chunk coord
function getNeighborRooms(cx, cy) {
  const rooms = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      rooms.push(chunkRoom(cx + dx, cy + dy));
    }
  }
  return rooms;
}

function moveSocketToChunkRoom(socket, coords) {
  if (!socket || !coords) return;
  const centerRoom = chunkRoom(coords.cx, coords.cy);
  const current = socketChunkRooms.get(socket.id);
  if (current && current.center === centerRoom) return; // no change

  const newRooms = getNeighborRooms(coords.cx, coords.cy);

  // Leave old rooms that aren't in the new set
  if (current && current.rooms) {
    for (const oldRoom of current.rooms) {
      if (!newRooms.includes(oldRoom)) {
        socket.leave(oldRoom);
        udp.leaveRoom(socket.id, oldRoom); // Mirror to UDP
      }
    }
  }
  // Join new rooms that weren't in the old set
  const oldRooms = (current && current.rooms) || [];
  for (const newRoom of newRooms) {
    if (!oldRooms.includes(newRoom)) {
      socket.join(newRoom);
      udp.joinRoom(socket.id, newRoom); // Mirror to UDP
    }
  }

  socketChunkRooms.set(socket.id, { center: centerRoom, rooms: newRooms, cx: coords.cx, cy: coords.cy });
}

const NODE_FLUSH_INTERVAL_MS = 75;
const chunkNodeBuffers = new Map();
const chunkIronBuffers = new Map();
let nodeFlushTimer = null;

const BAG_MERGE_INTERVAL_MS = 150;
const BAG_MERGE_BUDGET = 25;

function scheduleNodeFlush() {
  if (nodeFlushTimer) return;
  nodeFlushTimer = setTimeout(() => {
    nodeFlushTimer = null;
    flushNodeBuffers();
  }, NODE_FLUSH_INTERVAL_MS);
}

function bufferNodeUpdate(cx, cy, payload, isIron) {
  const target = isIron ? chunkIronBuffers : chunkNodeBuffers;
  const key = `${cx},${cy}`;
  const list = target.get(key) || [];
  list.push(payload);
  target.set(key, list);
  scheduleNodeFlush();
}

function flushNodeBuffers() {
  const flush = (map, eventName) => {
    for (const [key, updates] of map.entries()) {
      map.delete(key);
      const [cx, cy] = key.split(',').map((n) => parseInt(n, 10));
      const room = chunkRoom(cx, cy);
      for (const payload of updates) {
        emitToRoom(room, eventName, payload);
      }
    }
  };
  flush(chunkNodeBuffers, 'UPDATE_NODE');
  flush(chunkIronBuffers, 'UPDATE_IRON_NODE');
}

// Normalize position to plain {x, y} object
function normalizePos(pos) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return { x: 0, y: 0 };
  return { x: pos.x, y: pos.y };
}

// Clone holding object to prevent circular references
function cloneHolding(holding) {
  if (!holding || typeof holding !== 'object') return holding;
  try {
    return JSON.parse(JSON.stringify(holding));
  } catch (e) {
    return null;
  }
}

function sanitizePlayerForClient(player) {
  if (!player) return player;
  return {
    id: player.id,
    name: player.name,
    pos: player.pos ? { x: player.pos.x, y: player.pos.y } : null,
    race: player.race ?? null,
    color: player.color ?? 0,
    holding: player.holding || { w: false, a: false, s: false, d: false },
    statBlock: player.statBlock
      ? {
          level: player.statBlock.level,
          xp: player.statBlock.xp,
          xpNeeded: player.statBlock.xpNeeded,
          stats: player.statBlock.stats
            ? {
                hp: player.statBlock.stats.hp,
                mhp: player.statBlock.stats.mhp,
                attack: player.statBlock.stats.attack,
                magic: player.statBlock.stats.magic,
                magicResistance: player.statBlock.stats.magicResistance,
              }
            : null,
        }
      : null,
    invBlock: null,
    teamId: player.teamId || null,
    kills: player.kills || 0,
    deaths: player.deaths || 0,
  };
}

// Base stats for each race - must match client-side
const BASE_STATS = [
  {
    name: "gnome",
    hp: 100, mhp: 100, healthRegen: 0.2, attack: 2, magic: 1, mp: 100, mmp: 100,
    magicResistance: 2, luck: 10, credit: 1, hearing: 1, speakingRange: 2,
    Fear: 1, powerLevel: 1, handDigSpeed: 0.05, runningSpeed: 1.3,
    growth: { hp: 10, mhp: 10, attack: 2, magic: 0.5, healthRegen: 0.05, mp: 1, mmp: 1, magicResistance: 0.2, luck: 1, runningSpeed: 0.05 }
  },
  {
    name: "aylah",
    hp: 100, mhp: 100, healthRegen: 0.1, attack: 1, magic: 5, mp: 150, mmp: 150,
    magicResistance: 5, luck: 1, credit: 1, hearing: 5, speakingRange: 1,
    Fear: 1, powerLevel: 1, handDigSpeed: 0.07, runningSpeed: 1,
    growth: { hp: 5, mhp: 5, attack: 0.5, magic: 2, healthRegen: 0.02, mp: 20, mmp: 20, magicResistance: 0.25, luck: 0.5, runningSpeed: 0.2 }
  },
  {
    name: "skizzard",
    hp: 100, mhp: 100, healthRegen: 5, attack: 1, magic: 1, mp: 100, mmp: 100,
    magicResistance: 1, luck: 1, credit: 1, hearing: 5, speakingRange: 1,
    Fear: 2, powerLevel: 1, handDigSpeed: 0.08, runningSpeed: 1.2,
    growth: { hp: 8, mhp: 8, attack: 0.5, magic: 0.5, healthRegen: 0.06, mp: 10, mmp: 10, magicResistance: 0.1, luck: 0.5, runningSpeed: 0.11 }
  }
];

// Ensure stats have all properties from BASE_STATS
function ensureCompleteStats(stats, race) {
  if (!stats || typeof race !== 'number' || !BASE_STATS[race]) return stats;
  const baseStats = JSON.parse(JSON.stringify(BASE_STATS[race]));
  delete baseStats.growth; // Don't include growth in merged stats
  return Object.assign({}, baseStats, stats);
}

// Save a player's current state into the savedPlayersByName cache and disk
function savePlayerSnapshot(player) {
  if (!player || !player.name) return false;

  const cleanInv = player.invBlock
    ? {
        items: player.invBlock.items || {},
        hotbar: Array.isArray(player.invBlock.hotbar)
          ? player.invBlock.hotbar
          : ["","","","",""],
        selectedHotBar:
          typeof player.invBlock.selectedHotBar === 'number'
            ? player.invBlock.selectedHotBar
            : 0,
        equiped: player.invBlock.equiped || {
          head: "",
          neck: "",
          chest: "",
          legs: "",
          feet: "",
        },
        movesSlots: Array.isArray(player.movesSlots) ? player.movesSlots.slice() : undefined
      }
    : null;

  savedPlayersByName[player.name] = {
    name: player.name,
    pos: player.pos || { x: 0, y: 0 },
    race: player.race || null,
    color: player.color ?? 0,
    maxDirtInv: Number.isFinite(player.maxDirtInv) ? player.maxDirtInv : 600,
    // Deep copy statBlock to prevent reference issues
    statBlock: player.statBlock ? JSON.parse(JSON.stringify(player.statBlock)) : null,
    invBlock: cleanInv,
    teamId: player.teamId || null,
    passwordHash: player.passwordHash || null,
  };

  schedulePlayerSnapshotPersist(player.name);
  return true;
}

// Delete a player's snapshot from persistent storage (used for permadeath)
function deletePlayerSnapshotByName(playerName) {
  if (!playerName) return false;
  if (!savedPlayersByName[playerName]) return false;
  delete savedPlayersByName[playerName];
  schedulePlayerSnapshotPersist(playerName);
  return true;
}

const dotenv = require('dotenv');
dotenv.config();

// Permadeath toggle (set PERMA_DEATH=true in environment to enable)
const PERMA_DEATH_ENABLED = (process.env.PERMA_DEATH || 'false').toLowerCase() === 'true';

// CLI utilities: allow clearing data via --delete
(function cliUtils(){
  try {
    const args = process.argv.slice(2);
    if (args.includes('--delete')) {
      const target = DATA_DIR;
      try {
        fs.rmSync(target, { recursive: true, force: true });
        console.log(`[CLI] Cleared data directory: ${target}`);
        logger.info('CLI delete executed', { dir: target });
      } catch (e) {
        console.error('[CLI] Failed to clear data directory', e);
        logger.error('CLI delete failed', { error: String(e) });
        process.exitCode = 1;
      }
      process.exit(0);
    }
  } catch {}
})();

// Timer/Restart configuration
const SERVER_TIME_ENV = process.env.SERVER_TIME;
// Disable timer if missing/empty or explicitly set to "NO TIME"
const TIMER_DISABLED = !SERVER_TIME_ENV || (typeof SERVER_TIME_ENV === 'string' && SERVER_TIME_ENV.toUpperCase() === 'NO TIME');
const RESTART_ON_TIMER = (process.env.RESTART_ON_TIMER || 'true').toLowerCase() === 'true';

let countdown;
let timerEndAt = null;
let preRestartSaved = false;
if (TIMER_DISABLED) {
  countdown = 0;
  timerEndAt = null;
} else {
  const parsed = Number(SERVER_TIME_ENV);
  countdown = Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 60 * 24 * 10000; // default very long
  timerEndAt = Date.now() + countdown * 1000;
}
console.log(TIMER_DISABLED ? 'Timer disabled' : `COUNT: ${countdown}`);
const allRoutes = require('./api/routes/Routes');
const port = process.env.PORT || 3000;
const app = express();
const MAX_PLAYERS = parseInt(process.env.MAX, 10) || 10;
const SAVE_INTERVAL_HOURS = parseFloat(process.env.SAVE_INTERVAL_HOURS || '3');
const SUMMARY_INTERVAL_MS = parseInt(process.env.SUMMARY_INTERVAL_MS || '30000', 10);

const badWords = ['shit', 'fuck', 'bitch', 'cunt', 'nigg', 'asshole', 'cock', 'dick', 'fag', "kike"]
const badWordRegex = new RegExp(badWords.join('|'), 'i');

app.use(express.json());           // parse JSON bodies (needed by /api/save-player-data)
app.use(
  cors({
    origin: true, // This automatically reflects the request's origin
    methods: ['GET', 'POST'],
    credentials: true,
  }),
);

const ServerWelcomeNewMessage = process.env.Server_Welcome || 'Please Welcome';
const ServerWelcomeReturningMessage = process.env.Server_Welcome_Returning || 'Welcome back';
const path = require('path');

// Serve static files using an absolute path
app.use(express.static(path.join(__dirname, '../Holes_Client')));
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on http://localhost:${port}`);
  try { logger.info('Server started', { port }); } catch {}
});

// Configure Socket.io with CORS
const io = socket(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 30000,
  pingInterval: 10000,
});

io.sockets.on('connection', newConnection);

// ── UDP Transport Initialization ──
// High-frequency events will be sent over WebRTC DataChannels (UDP) when available,
// with automatic fallback to Socket.IO (TCP) if the UDP channel isn't connected.
let udpReady = false;

// ────────────────────────────────────────────────────────────
// SMART BROADCAST HELPERS
// ────────────────────────────────────────────────────────────
// Strategy: Send via UDP to clients that have a DataChannel.
// Send via Socket.IO ONLY to clients that do NOT have a DataChannel.
// This eliminates double-delivery while maintaining full coverage.

/** Emit to a specific player — prefer UDP, fall back to Socket.IO. */
function emitToPlayer(socketId, event, data) {
  if (udpReady && udp.sendToPlayer(socketId, event, data)) return;
  io.to(socketId).emit(event, data);
}

/** Emit to a Socket.IO room — UDP clients get UDP, others get Socket.IO. */
function emitToRoom(roomName, event, data) {
  if (udpReady && udp.channelCount() > 0) {
    udp.broadcastToRoom(roomName, event, data);
    // Also send via Socket.IO for non-UDP clients in the room
    _emitToRoomExcludingUdp(roomName, event, data);
  } else {
    io.to(roomName).emit(event, data);
  }
}

/** Broadcast to a room excluding sender — UDP clients get UDP, others get Socket.IO. */
function broadcastToRoomFrom(senderSocket, roomName, event, data) {
  if (udpReady && udp.channelCount() > 0) {
    udp.broadcastToRoomExcluding(roomName, event, data, senderSocket.id);
    _emitToRoomExcludingUdp(roomName, event, data, senderSocket.id);
  } else {
    senderSocket.to(roomName).emit(event, data);
  }
}

/** Emit to ALL connected clients — UDP clients get UDP, others get Socket.IO. */
function emitToAll(event, data, excludeSocketId) {
  if (udpReady && udp.channelCount() > 0) {
    udp.emitAll(event, data, excludeSocketId);
    // Socket.IO only to sockets WITHOUT a UDP channel
    const udpSockets = udp.getConnectedSocketIds();
    for (const [sid, sock] of io.sockets.sockets) {
      if (sid === excludeSocketId) continue;
      if (!udpSockets.has(sid)) {
        sock.emit(event, data);
      }
    }
  } else {
    if (excludeSocketId) {
      const sock = io.sockets.sockets.get(excludeSocketId);
      if (sock) {
        sock.broadcast.emit(event, data);
      } else {
        io.emit(event, data);
      }
    } else {
      io.emit(event, data);
    }
  }
}

/** Broadcast to rooms around chunk coords — used for spatial events.
 *  If excludeSocketId is given, the sender is excluded from all rooms.
 */
function emitToNearbyRooms(cx, cy, event, data, excludeSocketId) {
  const rooms = getNeighborRooms(cx, cy);
  if (excludeSocketId) {
    const sock = io.sockets.sockets.get(excludeSocketId);
    for (let i = 0; i < rooms.length; i++) {
      if (sock) {
        broadcastToRoomFrom(sock, rooms[i], event, data);
      } else {
        emitToRoom(rooms[i], event, data);
      }
    }
  } else {
    for (let i = 0; i < rooms.length; i++) {
      emitToRoom(rooms[i], event, data);
    }
  }
}

/**
 * Internal: emit via Socket.IO to sockets in a room that do NOT
 * have an active UDP channel (so they aren't double-delivered).
 */
function _emitToRoomExcludingUdp(roomName, event, data, alsoExcludeId) {
  const room = io.sockets.adapter.rooms.get(roomName);
  if (!room) return;
  const udpSockets = udp.getConnectedSocketIds();
  for (const sid of room) {
    if (sid === alsoExcludeId) continue;
    if (udpSockets.has(sid)) continue; // already got it via UDP
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.emit(event, data);
  }
}

// UDP client→server message handlers — these mirror the Socket.IO handlers
// and are registered once during init. Each handler receives (data, socketId).
// They delegate to the same game logic as Socket.IO handlers.
const udpClientHandlers = {};

// update_player: The most frequent event — position + state updates
udpClientHandlers['update_player'] = (data, socketId) => {
  if (!data || !data.id) return;
  // Only allow the player to update their own data
  if (data.id !== socketId) return;
  if (!players[data.id]) return;

  // Replicate the update_player logic
  let hasVisual = false;
  let visualEvents = [];
  for (let i = 0; i < (data.update_names || []).length; i++) {
    const name = data.update_names[i];
    const value = data.update_values[i];
    if (name.includes('stats')) {
      if (players[data.id].statBlock) players[data.id].statBlock.stats[name.split('stats.')[1]] = value;
    } else if (name.includes('statBlock')) {
      if (players[data.id].statBlock) players[data.id].statBlock[name.split('statBlock.')[1]] = value;
    } else {
      players[data.id][name] = value;
      if (name === 'forcefieldActive' || name === 'isDashing' || name === 'flashTimer' ||
          name === 'particles' || name === 'meditateActive' || name === 'auraTimer' ||
          name === 'dashTimer' || name === 'combustionActive') {
        hasVisual = true;
        visualEvents.push({ playerId: data.id, ability: name, value: value });
      }
    }
  }
  if (isValidPos(data.pos)) {
    players[data.id].pos = data.pos;
    // Find the socket object to update rooms
    const sio = io.sockets.sockets.get(socketId);
    if (sio) {
      const coords = chunkCoordsFromPos(data.pos);
      if (coords) moveSocketToChunkRoom(sio, coords);
    }
  }
  if (data.holding !== undefined) players[data.id].holding = data.holding;

  const normalizedData = {
    id: data.id,
    pos: normalizePos(data.pos),
    holding: cloneHolding(data.holding),
    update_names: data.update_names || [],
    update_values: data.update_values || []
  };

  const playerCoords = chunkCoordsFromPos(data.pos);

  if (hasVisual) {
    if (playerCoords) {
      emitToNearbyRooms(playerCoords.cx, playerCoords.cy, 'UPDATE_PLAYER', normalizedData, socketId);
      for (const evt of visualEvents) emitToNearbyRooms(playerCoords.cx, playerCoords.cy, 'ABILITY_VISUAL', evt, socketId);
    } else {
      emitToAll('UPDATE_PLAYER', normalizedData, socketId);
      for (const evt of visualEvents) emitToAll('ABILITY_VISUAL', evt, socketId);
    }
  } else if (data.pos || data.holding) {
    if (playerCoords) {
      emitToNearbyRooms(playerCoords.cx, playerCoords.cy, 'UPDATE_PLAYER', normalizedData, socketId);
    } else {
      emitToAll('UPDATE_PLAYER', normalizedData, socketId);
    }
  }
};

// update_node: Terrain digging (dirt)
udpClientHandlers['update_node'] = (data, socketId) => {
  if (!data || !data.chunkPos) return;
  let chunkPos = data.chunkPos.split(',');
  chunkPos[0] = parseInt(chunkPos[0]);
  chunkPos[1] = parseInt(chunkPos[1]);
  let chunk = serverMap.getChunk(chunkPos[0], chunkPos[1]);
  if (data.amt > 0) {
    if (chunk.data[data.index] > 0) chunk.data[data.index] -= data.amt;
    if (chunk.data[data.index] < 0.3 && chunk.data[data.index] !== -1) chunk.data[data.index] = 0;
  } else {
    if (chunk.data[data.index] < 1.3 && chunk.data[data.index] !== -1) chunk.data[data.index] -= data.amt;
    if (chunk.data[data.index] > 1.3) chunk.data[data.index] = 1.3;
  }
  bufferNodeUpdate(chunkPos[0], chunkPos[1], data, false);
};

// update_iron_node: Terrain mining (iron)
udpClientHandlers['update_iron_node'] = (data, socketId) => {
  if (!data || !data.chunkPos) return;
  let chunkPos = data.chunkPos.split(',');
  chunkPos[0] = parseInt(chunkPos[0]);
  chunkPos[1] = parseInt(chunkPos[1]);
  let chunk = serverMap.getChunk(chunkPos[0], chunkPos[1]);
  if (data.amt > 0) {
    if (chunk.iron_data[data.index] > 0) chunk.iron_data[data.index] -= data.amt;
    if (chunk.iron_data[data.index] < 0.3 && chunk.iron_data[data.index] !== -1) chunk.iron_data[data.index] = 0;
  } else {
    if (chunk.iron_data[data.index] < 1.3 && chunk.iron_data[data.index] !== -1) chunk.iron_data[data.index] -= data.amt;
    if (chunk.iron_data[data.index] > 1.3) chunk.iron_data[data.index] = 1.3;
  }
  bufferNodeUpdate(chunkPos[0], chunkPos[1], data, true);
};

// EXPLOSION: Visual effect broadcast
udpClientHandlers['EXPLOSION'] = (data, socketId) => {
  if (!data) return;
  emitToAll('EXPLOSION', data, socketId);
};

// new_proj: Projectile spawned
udpClientHandlers['new_proj'] = (data, socketId) => {
  if (!data) return;
  if (!data.cPos && data.pos) {
    const cx = Math.floor(data.pos.x / (TILESIZE * CHUNKSIZE));
    const cy = Math.floor(data.pos.y / (TILESIZE * CHUNKSIZE));
    data.cPos = { x: cx, y: cy };
  }
  if (data.cPos) {
    let chunk = serverMap.getChunk(data.cPos.x, data.cPos.y);
    if (chunk) chunk.projectiles.push(data);
  }
  emitToAll('NEW_PROJECTILE', data, socketId);
};

// delete_proj: Projectile removed
udpClientHandlers['delete_proj'] = (data, socketId) => {
  if (!data) return;
  if (!data.cPos && data.pos) {
    const cx = Math.floor(data.pos.x / (TILESIZE * CHUNKSIZE));
    const cy = Math.floor(data.pos.y / (TILESIZE * CHUNKSIZE));
    data.cPos = { x: cx, y: cy };
  }
  if (!data.cPos) return;
  let chunk = serverMap.getChunk(data.cPos.x, data.cPos.y);
  if (!chunk) return;
  for (let i = chunk.projectiles.length - 1; i >= 0; i--) {
    if (data.id == chunk.projectiles[i].id) {
      chunk.projectiles.splice(i, 1);
      emitToAll('DELETE_PROJ', data, socketId);
      break;
    }
  }
};

// new_sound: Spatial sound spawned
udpClientHandlers['new_sound'] = (data, socketId) => {
  if (!data || !data.cPos) return;
  let chunk = serverMap.getChunk(data.cPos.x, data.cPos.y);
  if (chunk) chunk.soundObjs.push(data);
  emitToAll('NEW_SOUND', data, socketId);
};

// delete_sound: Spatial sound removed
udpClientHandlers['delete_sound'] = (data, socketId) => {
  if (!data || !data.cPos) return;
  let chunk = serverMap.getChunk(data.cPos.x, data.cPos.y);
  if (!chunk) return;
  for (let i = chunk.soundObjs.length - 1; i >= 0; i--) {
    if (data.id == chunk.soundObjs[i].id && data.lifeSpan == chunk.soundObjs[i].lifeSpan &&
        data.pos.x == chunk.soundObjs[i].pos.x && data.pos.y == chunk.soundObjs[i].pos.y) {
      chunk.soundObjs.splice(i, 1);
    }
  }
};

// wander_request: Entity AI wander
udpClientHandlers['wander_request'] = (data, socketId) => {
  if (!data || !data.id) return;
  for (let i = 0; i < serverMap.brains.length; i++) {
    if (data.id == serverMap.brains[i].id) {
      let angle = Math.random() * 2 * Math.PI;
      let target = { x: data.pos.x + Math.cos(angle) * 100, y: data.pos.y + Math.sin(angle) * 100 };
      emitToAll('WANDER_TARGET', { id: data.id, target: target });
      serverMap.brains[i].target = target;
      break;
    }
  }
};

(async function startUdp() {
  const ok = await udp.initUdpTransport(server, (socketId, channel) => {
    // Channel ready callback — notify the client that UDP is active
    io.to(socketId).emit('UDP_CONNECTED', { ok: true });

    // Sync the new UDP channel into the player's existing chunk rooms.
    // If the player joined the game before the DataChannel opened,
    // their Socket.IO socket is already in rooms but the UDP channel
    // has none — this closes that gap so room-scoped broadcasts
    // (UPDATE_NODE, etc.) reach the player immediately.
    const currentRooms = socketChunkRooms.get(socketId);
    if (currentRooms && currentRooms.rooms) {
      for (const room of currentRooms.rooms) {
        udp.joinRoom(socketId, room);
      }
      console.log(`[UDP] Channel ready for ${socketId} — synced ${currentRooms.rooms.length} rooms`);
    } else {
      console.log(`[UDP] Channel ready for ${socketId} — no rooms yet (player hasn't spawned)`);
    }
  }, udpClientHandlers);
  if (ok) {
    udpReady = true;
    console.log('[Server] UDP transport ready — high-frequency events will use WebRTC DataChannels');
  } else {
    console.warn('[Server] UDP transport failed to init — all traffic will use Socket.IO (TCP)');
  }
})();

app.use(allRoutes);

// Attempt to load saved world state on startup
(function bootstrapLoad() {
  try {
    const loaded = loadState();
    if (loaded && loaded.serverMap) {
      // Reconstruct serverMap from saved data
      const seed = loaded.serverMap.seed || Math.random();
      serverMap = new GameMap(seed);

      const keys = Object.keys(loaded.serverMap.chunks || {});
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const raw = loaded.serverMap.chunks[key];
        const ch = new Chunk(raw.cx, raw.cy);
        ch.data = raw.data || {};
        ch.iron_data = raw.iron_data || {};
        ch.objects = raw.objects || [];
        ch.projectiles = raw.projectiles || [];
        ch.soundObjs = raw.soundObjs || [];
        serverMap.chunks[key] = ch;
      }

      serverMap.brains = loaded.serverMap.brains || [];

      // Restore teams if present
      teams = loaded.teams || teams;
      // Restore saved players snapshot
      savedPlayersByName = loaded.playersSnapshot || {};

      // Keep globals in sync
      globals.serverMap = serverMap;
      globals.teams = teams;

      console.log('[Persistence] World state loaded with', keys.length, 'chunks');
    } else {
      console.log('[Persistence] No saved world found, starting fresh');
    }
  } catch (e) {
    console.error('[Persistence] Failed to load world state:', e);
  }
})();

// Periodic autosave
setInterval(() => {
  queueWorldSave('autosave').then((ok) => {
    if (ok !== false) {
      console.log('[Persistence] Autosaved world state');
    }
  });
}, Math.max(0.1, SAVE_INTERVAL_HOURS) * 60 * 60 * 1000);

// Periodic summary snapshot cache for quick client consumption
function snapshotServerSummary() {
  return {
    teams,
    updatedAt: Date.now(),
  };
}

function refreshSummaryCache() {
  const snap = snapshotServerSummary();
  summaryCache = snap;
  globals.summaryCache = summaryCache;
  globals.playerSnapshotCache = snap.players || {};
  playerSnapshotCache = globals.playerSnapshotCache;
  return snap;
}

setInterval(() => {
  refreshSummaryCache();
}, Math.max(5000, SUMMARY_INTERVAL_MS));

// Prime caches on startup
refreshSummaryCache();

// Save on graceful shutdown
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    console.log(`[Persistence] Received ${sig}, saving world state...`);
    queueWorldSave('cli-delete');
    process.exit(0);
  });
});

  function snapshotPlayersForBroadcast() {
      const out = {};
      for (const id of Object.keys(players)) {
        const p = players[id];
        if (!p) continue;
        out[id] = sanitizePlayerForClient(p);
      }
      return out;
  }

  // ── Periodic PLAYERS_SYNC: self-healing reconciliation ──
  // Every 5 seconds, broadcast the full player list so clients can
  // recover from any dropped NEW_PLAYER / REMOVE_PLAYER events.
  setInterval(() => {
    const ids = Object.keys(players);
    if (ids.length === 0) return; // nothing to sync
    const syncData = { players: snapshotPlayersForBroadcast() };
    emitToAll('PLAYERS_SYNC', syncData);
  }, 5000);

  function newConnection(socket) {
    try {
      //all caps means it came from the server
      //all lower means it came from the client

      // Enforce max players: if full, notify and disconnect immediately
      const currentPlayers = Object.keys(players).length;
      if (currentPlayers >= MAX_PLAYERS) {
        io.to(socket.id).emit('SERVER_FULL', {
          message: 'Server is full. Please try again later.',
          current: currentPlayers,
          max: MAX_PLAYERS,
        });
        setTimeout(() => socket.disconnect(true), 100);
        return;
      }

      console.log('New connection: ' + socket.id);
      try { logger.info('Client connected', { id: socket.id }); } catch {}
      // Send all existing players so the new client can see everyone
      io.to(socket.id).emit('OLD_DATA', { players: snapshotPlayersForBroadcast() });
      io.to(socket.id).emit('YOUR_ID', { id: socket.id });

      // Send UDP auth token so client can establish WebRTC DataChannel
      if (udpReady) {
        io.to(socket.id).emit('UDP_TOKEN', { token: udp.generateUdpToken(socket.id) });
      }

      // Skip sending SERVER_SUMMARY to avoid large/circular payloads for now

      if (TIMER_DISABLED) {
        io.to(socket.id).emit('sync_time', { disabled: true });
      } else {
        const minutes = Math.floor(countdown / 60);
        const seconds = countdown % 60;
        io.to(socket.id).emit('sync_time', { minutes, seconds, totalSeconds: countdown, endsAt: timerEndAt });
      }

      socket.on('new_player', new_player);
      function new_player(data = {}, ack) {
        const reply = (payload) => {
          if (typeof ack === 'function') ack(payload);
        };

        // Double-check capacity at the moment of joining
        const nowPlayers = Object.keys(players).length;
        if (nowPlayers >= MAX_PLAYERS) {
          io.to(socket.id).emit('SERVER_FULL', {
            message: 'Server is full. Please try again later.',
            current: nowPlayers,
            max: MAX_PLAYERS,
          });
          setTimeout(() => socket.disconnect(true), 100);
          reply({ ok: false, code: 'FULL' });
          return;
        }

        if (!data.name || typeof data.name !== 'string') {
          reply({ ok: false, code: 'INVALID_NAME', message: 'Name is required.' });
          return;
        }

        const originalName = data.name.trim();
        let name = originalName;

        // Replace bad words with asterisks or generic fallback
        if (badWordRegex.test(name)) {
          name = 'Player' + Math.random().toString(16).slice(2, 6);
        }

        // Prevent duplicate live sessions on the same name
        const liveConflict = Object.values(players).some((player) => player && player.name === name);
        if (liveConflict) {
          reply({ ok: false, code: 'NAME_IN_USE', message: 'That name is already in use.' });
          return;
        }

        const incomingPassword = typeof data.password === 'string' ? data.password : '';
        delete data.password;

        data.name = name;
        data.kills = 0;
        data.deaths = 0;
        data.holding = data.holding || { w: false, a: false, s: false, d: false };

        const snap = savedPlayersByName[name];
        const snapHasPassword = !!snap?.passwordHash;
        let passwordHashToPersist = snap?.passwordHash || null;

        if (snapHasPassword) {
          if (!incomingPassword) {
            reply({ ok: false, code: 'PASSWORD_REQUIRED', message: 'Password required for this player.' });
            return;
          }
          if (!verifyPassword(incomingPassword, snap.passwordHash)) {
            reply({ ok: false, code: 'BAD_PASSWORD', message: 'Incorrect password.' });
            return;
          }
        } else if (incomingPassword) {
          passwordHashToPersist = hashPassword(incomingPassword);
        }

        // IMPORTANT: Restore snapshot data BEFORE storing player
        // Otherwise disconnect will save empty inventory over old data!
        if (snap) {
          console.log(`[Spawn] Restoring saved data for "${name}" into server player object`);
          if (snap.invBlock) {
            data.invBlock = {
              items: JSON.parse(JSON.stringify(snap.invBlock.items || {})),
              hotbar: Array.isArray(snap.invBlock.hotbar) ? snap.invBlock.hotbar.slice() : ["","","","",""],
              selectedHotBar: typeof snap.invBlock.selectedHotBar === 'number' ? snap.invBlock.selectedHotBar : 0,
              equiped: snap.invBlock.equiped ? JSON.parse(JSON.stringify(snap.invBlock.equiped)) : { head: "", neck: "", chest: "", legs: "", feet: "" }
            };
          }
          if (snap.statBlock) {
            // Deep copy statBlock to prevent reference issues
            data.statBlock = JSON.parse(JSON.stringify(snap.statBlock));
            // Ensure stats have all properties from BASE_STATS
            if (data.statBlock.stats && typeof data.race === 'number') {
              data.statBlock.stats = ensureCompleteStats(data.statBlock.stats, data.race);
            }
          }
          if (snap.pos && snap.pos.x != null && snap.pos.y != null) {
            data.pos = { x: snap.pos.x, y: snap.pos.y };
          }
          if (snap.teamId) {
            data.teamId = snap.teamId;
            // Apply team color so other clients see it immediately
            if (teams[snap.teamId] && teams[snap.teamId].color) {
              data.color = teams[snap.teamId].color;
            }
          }
          if (Number.isFinite(snap.maxDirtInv)) {
            data.maxDirtInv = snap.maxDirtInv;
          }
        }

        data.passwordHash = passwordHashToPersist || null;
        // Store player with restored data
        if (!Number.isFinite(data.maxDirtInv)) data.maxDirtInv = 600;
        players[data.id] = data;

        // Immediately assign chunk room so this player receives chunk-scoped broadcasts
        const spawnCoords = chunkCoordsFromPos(data.pos);
        if (spawnCoords) moveSocketToChunkRoom(socket, spawnCoords);

        const broadcastPlayer = sanitizePlayerForClient(data);
        socket.broadcast.emit('NEW_PLAYER', broadcastPlayer);
        // Send team data to the joining player and all clients
        io.emit('TEAMS_UPDATE', { teams });
        
        try { logger.info('Player joined', { id: data.id, name: data.name }); } catch {}

        const isReturning = !!snap;
        io.emit('NEW_CHAT_MESSAGE', {
          message: `${isReturning ? ServerWelcomeReturningMessage : ServerWelcomeNewMessage} ${data.name}`,
          x: 0,
          y: 0,
          user: 'SERVER',
        });

        reply({ ok: true, isReturning, hasPassword: !!passwordHashToPersist });
      }

      // Handle explicit item request from client after spawn
      socket.on('request_my_items', (data) => {
        const playerName = data.name;
        const snap = savedPlayersByName[playerName];
        const hasInventory = !!(snap && snap.invBlock);
        
        console.log(`[Items] Request from "${playerName}"`);
        console.log(`[Items] Snapshot exists:`, !!snap, 'inv?', hasInventory);
        
        // If snapshot exists with inventory, they're a returning player
        if (snap && hasInventory) {
          console.log(`[Items] "${playerName}" is a RETURNING player - restoring old data`);
          console.log(`[Items] Position:`, snap.pos);
          console.log(`[Items] Level:`, snap.statBlock?.level);
          console.log(`[Items] Items count:`, Object.keys(snap.invBlock?.items || {}).length);
          
          try {
            // Update server-side player with restored data
            if (players[socket.id]) {
              if (snap.invBlock) {
                players[socket.id].invBlock = {
                  items: JSON.parse(JSON.stringify(snap.invBlock.items || {})),
                  hotbar: Array.isArray(snap.invBlock.hotbar) ? snap.invBlock.hotbar.slice() : ["","","","",""],
                  selectedHotBar: typeof snap.invBlock.selectedHotBar === 'number' ? snap.invBlock.selectedHotBar : 0,
                  equiped: snap.invBlock.equiped ? JSON.parse(JSON.stringify(snap.invBlock.equiped)) : { head: "", neck: "", chest: "", legs: "", feet: "" }
                };
              }
              if (snap.statBlock) {
                // Deep copy statBlock to prevent reference issues
                players[socket.id].statBlock = JSON.parse(JSON.stringify(snap.statBlock));
                // Ensure stats have all properties from BASE_STATS
                if (players[socket.id].statBlock.stats && typeof players[socket.id].race === 'number') {
                  players[socket.id].statBlock.stats = ensureCompleteStats(players[socket.id].statBlock.stats, players[socket.id].race);
                }
              }
              if (snap.pos && snap.pos.x != null && snap.pos.y != null) {
                players[socket.id].pos = { x: snap.pos.x, y: snap.pos.y };
              }
              if (snap.teamId) {
                players[socket.id].teamId = snap.teamId;
                // Apply team color so other clients see it immediately
                if (teams[snap.teamId] && teams[snap.teamId].color) {
                  players[socket.id].color = teams[snap.teamId].color;
                }
              }
              if (Number.isFinite(snap.maxDirtInv)) {
                players[socket.id].maxDirtInv = snap.maxDirtInv;
              }
            }
            
            // ✅ Send old data to client - they decide if items are empty
            // Send deep copies to prevent reference issues
            let statBlockToSend = snap.statBlock ? JSON.parse(JSON.stringify(snap.statBlock)) : null;
            if (statBlockToSend && statBlockToSend.stats && typeof snap.race === 'number') {
              statBlockToSend.stats = ensureCompleteStats(statBlockToSend.stats, snap.race);
            }
            console.log('[SERVER] Sending moves set to client:', Array.isArray(snap.movesSlots) ? snap.movesSlots : null);
            io.to(socket.id).emit('receive_my_items', {
              hasOldItems: true, // only true when inventory exists
              invBlock: snap.invBlock ? JSON.parse(JSON.stringify(snap.invBlock)) : { items: {}, hotbar: ["","","","",""], selectedHotBar: 0, equiped: {}, movesSlots: [] },
              statBlock: statBlockToSend,
              pos: snap.pos ? { x: snap.pos.x, y: snap.pos.y } : null,
              teamId: snap.teamId || null,
              maxDirtInv: Number.isFinite(snap.maxDirtInv) ? snap.maxDirtInv : 600,
              movesSlots: Array.isArray(snap.invBlock?.movesSlots) ? snap.invBlock.movesSlots : null,
            });
          } catch (e) {
            console.warn('[Items] Failed to restore items for', playerName, e);
            // Tell client to use starter kit on error
            io.to(socket.id).emit('receive_my_items', { hasOldItems: false });
          }
        } else {
          console.log(`[Items] "${playerName}" is a NEW player - will receive starter kit`);
          // Tell client to give starter kit
          io.to(socket.id).emit('receive_my_items', { hasOldItems: false });
        }
      });

      socket.on('set_password', (data = {}, ack) => {
        const reply = (payload) => {
          if (typeof ack === 'function') ack(payload);
        };

        const p = players[socket.id];
        if (!p || !p.name) {
          reply({ ok: false, message: 'Player not logged in.' });
          return;
        }

        const newPass = typeof data.password === 'string' ? data.password : '';
        let hashed = null;
        if (newPass) {
          hashed = hashPassword(newPass);
          if (!hashed) {
            reply({ ok: false, message: 'Unable to set password.' });
            return;
          }
        }

        // Update in-memory player
        p.passwordHash = hashed;

        // Update snapshot without clobbering inventory if it's not yet present
        const existingSnap = savedPlayersByName[p.name] || {};
        savedPlayersByName[p.name] = {
          ...existingSnap,
          name: p.name,
          passwordHash: hashed,
          // keep existing snapshot fields if any; do not overwrite invBlock/statBlock when absent
        };
        schedulePlayerSnapshotPersist(p.name);

        reply({ ok: true, hasPassword: !!hashed });
      });

      socket.on('sync_player_inventory', (data) => {
        if (!players[socket.id]) return;
        
        // Update server-side player inventory
        if (data.invBlock) {
          players[socket.id].invBlock = {
            items: data.invBlock.items || {},
            hotbar: Array.isArray(data.invBlock.hotbar) ? data.invBlock.hotbar : ["","","","",""],
            selectedHotBar: typeof data.invBlock.selectedHotBar === 'number' ? data.invBlock.selectedHotBar : 0,
            equiped: data.invBlock.equiped || { head: "", neck: "", chest: "", legs: "", feet: "" }
          };
        }
        
        // Also update position and stats if provided
        if (isValidPos(data.pos)) {
          players[socket.id].pos = data.pos;
        }
        if (data.statBlock) {
          players[socket.id].statBlock = data.statBlock;
        }
        
        // Save player snapshot with updated inventory
        savePlayerSnapshot(players[socket.id]);
        
        console.log(`[Sync] Updated inventory for "${players[socket.id].name}" - ${Object.keys(data.invBlock?.items || {}).length} items`);
      });

      socket.on('save_player_state', (data = {}) => {
        const p = players[socket.id] || {};
        console.log("save player",data.invBlock)
        // Merge any client-provided fields before saving
        if (data.invBlock) {
          p.invBlock = {
            items: data.invBlock.items || {},
            hotbar: Array.isArray(data.invBlock.hotbar) ? data.invBlock.hotbar : ["","","","",""],
            selectedHotBar:
              typeof data.invBlock.selectedHotBar === 'number'
                ? data.invBlock.selectedHotBar
                : 0,
            equiped: data.invBlock.equiped || { head: "", neck: "", chest: "", legs: "", feet: "" },
          };
        }
        if (data.statBlock) p.statBlock = data.statBlock;
        if (isValidPos(data.pos)) p.pos = data.pos;
        if (data.teamId !== undefined) p.teamId = data.teamId;
        if (data.race !== undefined) p.race = data.race;
        if (data.color !== undefined) p.color = data.color;
        if (data.name) p.name = data.name;
        if (Array.isArray(data.movesSlots)) p.movesSlots = data.movesSlots;

        // Ensure the players table has this socket
        if (!players[socket.id] && p.name) {
          p.id = socket.id;
          players[socket.id] = p;
        }

        const ok = savePlayerSnapshot(players[socket.id] || p);
        io.to(socket.id).emit('PLAYER_SAVED', { ok });
      });

      socket.on('player_reconnected', player_reconnected);
      function player_reconnected(data) {
        if (!data || !data.player) return;
        const incoming = data.player;
        // Accept only sane positions
        if (!isValidPos(incoming.pos)) {
          incoming.pos = players[incoming.id]?.pos || { x: 0, y: 0 };
        }
        // Clean up old player entry to prevent ghost duplicates
        if (data.oldID && data.oldID !== incoming.id) {
          delete players[data.oldID];
          socketChunkRooms.delete(data.oldID);
        }
        players[incoming.id] = incoming;
        if (kills_deaths[data.oldID] != undefined) {
          players[data.player.id].kills = kills_deaths[data.oldID].kills;
          players[data.player.id].deaths = kills_deaths[data.oldID].deaths;
          delete kills_deaths[data.oldID];
        } else {
          players[data.player.id].kills = 0;
          players[data.player.id].deaths = 0;
        }

        // Join proper chunk room if we have coords
        const coords = chunkCoordsFromPos(players[data.player.id].pos);
        moveSocketToChunkRoom(socket, coords);

        // Note: Team membership is now based on username, not socket ID
        // No ID fixing needed on reconnect

        socket.broadcast.emit('NEW_PLAYER', sanitizePlayerForClient(data.player));
        socket.broadcast.emit('PLAYERS_CHECK', {
          ids: Object.keys(players),
        });
        
        // Broadcast updated teams to all clients
        io.emit('TEAMS_UPDATE', { teams });
      }

      // Handle explicit player leave message
      socket.on('player_leave', (data) => {
        try { logger.info('Player leaving', { id: socket.id, playerName: data.playerName }); } catch {}
        console.log(`[LEAVE] Player "${data.playerName}" (${socket.id}) is leaving`);
        
        // Clean up player state immediately
        if (players[socket.id] != undefined) {
          const p = players[socket.id];
          if (p && p.name) {
            // Save player snapshot before removal
            const ok = savePlayerSnapshot(p);
            console.log(ok ? `[SAVE] ✓ Snapshot saved for "${p.name}"` : `[SAVE] ✗ Snapshot failed for "${p.name}"`);
          }
          players[socket.id] = [];
          delete players[socket.id];
        }
        
        // Notify all clients about the player leaving
        io.emit('PLAYERS_CHECK', {
          ids: Object.keys(players),
        });
      });

      socket.on('disconnect', disconnect);

      function disconnect(data) {
        try { logger.info('Client disconnected', { id: socket.id }); } catch {}
        console.log(socket.id + ' disconnected');
        if (players[socket.id] != undefined) {
          console.log(
            '{\n' +
              '   id: ' +
              players[socket.id].id +
              '\n   name: ' +
              players[socket.id].name +
              '\n   kills: ' +
              players[socket.id].kills +
              '\n   deaths: ' +
              players[socket.id].deaths +
              '\n}',
          );
          kills_deaths[socket.id] = {
            kills: players[socket.id].kills,
            deaths: players[socket.id].deaths,
          };
          
          // Save snapshot by player name before removal
          const p = players[socket.id];
          if (p && p.name) {
            // Persist latest server-side state (inventory, stats, position) before removal
            const ok = savePlayerSnapshot(p);
            console.log(ok ? `[SAVE] ✓ Snapshot saved for "${p.name}"` : `[SAVE] ✗ Snapshot failed for "${p.name}"`);
          }
        }

        players[socket.id] = [];
        delete players[socket.id];
        socketChunkRooms.delete(socket.id);
        udp.removeChannel(socket.id); // Clean up UDP channel

        io.emit('REMOVE_PLAYER', socket.id);
        // send message
        io.emit('NEW_CHAT_MESSAGE', {
          message: `Goodbye ${players[socket.id] ? players[socket.id].name : 'a player'}`,
          x: 0,
          y: 0,
          user: players[socket.id] ? players[socket.id].name : 'a player'
        });

      }

      socket.on('update_pos', update_pos);

      function update_pos(data) {
        if (!players[data.id]) {
          console.error(`Player with id ${data.id} not found.`);
          return;
        }

        if (isValidPos(data.pos)) {
          players[data.id].pos = data.pos;
          const coords = chunkCoordsFromPos(data.pos);
          moveSocketToChunkRoom(socket, coords);
          // Broadcast the updated position to other clients with normalized payload
          const normalizedData = {
            id: data.id,
            pos: normalizePos(data.pos),
            holding: cloneHolding(data.holding)
          };
          if (coords) {
            emitToNearbyRooms(coords.cx, coords.cy, 'UPDATE_POS', normalizedData, socket.id);
          } else {
            emitToAll('UPDATE_POS', normalizedData, socket.id);
          }
        }
        // Always update holding if present
        if (data.holding !== undefined) {
          players[data.id].holding = data.holding;
        }
      }

      socket.on('update_player', update_player);

      function update_player(data) {
        if (!players[data.id]) {
          console.error(`Player with id ${data.id} not found.`);
          return;
        }

        let hasVisual = false;
        let visualEvents = [];
        for (let i = 0; i < data.update_names.length; i++) {
          const name = data.update_names[i];
          const value = data.update_values[i];
          if (name.includes('stats')) {
            players[data.id].statBlock.stats[name.split('stats.')[1]] = value;
          } else if (name.includes('statBlock')) {
            players[data.id].statBlock[name.split('statBlock.')[1]] = value;
          } else {
            players[data.id][name] = value;
            // Detect visual effect fields (add more as needed)
            if (
              name === 'forcefieldActive' ||
              name === 'isDashing' ||
              name === 'flashTimer' ||
              name === 'particles' ||
              name === 'meditateActive' ||
              name === 'auraTimer' ||
              name === 'dashTimer' ||
              name === 'combustionActive'
            ) {
              hasVisual = true;
              visualEvents.push({
                playerId: data.id,
                ability: name,
                value: value
              });
            }
          }
        }
        players[data.id].pos = data.pos;
        players[data.id].holding = data.holding;

        // Normalize the broadcast payload to avoid circular references
        const normalizedData = {
          id: data.id,
          pos: normalizePos(data.pos),
          holding: cloneHolding(data.holding),
          update_names: data.update_names,
          update_values: data.update_values
        };

        // Broadcast through chunk rooms (3x3 grid) instead of globally
        const playerCoords = chunkCoordsFromPos(data.pos);
        if (playerCoords) {
          moveSocketToChunkRoom(socket, playerCoords);
        }

        if (hasVisual) {
          if (playerCoords) {
            emitToNearbyRooms(playerCoords.cx, playerCoords.cy, 'UPDATE_PLAYER', normalizedData, socket.id);
            for (const evt of visualEvents) {
              emitToNearbyRooms(playerCoords.cx, playerCoords.cy, 'ABILITY_VISUAL', evt, socket.id);
            }
          } else {
            emitToAll('UPDATE_PLAYER', normalizedData, socket.id);
            for (const evt of visualEvents) {
              emitToAll('ABILITY_VISUAL', evt, socket.id);
            }
          }
        } else {
          if (data.pos || data.holding) {
            if (playerCoords) {
              emitToNearbyRooms(playerCoords.cx, playerCoords.cy, 'UPDATE_PLAYER', normalizedData, socket.id);
            } else {
              emitToAll('UPDATE_PLAYER', normalizedData, socket.id);
            }
          } else {
            // Only stat updates, send just to the player
            emitToPlayer(data.id, 'UPDATE_PLAYER', normalizedData);
          }
        }
      }

      // Broadcast explosion events to nearby clients
      socket.on('EXPLOSION', (data) => {
        emitToAll('EXPLOSION', data, socket.id);
      });

      // Sync movesSlots from client
      socket.on('update_moves', (data = {}) => {
        const p = players[socket.id];
        if (!p) return;
        if (Array.isArray(data.movesSlots)) {
          p.movesSlots = data.movesSlots;
        }
        if (p.name) {
          savePlayerSnapshot(p);
        }
        io.to(socket.id).emit('PLAYER_MOVES_SAVED', { ok: true });
      });

      // Spawn entity handler (e.g., for Queen's Kiss ability)
      socket.on('spawn_entity', (data) => {
        const { name, x, y, teamId, color, ownerName } = data;
        const playerData = players[socket.id];
        
        if (!playerData || !name || x === undefined || y === undefined) {
          console.error('Invalid spawn_entity data:', data);
          return;
        }

        // Generate unique brain ID for the entity
        const brainID = Math.floor(Math.random() * 1000000).toString();
        
        // Create brain object for AI control
        const brain = {
          id: brainID,
          target: { x, y },
          personality: 'swarm', // Ants use swarm AI
          teamId: teamId || null,
          ownerName: ownerName || playerData.name
        };
        
        // Add to server map brains
        if (!serverMap.brains) serverMap.brains = [];
        serverMap.brains.push(brain);
        
        // Broadcast to all clients to spawn the entity
        io.emit('NEW_BRAIN', brain);
        
        console.log(`[Spawn Entity] ${ownerName} spawned ${name} at (${x}, ${y})`);
      });

      // Team management handlers
      socket.on('create_team', (data) => {
        const { name, color } = data;
        const playerData = players[socket.id];
        
        if (!playerData || !playerData.name) return;

        // Generate unique team ID
        const teamId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        
        teams[teamId] = {
          id: teamId,
          name: name,
          color: color, // { r, g, b }
          creator: playerData.name,
          leaders: [playerData.name], // Array of leader names (starts with creator)
          members: [playerData.name],
          requests: []
        };

        // Update player's team
        playerData.teamId = teamId;
        // Set player color to team color
        playerData.color = { r: color.r, g: color.g, b: color.b };

        io.emit('TEAM_CREATED', { teamId, team: teams[teamId] });
        io.emit('TEAMS_UPDATE', { teams });
        
        // Save team data to disk
        queueWorldSave('team-create');
        
        // Save player snapshot with team
        savePlayerSnapshot(playerData);
        
        socket.emit('TEAM_JOINED', { teamId, team: teams[teamId] });
      });

      socket.on('request_join_team', (data) => {
        const { teamId } = data;
        const playerData = players[socket.id];
        
        if (!playerData || !playerData.name || !teams[teamId]) return;
        
        // Check if already in a team
        if (playerData.teamId) {
          socket.emit('TEAM_ERROR', { message: 'Already in a team. Leave your current team first.' });
          return;
        }

        // Check if already requested
        if (teams[teamId].requests.includes(playerData.name)) {
          socket.emit('TEAM_ERROR', { message: 'Already requested to join this team.' });
          return;
        }

        teams[teamId].requests.push(playerData.name);
        
        // Save team changes
        queueWorldSave('team-request');
        
        // Notify team creator (find their socket ID by name)
        const creatorSocketId = Object.keys(players).find(id => players[id].name === teams[teamId].creator);
        if (creatorSocketId) {
          io.to(creatorSocketId).emit('TEAM_REQUEST', {
            teamId,
            playerName: playerData.name
          });
        }

        socket.emit('TEAM_REQUEST_SENT', { teamId });
      });

      socket.on('accept_team_request', (data) => {
        const { teamId, playerName } = data;
        const team = teams[teamId];
        const playerSocketId = Object.keys(players).find(id => players[id].name === playerName);
        const playerData = playerSocketId ? players[playerSocketId] : null;
        
        if (!team || !playerData || !playerName) return;
        
        // Check if requester is the creator
        const requesterData = players[socket.id];
        if (!requesterData || team.creator !== requesterData.name) {
          socket.emit('TEAM_ERROR', { message: 'Only team creator can accept requests.' });
          return;
        }

        // Remove from requests
        team.requests = team.requests.filter(name => name !== playerName);
        
        // Add to members
        team.members.push(playerName);
        playerData.teamId = teamId;
        // Set player color to team color
        playerData.color = { r: team.color.r, g: team.color.g, b: team.color.b };

        // Save all changes
        queueWorldSave('team-accept');
        savePlayerSnapshot(playerData);

        io.emit('TEAMS_UPDATE', { teams });
        // Broadcast player color update to all clients
        io.emit('PLAYER_COLOR_CHANGED', { 
          playerId: playerSocketId, 
          color: playerData.color 
        });
        io.to(playerSocketId).emit('TEAM_JOINED', { teamId, team });
      });

      socket.on('deny_team_request', (data) => {
        const { teamId, playerName } = data;
        const team = teams[teamId];
        const playerSocketId = Object.keys(players).find(id => players[id].name === playerName);
        
        if (!team || !playerName) return;
        
        // Check if requester is the creator
        const requesterData = players[socket.id];
        if (!requesterData || team.creator !== requesterData.name) return;

        // Remove from requests
        team.requests = team.requests.filter(name => name !== playerName);
        
        // Save changes
        queueWorldSave('team-deny');
        
        if (playerSocketId) {
          io.to(playerSocketId).emit('TEAM_REQUEST_DENIED', { teamId });
        }
      });

      socket.on('leave_team', () => {
        const playerData = players[socket.id];
        
        if (!playerData || !playerData.teamId || !playerData.name) return;
        
        const teamId = playerData.teamId;
        const team = teams[teamId];
        
        if (!team) return;

        // Remove from members and leaders
        team.members = team.members.filter(name => name !== playerData.name);
        team.leaders = team.leaders.filter(name => name !== playerData.name);
        playerData.teamId = null;
        playerData.color = 0; // Reset to no team

        // If creator leaves, disband team
        if (team.creator === playerData.name) {
          // Notify all members
          team.members.forEach(memberName => {
            const memberSocketId = Object.keys(players).find(id => players[id].name === memberName);
            if (memberSocketId) {
              players[memberSocketId].teamId = null;
              players[memberSocketId].color = 0;
              savePlayerSnapshot(players[memberSocketId]);
              io.to(memberSocketId).emit('TEAM_DISBANDED', { teamId });
            }
          });
          delete teams[teamId];
        }

        // Save all changes
        queueWorldSave('team-leave');
        savePlayerSnapshot(playerData);

        io.emit('TEAMS_UPDATE', { teams });
        // Broadcast player color update to all clients
        io.emit('PLAYER_COLOR_CHANGED', { 
          playerId: socket.id, 
          color: playerData.color 
        });
        socket.emit('TEAM_LEFT', { teamId });
      });

      socket.on('update_team', (data) => {
        const { teamId, name, color } = data;
        const team = teams[teamId];
        const requesterData = players[socket.id];
        
        if (!team || !requesterData) return;
        
        // Check if requester is the creator or a leader
        if (team.creator !== requesterData.name && !team.leaders.includes(requesterData.name)) {
          socket.emit('TEAM_ERROR', { message: 'Only team leaders can update team.' });
          return;
        }

        if (name) team.name = name;
        if (color) {
          team.color = color;
          // Update all team members' color to the new team color
          team.members.forEach(memberName => {
            const memberSocketId = Object.keys(players).find(id => players[id].name === memberName);
            if (memberSocketId && players[memberSocketId]) {
              players[memberSocketId].color = { r: color.r, g: color.g, b: color.b };
              savePlayerSnapshot(players[memberSocketId]);
            }
          });
        }

        // Save all changes
        queueWorldSave('team-update');

        io.emit('TEAMS_UPDATE', { teams });
      });

      socket.on('get_teams', () => {
        socket.emit('TEAMS_UPDATE', { teams });
      });

      socket.on('promote_member', (data) => {
        const { teamId, memberName } = data;
        const team = teams[teamId];
        const requesterData = players[socket.id];
        
        if (!team || !requesterData || !memberName) return;
        
        // Check if requester is a leader
        if (!team.leaders.includes(requesterData.name)) {
          socket.emit('TEAM_ERROR', { message: 'Only team leaders can promote members.' });
          return;
        }

        // Check if member exists in team
        if (!team.members.includes(memberName)) {
          socket.emit('TEAM_ERROR', { message: 'Member not found in team.' });
          return;
        }

        // Add to leaders if not already
        if (!team.leaders.includes(memberName)) {
          team.leaders.push(memberName);
        }

        // Save changes
        queueWorldSave('team-promote');

        io.emit('TEAMS_UPDATE', { teams });
      });

      socket.on('remove_member', (data) => {
        const { teamId, memberName } = data;
        const team = teams[teamId];
        const memberSocketId = Object.keys(players).find(id => players[id].name === memberName);
        const memberData = memberSocketId ? players[memberSocketId] : null;
        const requesterData = players[socket.id];
        
        if (!team || !requesterData || !memberName) return;
        
        // Check if requester is a leader
        if (!team.leaders.includes(requesterData.name)) {
          socket.emit('TEAM_ERROR', { message: 'Only team leaders can remove members.' });
          return;
        }

        // Cannot remove a leader
        if (team.leaders.includes(memberName)) {
          socket.emit('TEAM_ERROR', { message: 'Cannot remove a team leader. Promote them to regular member first.' });
          return;
        }

        // Remove from members
        team.members = team.members.filter(name => name !== memberName);
        
        // Reset player team
        if (memberData && memberSocketId) {
          memberData.teamId = null;
          memberData.color = 0;
          savePlayerSnapshot(memberData);
          io.to(memberSocketId).emit('TEAM_MEMBER_REMOVED', { teamId });
        }

        // Save changes
        queueWorldSave('team-remove');

        io.emit('TEAMS_UPDATE', { teams });
      });

      socket.on('invite_player', (data) => {
        const { teamId, invitedPlayerName } = data;
        const team = teams[teamId];
        const requesterData = players[socket.id];
        const invitedPlayerSocketId = Object.keys(players).find(id => players[id].name === invitedPlayerName);
        const invitedPlayer = invitedPlayerSocketId ? players[invitedPlayerSocketId] : null;
        
        if (!team || !requesterData || !invitedPlayerName || !invitedPlayer) return;
        
        // Check if requester is a leader
        if (!team.leaders.includes(requesterData.name)) {
          socket.emit('TEAM_ERROR', { message: 'Only team leaders can invite players.' });
          return;
        }

        // Check if invited player is already in a team
        if (invitedPlayer.teamId) {
          socket.emit('TEAM_ERROR', { message: 'That player is already in a team.' });
          return;
        }

        // Send invite prompt to the invited player
        io.to(invitedPlayerSocketId).emit('TEAM_INVITE', {
          teamId: teamId,
          teamName: team.name,
          inviterName: requesterData.name
        });

        socket.emit('TEAM_INVITE_SENT', { playerName: invitedPlayerName });
      });

      socket.on('accept_invite', (data) => {
        const { teamId } = data;
        const playerData = players[socket.id];
        const team = teams[teamId];

        if (!playerData || !playerData.name || !team) return;

        // Check if player is already in a team
        if (playerData.teamId) {
          socket.emit('TEAM_ERROR', { message: 'You are already in a team.' });
          return;
        }

        // Add to members
        team.members.push(playerData.name);
        playerData.teamId = teamId;
        // Set player color to team color
        playerData.color = { r: team.color.r, g: team.color.g, b: team.color.b };

        // Save all changes
        queueWorldSave('team-accept-invite');
        savePlayerSnapshot(playerData);

        io.emit('TEAMS_UPDATE', { teams });
        // Broadcast player color update to all clients
        io.emit('PLAYER_COLOR_CHANGED', { 
          playerId: socket.id, 
          color: playerData.color 
        });
        socket.emit('TEAM_JOINED', { teamId, team });
      });

      socket.on('decline_invite', (data) => {
        const { teamId } = data;
        // Just emit a confirmation to the player
        socket.emit('TEAM_INVITE_DECLINED', { teamId });
      });

      socket.on('update_node', update_node);

      function update_node(data) {
        let chunkPos = data.chunkPos.split(',');
        chunkPos[0] = parseInt(chunkPos[0]);
        chunkPos[1] = parseInt(chunkPos[1]);
        let chunk = serverMap.getChunk(chunkPos[0], chunkPos[1]);

        if (data.amt > 0) {
          if (chunk.data[data.index] > 0) chunk.data[data.index] -= data.amt;
          if (chunk.data[data.index] < 0.3 && chunk.data[data.index] !== -1) {
            chunk.data[data.index] = 0;
          }
        } else {
          if (chunk.data[data.index] < 1.3 && chunk.data[data.index] !== -1) {
            chunk.data[data.index] -= data.amt;
          }
          if (chunk.data[data.index] > 1.3) {
            chunk.data[data.index] = 1.3;
          }
        }

        bufferNodeUpdate(chunkPos[0], chunkPos[1], data, false);
      }

      socket.on('update_iron_node', update_iron_node);

      function update_iron_node(data) {
        let chunkPos = data.chunkPos.split(',');
        chunkPos[0] = parseInt(chunkPos[0]);
        chunkPos[1] = parseInt(chunkPos[1]);
        let chunk = serverMap.getChunk(chunkPos[0], chunkPos[1]);

        if (data.amt > 0) {
          if (chunk.iron_data[data.index] > 0) chunk.iron_data[data.index] -= data.amt;
          if (chunk.iron_data[data.index] < 0.3 && chunk.iron_data[data.index] !== -1) {
            chunk.iron_data[data.index] = 0;
          }
        } else {
          if (chunk.iron_data[data.index] < 1.3 && chunk.iron_data[data.index] !== -1) {
            chunk.iron_data[data.index] -= data.amt;
          }
          if (chunk.iron_data[data.index] > 1.3) {
            chunk.iron_data[data.index] = 1.3;
          }
        }

        bufferNodeUpdate(chunkPos[0], chunkPos[1], data, true);
      }

      socket.on('update_nodes', update_nodes);

      function update_nodes(data) {
        //console.log("update nodes", data);
        let chunk = serverMap.getChunk(data.cx, data.cy);
        let posX = Math.round(data.pos.x / TILESIZE);
        let posY = Math.round(data.pos.y / TILESIZE);
        posX = posX - data.cx * CHUNKSIZE;
        posY = posY - data.cy * CHUNKSIZE;
        for (let x = posX - data.radius; x <= posX + data.radius; x++) {
          for (let y = posY - data.radius; y <= posY + data.radius; y++) {
            if (x >= 0 && x < CHUNKSIZE && y >= 0 && y < CHUNKSIZE) {
              let index = x + y * CHUNKSIZE;
              if (data.amt > 0) {
                if (chunk.data[index] > 0) chunk.data[index] -= data.amt;
                if (chunk.data[index] < 0.3 && chunk.data[index] !== -1) {
                  chunk.data[index] = 0;
                }
              } else {
                if (chunk.data[index] < 1.3 && chunk.data[index] !== -1) {
                  chunk.data[index] -= data.amt;
                }
                if (chunk.data[index] > 1.3) {
                  chunk.data[index] = 1.3;
                }
              }
            } else {
              //deal with the edge cases where the node is outside the chunk
              let tempChunk;
              let index;
              if (y < 0 && x >= 0 && x < CHUNKSIZE) {
                // top edge
                tempChunk = serverMap.getChunk(data.cx, data.cy - 1);
                index = x + 1 + y * CHUNKSIZE;
              } else if (y >= CHUNKSIZE && x >= 0 && x < CHUNKSIZE) {
                // bottom edge
                tempChunk = serverMap.getChunk(data.cx, data.cy + 1);
                index = x - 1 + (y - CHUNKSIZE) * CHUNKSIZE;
              } else if (x < 0 && y >= 0 && y < CHUNKSIZE) {
                // left edge
                tempChunk = serverMap.getChunk(data.cx - 1, data.cy);
                index = (CHUNKSIZE + x) + y * CHUNKSIZE;
              } else if (x >= CHUNKSIZE && y >= 0 && y < CHUNKSIZE) {
                // right edge
                tempChunk = serverMap.getChunk(data.cx + 1, data.cy);
                index = (x - CHUNKSIZE) + y * CHUNKSIZE;
              } else if (x < 0 && y < 0) {
                // top left corner
                tempChunk = serverMap.getChunk(data.cx - 1, data.cy - 1);
                index = (CHUNKSIZE + x + 1) + (CHUNKSIZE + y) * CHUNKSIZE;
              } else if (x >= CHUNKSIZE && y < 0) {
                // top right corner
                tempChunk = serverMap.getChunk(data.cx + 1, data.cy - 1);
                index = (x - CHUNKSIZE + 1) + (CHUNKSIZE + y) * CHUNKSIZE;
              } else if (x < 0 && y >= CHUNKSIZE) {
                // bottom left corner
                tempChunk = serverMap.getChunk(data.cx - 1, data.cy + 1);
                index = (CHUNKSIZE + x - 1) + (y - CHUNKSIZE) * CHUNKSIZE;
              } else if (x >= CHUNKSIZE && y >= CHUNKSIZE) {
                // bottom right corner
                tempChunk = serverMap.getChunk(data.cx + 1, data.cy + 1);
                index = (x - CHUNKSIZE - 1) + (y - CHUNKSIZE) * CHUNKSIZE;
              }
              if (tempChunk != undefined) {
                if (index != undefined) {
                  if (data.amt > 0) {
                    if (tempChunk.data[index] > 0) tempChunk.data[index] -= data.amt;
                    if (tempChunk.data[index] < 0.3 && tempChunk.data[index] !== -1) {
                      tempChunk.data[index] = 0;
                    }
                  } else {
                    if (tempChunk.data[index] < 1.3 && tempChunk.data[index] !== -1) {
                      tempChunk.data[index] -= data.amt;
                    }
                    if (tempChunk.data[index] > 1.3) {
                      tempChunk.data[index] = 1.3;
                    }
                  }
                }
              }
            }
          }
        }

        emitToRoom(chunkRoom(data.cx, data.cy), 'UPDATE_NODES', data);
      }

      socket.on('update_iron_nodes', update_iron_nodes);

      function update_iron_nodes(data) {
        //console.log("update nodes", data);
        let chunk = serverMap.getChunk(data.cx, data.cy);
        let posX = Math.round(data.pos.x / TILESIZE);
        let posY = Math.round(data.pos.y / TILESIZE);
        posX = posX - data.cx * CHUNKSIZE;
        posY = posY - data.cy * CHUNKSIZE;

        let reward = 0;
        for (let x = posX - data.radius; x <= posX + data.radius; x++) {
          for (let y = posY - data.radius; y <= posY + data.radius; y++) {
            if (x >= 0 && x < CHUNKSIZE && y >= 0 && y < CHUNKSIZE) {
              let index = x + y * CHUNKSIZE;
              if (data.amt > 0) {
                if (chunk.iron_data[index] > 0) {
                  reward += chunk.iron_data[index];
                  chunk.iron_data[index] -= data.amt;
                }
                if (chunk.iron_data[index] < 0.3 && chunk.iron_data[index] !== -1) {
                  chunk.iron_data[index] = 0;
                }
              } else {
                if (chunk.iron_data[index] < 1.3 && chunk.iron_data[index] !== -1) {
                  chunk.iron_data[index] -= data.amt;
                }
                if (chunk.iron_data[index] > 1.3) {
                  chunk.iron_data[index] = 1.3;
                }
              }
            } else {
              //deal with the edge cases where the node is outside the chunk
              let tempChunk;
              let index;
              if (y < 0 && x >= 0 && x < CHUNKSIZE) {
                // top edge
                tempChunk = serverMap.getChunk(data.cx, data.cy - 1);
                index = x + 1 + y * CHUNKSIZE;
              } else if (y >= CHUNKSIZE && x >= 0 && x < CHUNKSIZE) {
                // bottom edge
                tempChunk = serverMap.getChunk(data.cx, data.cy + 1);
                index = x - 1 + (y - CHUNKSIZE) * CHUNKSIZE;
              } else if (x < 0 && y >= 0 && y < CHUNKSIZE) {
                // left edge
                tempChunk = serverMap.getChunk(data.cx - 1, data.cy);
                index = (CHUNKSIZE + x) + y * CHUNKSIZE;
              } else if (x >= CHUNKSIZE && y >= 0 && y < CHUNKSIZE) {
                // right edge
                tempChunk = serverMap.getChunk(data.cx + 1, data.cy);
                index = (x - CHUNKSIZE) + y * CHUNKSIZE;
              } else if (x < 0 && y < 0) {
                // top left corner
                tempChunk = serverMap.getChunk(data.cx - 1, data.cy - 1);
                index = (CHUNKSIZE + x + 1) + (CHUNKSIZE + y) * CHUNKSIZE;
              } else if (x >= CHUNKSIZE && y < 0) {
                // top right corner
                tempChunk = serverMap.getChunk(data.cx + 1, data.cy - 1);
                index = (x - CHUNKSIZE + 1) + (CHUNKSIZE + y) * CHUNKSIZE;
              } else if (x < 0 && y >= CHUNKSIZE) {
                // bottom left corner
                tempChunk = serverMap.getChunk(data.cx - 1, data.cy + 1);
                index = (CHUNKSIZE + x - 1) + (y - CHUNKSIZE) * CHUNKSIZE;
              } else if (x >= CHUNKSIZE && y >= CHUNKSIZE) {
                // bottom right corner
                tempChunk = serverMap.getChunk(data.cx + 1, data.cy + 1);
                index = (x - CHUNKSIZE - 1) + (y - CHUNKSIZE) * CHUNKSIZE;
              }
              if (tempChunk != undefined) {
                if (index != undefined) {
                  if (data.amt > 0) {
                    if (tempChunk.iron_data[index] > 0) {
                      reward += tempChunk.iron_data[index];
                      tempChunk.iron_data[index] -= data.amt;
                    }
                    if (tempChunk.iron_data[index] < 0.3 && tempChunk.iron_data[index] !== -1) {
                      tempChunk.iron_data[index] = 0;
                    }
                  } else {
                    if (tempChunk.iron_data[index] < 1.3 && tempChunk.iron_data[index] !== -1) {
                      tempChunk.iron_data[index] -= data.amt;
                    }
                    if (tempChunk.iron_data[index] > 1.3) {
                      tempChunk.iron_data[index] = 1.3;
                    }
                  }
                }
              }
            }
          }
        }

        if (reward > 0) {
          let itemBag = new Placeable(
            'ItemBag',
            data.pos.x,
            data.pos.y,
            0,
            12 * 3,
            13 * 3,
            1,
            11,
            '',
            '',
          );
          itemBag.type = 'InvObj';
          itemBag.invBlock = { items: {} };
          itemBag.invBlock.invId = Math.random() * 100000;
          itemBag.invBlock.items['Raw Metal'] = {};
          itemBag.invBlock.items['Raw Metal'].amount = Math.round(reward * 0.2) + 1;
          chunk.objects.push(itemBag);
          io.emit('NEW_OBJECT', {
            cx: chunk.cx,
            cy: chunk.cy,
            obj: itemBag,
          });
        }
        emitToRoom(chunkRoom(data.cx, data.cy), 'UPDATE_IRON_NODES', data);
      }

      socket.on('new_object', new_object);

      function new_object(data) {
        let chunk = serverMap.getChunk(data.cx, data.cy);
        chunk.objects.push(data.obj);

        socket.broadcast.emit('NEW_OBJECT', data);
      }

      socket.on('delete_obj', delete_obj);

      function delete_obj(data) {
        //console.log(data);
        let chunk = serverMap.getChunk(data.cx, data.cy);
        for (let i = chunk.objects.length - 1; i >= 0; i--) {
          if (data.objName == 'ExpOrb') {
            if (data.z == chunk.objects[i].z && data.id == chunk.objects[i].id) {
              io.emit('DELETE_OBJ', data);
              chunk.objects.splice(i, 1);
              spawnItemBag(chunk, data);
            }
          } else if (data.brainID != undefined) {
            if (data.z == chunk.objects[i].z && data.brainID == chunk.objects[i].brainID) {
              io.emit('DELETE_OBJ', data);
              chunk.objects.splice(i, 1);
              spawnItemBag(chunk, data);
            }
          } else {
            if (
              data.pos.x == chunk.objects[i].pos.x &&
              data.pos.y == chunk.objects[i].pos.y &&
              data.z == chunk.objects[i].z &&
              data.objName == chunk.objects[i].objName
            ) {
              io.emit('DELETE_OBJ', data);
              chunk.objects.splice(i, 1);
              spawnItemBag(chunk, data);
            }
          }
        }
      }

      function spawnItemBag(chunk, data) {
        if (data.cost != undefined) {
          if (data.cost.length > 0) {
            let itemBag = new Placeable(
              'ItemBag',
              data.pos.x,
              data.pos.y,
              0,
              12 * 3,
              13 * 3,
              1,
              11,
              '',
              '',
            );
            itemBag.type = 'InvObj';
            itemBag.invBlock = { items: {} };
            itemBag.invBlock.invId = Math.random() * 100000;
            for (let i = 0; i < data.cost.length; i++) {
              if (data.cost[i][0] == 'dirt') {
              } else {
                if (data.cost[i][1] >= 1) {
                  itemBag.invBlock.items[data.cost[i][0]] = {};
                  itemBag.invBlock.items[data.cost[i][0]].amount = Math.round(
                    data.cost[i][1] * (Math.random() * 0.4 + 0.5),
                  );
                } else {
                  if (Math.random() < data.cost[i][1]) {
                    itemBag.invBlock.items[data.cost[i][0]] = {};
                    itemBag.invBlock.items[data.cost[i][0]].amount = 1;
                  }
                }
              }
            }
            chunk.objects.push(itemBag);
            io.emit('NEW_OBJECT', {
              cx: chunk.cx,
              cy: chunk.cy,
              obj: itemBag,
            });
          }
        }

        mergeAllChunkBags(BAG_MERGE_BUDGET);
      }

      socket.on('update_obj', update_obj);

      function update_obj(data) {
        let chunk = serverMap.getChunk(data.cx, data.cy);
        for (let i = chunk.objects.length - 1; i >= 0; i--) {
          if (data.objName == 'ExpOrb') {
            if (data.z == chunk.objects[i].z && data.id == chunk.objects[i].id) {
              chunk.objects[i][data.update_name] = data.update_value;
              chunk.objects[i].pos.x = data.pos.x;
              chunk.objects[i].pos.y = data.pos.y;
              socket.broadcast.emit('UPDATE_OBJ', data);
            }
          } else if (data.brainID != undefined) {
            //console.log(data);
            if (data.z == chunk.objects[i].z && data.brainID == chunk.objects[i].brainID) {
              chunk.objects[i][data.update_name] = data.update_value;
              chunk.objects[i].pos.x = data.pos.x;
              chunk.objects[i].pos.y = data.pos.y;
              //socket.broadcast.emit("UPDATE_OBJ", data);
            }
          } else {
            if (
              data.pos.x == chunk.objects[i].pos.x &&
              data.pos.y == chunk.objects[i].pos.y &&
              data.z == chunk.objects[i].z &&
              data.objName == chunk.objects[i].objName
            ) {
              chunk.objects[i][data.update_name] = data.update_value;
              socket.broadcast.emit('UPDATE_OBJ', data);
            }
          }
        }
      }

      socket.on('update_inv', update_inv);

      function sanitizeItems(items) {
        const cleaned = {};
        if (!items || typeof items !== 'object') return cleaned;
        for (const k of Object.keys(items)) {
          const v = items[k];
          const amt = v && typeof v.amount === 'number' ? v.amount : Number(v?.amount);
          if (Number.isFinite(amt) && amt > 0) cleaned[k] = { amount: Math.floor(amt) };
        }
        return cleaned;
      }

      function update_inv(data) {
        const chunk = serverMap.getChunk(data.cx, data.cy);
        if (!chunk || !Array.isArray(chunk.objects)) return;

        for (let i = chunk.objects.length - 1; i >= 0; i--) {
          const obj = chunk.objects[i];
          const idMatch =
            obj.invBlock && data.invId !== undefined && obj.invBlock.invId === data.invId;
          const posMatch =
            data.pos.x === obj.pos.x &&
            data.pos.y === obj.pos.y &&
            data.z === obj.z &&
            data.objName === obj.objName;

          const hasInventory = obj && (obj.invBlock || obj.objName === 'Chest' || obj.objName === 'ItemBag');

          if (hasInventory && (idMatch || posMatch)) {
            obj.invBlock = obj.invBlock || { items: {} };
            obj.invBlock.items = sanitizeItems(data.items);
            if (typeof obj.invBlock.invId !== 'number' && typeof data.invId === 'number') {
              obj.invBlock.invId = data.invId;
            }
            const payload = {
              cx: data.cx,
              cy: data.cy,
              objName: data.objName,
              pos: data.pos,
              z: data.z,
              invId: obj.invBlock.invId,
              items: obj.invBlock.items,
            };
            io.emit('UPDATE_INV', payload); // send to everyone, including sender
            break;
          }
        }
      }

      socket.on('new_proj', new_projectile);

      function new_projectile(data) {
        // add projectiles to server map
        // Compute cPos if missing
        if (!data.cPos) {
          const TILESIZE = serverMap.TILESIZE || 40;
          const CHUNKSIZE = serverMap.CHUNKSIZE || 32;
          const cx = Math.floor(data.x / (TILESIZE * CHUNKSIZE));
          const cy = Math.floor(data.y / (TILESIZE * CHUNKSIZE));
          data.cPos = { x: cx, y: cy };
        }
        let chunk = serverMap.getChunk(data.cPos.x, data.cPos.y);
        if (chunk) {
          chunk.projectiles.push(data);
        }
        emitToAll('NEW_PROJECTILE', data, socket.id);
      }

      socket.on('delete_proj', delete_projectile);

      function delete_projectile(data) {
        // Compute cPos if missing
        if (!data.cPos) {
          const TILESIZE = serverMap.TILESIZE || 40;
          const CHUNKSIZE = serverMap.CHUNKSIZE || 32;
          const cx = Math.floor(data.x / (TILESIZE * CHUNKSIZE));
          const cy = Math.floor(data.y / (TILESIZE * CHUNKSIZE));
          data.cPos = { x: cx, y: cy };
        }
        let chunk = serverMap.getChunk(data.cPos.x, data.cPos.y);
        if (!chunk) return;
        for (let i = chunk.projectiles.length - 1; i >= 0; i--) {
          // Match by ID - most reliable identifier
          if (data.id == chunk.projectiles[i].id) {
            chunk.projectiles.splice(i, 1);
            emitToAll('DELETE_PROJ', data, socket.id);
            break; // Exit after first match since IDs are unique
          }
        }
      }

      socket.on('new_sound', new_sound);

      function new_sound(data) {
        //add sounds to server map
        let chunk = serverMap.getChunk(data.cPos.x, data.cPos.y);
        chunk.soundObjs.push(data);
        emitToAll('NEW_SOUND', data, socket.id);
      }

      socket.on('delete_sound', delete_sound);

      function delete_sound(data) {
        let chunk = serverMap.getChunk(data.cPos.x, data.cPos.y);
        for (let i = chunk.soundObjs.length - 1; i >= 0; i--) {
          if (
            data.id == chunk.soundObjs[i].id &&
            data.lifeSpan == chunk.soundObjs[i].lifeSpan &&
            data.pos.x == chunk.soundObjs[i].pos.x &&
            data.pos.y == chunk.soundObjs[i].pos.y
          ) {
            chunk.soundObjs.splice(i, 1);
          }
        }
      }

      socket.on('wander_request', wander_request);

      function wander_request(data) {
        for (let i = 0; i < serverMap.brains.length; i++) {
          if (data.id == serverMap.brains[i].id) {
            let angle = Math.random() * 2 * Math.PI;
            let target = {
              x: data.pos.x + Math.cos(angle) * 100,
              y: data.pos.y + Math.sin(angle) * 100,
            };

            emitToAll('WANDER_TARGET', { id: data.id, target: target });
            serverMap.brains[i].target = target;

            i = serverMap.brains.length;
          }
        }
      }

      socket.on('get_chunk', get_chunk);

      function get_chunk(data) {
        let pos = data.split(',');
        pos[0] = parseInt(pos[0]);
        pos[1] = parseInt(pos[1]);
        socket.join(chunkRoom(pos[0], pos[1]));
        let chunk = serverMap.getChunk(pos[0], pos[1]);
        let tempData = {};
        for (let x = 0; x < CHUNKSIZE; x++) {
          for (let y = 0; y < CHUNKSIZE; y++) {
            tempData[x + y * CHUNKSIZE] = chunk.data[x + y * CHUNKSIZE];
          }
        }
        let tempData2 = {};
        for (let x = 0; x < CHUNKSIZE; x++) {
          for (let y = 0; y < CHUNKSIZE; y++) {
            tempData2[x + y * CHUNKSIZE] = chunk.iron_data[x + y * CHUNKSIZE];
          }
        }
        io.to(socket.id).emit('GIVE_CHUNK', {
          x: pos[0],
          y: pos[1],
          data: tempData,
          iron_data: tempData2,
          objects: chunk.objects,
          projectiles: chunk.projectiles,
        });
      }

      socket.on('get_portals', get_portals);

      function get_portals(data) {
        let portals = [];
        for (let y = data.cPos.y - 5; y <= data.cPos.y + 5; y++) {
          for (let x = data.cPos.x - 5; x <= data.cPos.x + 5; x++) {
            if (serverMap.chunks['' + x + ',' + y] != undefined) {
              let chunk = serverMap.chunks['' + x + ',' + y];
              for (let i = 0; i < chunk.objects.length; i++) {
                if (chunk.objects[i].objName == 'Portal') {
                  portals.push({
                    cx: x,
                    cy: y,
                    pos: chunk.objects[i].pos,
                    color: chunk.objects[i].color,
                  });
                }
              }
            }
          }
        }
        io.to(socket.id).emit('GIVE_PORTALS', { portals: portals });
      }

      socket.on('send_message', send_message);
      socket.on('entity_chat', entity_chat);

      function broadcastChat(chatMsg, speakingRangeOverride) {
        if (!chatMsg || typeof chatMsg.message !== 'string') return;

        // Basic sanitization and fallback values
        const message = chatMsg.message.trim();
        if (!message) return;

        const cleanMsg = {
          user: chatMsg.user || 'Entity',
          message: badWordRegex.test(message) ? 'I curse at you !!!' : message,
          x: Number.isFinite(chatMsg.x) ? chatMsg.x : 0,
          y: Number.isFinite(chatMsg.y) ? chatMsg.y : 0,
          time: chatMsg.time || new Date().toISOString(),
        };

        const speakerRange = Number.isFinite(speakingRangeOverride)
          ? speakingRangeOverride
          : players[socket.id]?.statBlock?.stats?.speakingRange || 1;

        for (let id in players) {
          if (!Object.prototype.hasOwnProperty.call(players, id)) continue;
          const player = players[id];
          if (!player || !player.pos || typeof player.statBlock?.stats?.hearing !== 'number') continue;

          const dx = player.pos.x - cleanMsg.x;
          const dy = player.pos.y - cleanMsg.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance <= 5000 + player.statBlock.stats.hearing * 20 * speakerRange) {
            io.to(id).emit('NEW_CHAT_MESSAGE', cleanMsg);
          }
        }
      }

      function send_message(data) {
        let parts = data.split(',');
        let x = parseFloat(parts[0]);
        let y = parseFloat(parts[1]);
        let message = parts.slice(2).join(','); // Handles commas in the message

        let user =
          players[socket.id] && players[socket.id].name ? players[socket.id].name : socket.id;

        let chatMsg = { message, x, y, user };

        broadcastChat(chatMsg, players[socket.id]?.statBlock?.stats?.speakingRange);
      }

      function entity_chat(data) {
        if (!data) return;
        const msg = typeof data.message === 'string' ? data.message : '';
        if (!msg.trim()) return;

        const chatMsg = {
          message: msg,
          x: Number.isFinite(data.pos?.x) ? data.pos.x : 0,
          y: Number.isFinite(data.pos?.y) ? data.pos.y : 0,
          user: typeof data.user === 'string' && data.user.trim() ? data.user.trim() : 'Entity',
          time: data.time,
        };

        const speakingRange = Number.isFinite(data.speakingRange) ? data.speakingRange : 1;
        broadcastChat(chatMsg, speakingRange);
      }

      //death sockets Player_Dies
      socket.on('player_dies', (data) => {
        //console.log(data);
        const { x, y, id, attacker, name } = data;
        //console.log("die mentions",x,y,id,attacker,name);
        // Mark the player as dead in the server-side state (optional, depends on your logic)
        if (players[id]) {
          players[id].isDead = true; // or players[id].status = "dead", etc.
          players[id].deaths += 1;

          // Permadeath: remove player from persistent world data if enabled
          if (PERMA_DEATH_ENABLED) {
            const removed = deletePlayerSnapshotByName(players[id].name);
            if (removed) {
              try { logger.info('Permadeath: player removed from persistence', { name: players[id].name }); } catch {}
            }
            // Notify the victim client that this is a permadeath
            socket.emit('PERMA_DEATH', { hardcore: true });
          }
        }
        // Notify all players within range of the death
        for (let pid in players) {
          if (players.hasOwnProperty(pid)) {
            let player = players[pid];
            if (player.name == attacker) {
              player.kills += 1;
              //console.log(player.name, player.kills)
            }
            if (player && player.pos && typeof player.statBlock.stats.hearing === 'number') {
              let dx = player.pos.x - x;
              let dy = player.pos.y - y;
              let distance = Math.sqrt(dx * dx + dy * dy);
              //console.log(distance)
              if (distance <= 1115000 + player.statBlock.stats.hearing * 20) {
                //console.log(name + " Has been killed by " + attacker , x,y )

                //console.log(player.name, player.kills)

                io.to(pid).emit('NEW_CHAT_MESSAGE', {
                  message: name + ' Has been killed by ' + attacker,
                  x,
                  y,
                  user: 'SERVER',
                });
              } else {
                //console.log("s2")
              }
            }
          } else {
            //console.log("????")
          }
        }

        // Instruct all clients to update the player’s render status
        io.emit('PLAYER_MARKED_DEAD', { id });
      });
    } catch (e) {
      console.log(e);
    }
  }

let resetCalled = false;
setInterval(() => {
  // If timer is disabled, skip time-related broadcasting entirely
  if (TIMER_DISABLED) {
    return;
  }

  // Recompute countdown from end timestamp to reduce drift
  if (timerEndAt) {
    countdown = Math.max(0, Math.round((timerEndAt - Date.now()) / 1000));
  }
  // Health/Mana regeneration for all players every 3 seconds
  if (countdown % 3 === 0) {
    Object.keys(players).forEach(id => {
      const p = players[id];
      if (!p || !p.statBlock || !p.statBlock.stats) return;
      
      const stats = p.statBlock.stats;
      let updated = false;
      const updateNames = [];
      const updateValues = [];
      
      // HP Regen
      if (stats.hp < stats.mhp && stats.healthRegen > 0) {
        stats.hp = Math.min(stats.hp + stats.healthRegen, stats.mhp);
        updateNames.push('stats.hp');
        updateValues.push(stats.hp);
        updated = true;
      }
      
      // MP Regen
      if (stats.mp < stats.mmp && stats.magic > 0) {
        const mpRegen = stats.magic * 0.1; // 10% of magic stat
        stats.mp = Math.min(stats.mp + mpRegen, stats.mmp);
        updateNames.push('stats.mp');
        updateValues.push(stats.mp);
        updated = true;
      }
      
      // Broadcast update to all clients via UDP when available
      if (updated) {
        const coords = chunkCoordsFromPos(p.pos);
        const payload = {
          id: id,
          pos: normalizePos(p.pos),
          holding: cloneHolding(p.holding),
          update_names: updateNames,
          update_values: updateValues
        };
        if (coords) {
          emitToRoom(chunkRoom(coords.cx, coords.cy), 'UPDATE_PLAYER', payload);
        } else {
          emitToAll('UPDATE_PLAYER', payload);
        }
      }
    });
  }

  // Broadcast every minute
  if (countdown % 30 === 0 || countdown <= 15 / 2) {
    //console.log("heal plants");
    //get the keys of the serverMap chunks
    let keys = Object.keys(serverMap.chunks);
    const healedRooms = new Set();
    // Loop through each chunk
    for (let i = 0; i < keys.length; i++) {
      let chunk = serverMap.chunks[keys[i]];
      // Loop through each tile in the chunk
      for (let j = 0; j < chunk.objects.length; j++) {
        if (
          chunk.objects[j].type == 'Plant' ||
          chunk.objects[j].objName == 'Tree' ||
          chunk.objects[j].objName == 'AppleTree'
        ) {
          if (chunk.objects[j].hp < chunk.objects[j].mhp) {
            chunk.objects[j].hp += 5; // Heal the plant by 0.1 HP
            if (chunk.objects[j].hp > chunk.objects[j].mhp) {
              chunk.objects[j].hp = chunk.objects[j].mhp; // Cap the HP at max HP
            }
            healedRooms.add(chunkRoom(chunk.cx, chunk.cy));
          }
        }
      }
    }
    for (const room of healedRooms) {
      emitToRoom(room, 'HEAL_PLANTS', {});
    }
  }

  // Grant XP to all entities every minute
  if (countdown % 60 === 0) {
    let keys = Object.keys(serverMap.chunks);
    for (let i = 0; i < keys.length; i++) {
      let chunk = serverMap.chunks[keys[i]];
      for (let j = 0; j < chunk.objects.length; j++) {
        let obj = chunk.objects[j];
        // Check if it's an entity (has brainID)
        if (obj.brainID !== undefined && obj.level !== undefined) {
          obj.xp += 10; // Grant 10 XP per minute
          
          // Level up if needed
          while (obj.xp >= obj.xpNeeded) {
            obj.level++;
            obj.xp = 0;
            obj.xpNeeded = Math.floor(obj.xpNeeded * 1.5);
            
            // Increase stats on level up
            obj.hp += 10;
            obj.mhp += 10;
          }
          
          // Broadcast entity level update via UDP when available
          const levelPayload = {
            cx: chunk.cx,
            cy: chunk.cy,
            objPos: obj.pos,
            level: obj.level,
            xp: obj.xp,
            hp: obj.hp,
            mhp: obj.mhp
          };
          emitToRoom(chunkRoom(chunk.cx, chunk.cy), 'ENTITY_LEVEL_UPDATE', levelPayload);
        }
      }
    }
  }

  // Broadcast timer more frequently near end for sync
  if (countdown % 5 === 0 || countdown <= 15) {
    const timeData = {
      totalSeconds: countdown,
      endsAt: timerEndAt,
    };
    emitToAll('sync_time', timeData);
  }

  // Capture a pre-restart snapshot a few seconds before shutdown so clients have data
  if (countdown === 5 && !preRestartSaved) {
    const preSummary = refreshSummaryCache();
    preRestartSaved = true;
    io.emit('SERVER_SUMMARY', preSummary);
  }

  // At 1 minute left
  if (countdown === 60) {
    io.emit('NEW_CHAT_MESSAGE', {
      message: '⚠️ One minute left!',
      x: 0,
      y: 0,
      user: 'TIMER',
    });
  }

  // When timer hits 0, reset
  if (countdown <= 0) {
    if (!resetCalled) {
      // Emit final snapshot so clients can show end-of-round state
      const finalSummary = refreshSummaryCache();
      io.emit('ROUND_END_STATE', {
        players: finalSummary.players,
        teams: finalSummary.teams,
        endedAt: finalSummary.updatedAt,
      });

      io.emit('server_ended');
      resetCalled = true;

      // Clear persisted world and player snapshots so next round starts fresh
      clearState();

      // Drop in-memory player data and stats
      Object.keys(players).forEach((id) => delete players[id]);
      savedPlayersByName = {};
      kills_deaths = {};
      chatMessages.length = 0;
      Object.keys(teams).forEach((id) => delete teams[id]);

      // Start a fresh map and reset round timer if applicable
      serverMap = new GameMap(Math.random());
      countdown = 15 * 60;
      timerEndAt = Date.now() + countdown * 1000;

      // Reset pre-restart snapshot flag for the next round
      preRestartSaved = false;

      // Allow future resets if restart is suppressed
      resetCalled = false;

      if (RESTART_ON_TIMER) {
        exec('pm2 restart holes-server', (err, stdout, stderr) => {
          if (err) {
            console.error(`Restart error: ${err.message}`);
            return;
          }
          console.log(`Server restart stdout: ${stdout}`);
          if (stderr) console.error(`Server restart stderr: ${stderr}`);
        });
      } else {
        console.log('Timer ended — restart suppressed by RESTART_ON_TIMER=false');
      }
    }
  } else {
    countdown--;
  }
}, 1000); // Runs every second

function ensureItemBagSchema(bag) {
  if (!bag) return null;
  if (bag.objName !== 'ItemBag') return null; // Only normalize loot bags
  // It must be an inventory object with a position
  if (bag.type !== 'InvObj') bag.type = 'InvObj';
  if (!bag.objName) bag.objName = 'ItemBag';
  if (!bag.pos || typeof bag.pos.x !== 'number' || typeof bag.pos.y !== 'number') {
    // Can't safely keep a bag without coordinates
    return null;
  }
  if (typeof bag.z !== 'number') bag.z = 0;

  // Ensure inventory block + id + items shape
  if (!bag.invBlock || typeof bag.invBlock !== 'object') bag.invBlock = {};
  if (!bag.invBlock.items || typeof bag.invBlock.items !== 'object') bag.invBlock.items = {};
  if (typeof bag.invBlock.invId !== 'number') {
    // Keep an existing id if present (even as string); otherwise create one
    const existing = bag.invBlock.invId;
    bag.invBlock.invId = typeof existing === 'number' ? existing : Math.floor(Math.random() * 1e9);
  }

  // Sanitize items: numbers only, drop empties / NaN / <=0
  for (const k of Object.keys(bag.invBlock.items)) {
    const v = bag.invBlock.items[k];
    const amt = v && typeof v.amount === 'number' ? v.amount : Number(v?.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      delete bag.invBlock.items[k];
    } else {
      bag.invBlock.items[k] = { amount: Math.floor(amt) };
    }
  }

  return bag;
}

function mergeAllChunkBags(maxMerges = Infinity) {
  // Only merge when bags are extremely close (about 1.5 tiles)
  const MERGE_DISTANCE = TILESIZE * 5.5;
  const CELL = MERGE_DISTANCE; // spatial hash cell size
  let mergesLeft = maxMerges;

  outer: for (const key in serverMap.chunks) {
    const chunk = serverMap.chunks[key];
    if (!chunk || !Array.isArray(chunk.objects) || chunk.objects.length < 2) continue;

    const roomCx = typeof chunk.cx === 'number' ? chunk.cx : parseInt(key.split(',')[0], 10);
    const roomCy = typeof chunk.cy === 'number' ? chunk.cy : parseInt(key.split(',')[1], 10);
    const room = chunkRoom(roomCx, roomCy);

    // Normalize and collect bags
    const bags = [];
    for (let idx = 0; idx < chunk.objects.length; idx++) {
      let bag = chunk.objects[idx];
      if (!bag || bag.type !== 'InvObj' || bag.objName !== 'ItemBag') continue;
      bag = ensureItemBagSchema(bag);
      if (!bag) {
        const removed = chunk.objects.splice(idx, 1)[0];
        io.to(room).emit('DELETE_OBJ', {
          cx: roomCx,
          cy: roomCy,
          objName: removed?.objName || 'ItemBag',
          pos: removed?.pos || { x: 0, y: 0 },
          z: removed?.z ?? 0,
        });
        idx--;
        continue;
      }
      chunk.objects[idx] = bag;
      bags.push({ bag, idx });
    }

    if (bags.length < 2) continue;

    const cellKey = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
    const cellMap = new Map();
    for (const entry of bags) {
      const key = cellKey(entry.bag.pos.x, entry.bag.pos.y);
      const list = cellMap.get(key) || [];
      list.push(entry);
      cellMap.set(key, list);
    }

    const toRemove = new Set();
    const dirtyBags = new Set();

    for (const entry of bags) {
      if (mergesLeft <= 0) break outer;
      if (toRemove.has(entry.idx)) continue;
      const a = entry.bag;
      const baseCellX = Math.floor(a.pos.x / CELL);
      const baseCellY = Math.floor(a.pos.y / CELL);

      for (let dx = -1; dx <= 1 && mergesLeft > 0; dx++) {
        for (let dy = -1; dy <= 1 && mergesLeft > 0; dy++) {
          const list = cellMap.get(`${baseCellX + dx},${baseCellY + dy}`);
          if (!list) continue;
          for (const other of list) {
            if (other.idx === entry.idx || toRemove.has(other.idx) || mergesLeft <= 0) continue;
            const b = other.bag;
            const dist = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
            if (dist > MERGE_DISTANCE) continue;

            for (const item of Object.keys(b.invBlock.items)) {
              const bAmt = b.invBlock.items[item]?.amount || 0;
              if (!a.invBlock.items[item]) a.invBlock.items[item] = { amount: 0 };
              a.invBlock.items[item].amount += bAmt;
            }

            for (const k of Object.keys(a.invBlock.items)) {
              if (!Number.isFinite(a.invBlock.items[k].amount) || a.invBlock.items[k].amount <= 0) {
                delete a.invBlock.items[k];
              } else {
                a.invBlock.items[k].amount = Math.floor(a.invBlock.items[k].amount);
              }
            }

            toRemove.add(other.idx);
            dirtyBags.add(entry.idx);
            mergesLeft--;
            if (mergesLeft <= 0) break;
          }
        }
      }
    }

    if (toRemove.size) {
      // Remove merged bags from chunk objects (highest index first)
      const sorted = Array.from(toRemove).sort((a, b) => b - a);
      for (const idx of sorted) {
        const removed = chunk.objects.splice(idx, 1)[0];
        io.to(room).emit('DELETE_OBJ', {
          cx: roomCx,
          cy: roomCy,
          objName: removed?.objName || 'ItemBag',
          pos: removed?.pos || { x: 0, y: 0 },
          z: removed?.z ?? 0,
        });
      }
    }

    // Emit updates for bags that received merges
    for (const idx of dirtyBags) {
      const bag = chunk.objects[idx];
      if (!bag) continue;
      io.to(room).emit('UPDATE_INV', {
        cx: roomCx,
        cy: roomCy,
        objName: bag.objName,
        pos: { x: bag.pos.x, y: bag.pos.y },
        z: bag.z,
        items: bag.invBlock.items,
      });
    }
  }
}

setInterval(() => {
  mergeAllChunkBags(BAG_MERGE_BUDGET);
}, BAG_MERGE_INTERVAL_MS);

