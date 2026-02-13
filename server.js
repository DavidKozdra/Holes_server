// ═══════════════════════════════════════════════════════════
// Holes Server — Main Orchestrator
// ═══════════════════════════════════════════════════════════
const express = require('express');
const socket = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

// ── Config & Utilities ──
const config = require('./utils/gameConfig');
const { getGlobals } = require('./globals');
const { loadState, clearState } = require('./utils/persistence');
const { logger, DATA_DIR } = require('./utils/logger');
const { Map: GameMap, Chunk, TILESIZE, CHUNKSIZE } = require('./utils/map');
const udp = require('./utils/udpTransport');

// ── Extracted Modules ──
const broadcast = require('./utils/broadcastHelpers');
const { socketChunkRooms, chunkRoom, chunkCoordsFromPos } = require('./utils/chunkRooms');
const nodeBuffer = require('./utils/nodeBuffer');
const {
  getSavedPlayers, setSavedPlayers,
  snapshotPlayersForBroadcast, sanitizePlayerForClient,
  queueWorldSave, savePlayerSnapshot,
} = require('./utils/playerUtils');
const { mergeAllChunkBags } = require('./utils/itemBags');

// ── Handlers ──
const connectionHandlers = require('./handlers/connectionHandlers');
const playerStateHandlers = require('./handlers/playerStateHandlers');
const teamHandlers = require('./handlers/teamHandlers');
const terrainHandlers = require('./handlers/terrainHandlers');
const objectHandlers = require('./handlers/objectHandlers');
const chatHandlers = require('./handlers/chatHandlers');
const combatHandlers = require('./handlers/combatHandlers');
const { buildUdpHandlers } = require('./handlers/udpHandlers');
const { startGameLoop } = require('./utils/gameLoop');

// ═══════════════════════════════════════════════════════════
// SHARED STATE
// ═══════════════════════════════════════════════════════════
const globals = getGlobals();
let { players, serverMap, chatMessages, teams } = globals;

// ═══════════════════════════════════════════════════════════
// CLI UTILITIES
// ═══════════════════════════════════════════════════════════
(function cliUtils() {
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

// ═══════════════════════════════════════════════════════════
// TIMER INIT
// ═══════════════════════════════════════════════════════════
let countdown;
let timerEndAt = null;
if (config.TIMER_DISABLED) {
  countdown = 0;
  timerEndAt = null;
} else {
  const parsed = Number(config.SERVER_TIME_ENV);
  countdown = Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 60 * 24 * 10000;
  timerEndAt = Date.now() + countdown * 1000;
}
console.log(config.TIMER_DISABLED ? 'Timer disabled' : `COUNT: ${countdown}`);

// ═══════════════════════════════════════════════════════════
// EXPRESS APP
// ═══════════════════════════════════════════════════════════
const allRoutes = require('./api/routes/Routes');
const app = express();

app.set('trust proxy', 3);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(express.json({ limit: '50kb' }));
app.use(cors({
  origin: config.CORS_ORIGINS,
  methods: ['GET', 'POST'],
  credentials: true,
}));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api', apiLimiter);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    players: Object.keys(players).length,
    maxPlayers: config.MAX_PLAYERS,
    timestamp: Date.now(),
  });
});

// Static files
app.use(express.static(path.join(__dirname, '../Holes_Client'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
}));

// Start server
const server = app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`Server is running on http://localhost:${config.PORT}`);
  try { logger.info('Server started', { port: config.PORT }); } catch {}
});

