const { TILESIZE, CHUNKSIZE } = require('../utils/map');
const { chunkRoom, chunkCoordsFromPos, isValidPos, moveSocketToChunkRoom } = require('../utils/chunkRooms');
const { normalizePos, cloneHolding } = require('../utils/playerUtils');
const { applySingleNode, applyMultiNode } = require('./terrainHandlers');

/**
 * Build the UDP client→server handler map.
 * Each handler receives (data, socketId).
 */
function buildUdpHandlers(ctx) {
  const handlers = {};
  const { players, broadcast } = ctx;

  handlers['update_player'] = (data, socketId) => {
    if (!data || !data.id) return;
    if (data.id !== socketId) return;
    if (!players[data.id]) return;

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
      const io = broadcast.getIO();
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
        broadcast.emitToNearbyRooms(playerCoords.cx, playerCoords.cy, 'UPDATE_PLAYER', normalizedData, socketId);
        for (const evt of visualEvents) broadcast.emitToNearbyRooms(playerCoords.cx, playerCoords.cy, 'ABILITY_VISUAL', evt, socketId);
      } else {
        broadcast.emitToAll('UPDATE_PLAYER', normalizedData, socketId);
        for (const evt of visualEvents) broadcast.emitToAll('ABILITY_VISUAL', evt, socketId);
      }
    } else if (data.pos || data.holding) {
      if (playerCoords) {
        broadcast.emitToNearbyRooms(playerCoords.cx, playerCoords.cy, 'UPDATE_PLAYER', normalizedData, socketId);
      } else {
        broadcast.emitToAll('UPDATE_PLAYER', normalizedData, socketId);
      }
    }
  };

  handlers['update_node'] = (data) => {
    if (!data || !data.chunkPos) return;
    applySingleNode(ctx.getServerMap(), data, false);
  };

  handlers['update_iron_node'] = (data) => {
    if (!data || !data.chunkPos) return;
    applySingleNode(ctx.getServerMap(), data, true);
  };

  handlers['update_nodes'] = (data) => {
    if (!data || data.cx == null || data.cy == null) return;
    applyMultiNode(ctx.getServerMap(), data, false);
    broadcast.emitToRoom(chunkRoom(data.cx, data.cy), 'UPDATE_NODES', data);
  };

  handlers['update_iron_nodes'] = (data) => {
    if (!data || data.cx == null || data.cy == null) return;
    applyMultiNode(ctx.getServerMap(), data, true);
    broadcast.emitToRoom(chunkRoom(data.cx, data.cy), 'UPDATE_IRON_NODES', data);
  };

  handlers['EXPLOSION'] = (data, socketId) => {
    if (!data) return;
    broadcast.emitToAll('EXPLOSION', data, socketId);
  };

  handlers['new_proj'] = (data, socketId) => {
    if (!data) return;
    if (!data.cPos && data.pos) {
      const cx = Math.floor(data.pos.x / (TILESIZE * CHUNKSIZE));
      const cy = Math.floor(data.pos.y / (TILESIZE * CHUNKSIZE));
      data.cPos = { x: cx, y: cy };
    }
    if (data.cPos) {
      let chunk = ctx.getServerMap().getChunk(data.cPos.x, data.cPos.y);
      if (chunk) chunk.projectiles.push(data);
    }
    broadcast.emitToAll('NEW_PROJECTILE', data, socketId);
  };

  handlers['delete_proj'] = (data, socketId) => {
    if (!data) return;
    if (!data.cPos && data.pos) {
      const cx = Math.floor(data.pos.x / (TILESIZE * CHUNKSIZE));
      const cy = Math.floor(data.pos.y / (TILESIZE * CHUNKSIZE));
      data.cPos = { x: cx, y: cy };
    }
    if (!data.cPos) return;
    let chunk = ctx.getServerMap().getChunk(data.cPos.x, data.cPos.y);
    if (!chunk) return;
    for (let i = chunk.projectiles.length - 1; i >= 0; i--) {
      if (data.id == chunk.projectiles[i].id) {
        chunk.projectiles.splice(i, 1);
        broadcast.emitToAll('DELETE_PROJ', data, socketId);
        break;
      }
    }
  };

  handlers['new_sound'] = (data, socketId) => {
    if (!data || !data.cPos) return;
    let chunk = ctx.getServerMap().getChunk(data.cPos.x, data.cPos.y);
    if (chunk) chunk.soundObjs.push(data);
    broadcast.emitToAll('NEW_SOUND', data, socketId);
  };

  handlers['delete_sound'] = (data) => {
    if (!data || !data.cPos) return;
    let chunk = ctx.getServerMap().getChunk(data.cPos.x, data.cPos.y);
    if (!chunk) return;
    for (let i = chunk.soundObjs.length - 1; i >= 0; i--) {
      if (data.id == chunk.soundObjs[i].id && data.lifeSpan == chunk.soundObjs[i].lifeSpan &&
          data.pos.x == chunk.soundObjs[i].pos.x && data.pos.y == chunk.soundObjs[i].pos.y) {
        chunk.soundObjs.splice(i, 1);
      }
    }
  };

  handlers['wander_request'] = (data) => {
    if (!data || !data.id) return;
    const serverMap = ctx.getServerMap();
    for (let i = 0; i < serverMap.brains.length; i++) {
      if (data.id == serverMap.brains[i].id) {
        let angle = Math.random() * 2 * Math.PI;
        let target = { x: data.pos.x + Math.cos(angle) * 100, y: data.pos.y + Math.sin(angle) * 100 };
        broadcast.emitToAll('WANDER_TARGET', { id: data.id, target: target });
        serverMap.brains[i].target = target;
        break;
      }
    }
  };

  return handlers;
}

module.exports = { buildUdpHandlers };
