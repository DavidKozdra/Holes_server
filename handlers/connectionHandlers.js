const { hashPassword, verifyPassword } = require('../utils/auth');
const { MAX_PLAYERS, BAD_WORD_REGEX, SERVER_WELCOME_NEW, SERVER_WELCOME_RETURNING } = require('../utils/gameConfig');
const { chunkCoordsFromPos, isValidPos, moveSocketToChunkRoom, socketChunkRooms } = require('../utils/chunkRooms');
const { sanitizePlayerForClient, ensureCompleteStats, snapshotPlayersForBroadcast, savePlayerSnapshot, deletePlayerSnapshotByName, getSavedPlayers, queueWorldSave } = require('../utils/playerUtils');
const { PERMA_DEATH_ENABLED } = require('../utils/gameConfig');
const { logger } = require('../utils/logger');
const udp = require('../utils/udpTransport');

let kills_deaths = {};

function getKillsDeaths() { return kills_deaths; }
function setKillsDeaths(kd) { kills_deaths = kd; }

function register(socket, ctx) {
  const { io, players, teams, udpReady, countdown, timerEndAt, TIMER_DISABLED } = ctx;
  const broadcast = ctx.broadcast;
  const savedPlayersByName = getSavedPlayers();

  // ── Socket-level rate limiting ──
  const RATE_LIMIT_EXEMPT = new Set([
    'app_ping', 'new_player', 'player_reconnected', 'player_leave',
    'disconnect', 'set_password', 'get_chunk', 'request_my_items',
    'get_teams', 'get_portals', 'save_player_state',
  ]);
  const socketRateLimit = { count: 0, lastReset: Date.now(), MAX_PER_SEC: 200, warned: false };
  socket.use((packet, next) => {
    const eventName = packet[0];
    if (RATE_LIMIT_EXEMPT.has(eventName)) return next();
    const now = Date.now();
    if (now - socketRateLimit.lastReset > 1000) {
      socketRateLimit.count = 0;
      socketRateLimit.lastReset = now;
      socketRateLimit.warned = false;
    }
    socketRateLimit.count++;
    if (socketRateLimit.count > socketRateLimit.MAX_PER_SEC) {
      if (!socketRateLimit.warned) {
        console.warn(`[RateLimit] Socket ${socket.id} exceeded ${socketRateLimit.MAX_PER_SEC} events/sec`);
        socketRateLimit.warned = true;
      }
      return;
    }
    next();
  });

  // Enforce max players
  const currentPlayers = Object.keys(players).length;
  if (currentPlayers >= MAX_PLAYERS) {
    io.to(socket.id).emit('SERVER_FULL', {
      message: 'Server is full. Please try again later.',
      current: currentPlayers,
      max: MAX_PLAYERS,
    });
    setTimeout(() => socket.disconnect(true), 100);
    return false; // signal: don't register further handlers
  }

  console.log('New connection: ' + socket.id);
  try { logger.info('Client connected', { id: socket.id }); } catch {}
  io.to(socket.id).emit('OLD_DATA', { players: snapshotPlayersForBroadcast(players) });
  io.to(socket.id).emit('YOUR_ID', { id: socket.id });

  if (udpReady) {
    io.to(socket.id).emit('UDP_TOKEN', { token: udp.generateUdpToken(socket.id) });
  }

  if (TIMER_DISABLED) {
    io.to(socket.id).emit('sync_time', { disabled: true });
  } else {
    const minutes = Math.floor(countdown / 60);
    const seconds = countdown % 60;
    io.to(socket.id).emit('sync_time', { minutes, seconds, totalSeconds: countdown, endsAt: timerEndAt });
  }

  // ── App-level heartbeat ──
  socket.on('app_ping', (data) => {
    socket.emit('app_pong', data);
    if (data && data.t) {
      console.log(`[Heartbeat] Ping from ${socket.id}, latency: ${Date.now() - data.t}ms`);
    }
  });

  // ── new_player ──
  socket.on('new_player', (data = {}, ack) => {
    const reply = (payload) => { if (typeof ack === 'function') ack(payload); };
    const nowPlayers = Object.keys(players).length;
    if (nowPlayers >= MAX_PLAYERS) {
      io.to(socket.id).emit('SERVER_FULL', {
        message: 'Server is full. Please try again later.',
        current: nowPlayers, max: MAX_PLAYERS,
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
    if (BAD_WORD_REGEX.test(name)) {
      name = 'Player' + Math.random().toString(16).slice(2, 6);
    }

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
        data.statBlock = JSON.parse(JSON.stringify(snap.statBlock));
        if (data.statBlock.stats && typeof data.race === 'number') {
          data.statBlock.stats = ensureCompleteStats(data.statBlock.stats, data.race);
        }
      }
      if (snap.pos && snap.pos.x != null && snap.pos.y != null) {
        data.pos = { x: snap.pos.x, y: snap.pos.y };
      }
      if (snap.teamId) {
        data.teamId = snap.teamId;
        if (teams[snap.teamId] && teams[snap.teamId].color) {
          data.color = teams[snap.teamId].color;
        }
      }
      if (Number.isFinite(snap.maxDirtInv)) {
        data.maxDirtInv = snap.maxDirtInv;
      }
    }

    data.passwordHash = passwordHashToPersist || null;
    if (!Number.isFinite(data.maxDirtInv)) data.maxDirtInv = 600;
    players[data.id] = data;

    const spawnCoords = chunkCoordsFromPos(data.pos);
    if (spawnCoords) moveSocketToChunkRoom(socket, spawnCoords);

    const broadcastPlayer = sanitizePlayerForClient(data);
    socket.broadcast.emit('NEW_PLAYER', broadcastPlayer);
    io.emit('TEAMS_UPDATE', { teams });

    try { logger.info('Player joined', { id: data.id, name: data.name }); } catch {}

    const isReturning = !!snap;
    io.emit('NEW_CHAT_MESSAGE', {
      message: `${isReturning ? SERVER_WELCOME_RETURNING : SERVER_WELCOME_NEW} ${data.name}`,
      x: 0, y: 0, user: 'SERVER',
    });

    reply({ ok: true, isReturning, hasPassword: !!passwordHashToPersist });
  });

  // ── request_my_items ──
  socket.on('request_my_items', (data) => {
    const playerName = data.name;
    const snap = savedPlayersByName[playerName];
    const hasInventory = !!(snap && snap.invBlock);

    console.log(`[Items] Request from "${playerName}"`);
    console.log(`[Items] Snapshot exists:`, !!snap, 'inv?', hasInventory);

    if (snap && hasInventory) {
      console.log(`[Items] "${playerName}" is a RETURNING player - restoring old data`);
      try {
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
            players[socket.id].statBlock = JSON.parse(JSON.stringify(snap.statBlock));
            if (players[socket.id].statBlock.stats && typeof players[socket.id].race === 'number') {
              players[socket.id].statBlock.stats = ensureCompleteStats(players[socket.id].statBlock.stats, players[socket.id].race);
            }
          }
          if (snap.pos && snap.pos.x != null && snap.pos.y != null) {
            players[socket.id].pos = { x: snap.pos.x, y: snap.pos.y };
          }
          if (snap.teamId) {
            players[socket.id].teamId = snap.teamId;
            if (teams[snap.teamId] && teams[snap.teamId].color) {
              players[socket.id].color = teams[snap.teamId].color;
            }
          }
          if (Number.isFinite(snap.maxDirtInv)) {
            players[socket.id].maxDirtInv = snap.maxDirtInv;
          }
        }

        let statBlockToSend = snap.statBlock ? JSON.parse(JSON.stringify(snap.statBlock)) : null;
        if (statBlockToSend && statBlockToSend.stats && typeof snap.race === 'number') {
          statBlockToSend.stats = ensureCompleteStats(statBlockToSend.stats, snap.race);
        }
        console.log('[SERVER] Sending moves set to client:', Array.isArray(snap.movesSlots) ? snap.movesSlots : null);
        io.to(socket.id).emit('receive_my_items', {
          hasOldItems: true,
          invBlock: snap.invBlock ? JSON.parse(JSON.stringify(snap.invBlock)) : { items: {}, hotbar: ["","","","",""], selectedHotBar: 0, equiped: {}, movesSlots: [] },
          statBlock: statBlockToSend,
          pos: snap.pos ? { x: snap.pos.x, y: snap.pos.y } : null,
          teamId: snap.teamId || null,
          maxDirtInv: Number.isFinite(snap.maxDirtInv) ? snap.maxDirtInv : 600,
          movesSlots: Array.isArray(snap.invBlock?.movesSlots) ? snap.invBlock.movesSlots : null,
        });
      } catch (e) {
        console.warn('[Items] Failed to restore items for', playerName, e);
        io.to(socket.id).emit('receive_my_items', { hasOldItems: false });
      }
    } else {
      console.log(`[Items] "${playerName}" is a NEW player - will receive starter kit`);
      io.to(socket.id).emit('receive_my_items', { hasOldItems: false });
    }
  });

  // ── set_password ──
  socket.on('set_password', (data = {}, ack) => {
    const reply = (payload) => { if (typeof ack === 'function') ack(payload); };
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

    p.passwordHash = hashed;
    const existingSnap = savedPlayersByName[p.name] || {};
    savedPlayersByName[p.name] = {
      ...existingSnap,
      name: p.name,
      passwordHash: hashed,
    };
    const { schedulePlayerSnapshotPersist } = require('../utils/playerUtils');
    schedulePlayerSnapshotPersist(p.name);

    reply({ ok: true, hasPassword: !!hashed });
  });

  // ── player_reconnected ──
  socket.on('player_reconnected', (data) => {
    if (!data || !data.player) return;
    const incoming = data.player;
    if (!isValidPos(incoming.pos)) {
      incoming.pos = players[incoming.id]?.pos || { x: 0, y: 0 };
    }

    // Retrieve existing server-side player or saved snapshot to preserve authoritative data
    const oldPlayer = (data.oldID && players[data.oldID]) ? players[data.oldID] : null;
    const savedSnap = incoming.name ? savedPlayersByName[incoming.name] : null;

    if (data.oldID && data.oldID !== incoming.id) {
      delete players[data.oldID];
      socketChunkRooms.delete(data.oldID);
    }

    // Build a sanitized player object — only trust safe fields from the client
    const sanitized = {
      id: incoming.id,
      name: incoming.name,
      pos: incoming.pos,
      race: incoming.race ?? oldPlayer?.race ?? savedSnap?.race ?? null,
      color: incoming.color ?? oldPlayer?.color ?? 0,
      holding: incoming.holding || { w: false, a: false, s: false, d: false },
      // Server-authoritative fields — never trust from client
      kills: 0,
      deaths: 0,
      statBlock: oldPlayer?.statBlock ?? (savedSnap?.statBlock ? JSON.parse(JSON.stringify(savedSnap.statBlock)) : incoming.statBlock ?? null),
      invBlock: oldPlayer?.invBlock ?? (savedSnap?.invBlock ? JSON.parse(JSON.stringify(savedSnap.invBlock)) : null),
      passwordHash: oldPlayer?.passwordHash ?? savedSnap?.passwordHash ?? null,
      teamId: oldPlayer?.teamId ?? savedSnap?.teamId ?? null,
      maxDirtInv: oldPlayer?.maxDirtInv ?? (Number.isFinite(savedSnap?.maxDirtInv) ? savedSnap.maxDirtInv : 600),
      isDead: oldPlayer?.isDead ?? false,
    };

    players[incoming.id] = sanitized;

    if (kills_deaths[data.oldID] != undefined) {
      players[incoming.id].kills = kills_deaths[data.oldID].kills;
      players[incoming.id].deaths = kills_deaths[data.oldID].deaths;
      delete kills_deaths[data.oldID];
    }

    const coords = chunkCoordsFromPos(players[incoming.id].pos);
    moveSocketToChunkRoom(socket, coords);

    socket.broadcast.emit('NEW_PLAYER', sanitizePlayerForClient(players[incoming.id]));
    socket.broadcast.emit('PLAYERS_CHECK', { ids: Object.keys(players) });
    io.emit('TEAMS_UPDATE', { teams });
  });

  // ── player_leave ──
  socket.on('player_leave', (data) => {
    try { logger.info('Player leaving', { id: socket.id, playerName: data.playerName }); } catch {}
    console.log(`[LEAVE] Player "${data.playerName}" (${socket.id}) is leaving`);

    if (players[socket.id] != undefined) {
      const p = players[socket.id];
      if (p && p.name) {
        const ok = savePlayerSnapshot(p);
        console.log(ok ? `[SAVE] ✓ Snapshot saved for "${p.name}"` : `[SAVE] ✗ Snapshot failed for "${p.name}"`);
      }
      players[socket.id] = [];
      delete players[socket.id];
    }

    io.emit('PLAYERS_CHECK', { ids: Object.keys(players) });
  });

  // ── disconnect ──
  socket.on('disconnect', (reason) => {
    try { logger.info('Client disconnected', { id: socket.id, reason }); } catch {}
    console.log(socket.id + ' disconnected (reason: ' + reason + ')');

    // Capture player name before deletion so the goodbye message is correct
    const disconnectedPlayer = players[socket.id];
    const playerName = (disconnectedPlayer && disconnectedPlayer.name) ? disconnectedPlayer.name : 'a player';

    if (disconnectedPlayer != undefined) {
      console.log(
        '{\n   id: ' + disconnectedPlayer.id +
        '\n   name: ' + disconnectedPlayer.name +
        '\n   kills: ' + disconnectedPlayer.kills +
        '\n   deaths: ' + disconnectedPlayer.deaths + '\n}',
      );
      kills_deaths[socket.id] = {
        kills: disconnectedPlayer.kills,
        deaths: disconnectedPlayer.deaths,
      };

      if (disconnectedPlayer.name) {
        const ok = savePlayerSnapshot(disconnectedPlayer);
        console.log(ok ? `[SAVE] ✓ Snapshot saved for "${disconnectedPlayer.name}"` : `[SAVE] ✗ Snapshot failed for "${disconnectedPlayer.name}"`);
      }
    }

    delete players[socket.id];
    socketChunkRooms.delete(socket.id);
    udp.removeChannel(socket.id);

    io.emit('REMOVE_PLAYER', socket.id);
    io.emit('NEW_CHAT_MESSAGE', {
      message: `Goodbye ${playerName}`,
      x: 0, y: 0,
      user: playerName
    });
  });

  return true; // signal: handlers registered
}

module.exports = { register, getKillsDeaths, setKillsDeaths };
