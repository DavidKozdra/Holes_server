const udp = require('./udpTransport');
const { getNeighborRooms } = require('./chunkRooms');

let io = null;
let udpReady = false;

function init(ioInstance) {
  io = ioInstance;
}

function setUdpReady(ready) {
  udpReady = ready;
}

function isUdpReady() {
  return udpReady;
}

/** Emit to a specific player — prefer UDP, fall back to Socket.IO. */
function emitToPlayer(socketId, event, data) {
  if (udpReady && udp.sendToPlayer(socketId, event, data)) return;
  io.to(socketId).emit(event, data);
}

/** Emit to a Socket.IO room — UDP clients get UDP, others get Socket.IO. */
function emitToRoom(roomName, event, data) {
  if (udpReady && udp.channelCount() > 0) {
    udp.broadcastToRoom(roomName, event, data);
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

/** Broadcast to rooms around chunk coords — used for spatial events. */
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
 * have an active UDP channel.
 */
function _emitToRoomExcludingUdp(roomName, event, data, alsoExcludeId) {
  const room = io.sockets.adapter.rooms.get(roomName);
  if (!room) return;
  const udpSockets = udp.getConnectedSocketIds();
  for (const sid of room) {
    if (sid === alsoExcludeId) continue;
    if (udpSockets.has(sid)) continue;
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.emit(event, data);
  }
}

/** Get the raw io instance (for cases that need direct io.emit / io.to) */
function getIO() {
  return io;
}

module.exports = {
  init,
  setUdpReady,
  isUdpReady,
  emitToPlayer,
  emitToRoom,
  broadcastToRoomFrom,
  emitToAll,
  emitToNearbyRooms,
  getIO,
};