// ═══════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════
const io = socket(server, {
  cors: {
    origin: config.CORS_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 30000,
  pingInterval: 10000,
});

// ── Initialize broadcast helpers ──
broadcast.init(io);
nodeBuffer.init(broadcast.emitToRoom);

// ── Helper: get current serverMap (may change on round reset) ──
function getServerMap() {
  return globals.serverMap;
}

// ── Shared handler context ──
function makeCtx() {
  return {
    io,
    players,
    teams,
    globals,
    broadcast,
    getServerMap,
    udpReady: broadcast.isUdpReady(),
    countdown,
    timerEndAt,
    TIMER_DISABLED: config.TIMER_DISABLED,
  };
}

// ── Periodic PLAYERS_SYNC ──
setInterval(() => {
  const ids = Object.keys(players);
  if (ids.length === 0) return;
  broadcast.emitToAll('PLAYERS_SYNC', { players: snapshotPlayersForBroadcast(players) });
}, 5000);

// ── Socket.IO connection handler ──
io.sockets.on('connection', (sock) => {
  try {
    const ctx = makeCtx();
    const ok = connectionHandlers.register(sock, ctx);
    if (ok === false) return; // server full, socket was rejected
    playerStateHandlers.register(sock, ctx);
    teamHandlers.register(sock, ctx);
    terrainHandlers.register(sock, ctx);
    objectHandlers.register(sock, ctx);
    chatHandlers.register(sock, ctx);
    combatHandlers.register(sock, ctx);
  } catch (e) {
    console.log(e);
  }
});

// ═══════════════════════════════════════════════════════════
// UDP TRANSPORT
// ═══════════════════════════════════════════════════════════
(async function startUdp() {
  const udpClientHandlers = buildUdpHandlers(makeCtx());
  const ok = await udp.initUdpTransport(server, (socketId, channel) => {
    io.to(socketId).emit('UDP_CONNECTED', { ok: true });
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
    broadcast.setUdpReady(true);
    console.log('[Server] UDP transport ready — high-frequency events will use WebRTC DataChannels');
  } else {
    console.warn('[Server] UDP transport failed to init — all traffic will use Socket.IO (TCP)');
  }
})();

// ── API routes ──
app.use(allRoutes);

// ═══════════════════════════════════════════════════════════
// BOOTSTRAP: LOAD WORLD STATE
// ═══════════════════════════════════════════════════════════
(function bootstrapLoad() {
  try {
    const loaded = loadState();
    if (loaded && loaded.serverMap) {
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

      teams = loaded.teams || teams;
      setSavedPlayers(loaded.playersSnapshot || {});

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

// ═══════════════════════════════════════════════════════════
// PERIODIC TASKS
// ═══════════════════════════════════════════════════════════

// Autosave
setInterval(() => {
  queueWorldSave('autosave').then((ok) => {
    if (ok !== false) console.log('[Persistence] Autosaved world state');
  });
}, Math.max(0.1, config.SAVE_INTERVAL_HOURS) * 60 * 60 * 1000);

// Summary cache
function refreshSummaryCache() {
  const snap = { teams, updatedAt: Date.now() };
  globals.summaryCache = snap;
  globals.playerSnapshotCache = snap.players || {};
  return snap;
}
setInterval(refreshSummaryCache, Math.max(5000, config.SUMMARY_INTERVAL_MS));
refreshSummaryCache();

// Chunk eviction & stale data pruning
setInterval(() => {
  const playerPositions = [];
  for (const id of Object.keys(players)) {
    const p = players[id];
    if (p && p.pos && Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y)) {
      playerPositions.push({
        cx: Math.floor(p.pos.x / (TILESIZE * CHUNKSIZE)),
        cy: Math.floor(p.pos.y / (TILESIZE * CHUNKSIZE)),
      });
    }
  }

  const currentServerMap = getServerMap();
  const chunkKeys = Object.keys(currentServerMap.chunks || {});
  let evictedCount = 0;
  for (let i = 0; i < chunkKeys.length; i++) {
    const chunk = currentServerMap.chunks[chunkKeys[i]];
    if (!chunk) continue;
    let isNearby = false;
    for (let j = 0; j < playerPositions.length; j++) {
      const dx = Math.abs(chunk.cx - playerPositions[j].cx);
      const dy = Math.abs(chunk.cy - playerPositions[j].cy);
      if (dx <= config.CHUNK_KEEP_RADIUS && dy <= config.CHUNK_KEEP_RADIUS) {
        isNearby = true;
        break;
      }
    }
    if (!isNearby && (!chunk.objects || chunk.objects.length === 0)) {
      delete currentServerMap.chunks[chunkKeys[i]];
      evictedCount++;
    }
  }
  if (evictedCount > 0) {
    console.log(`[Memory] Evicted ${evictedCount} empty chunks far from players`);
  }

  // Prune stale kills_deaths
  const connectedIds = new Set(Object.keys(players));
  const kills_deaths = connectionHandlers.getKillsDeaths();
  for (const id of Object.keys(kills_deaths)) {
    if (!connectedIds.has(id)) delete kills_deaths[id];
  }
}, config.CHUNK_EVICTION_INTERVAL_MS);

// Item bag merging
setInterval(() => {
  mergeAllChunkBags(getServerMap(), io, config.BAG_MERGE_BUDGET);
}, config.BAG_MERGE_INTERVAL_MS);

// ═══════════════════════════════════════════════════════════
// GAME LOOP (1-second tick)
// ═══════════════════════════════════════════════════════════
startGameLoop({
  globals,
  broadcast,
  timer: { countdown, timerEndAt },
});

// ═══════════════════════════════════════════════════════════
// CRASH HANDLERS & GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  try { logger.error('Uncaught exception', { message: err.message, stack: err.stack }); } catch {}
  queueWorldSave('uncaught-exception').catch(() => {}).finally(() => {
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
  try { logger.error('Unhandled rejection', { message: String(reason), stack: reason?.stack }); } catch {}
});

let isShuttingDown = false;
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Persistence] Received ${sig}, saving world state...`);
    try {
      await queueWorldSave('graceful-shutdown');
      console.log('[Persistence] Save complete. Exiting.');
    } catch (e) {
      console.error('[Persistence] Save failed during shutdown:', e);
    }
    process.exit(0);
  });
});

