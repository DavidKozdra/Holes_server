const { TILESIZE, CHUNKSIZE } = require('../utils/map');
const { chunkRoom } = require('../utils/chunkRooms');
const { sanitizeItems, spawnItemBag, mergeAllChunkBags } = require('../utils/itemBags');
const { BAG_MERGE_BUDGET } = require('../utils/gameConfig');

function register(socket, ctx) {
  const { io, broadcast } = ctx;
  const getServerMap = ctx.getServerMap;

  // ── new_object ──
  socket.on('new_object', (data) => {
    if (!data || !data.obj || typeof data.cx !== 'number' || typeof data.cy !== 'number') return;
    const obj = data.obj;
    if (!obj.objName || typeof obj.objName !== 'string') return;
    if (!obj.pos || typeof obj.pos.x !== 'number' || typeof obj.pos.y !== 'number') return;
    // Strip any dangerous prototype-polluting keys
    delete obj.__proto__;
    delete obj.constructor;
    let chunk = getServerMap().getChunk(data.cx, data.cy);
    chunk.objects.push(obj);
    socket.broadcast.emit('NEW_OBJECT', data);
  });

  // ── delete_obj ──
  socket.on('delete_obj', (data) => {
    let chunk = getServerMap().getChunk(data.cx, data.cy);
    for (let i = chunk.objects.length - 1; i >= 0; i--) {
      if (data.objName == 'ExpOrb') {
        if (data.z == chunk.objects[i].z && data.id == chunk.objects[i].id) {
          io.emit('DELETE_OBJ', data);
          chunk.objects.splice(i, 1);
          spawnItemBag(chunk, data, io, () => mergeAllChunkBags(getServerMap(), io, BAG_MERGE_BUDGET));
        }
      } else if (data.brainID != undefined) {
        if (data.z == chunk.objects[i].z && data.brainID == chunk.objects[i].brainID) {
          io.emit('DELETE_OBJ', data);
          chunk.objects.splice(i, 1);
          // Remove the matching brain entry so it doesn't grow unbounded
          const brains = getServerMap().brains;
          for (let b = brains.length - 1; b >= 0; b--) {
            if (brains[b].id == data.brainID) { brains.splice(b, 1); break; }
          }
          spawnItemBag(chunk, data, io, () => mergeAllChunkBags(getServerMap(), io, BAG_MERGE_BUDGET));
        }
      } else {
        if (
          data.pos &&
          data.pos.x == chunk.objects[i].pos.x &&
          data.pos.y == chunk.objects[i].pos.y &&
          data.z == chunk.objects[i].z &&
          data.objName == chunk.objects[i].objName
        ) {
          io.emit('DELETE_OBJ', data);
          chunk.objects.splice(i, 1);
          spawnItemBag(chunk, data, io, () => mergeAllChunkBags(getServerMap(), io, BAG_MERGE_BUDGET));
        }
      }
    }
  });

  // ── update_obj ──
  const ALLOWED_OBJ_UPDATE_FIELDS = new Set([
    'hp', 'pos', 'rot', 'openBool', 'stage',
    'color', 'ownerName', 'flightPath',
  ]);

  socket.on('update_obj', (data) => {
    if (!data || !data.update_name || !ALLOWED_OBJ_UPDATE_FIELDS.has(data.update_name)) return;
    let chunk = getServerMap().getChunk(data.cx, data.cy);
    for (let i = chunk.objects.length - 1; i >= 0; i--) {
      if (data.objName == 'ExpOrb') {
        if (data.z == chunk.objects[i].z && data.id == chunk.objects[i].id) {
          chunk.objects[i][data.update_name] = data.update_value;
          chunk.objects[i].pos.x = data.pos.x;
          chunk.objects[i].pos.y = data.pos.y;
          socket.broadcast.emit('UPDATE_OBJ', data);
        }
      } else if (data.brainID != undefined) {
        if (data.z == chunk.objects[i].z && data.brainID == chunk.objects[i].brainID) {
          chunk.objects[i][data.update_name] = data.update_value;
          chunk.objects[i].pos.x = data.pos.x;
          chunk.objects[i].pos.y = data.pos.y;
        }
      } else {
        if (
          data.pos &&
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
  });

  // ── update_inv ──
  socket.on('update_inv', (data) => {
    const chunk = getServerMap().getChunk(data.cx, data.cy);
    if (!chunk || !Array.isArray(chunk.objects)) return;

    for (let i = chunk.objects.length - 1; i >= 0; i--) {
      const obj = chunk.objects[i];
      const idMatch = obj.invBlock && data.invId !== undefined && obj.invBlock.invId === data.invId;
      const posMatch =
        data.pos.x === obj.pos.x && data.pos.y === obj.pos.y &&
        data.z === obj.z && data.objName === obj.objName;

      const hasInventory = obj && (obj.invBlock || obj.objName === 'Chest' || obj.objName === 'ItemBag');

      if (hasInventory && (idMatch || posMatch)) {
        obj.invBlock = obj.invBlock || { items: {} };
        obj.invBlock.items = sanitizeItems(data.items);
        if (typeof obj.invBlock.invId !== 'number' && typeof data.invId === 'number') {
          obj.invBlock.invId = data.invId;
        }
        const payload = {
          cx: data.cx, cy: data.cy,
          objName: data.objName,
          pos: data.pos, z: data.z,
          invId: obj.invBlock.invId,
          items: obj.invBlock.items,
        };
        io.emit('UPDATE_INV', payload);
        break;
      }
    }
  });

  // ── new_proj ──
  socket.on('new_proj', (data) => {
    if (!data.cPos) {
      const cx = Math.floor(data.x / (TILESIZE * CHUNKSIZE));
      const cy = Math.floor(data.y / (TILESIZE * CHUNKSIZE));
      data.cPos = { x: cx, y: cy };
    }
    let chunk = getServerMap().getChunk(data.cPos.x, data.cPos.y);
    if (chunk) chunk.projectiles.push(data);
    broadcast.emitToAll('NEW_PROJECTILE', data, socket.id);
  });

  // ── delete_proj ──
  socket.on('delete_proj', (data) => {
    if (!data.cPos) {
      const cx = Math.floor(data.x / (TILESIZE * CHUNKSIZE));
      const cy = Math.floor(data.y / (TILESIZE * CHUNKSIZE));
      data.cPos = { x: cx, y: cy };
    }
    let chunk = getServerMap().getChunk(data.cPos.x, data.cPos.y);
    if (!chunk) return;
    for (let i = chunk.projectiles.length - 1; i >= 0; i--) {
      if (data.id == chunk.projectiles[i].id) {
        chunk.projectiles.splice(i, 1);
        broadcast.emitToAll('DELETE_PROJ', data, socket.id);
        break;
      }
    }
  });

  // ── new_sound ──
  socket.on('new_sound', (data) => {
    if (!data || !data.cPos || typeof data.cPos.x !== 'number' || typeof data.cPos.y !== 'number') return;
    let chunk = getServerMap().getChunk(data.cPos.x, data.cPos.y);
    chunk.soundObjs.push(data);
    broadcast.emitToAll('NEW_SOUND', data, socket.id);
  });

  // ── delete_sound ──
  socket.on('delete_sound', (data) => {
    if (!data || !data.cPos || typeof data.cPos.x !== 'number' || typeof data.cPos.y !== 'number') return;
    if (!data.pos) return;
    let chunk = getServerMap().getChunk(data.cPos.x, data.cPos.y);
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
  });

  // ── wander_request ──
  socket.on('wander_request', (data) => {
    const serverMap = getServerMap();
    for (let i = 0; i < serverMap.brains.length; i++) {
      if (data.id == serverMap.brains[i].id) {
        let angle = Math.random() * 2 * Math.PI;
        let target = { x: data.pos.x + Math.cos(angle) * 100, y: data.pos.y + Math.sin(angle) * 100 };
        broadcast.emitToAll('WANDER_TARGET', { id: data.id, target: target });
        serverMap.brains[i].target = target;
        break;
      }
    }
  });

  // ── get_chunk ──
  socket.on('get_chunk', (data) => {
    let pos = data.split(',');
    pos[0] = parseInt(pos[0]);
    pos[1] = parseInt(pos[1]);
    socket.join(chunkRoom(pos[0], pos[1]));
    let chunk = getServerMap().getChunk(pos[0], pos[1]);
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
      x: pos[0], y: pos[1],
      data: tempData,
      iron_data: tempData2,
      objects: chunk.objects,
      projectiles: chunk.projectiles,
    });
  });

  // ── get_portals ──
  socket.on('get_portals', (data) => {
    const serverMap = getServerMap();
    let portals = [];
    for (let y = data.cPos.y - 5; y <= data.cPos.y + 5; y++) {
      for (let x = data.cPos.x - 5; x <= data.cPos.x + 5; x++) {
        if (serverMap.chunks['' + x + ',' + y] != undefined) {
          let chunk = serverMap.chunks['' + x + ',' + y];
          for (let i = 0; i < chunk.objects.length; i++) {
            if (chunk.objects[i].objName == 'Portal') {
              portals.push({ cx: x, cy: y, pos: chunk.objects[i].pos, color: chunk.objects[i].color });
            }
          }
        }
      }
    }
    io.to(socket.id).emit('GIVE_PORTALS', { portals: portals });
  });
}

module.exports = { register };
