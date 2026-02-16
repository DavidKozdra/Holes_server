const { PERMA_DEATH_ENABLED } = require('../utils/gameConfig');
const { deletePlayerSnapshotByName } = require('../utils/playerUtils');
const { logger } = require('../utils/logger');

function register(socket, ctx) {
  const { io, players } = ctx;

  socket.on('player_dies', (data) => {
    const { x, y, id, attacker, name } = data;

    // Only allow a client to report its own death
    if (id !== socket.id) return;

    if (players[id]) {
      players[id].isDead = true;
      players[id].deaths += 1;

      if (PERMA_DEATH_ENABLED) {
        const removed = deletePlayerSnapshotByName(players[id].name);
        if (removed) {
          try { logger.info('Permadeath: player removed from persistence', { name: players[id].name }); } catch {}
        }
        socket.emit('PERMA_DEATH', { hardcore: true });
      }
    }

    for (let pid in players) {
      if (players.hasOwnProperty(pid)) {
        let player = players[pid];
        if (player && player.name === attacker) {
          player.kills += 1;
        }
        if (player && player.pos && player.statBlock && player.statBlock.stats && typeof player.statBlock.stats.hearing === 'number') {
          let dx = player.pos.x - x;
          let dy = player.pos.y - y;
          let distance = Math.sqrt(dx * dx + dy * dy);
          if (distance <= 1115000 + player.statBlock.stats.hearing * 20) {
            io.to(pid).emit('NEW_CHAT_MESSAGE', {
              message: name + ' Has been killed by ' + attacker,
              x, y, user: 'SERVER',
            });
          }
        }
      }
    }

    io.emit('PLAYER_MARKED_DEAD', { id });
  });
}

module.exports = { register };
