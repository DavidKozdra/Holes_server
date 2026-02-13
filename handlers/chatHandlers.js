const { BAD_WORD_REGEX } = require('../utils/gameConfig');

function register(socket, ctx) {
  const { io, players } = ctx;

  function broadcastChat(chatMsg, speakingRangeOverride) {
    if (!chatMsg || typeof chatMsg.message !== 'string') return;

    const MAX_CHAT_LENGTH = 500;
    let message = chatMsg.message.trim().slice(0, MAX_CHAT_LENGTH);
    if (!message) return;

    message = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const cleanMsg = {
      user: (chatMsg.user || 'Entity').slice(0, 32),
      message: BAD_WORD_REGEX.test(message) ? 'I curse at you !!!' : message,
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

  socket.on('send_message', (data) => {
    let parts = data.split(',');
    let x = parseFloat(parts[0]);
    let y = parseFloat(parts[1]);
    let message = parts.slice(2).join(',');

    let user = players[socket.id] && players[socket.id].name ? players[socket.id].name : socket.id;
    let chatMsg = { message, x, y, user };
    broadcastChat(chatMsg, players[socket.id]?.statBlock?.stats?.speakingRange);
  });

  socket.on('entity_chat', (data) => {
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
  });
}

module.exports = { register };
