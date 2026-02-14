const { chunkRoom } = require('./chunkRooms');
const { NODE_FLUSH_INTERVAL_MS } = require('./gameConfig');

let emitToRoom = null;
const chunkNodeBuffers = new Map();
const chunkIronBuffers = new Map();
let nodeFlushTimer = null;

function init(emitToRoomFn) {
  emitToRoom = emitToRoomFn;
}

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

module.exports = {
  init,
  bufferNodeUpdate,
  flushNodeBuffers,
};
