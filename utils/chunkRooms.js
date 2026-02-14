const { TILESIZE, CHUNKSIZE } = require('./map');
const udp = require('./udpTransport');

const socketChunkRooms = new Map();

const chunkRoom = (cx, cy) => `chunk_${cx}_${cy}`;

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
  if (current && current.center === centerRoom) return;

  const newRooms = getNeighborRooms(coords.cx, coords.cy);

  if (current && current.rooms) {
    for (const oldRoom of current.rooms) {
      if (!newRooms.includes(oldRoom)) {
        socket.leave(oldRoom);
        udp.leaveRoom(socket.id, oldRoom);
      }
    }
  }
  const oldRooms = (current && current.rooms) || [];
  for (const newRoom of newRooms) {
    if (!oldRooms.includes(newRoom)) {
      socket.join(newRoom);
      udp.joinRoom(socket.id, newRoom);
    }
  }

  socketChunkRooms.set(socket.id, { center: centerRoom, rooms: newRooms, cx: coords.cx, cy: coords.cy });
}

module.exports = {
  socketChunkRooms,
  chunkRoom,
  chunkCoordsFromPos,
  isValidPos,
  getNeighborRooms,
  moveSocketToChunkRoom,
};
