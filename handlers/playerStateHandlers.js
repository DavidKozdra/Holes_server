const { isValidPos, chunkCoordsFromPos, moveSocketToChunkRoom } = require('../utils/chunkRooms');
const { normalizePos, cloneHolding, savePlayerSnapshot } = require('../utils/playerUtils');

function register(socket, ctx) {
  const { io, players, broadcast } = ctx;

  // ── update_pos ──
  socket.on('update_pos', (data) => {
    if (!players[data.id]) return;

    if (isValidPos(data.pos)) {
      players[data.id].pos = data.pos;
      const coords = chunkCoordsFromPos(data.pos);
      moveSocketToChunkRoom(socket, coords);
      const normalizedData = {
        id: data.id,
        pos: normalizePos(data.pos),
        holding: cloneHolding(data.holding)
      };
      if (coords) {
        broadcast.emitToNearbyRooms(coords.cx, coords.cy, 'UPDATE_POS', normalizedData, socket.id);
      } else {
        broadcast.emitToAll('UPDATE_POS', normalizedData, socket.id);
      }
    }
    if (data.holding !== undefined) {
      players[data.id].holding = data.holding;
    }
  });

  // ── update_player ──
  const ALLOWED_UPDATE_FIELDS = new Set([
    'stats.hp', 'stats.mp', 'stats.mhp', 'stats.mmp',
    'stats.attack', 'stats.magic', 'stats.magicResistance',
    'stats.luck', 'stats.runningSpeed', 'stats.healthRegen',
    'statBlock.level', 'statBlock.xp', 'statBlock.xpNeeded',
    'forcefieldActive', 'isDashing', 'flashTimer',
    'particles', 'meditateActive', 'auraTimer',
    'dashTimer', 'combustionActive', 'isDead',
    'color', 'maxDirtInv',
  ]);

  socket.on('update_player', (data) => {
    if (!players[data.id]) return;
    if (data.id !== socket.id) return;
    if (!Array.isArray(data.update_names) || !Array.isArray(data.update_values)) return;
    if (data.update_names.length !== data.update_values.length) return;
    const maxFields = Math.min(data.update_names.length, 20);

    let hasVisual = false;
    let visualEvents = [];
    for (let i = 0; i < maxFields; i++) {
      const name = data.update_names[i];
      const value = data.update_values[i];
      if (!ALLOWED_UPDATE_FIELDS.has(name)) continue;
      if (name.includes('stats')) {
        players[data.id].statBlock.stats[name.split('stats.')[1]] = value;
      } else if (name.includes('statBlock')) {
        players[data.id].statBlock[name.split('statBlock.')[1]] = value;
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
    players[data.id].pos = data.pos;
    players[data.id].holding = data.holding;

    const normalizedData = {
      id: data.id,
      pos: normalizePos(data.pos),
      holding: cloneHolding(data.holding),
      update_names: data.update_names,
      update_values: data.update_values
    };

    const playerCoords = chunkCoordsFromPos(data.pos);
    if (playerCoords) moveSocketToChunkRoom(socket, playerCoords);

    if (hasVisual) {
      if (playerCoords) {
        broadcast.emitToNearbyRooms(playerCoords.cx, playerCoords.cy, 'UPDATE_PLAYER', normalizedData, socket.id);
        for (const evt of visualEvents) broadcast.emitToNearbyRooms(playerCoords.cx, playerCoords.cy, 'ABILITY_VISUAL', evt, socket.id);
      } else {
        broadcast.emitToAll('UPDATE_PLAYER', normalizedData, socket.id);
        for (const evt of visualEvents) broadcast.emitToAll('ABILITY_VISUAL', evt, socket.id);
      }
    } else if (data.pos || data.holding) {
      if (playerCoords) {
        broadcast.emitToNearbyRooms(playerCoords.cx, playerCoords.cy, 'UPDATE_PLAYER', normalizedData, socket.id);
      } else {
        broadcast.emitToAll('UPDATE_PLAYER', normalizedData, socket.id);
      }
    } else {
      broadcast.emitToPlayer(data.id, 'UPDATE_PLAYER', normalizedData);
    }
  });

  // ── EXPLOSION ──
  socket.on('EXPLOSION', (data) => {
    broadcast.emitToAll('EXPLOSION', data, socket.id);
  });

  // ── sync_player_inventory ──
  socket.on('sync_player_inventory', (data) => {
    if (!players[socket.id]) return;
    if (data.invBlock) {
      players[socket.id].invBlock = {
        items: data.invBlock.items || {},
        hotbar: Array.isArray(data.invBlock.hotbar) ? data.invBlock.hotbar : ["","","","",""],
        selectedHotBar: typeof data.invBlock.selectedHotBar === 'number' ? data.invBlock.selectedHotBar : 0,
        equiped: data.invBlock.equiped || { head: "", neck: "", chest: "", legs: "", feet: "" }
      };
    }
    if (isValidPos(data.pos)) players[socket.id].pos = data.pos;
    if (data.statBlock) players[socket.id].statBlock = data.statBlock;
    savePlayerSnapshot(players[socket.id]);
    console.log(`[Sync] Updated inventory for "${players[socket.id].name}" - ${Object.keys(data.invBlock?.items || {}).length} items`);
  });

  // ── save_player_state ──
  socket.on('save_player_state', (data = {}) => {
    const p = players[socket.id] || {};
    console.log("save player", data.invBlock);
    if (data.invBlock) {
      p.invBlock = {
        items: data.invBlock.items || {},
        hotbar: Array.isArray(data.invBlock.hotbar) ? data.invBlock.hotbar : ["","","","",""],
        selectedHotBar: typeof data.invBlock.selectedHotBar === 'number' ? data.invBlock.selectedHotBar : 0,
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

    if (!players[socket.id] && p.name) {
      p.id = socket.id;
      players[socket.id] = p;
    }

    const ok = savePlayerSnapshot(players[socket.id] || p);
    io.to(socket.id).emit('PLAYER_SAVED', { ok });
  });

  // ── update_moves ──
  socket.on('update_moves', (data = {}) => {
    const p = players[socket.id];
    if (!p) return;
    if (Array.isArray(data.movesSlots)) {
      p.movesSlots = data.movesSlots;
    }
    if (p.name) savePlayerSnapshot(p);
    io.to(socket.id).emit('PLAYER_MOVES_SAVED', { ok: true });
  });

  // ── spawn_entity ──
  socket.on('spawn_entity', (data) => {
    const { name, x, y, teamId, color, ownerName } = data;
    const playerData = players[socket.id];
    if (!playerData || !name || x === undefined || y === undefined) {
      console.error('Invalid spawn_entity data:', data);
      return;
    }

    const brainID = Math.floor(Math.random() * 1000000).toString();
    const brain = {
      id: brainID,
      target: { x, y },
      personality: 'swarm',
      teamId: teamId || null,
      ownerName: ownerName || playerData.name
    };

    const serverMap = ctx.getServerMap();
    if (!serverMap.brains) serverMap.brains = [];
    serverMap.brains.push(brain);

    io.emit('NEW_BRAIN', brain);
    console.log(`[Spawn Entity] ${ownerName} spawned ${name} at (${x}, ${y})`);
  });
}

module.exports = { register };
