const { exec } = require('child_process');
const { Map: GameMap } = require('../utils/map');
const { chunkRoom, chunkCoordsFromPos } = require('../utils/chunkRooms');
const { normalizePos, cloneHolding, queueWorldSave, setSavedPlayers } = require('../utils/playerUtils');
const { clearState } = require('../utils/persistence');
const { TIMER_DISABLED, RESTART_ON_TIMER } = require('../utils/gameConfig');

/**
 * Start the 1-second game tick interval.
 * Returns an object with getCountdown/setCountdown for external access.
 */
function startGameLoop(ctx) {
  const { globals, broadcast } = ctx;
  let { countdown, timerEndAt } = ctx.timer;
  let preRestartSaved = false;
  let resetCalled = false;

  function refreshSummaryCache() {
    const teams = globals.teams;
    const snap = { teams, updatedAt: Date.now() };
    globals.summaryCache = snap;
    globals.playerSnapshotCache = snap.players || {};
    return snap;
  }

  const intervalId = setInterval(() => {
    if (TIMER_DISABLED) return;

    const players = globals.players;
    const io = broadcast.getIO();

    // Recompute countdown from end timestamp to reduce drift
    if (timerEndAt) {
      countdown = Math.max(0, Math.round((timerEndAt - Date.now()) / 1000));
    }

    // Health/Mana regeneration every 3 seconds
    if (countdown % 3 === 0) {
      Object.keys(players).forEach(id => {
        const p = players[id];
        if (!p || !p.statBlock || !p.statBlock.stats) return;

        const stats = p.statBlock.stats;
        let updated = false;
        const updateNames = [];
        const updateValues = [];

        if (stats.hp < stats.mhp && stats.healthRegen > 0) {
          stats.hp = Math.min(stats.hp + stats.healthRegen, stats.mhp);
          updateNames.push('stats.hp');
          updateValues.push(stats.hp);
          updated = true;
        }

        if (stats.mp < stats.mmp && stats.magic > 0) {
          const mpRegen = stats.magic * 0.1;
          stats.mp = Math.min(stats.mp + mpRegen, stats.mmp);
          updateNames.push('stats.mp');
          updateValues.push(stats.mp);
          updated = true;
        }

        if (updated) {
          const coords = chunkCoordsFromPos(p.pos);
          const payload = {
            id, pos: normalizePos(p.pos),
            holding: cloneHolding(p.holding),
            update_names: updateNames,
            update_values: updateValues
          };
          if (coords) {
            broadcast.emitToRoom(chunkRoom(coords.cx, coords.cy), 'UPDATE_PLAYER', payload);
          } else {
            broadcast.emitToAll('UPDATE_PLAYER', payload);
          }
        }
      });
    }

    // Plant healing every 30 seconds
    if (countdown % 30 === 0 || countdown <= 15 / 2) {
      const serverMap = globals.serverMap;
      let keys = Object.keys(serverMap.chunks);
      const healedRooms = new Set();
      for (let i = 0; i < keys.length; i++) {
        let chunk = serverMap.chunks[keys[i]];
        for (let j = 0; j < chunk.objects.length; j++) {
          if (
            chunk.objects[j].type == 'Plant' ||
            chunk.objects[j].objName == 'Tree' ||
            chunk.objects[j].objName == 'AppleTree'
          ) {
            if (chunk.objects[j].hp < chunk.objects[j].mhp) {
              chunk.objects[j].hp += 5;
              if (chunk.objects[j].hp > chunk.objects[j].mhp) {
                chunk.objects[j].hp = chunk.objects[j].mhp;
              }
              healedRooms.add(chunkRoom(chunk.cx, chunk.cy));
            }
          }
        }
      }
      for (const room of healedRooms) {
        broadcast.emitToRoom(room, 'HEAL_PLANTS', {});
      }
    }

    // Entity XP every 60 seconds
    if (countdown % 60 === 0) {
      const serverMap = globals.serverMap;
      let keys = Object.keys(serverMap.chunks);
      for (let i = 0; i < keys.length; i++) {
        let chunk = serverMap.chunks[keys[i]];
        for (let j = 0; j < chunk.objects.length; j++) {
          let obj = chunk.objects[j];
          if (obj.brainID !== undefined && obj.level !== undefined) {
            obj.xp += 10;
            while (obj.xp >= obj.xpNeeded) {
              obj.level++;
              obj.xp = 0;
              obj.xpNeeded = Math.floor(obj.xpNeeded * 1.5);
              obj.hp += 10;
              obj.mhp += 10;
            }
            const levelPayload = {
              cx: chunk.cx, cy: chunk.cy,
              objPos: obj.pos, level: obj.level,
              xp: obj.xp, hp: obj.hp, mhp: obj.mhp
            };
            broadcast.emitToRoom(chunkRoom(chunk.cx, chunk.cy), 'ENTITY_LEVEL_UPDATE', levelPayload);
          }
        }
      }
    }

    // Timer sync
    if (countdown % 5 === 0 || countdown <= 15) {
      broadcast.emitToAll('sync_time', { totalSeconds: countdown, endsAt: timerEndAt });
    }

    // Pre-restart snapshot
    if (countdown === 5 && !preRestartSaved) {
      const preSummary = refreshSummaryCache();
      preRestartSaved = true;
      io.emit('SERVER_SUMMARY', preSummary);
    }

    // 1 minute warning
    if (countdown === 60) {
      io.emit('NEW_CHAT_MESSAGE', {
        message: '⚠️ One minute left!', x: 0, y: 0, user: 'TIMER',
      });
    }

    // Round end
    if (countdown <= 0) {
      if (!resetCalled) {
        const finalSummary = refreshSummaryCache();
        io.emit('ROUND_END_STATE', {
          players: finalSummary.players,
          teams: finalSummary.teams,
          endedAt: finalSummary.updatedAt,
        });

        io.emit('server_ended');
        resetCalled = true;

        clearState();

        Object.keys(players).forEach((id) => delete players[id]);
        setSavedPlayers({});
        const { getKillsDeaths, setKillsDeaths } = require('../handlers/connectionHandlers');
        setKillsDeaths({});
        globals.chatMessages.length = 0;
        Object.keys(globals.teams).forEach((id) => delete globals.teams[id]);

        globals.serverMap = new GameMap(Math.random());
        countdown = 15 * 60;
        timerEndAt = Date.now() + countdown * 1000;
        preRestartSaved = false;
        resetCalled = false;

        if (RESTART_ON_TIMER) {
          exec('pm2 restart holes-server', (err, stdout, stderr) => {
            if (err) { console.error(`Restart error: ${err.message}`); return; }
            console.log(`Server restart stdout: ${stdout}`);
            if (stderr) console.error(`Server restart stderr: ${stderr}`);
          });
        } else {
          console.log('Timer ended — restart suppressed by RESTART_ON_TIMER=false');
        }
      }
    } else {
      countdown--;
    }
  }, 1000);

  return {
    getCountdown: () => countdown,
    getTimerEndAt: () => timerEndAt,
    intervalId,
  };
}

module.exports = { startGameLoop };
