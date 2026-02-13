const { TILESIZE, CHUNKSIZE, Placeable } = require('../utils/map');
const { chunkRoom } = require('../utils/chunkRooms');
const { bufferNodeUpdate } = require('../utils/nodeBuffer');

/**
 * Shared terrain update logic used by both Socket.IO and UDP handlers.
 */

function applySingleNode(serverMap, data, isIron) {
  let chunkPos = data.chunkPos.split(',');
  chunkPos[0] = parseInt(chunkPos[0]);
  chunkPos[1] = parseInt(chunkPos[1]);
  let chunk = serverMap.getChunk(chunkPos[0], chunkPos[1]);
  const arr = isIron ? chunk.iron_data : chunk.data;

  if (data.amt > 0) {
    if (arr[data.index] > 0) arr[data.index] -= data.amt;
    if (arr[data.index] < 0.3 && arr[data.index] !== -1) arr[data.index] = 0;
  } else {
    if (arr[data.index] < 1.3 && arr[data.index] !== -1) arr[data.index] -= data.amt;
    if (arr[data.index] > 1.3) arr[data.index] = 1.3;
  }

  bufferNodeUpdate(chunkPos[0], chunkPos[1], data, isIron);
}

function applyMultiNode(serverMap, data, isIron) {
  let chunk = serverMap.getChunk(data.cx, data.cy);
  if (!chunk) return { chunk: null, reward: 0 };

  let posX = Math.round(data.pos.x / TILESIZE);
  let posY = Math.round(data.pos.y / TILESIZE);
  posX = posX - data.cx * CHUNKSIZE;
  posY = posY - data.cy * CHUNKSIZE;

  let reward = 0;
  const dataField = isIron ? 'iron_data' : 'data';

  for (let x = posX - data.radius; x <= posX + data.radius; x++) {
    for (let y = posY - data.radius; y <= posY + data.radius; y++) {
      if (x >= 0 && x < CHUNKSIZE && y >= 0 && y < CHUNKSIZE) {
        let index = x + y * CHUNKSIZE;
        if (data.amt > 0) {
          if (isIron && chunk[dataField][index] > 0) reward += chunk[dataField][index];
          if (chunk[dataField][index] > 0) chunk[dataField][index] -= data.amt;
          if (chunk[dataField][index] < 0.3 && chunk[dataField][index] !== -1) chunk[dataField][index] = 0;
        } else {
          if (chunk[dataField][index] < 1.3 && chunk[dataField][index] !== -1) chunk[dataField][index] -= data.amt;
          if (chunk[dataField][index] > 1.3) chunk[dataField][index] = 1.3;
        }
      } else {
        let tempChunk;
        let index;
        if (y < 0 && x >= 0 && x < CHUNKSIZE) {
          tempChunk = serverMap.getChunk(data.cx, data.cy - 1);
          index = x + 1 + y * CHUNKSIZE;
        } else if (y >= CHUNKSIZE && x >= 0 && x < CHUNKSIZE) {
          tempChunk = serverMap.getChunk(data.cx, data.cy + 1);
          index = x - 1 + (y - CHUNKSIZE) * CHUNKSIZE;
        } else if (x < 0 && y >= 0 && y < CHUNKSIZE) {
          tempChunk = serverMap.getChunk(data.cx - 1, data.cy);
          index = (CHUNKSIZE + x) + y * CHUNKSIZE;
        } else if (x >= CHUNKSIZE && y >= 0 && y < CHUNKSIZE) {
          tempChunk = serverMap.getChunk(data.cx + 1, data.cy);
          index = (x - CHUNKSIZE) + y * CHUNKSIZE;
        } else if (x < 0 && y < 0) {
          tempChunk = serverMap.getChunk(data.cx - 1, data.cy - 1);
          index = (CHUNKSIZE + x + 1) + (CHUNKSIZE + y) * CHUNKSIZE;
        } else if (x >= CHUNKSIZE && y < 0) {
          tempChunk = serverMap.getChunk(data.cx + 1, data.cy - 1);
          index = (x - CHUNKSIZE + 1) + (CHUNKSIZE + y) * CHUNKSIZE;
        } else if (x < 0 && y >= CHUNKSIZE) {
          tempChunk = serverMap.getChunk(data.cx - 1, data.cy + 1);
          index = (CHUNKSIZE + x - 1) + (y - CHUNKSIZE) * CHUNKSIZE;
        } else if (x >= CHUNKSIZE && y >= CHUNKSIZE) {
          tempChunk = serverMap.getChunk(data.cx + 1, data.cy + 1);
          index = (x - CHUNKSIZE - 1) + (y - CHUNKSIZE) * CHUNKSIZE;
        }
        if (tempChunk != undefined && index != undefined) {
          if (data.amt > 0) {
            if (isIron && tempChunk[dataField][index] > 0) reward += tempChunk[dataField][index];
            if (tempChunk[dataField][index] > 0) tempChunk[dataField][index] -= data.amt;
            if (tempChunk[dataField][index] < 0.3 && tempChunk[dataField][index] !== -1) tempChunk[dataField][index] = 0;
          } else {
            if (tempChunk[dataField][index] < 1.3 && tempChunk[dataField][index] !== -1) tempChunk[dataField][index] -= data.amt;
            if (tempChunk[dataField][index] > 1.3) tempChunk[dataField][index] = 1.3;
          }
        }
      }
    }
  }

  return { chunk, reward };
}

function register(socket, ctx) {
  const { io, broadcast } = ctx;
  const getServerMap = ctx.getServerMap;

  socket.on('update_node', (data) => {
    if (!data || !data.chunkPos) return;
    applySingleNode(getServerMap(), data, false);
  });

  socket.on('update_iron_node', (data) => {
    if (!data || !data.chunkPos) return;
    applySingleNode(getServerMap(), data, true);
  });

  socket.on('update_nodes', (data) => {
    if (!data || data.cx == null || data.cy == null) return;
    const serverMap = getServerMap();
    applyMultiNode(serverMap, data, false);
    broadcast.emitToRoom(chunkRoom(data.cx, data.cy), 'UPDATE_NODES', data);
  });

  socket.on('update_iron_nodes', (data) => {
    if (!data || data.cx == null || data.cy == null) return;
    const serverMap = getServerMap();
    const { chunk, reward } = applyMultiNode(serverMap, data, true);

    if (reward > 0 && chunk) {
      let itemBag = new Placeable('ItemBag', data.pos.x, data.pos.y, 0, 12 * 3, 13 * 3, 1, 11, '', '');
      itemBag.type = 'InvObj';
      itemBag.invBlock = { items: {} };
      itemBag.invBlock.invId = Math.random() * 100000;
      itemBag.invBlock.items['Raw Metal'] = {};
      itemBag.invBlock.items['Raw Metal'].amount = Math.round(reward * 0.2) + 1;
      chunk.objects.push(itemBag);
      io.emit('NEW_OBJECT', { cx: chunk.cx, cy: chunk.cy, obj: itemBag });
    }
    broadcast.emitToRoom(chunkRoom(data.cx, data.cy), 'UPDATE_IRON_NODES', data);
  });
}

// Export shared logic for UDP handlers
module.exports = { register, applySingleNode, applyMultiNode };
