const express = require('express');
const socket = require('socket.io');
const cors = require('cors');
const { validColors } = require('./utils/color');
const { Map, Chunk, Placeable, TILESIZE, CHUNKSIZE } = require('./utils/map');
const { saveState, loadState } = require('./utils/persistence');
const { getGlobals } = require('./globals'); // Ensure correct import
const { exec } = require('child_process');
const globals = getGlobals(); // Now it correctly retrieves global variables
let { players, serverMap, chatMessages, teams } = globals;
var kills_deaths = {};

const dotenv = require('dotenv');
dotenv.config();

// Timer/Restart configuration
const SERVER_TIME_ENV = process.env.SERVER_TIME;
// Disable timer if missing/empty or explicitly set to "NO TIME"
const TIMER_DISABLED = !SERVER_TIME_ENV || (typeof SERVER_TIME_ENV === 'string' && SERVER_TIME_ENV.toUpperCase() === 'NO TIME');
const RESTART_ON_TIMER = (process.env.RESTART_ON_TIMER || 'true').toLowerCase() === 'true';

let countdown;
if (TIMER_DISABLED) {
  countdown = 0;
} else {
  const parsed = Number(SERVER_TIME_ENV);
  countdown = Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 60 * 24 * 10000; // default very long
}
console.log(TIMER_DISABLED ? 'Timer disabled' : `COUNT: ${countdown}`);
const allRoutes = require('./api/routes/Routes');
const port = process.env.PORT || 3000;
const app = express();
const MAX_PLAYERS = parseInt(process.env.MAX, 10) || 10;
const SAVE_INTERVAL_HOURS = parseFloat(process.env.SAVE_INTERVAL_HOURS || '3');

// ✅ Basic bad word filter (case-insensitive)
const badWords = ['shit', 'fuck', 'bitch', 'cunt', 'nigg', 'asshole', 'cock', 'dick', 'fag'];
const badWordRegex = new RegExp(badWords.join('|'), 'i');

app.use(
  cors({
    origin: true, // This automatically reflects the request's origin
    methods: ['GET', 'POST'],
    credentials: true,
  }),
);

const ServerWelcomeMessage = process.env.Server_Welcome || 'Please Welcome';
const path = require('path');

// Serve static files using an absolute path
app.use(express.static(path.join(__dirname, '../Holes_Client')));
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on http://localhost:${port}`);
});

// Configure Socket.io with CORS
const io = socket(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

io.sockets.on('connection', newConnection);

app.use(allRoutes);

// Attempt to load saved world state on startup
(function bootstrapLoad() {
  try {
    const loaded = loadState();
    if (loaded && loaded.serverMap) {
      // Reconstruct serverMap from saved data
      const seed = loaded.serverMap.seed || Math.random();
      serverMap = new Map(seed);

      const keys = Object.keys(loaded.serverMap.chunks || {});
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const raw = loaded.serverMap.chunks[key];
        const ch = new Chunk(raw.cx, raw.cy);
        ch.data = raw.data || {};
        ch.iron_data = raw.iron_data || {};
        ch.objects = raw.objects || [];
        ch.projectiles = raw.projectiles || [];
        ch.soundObjs = raw.soundObjs || [];
        serverMap.chunks[key] = ch;
      }

      serverMap.brains = loaded.serverMap.brains || [];

      // Restore teams if present
      teams = loaded.teams || teams;

      // Keep globals in sync
      globals.serverMap = serverMap;
      globals.teams = teams;

      console.log('[Persistence] World state loaded with', keys.length, 'chunks');
    } else {
      console.log('[Persistence] No saved world found, starting fresh');
    }
  } catch (e) {
    console.error('[Persistence] Failed to load world state:', e);
  }
})();

// Periodic autosave
setInterval(() => {
  const ok = saveState({ players, serverMap, chatMessages, teams });
  if (ok) {
    console.log('[Persistence] Autosaved world state');
  }
}, Math.max(0.1, SAVE_INTERVAL_HOURS) * 60 * 60 * 1000);

// Save on graceful shutdown
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    console.log(`[Persistence] Received ${sig}, saving world state...`);
    try { saveState({ players, serverMap, chatMessages, teams }); } catch {}
    process.exit(0);
  });
});

function newConnection(socket) {
  try {
    //all caps means it came from the server
    //all lower means it came from the client

    // Enforce max players: if full, notify and disconnect immediately
    const currentPlayers = Object.keys(players).length;
    if (currentPlayers >= MAX_PLAYERS) {
      io.to(socket.id).emit('SERVER_FULL', {
        message: 'Server is full. Please try again later.',
        current: currentPlayers,
        max: MAX_PLAYERS,
      });
      setTimeout(() => socket.disconnect(true), 100);
      return;
    }

    console.log('New connection: ' + socket.id);
    io.to(socket.id).emit('OLD_DATA', { players: players }); //maybe add old chat messages here?
    io.to(socket.id).emit('YOUR_ID', { id: socket.id });

    if (TIMER_DISABLED) {
      io.to(socket.id).emit('sync_time', { disabled: true });
    } else {
      const minutes = Math.floor(countdown / 60);
      const seconds = countdown % 60;
      io.to(socket.id).emit('sync_time', { minutes, seconds, totalSeconds: countdown });
    }

    socket.on('new_player', new_player);
    function new_player(data) {
      // Double-check capacity at the moment of joining
      const nowPlayers = Object.keys(players).length;
      if (nowPlayers >= MAX_PLAYERS) {
        io.to(socket.id).emit('SERVER_FULL', {
          message: 'Server is full. Please try again later.',
          current: nowPlayers,
          max: MAX_PLAYERS,
        });
        setTimeout(() => socket.disconnect(true), 100);
        return;
      }

      const originalName = data.name;
      let name = originalName;
      let suffix = 1;

      // Replace bad words with asterisks or generic fallback
      if (badWordRegex.test(name)) {
        name = 'Player' + Math.random();
      }

      // ✅ Ensure uniqueness
      const nameExists = (n) => {
        return Object.values(players).some((player) => player && player.name === n);
      };

      while (nameExists(name)) {
        name = `${originalName}_${suffix}`;
        suffix++;
      }

      // ✅ Only notify if the name was changed
      if (name !== originalName) {
        io.to(socket.id).emit('change_name', name);
      }

      data.name = name;
      data.kills = 0;
      data.deaths = 0;
      players[data.id] = data;

      socket.broadcast.emit('NEW_PLAYER', data);

      io.emit('NEW_CHAT_MESSAGE', {
        message: `${ServerWelcomeMessage} ${data.name}`,
        x: 0,
        y: 0,
        user: 'SERVER',
      });
    }

    socket.on('player_reconnected', player_reconnected);
    function player_reconnected(data) {
      players[data.player.id] = data.player;
      if (kills_deaths[data.oldID] != undefined) {
        players[data.player.id].kills = kills_deaths[data.oldID].kills;
        players[data.player.id].deaths = kills_deaths[data.oldID].deaths;
        delete kills_deaths[data.oldID];
      } else {
        players[data.player.id].kills = 0;
        players[data.player.id].deaths = 0;
      }

      socket.broadcast.emit('NEW_PLAYER', data.player);
      socket.broadcast.emit('PLAYERS_CHECK', {
        ids: Object.keys(players),
      });
    }

    socket.on('disconnect', disconnect);

    function disconnect(data) {
      console.log(socket.id + ' disconnected');
      if (players[socket.id] != undefined) {
        console.log(
          '{\n' +
            '   id: ' +
            players[socket.id].id +
            '\n   name: ' +
            players[socket.id].name +
            '\n   kills: ' +
            players[socket.id].kills +
            '\n   deaths: ' +
            players[socket.id].deaths +
            '\n}',
        );
        kills_deaths[socket.id] = {
          kills: players[socket.id].kills,
          deaths: players[socket.id].deaths,
        };
      }

      players[socket.id] = [];
      delete players[socket.id];

      io.emit('REMOVE_PLAYER', socket.id);
    }

    socket.on('update_pos', update_pos);

    function update_pos(data) {
      if (!players[data.id]) {
        console.error(`Player with id ${data.id} not found.`);
        return;
      }

      players[data.id].pos = data.pos;
      players[data.id].holding = data.holding;

      // Broadcast the updated position to other clients
      socket.broadcast.emit('UPDATE_POS', data);
    }

    socket.on('update_player', update_player);

    function update_player(data) {
      if (!players[data.id]) {
        console.error(`Player with id ${data.id} not found.`);
        return;
      }

      for (let i = 0; i < data.update_names.length; i++) {
        if (data.update_names[i].includes('stats')) {
          players[data.id].statBlock.stats[data.update_names[i].split('stats.')[1]] =
            data.update_values[i];
        } else if (data.update_names[i].includes('statBlock')) {
          console.log("statBlock update", data.update_names[i], data.update_values[i]);
          players[data.id].statBlock[data.update_names[i].split('statBlock.')[1]] =
            data.update_values[i];
        } else {
          players[data.id][data.update_names[i]] = data.update_values[i];
        }
      }
      players[data.id].pos = data.pos;
      players[data.id].holding = data.holding;

      // Broadcast the updated value to other clients
      socket.broadcast.emit('UPDATE_PLAYER', data);
    }

    // Team management handlers
    socket.on('create_team', (data) => {
      const { name, color } = data;
      const playerData = players[socket.id];
      
      if (!playerData) return;

      // Generate unique team ID
      const teamId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      
      teams[teamId] = {
        id: teamId,
        name: name,
        color: color, // { r, g, b }
        creator: socket.id,
        creatorName: playerData.name,
        members: [socket.id],
        requests: []
      };

      // Update player's team
      playerData.teamId = teamId;
      playerData.color = 0; // Custom color, index 0 will be overridden by teamColor

      io.emit('TEAM_CREATED', { teamId, team: teams[teamId] });
      io.emit('TEAMS_UPDATE', { teams });
      
      socket.emit('TEAM_JOINED', { teamId, team: teams[teamId] });
    });

    socket.on('request_join_team', (data) => {
      const { teamId } = data;
      const playerData = players[socket.id];
      
      if (!playerData || !teams[teamId]) return;
      
      // Check if already in a team
      if (playerData.teamId) {
        socket.emit('TEAM_ERROR', { message: 'Already in a team. Leave your current team first.' });
        return;
      }

      // Check if already requested
      if (teams[teamId].requests.includes(socket.id)) {
        socket.emit('TEAM_ERROR', { message: 'Already requested to join this team.' });
        return;
      }

      teams[teamId].requests.push(socket.id);
      
      // Notify team creator
      io.to(teams[teamId].creator).emit('TEAM_REQUEST', {
        teamId,
        playerId: socket.id,
        playerName: playerData.name
      });

      socket.emit('TEAM_REQUEST_SENT', { teamId });
    });

    socket.on('accept_team_request', (data) => {
      const { teamId, playerId } = data;
      const team = teams[teamId];
      const playerData = players[playerId];
      
      if (!team || !playerData) return;
      
      // Check if requester is the creator
      if (team.creator !== socket.id) {
        socket.emit('TEAM_ERROR', { message: 'Only team creator can accept requests.' });
        return;
      }

      // Remove from requests
      team.requests = team.requests.filter(id => id !== playerId);
      
      // Add to members
      team.members.push(playerId);
      playerData.teamId = teamId;

      io.emit('TEAMS_UPDATE', { teams });
      io.to(playerId).emit('TEAM_JOINED', { teamId, team });
    });

    socket.on('deny_team_request', (data) => {
      const { teamId, playerId } = data;
      const team = teams[teamId];
      
      if (!team) return;
      
      // Check if requester is the creator
      if (team.creator !== socket.id) return;

      // Remove from requests
      team.requests = team.requests.filter(id => id !== playerId);
      
      io.to(playerId).emit('TEAM_REQUEST_DENIED', { teamId });
    });

    socket.on('leave_team', () => {
      const playerData = players[socket.id];
      
      if (!playerData || !playerData.teamId) return;
      
      const teamId = playerData.teamId;
      const team = teams[teamId];
      
      if (!team) return;

      // Remove from members
      team.members = team.members.filter(id => id !== socket.id);
      playerData.teamId = null;
      playerData.color = 0; // Reset to no team

      // If creator leaves, disband team
      if (team.creator === socket.id) {
        // Notify all members
        team.members.forEach(memberId => {
          if (players[memberId]) {
            players[memberId].teamId = null;
            players[memberId].color = 0;
            io.to(memberId).emit('TEAM_DISBANDED', { teamId });
          }
        });
        delete teams[teamId];
      }

      io.emit('TEAMS_UPDATE', { teams });
      socket.emit('TEAM_LEFT', { teamId });
    });

    socket.on('update_team', (data) => {
      const { teamId, name, color } = data;
      const team = teams[teamId];
      
      if (!team) return;
      
      // Check if requester is the creator
      if (team.creator !== socket.id) {
        socket.emit('TEAM_ERROR', { message: 'Only team creator can update team.' });
        return;
      }

      if (name) team.name = name;
      if (color) team.color = color;

      io.emit('TEAMS_UPDATE', { teams });
    });

    socket.on('get_teams', () => {
      socket.emit('TEAMS_UPDATE', { teams });
    });

    socket.on('update_node', update_node);

    function update_node(data) {
      let chunkPos = data.chunkPos.split(',');
      chunkPos[0] = parseInt(chunkPos[0]);
      chunkPos[1] = parseInt(chunkPos[1]);
      let chunk = serverMap.getChunk(chunkPos[0], chunkPos[1]);

      if (data.amt > 0) {
        if (chunk.data[data.index] > 0) chunk.data[data.index] -= data.amt;
        if (chunk.data[data.index] < 0.3 && chunk.data[data.index] !== -1) {
          chunk.data[data.index] = 0;
        }
      } else {
        if (chunk.data[data.index] < 1.3 && chunk.data[data.index] !== -1) {
          chunk.data[data.index] -= data.amt;
        }
        if (chunk.data[data.index] > 1.3) {
          chunk.data[data.index] = 1.3;
        }
      }

      io.emit('UPDATE_NODE', data);
    }

    socket.on('update_iron_node', update_iron_node);

    function update_iron_node(data) {
      let chunkPos = data.chunkPos.split(',');
      chunkPos[0] = parseInt(chunkPos[0]);
      chunkPos[1] = parseInt(chunkPos[1]);
      let chunk = serverMap.getChunk(chunkPos[0], chunkPos[1]);

      if (data.amt > 0) {
        if (chunk.iron_data[data.index] > 0) chunk.iron_data[data.index] -= data.amt;
        if (chunk.iron_data[data.index] < 0.3 && chunk.iron_data[data.index] !== -1) {
          chunk.iron_data[data.index] = 0;
        }
      } else {
        if (chunk.iron_data[data.index] < 1.3 && chunk.iron_data[data.index] !== -1) {
          chunk.iron_data[data.index] -= data.amt;
        }
        if (chunk.iron_data[data.index] > 1.3) {
          chunk.iron_data[data.index] = 1.3;
        }
      }

      io.emit('UPDATE_IRON_NODE', data);
    }

    socket.on('update_nodes', update_nodes);

    function update_nodes(data) {
      //console.log("update nodes", data);
      let chunk = serverMap.getChunk(data.cx, data.cy);
      let posX = Math.round(data.pos.x / TILESIZE);
      let posY = Math.round(data.pos.y / TILESIZE);
      posX = posX - data.cx * CHUNKSIZE;
      posY = posY - data.cy * CHUNKSIZE;
      for (let x = posX - data.radius; x <= posX + data.radius; x++) {
        for (let y = posY - data.radius; y <= posY + data.radius; y++) {
          if (x >= 0 && x < CHUNKSIZE && y >= 0 && y < CHUNKSIZE) {
            let index = x + y / CHUNKSIZE;
            if (data.amt > 0) {
              if (chunk.data[index] > 0) chunk.data[index] -= data.amt;
              if (chunk.data[index] < 0.3 && chunk.data[index] !== -1) {
                chunk.data[index] = 0;
              }
            } else {
              if (chunk.data[index] < 1.3 && chunk.data[index] !== -1) {
                chunk.data[index] -= data.amt;
              }
              if (chunk.data[index] > 1.3) {
                chunk.data[index] = 1.3;
              }
            }
          } else {
            //deal with the edge cases where the node is outside the chunk
            let tempChunk;
            let index;
            if (y < 0 && x >= 0 && x < CHUNKSIZE) {
              // top edge
              tempChunk = serverMap.getChunk(data.cx, data.cy - 1);
              index = x + 1 + y / CHUNKSIZE;
            } else if (y >= CHUNKSIZE && x >= 0 && x < CHUNKSIZE) {
              // bottom edge
              tempChunk = serverMap.getChunk(data.cx, data.cy + 1);
              index = x + -1 + y / CHUNKSIZE;
            } else if (x < 0 && y >= 0 && y < CHUNKSIZE) {
              // left edge
              tempChunk = serverMap.getChunk(data.cx - 1, data.cy);
              index = x + CHUNKSIZE + y / CHUNKSIZE;
            } else if (x >= CHUNKSIZE && y >= 0 && y < CHUNKSIZE) {
              // right edge
              tempChunk = serverMap.getChunk(data.cx + 1, data.cy);
              index = x - CHUNKSIZE + y / CHUNKSIZE;
            } else if (x < 0 && y < 0) {
              // top left corner
              tempChunk = serverMap.getChunk(data.cx - 1, data.cy - 1);
              index = x + CHUNKSIZE + 1 + y / CHUNKSIZE;
            } else if (x >= CHUNKSIZE && y < 0) {
              // top right corner
              tempChunk = serverMap.getChunk(data.cx + 1, data.cy - 1);
              index = x - CHUNKSIZE + 1 + y / CHUNKSIZE;
            } else if (x < 0 && y >= CHUNKSIZE) {
              // bottom left corner
              tempChunk = serverMap.getChunk(data.cx - 1, data.cy + 1);
              index = x + CHUNKSIZE + -1 + y / CHUNKSIZE;
            } else if (x >= CHUNKSIZE && y >= CHUNKSIZE) {
              // bottom right corner
              tempChunk = serverMap.getChunk(data.cx + 1, data.cy + 1);
              index = x - CHUNKSIZE + -1 + y / CHUNKSIZE;
            }
            if (tempChunk != undefined) {
              if (index != undefined) {
                if (data.amt > 0) {
                  if (tempChunk.data[index] > 0) tempChunk.data[index] -= data.amt;
                  if (tempChunk.data[index] < 0.3 && tempChunk.data[index] !== -1) {
                    tempChunk.data[index] = 0;
                  }
                } else {
                  if (tempChunk.data[index] < 1.3 && tempChunk.data[index] !== -1) {
                    tempChunk.data[index] -= data.amt;
                  }
                  if (tempChunk.data[index] > 1.3) {
                    tempChunk.data[index] = 1.3;
                  }
                }
              }
            }
          }
        }
      }

      io.emit('UPDATE_NODES', data);
    }

    socket.on('update_iron_nodes', update_iron_nodes);

    function update_iron_nodes(data) {
      //console.log("update nodes", data);
      let chunk = serverMap.getChunk(data.cx, data.cy);
      let posX = Math.round(data.pos.x / TILESIZE);
      let posY = Math.round(data.pos.y / TILESIZE);
      posX = posX - data.cx * CHUNKSIZE;
      posY = posY - data.cy * CHUNKSIZE;

      let reward = 0;
      for (let x = posX - data.radius; x <= posX + data.radius; x++) {
        for (let y = posY - data.radius; y <= posY + data.radius; y++) {
          if (x >= 0 && x < CHUNKSIZE && y >= 0 && y < CHUNKSIZE) {
            let index = x + y / CHUNKSIZE;
            if (data.amt > 0) {
              if (chunk.iron_data[index] > 0) {
                reward += chunk.iron_data[index];
                chunk.iron_data[index] -= data.amt;
              }
              if (chunk.iron_data[index] < 0.3 && chunk.iron_data[index] !== -1) {
                chunk.iron_data[index] = 0;
              }
            } else {
              if (chunk.iron_data[index] < 1.3 && chunk.iron_data[index] !== -1) {
                chunk.iron_data[index] -= data.amt;
              }
              if (chunk.iron_data[index] > 1.3) {
                chunk.iron_data[index] = 1.3;
              }
            }
          } else {
            //deal with the edge cases where the node is outside the chunk
            let tempChunk;
            let index;
            if (y < 0 && x >= 0 && x < CHUNKSIZE) {
              // top edge
              tempChunk = serverMap.getChunk(data.cx, data.cy - 1);
              index = x + 1 + y / CHUNKSIZE;
            } else if (y >= CHUNKSIZE && x >= 0 && x < CHUNKSIZE) {
              // bottom edge
              tempChunk = serverMap.getChunk(data.cx, data.cy + 1);
              index = x + -1 + y / CHUNKSIZE;
            } else if (x < 0 && y >= 0 && y < CHUNKSIZE) {
              // left edge
              tempChunk = serverMap.getChunk(data.cx - 1, data.cy);
              index = x + CHUNKSIZE + y / CHUNKSIZE;
            } else if (x >= CHUNKSIZE && y >= 0 && y < CHUNKSIZE) {
              // right edge
              tempChunk = serverMap.getChunk(data.cx + 1, data.cy);
              index = x - CHUNKSIZE + y / CHUNKSIZE;
            } else if (x < 0 && y < 0) {
              // top left corner
              tempChunk = serverMap.getChunk(data.cx - 1, data.cy - 1);
              index = x + CHUNKSIZE + 1 + y / CHUNKSIZE;
            } else if (x >= CHUNKSIZE && y < 0) {
              // top right corner
              tempChunk = serverMap.getChunk(data.cx + 1, data.cy - 1);
              index = x - CHUNKSIZE + 1 + y / CHUNKSIZE;
            } else if (x < 0 && y >= CHUNKSIZE) {
              // bottom left corner
              tempChunk = serverMap.getChunk(data.cx - 1, data.cy + 1);
              index = x + CHUNKSIZE + -1 + y / CHUNKSIZE;
            } else if (x >= CHUNKSIZE && y >= CHUNKSIZE) {
              // bottom right corner
              tempChunk = serverMap.getChunk(data.cx + 1, data.cy + 1);
              index = x - CHUNKSIZE + -1 + y / CHUNKSIZE;
            }
            if (tempChunk != undefined) {
              if (index != undefined) {
                if (data.amt > 0) {
                  if (tempChunk.iron_data[index] > 0) {
                    reward += tempChunk.iron_data[index];
                    tempChunk.iron_data[index] -= data.amt;
                  }
                  if (tempChunk.iron_data[index] < 0.3 && tempChunk.iron_data[index] !== -1) {
                    tempChunk.iron_data[index] = 0;
                  }
                } else {
                  if (tempChunk.iron_data[index] < 1.3 && tempChunk.iron_data[index] !== -1) {
                    tempChunk.iron_data[index] -= data.amt;
                  }
                  if (tempChunk.iron_data[index] > 1.3) {
                    tempChunk.iron_data[index] = 1.3;
                  }
                }
              }
            }
          }
        }
      }

      if (reward > 0) {
        let itemBag = new Placeable(
          'ItemBag',
          data.pos.x,
          data.pos.y,
          0,
          12 * 3,
          13 * 3,
          1,
          11,
          '',
          '',
        );
        itemBag.type = 'InvObj';
        itemBag.invBlock = { items: {} };
        itemBag.invBlock.invId = Math.random() * 100000;
        itemBag.invBlock.items['Raw Metal'] = {};
        itemBag.invBlock.items['Raw Metal'].amount = Math.round(reward * 0.2) + 1;
        chunk.objects.push(itemBag);
        io.emit('NEW_OBJECT', {
          cx: chunk.cx,
          cy: chunk.cy,
          obj: itemBag,
        });
      }
      io.emit('UPDATE_IRON_NODES', data);
    }

    socket.on('new_object', new_object);

    function new_object(data) {
      let chunk = serverMap.getChunk(data.cx, data.cy);
      chunk.objects.push(data.obj);

      socket.broadcast.emit('NEW_OBJECT', data);
    }

    socket.on('delete_obj', delete_obj);

    function delete_obj(data) {
      //console.log(data);
      let chunk = serverMap.getChunk(data.cx, data.cy);
      for (let i = chunk.objects.length - 1; i >= 0; i--) {
        if (data.objName == 'ExpOrb') {
          if (data.z == chunk.objects[i].z && data.id == chunk.objects[i].id) {
            io.emit('DELETE_OBJ', data);
            chunk.objects.splice(i, 1);
            spawnItemBag(chunk, data);
          }
        } else if (data.brainID != undefined) {
          if (data.z == chunk.objects[i].z && data.brainID == chunk.objects[i].brainID) {
            io.emit('DELETE_OBJ', data);
            chunk.objects.splice(i, 1);
            spawnItemBag(chunk, data);
          }
        } else {
          if (
            data.pos.x == chunk.objects[i].pos.x &&
            data.pos.y == chunk.objects[i].pos.y &&
            data.z == chunk.objects[i].z &&
            data.objName == chunk.objects[i].objName
          ) {
            io.emit('DELETE_OBJ', data);
            chunk.objects.splice(i, 1);
            spawnItemBag(chunk, data);
          }
        }
      }
    }

    function spawnItemBag(chunk, data) {
      if (data.cost != undefined) {
        if (data.cost.length > 0) {
          let itemBag = new Placeable(
            'ItemBag',
            data.pos.x,
            data.pos.y,
            0,
            12 * 3,
            13 * 3,
            1,
            11,
            '',
            '',
          );
          itemBag.type = 'InvObj';
          itemBag.invBlock = { items: {} };
          itemBag.invBlock.invId = Math.random() * 100000;
          for (let i = 0; i < data.cost.length; i++) {
            if (data.cost[i][0] == 'dirt') {
            } else {
              if (data.cost[i][1] >= 1) {
                itemBag.invBlock.items[data.cost[i][0]] = {};
                itemBag.invBlock.items[data.cost[i][0]].amount = Math.round(
                  data.cost[i][1] * (Math.random() * 0.4 + 0.5),
                );
              } else {
                if (Math.random() < data.cost[i][1]) {
                  itemBag.invBlock.items[data.cost[i][0]] = {};
                  itemBag.invBlock.items[data.cost[i][0]].amount = 1;
                }
              }
            }
          }
          chunk.objects.push(itemBag);
          io.emit('NEW_OBJECT', {
            cx: chunk.cx,
            cy: chunk.cy,
            obj: itemBag,
          });
        }
      }

      mergeAllChunkBags();
    }

    socket.on('update_obj', update_obj);

    function update_obj(data) {
      let chunk = serverMap.getChunk(data.cx, data.cy);
      for (let i = chunk.objects.length - 1; i >= 0; i--) {
        if (data.objName == 'ExpOrb') {
          if (data.z == chunk.objects[i].z && data.id == chunk.objects[i].id) {
            chunk.objects[i][data.update_name] = data.update_value;
            chunk.objects[i].pos.x = data.pos.x;
            chunk.objects[i].pos.y = data.pos.y;
            socket.broadcast.emit('UPDATE_OBJ', data);
          }
        } else if (data.brainID != undefined) {
          //console.log(data);
          if (data.z == chunk.objects[i].z && data.brainID == chunk.objects[i].brainID) {
            chunk.objects[i][data.update_name] = data.update_value;
            chunk.objects[i].pos.x = data.pos.x;
            chunk.objects[i].pos.y = data.pos.y;
            //socket.broadcast.emit("UPDATE_OBJ", data);
          }
        } else {
          if (
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
    }

    socket.on('update_inv', update_inv);

    function sanitizeItems(items) {
      const cleaned = {};
      if (!items || typeof items !== 'object') return cleaned;
      for (const k of Object.keys(items)) {
        const v = items[k];
        const amt = v && typeof v.amount === 'number' ? v.amount : Number(v?.amount);
        if (Number.isFinite(amt) && amt > 0) cleaned[k] = { amount: Math.floor(amt) };
      }
      return cleaned;
    }

    function update_inv(data) {
      const chunk = serverMap.getChunk(data.cx, data.cy);
      if (!chunk || !Array.isArray(chunk.objects)) return;

      for (let i = chunk.objects.length - 1; i >= 0; i--) {
        const obj = chunk.objects[i];
        const idMatch =
          obj.invBlock && data.invId !== undefined && obj.invBlock.invId === data.invId;
        const posMatch =
          data.pos.x === obj.pos.x &&
          data.pos.y === obj.pos.y &&
          data.z === obj.z &&
          data.objName === obj.objName;

        const hasInventory = obj && (obj.invBlock || obj.objName === 'Chest' || obj.objName === 'ItemBag');

        if (hasInventory && (idMatch || posMatch)) {
          obj.invBlock = obj.invBlock || { items: {} };
          obj.invBlock.items = sanitizeItems(data.items);
          if (typeof obj.invBlock.invId !== 'number' && typeof data.invId === 'number') {
            obj.invBlock.invId = data.invId;
          }
          const payload = {
            cx: data.cx,
            cy: data.cy,
            objName: data.objName,
            pos: data.pos,
            z: data.z,
            invId: obj.invBlock.invId,
            items: obj.invBlock.items,
          };
          io.emit('UPDATE_INV', payload); // send to everyone, including sender
          break;
        }
      }
    }

    socket.on('new_proj', new_projectile);

    function new_projectile(data) {
      //add projectiles to server map
      let chunk = serverMap.getChunk(data.cPos.x, data.cPos.y);
      chunk.projectiles.push(data);
      socket.broadcast.emit('NEW_PROJECTILE', data);
    }

    socket.on('delete_proj', delete_projectile);

    function delete_projectile(data) {
      let chunk = serverMap.getChunk(data.cPos.x, data.cPos.y);
      for (let i = chunk.projectiles.length - 1; i >= 0; i--) {
        if (
          data.id == chunk.projectiles[i].id &&
          data.lifeSpan == chunk.projectiles[i].lifeSpan &&
          data.name == chunk.projectiles[i].name &&
          data.ownerName == chunk.projectiles[i].ownerName
        ) {
          socket.broadcast.emit('DELETE_PROJ', data);
          chunk.projectiles.splice(i, 1);
        }
      }
    }

    socket.on('new_sound', new_sound);

    function new_sound(data) {
      //add sounds to server map
      let chunk = serverMap.getChunk(data.cPos.x, data.cPos.y);
      chunk.soundObjs.push(data);
      socket.broadcast.emit('NEW_SOUND', data);
    }

    socket.on('delete_sound', delete_sound);

    function delete_sound(data) {
      let chunk = serverMap.getChunk(data.cPos.x, data.cPos.y);
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
    }

    socket.on('wander_request', wander_request);

    function wander_request(data) {
      for (let i = 0; i < serverMap.brains.length; i++) {
        if (data.id == serverMap.brains[i].id) {
          let angle = Math.random() * 2 * Math.PI;
          let target = {
            x: data.pos.x + Math.cos(angle) * 100,
            y: data.pos.y + Math.sin(angle) * 100,
          };

          io.emit('WANDER_TARGET', { id: data.id, target: target });
          serverMap.brains[i].target = target;

          i = serverMap.brains.length;
        }
      }
    }

    socket.on('get_chunk', get_chunk);

    function get_chunk(data) {
      let pos = data.split(',');
      pos[0] = parseInt(pos[0]);
      pos[1] = parseInt(pos[1]);
      let chunk = serverMap.getChunk(pos[0], pos[1]);
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
        x: pos[0],
        y: pos[1],
        data: tempData,
        iron_data: tempData2,
        objects: chunk.objects,
        projectiles: chunk.projectiles,
      });
    }

    socket.on('get_portals', get_portals);

    function get_portals(data) {
      let portals = [];
      for (let y = data.cPos.y - 5; y <= data.cPos.y + 5; y++) {
        for (let x = data.cPos.x - 5; x <= data.cPos.x + 5; x++) {
          if (serverMap.chunks['' + x + ',' + y] != undefined) {
            let chunk = serverMap.chunks['' + x + ',' + y];
            for (let i = 0; i < chunk.objects.length; i++) {
              if (chunk.objects[i].objName == 'Portal') {
                portals.push({
                  cx: x,
                  cy: y,
                  pos: chunk.objects[i].pos,
                  color: chunk.objects[i].color,
                });
              }
            }
          }
        }
      }
      io.to(socket.id).emit('GIVE_PORTALS', { portals: portals });
    }

    socket.on('send_message', send_message);

    function send_message(data) {
      //console.log("send", data);
      // Expecting data in the format "x,y,message"
      let parts = data.split(',');
      let x = parseFloat(parts[0]);
      let y = parseFloat(parts[1]);
      let message = parts.slice(2).join(','); // Handles commas in the message

      // Retrieve the sender's name if available; otherwise, fallback to socket.id.
      let user =
        players[socket.id] && players[socket.id].name ? players[socket.id].name : socket.id;

      // Create the chat message object.
      let chatMsg = { message, x, y, user };

      console.log("send", chatMsg);

      // For each connected player, check if they are within hearing distance.
      for (let id in players) {
        //console.log(id)
        if (players.hasOwnProperty(id)) {
          let player = players[id];
          //console.log(id)
          // Ensure player has a position and hearing range defined
          if (player && player.pos && typeof player.statBlock.stats.hearing === 'number') {
            //console.log("num")
            let dx = player.pos.x - x;
            let dy = player.pos.y - y;
            let distance = Math.sqrt(dx * dx + dy * dy);
            //console.log("NUMBERS",distance, player.statBlock.stats.hearing*20)
            // If the player is within their hearing range, send the chat message.
            if (
              distance <=
              5000 +
                player.statBlock.stats.hearing *
                  20 *
                  players[socket.id].statBlock.stats.speakingRange
            ) {
              //console.log("???????",chatMsg)
              //console.log(chatMsg)
              //check chat message to bad words
              if (badWordRegex.test(chatMsg.message)) {
                chatMsg.message = 'I curse at you !!!';
              }

              io.to(id).emit('NEW_CHAT_MESSAGE', chatMsg);
            }
          }
        }
      }
    }

    //death sockets Player_Dies
    socket.on('player_dies', (data) => {
      //console.log(data);
      const { x, y, id, attacker, name } = data;
      //console.log("die mentions",x,y,id,attacker,name);
      // Mark the player as dead in the server-side state (optional, depends on your logic)
      if (players[id]) {
        players[id].isDead = true; // or players[id].status = "dead", etc.
        players[id].deaths += 1;
      }
      // Notify all players within range of the death
      for (let pid in players) {
        if (players.hasOwnProperty(pid)) {
          let player = players[pid];
          if (player.name == attacker) {
            player.kills += 1;
            //console.log(player.name, player.kills)
          }
          if (player && player.pos && typeof player.statBlock.stats.hearing === 'number') {
            let dx = player.pos.x - x;
            let dy = player.pos.y - y;
            let distance = Math.sqrt(dx * dx + dy * dy);
            //console.log(distance)
            if (distance <= 1115000 + player.statBlock.stats.hearing * 20) {
              //console.log(name + " Has been killed by " + attacker , x,y )

              //console.log(player.name, player.kills)

              io.to(pid).emit('NEW_CHAT_MESSAGE', {
                message: name + ' Has been killed by ' + attacker,
                x,
                y,
                user: 'SERVER',
              });
            } else {
              //console.log("s2")
            }
          }
        } else {
          //console.log("????")
        }
      }

      // Instruct all clients to update the player’s render status
      io.emit('PLAYER_MARKED_DEAD', { id });
    });
  } catch (e) {
    console.log(e);
  }
}

let resetCalled = false;
setInterval(() => {
  // If timer is disabled, skip time-related broadcasting entirely
  if (TIMER_DISABLED) {
    return;
  }
  // Broadcast every minute
  if (countdown % 30 === 0 || countdown <= 15 / 2) {
    //console.log("heal plants");
    //get the keys of the serverMap chunks
    let keys = Object.keys(serverMap.chunks);
    // Loop through each chunk
    for (let i = 0; i < keys.length; i++) {
      let chunk = serverMap.chunks[keys[i]];
      // Loop through each tile in the chunk
      for (let j = 0; j < chunk.objects.length; j++) {
        if (
          chunk.objects[j].type == 'Plant' ||
          chunk.objects[j].objName == 'Tree' ||
          chunk.objects[j].objName == 'AppleTree'
        ) {
          if (chunk.objects[j].hp < chunk.objects[j].mhp) {
            chunk.objects[j].hp += 5; // Heal the plant by 0.1 HP
            if (chunk.objects[j].hp > chunk.objects[j].mhp) {
              chunk.objects[j].hp = chunk.objects[j].mhp; // Cap the HP at max HP
            }
          }
        }
      }
    }
    io.emit('HEAL_PLANTS', {});
  }

  // Grant XP to all entities every minute
  if (countdown % 60 === 0) {
    let keys = Object.keys(serverMap.chunks);
    for (let i = 0; i < keys.length; i++) {
      let chunk = serverMap.chunks[keys[i]];
      for (let j = 0; j < chunk.objects.length; j++) {
        let obj = chunk.objects[j];
        // Check if it's an entity (has brainID)
        if (obj.brainID !== undefined && obj.level !== undefined) {
          obj.xp += 10; // Grant 10 XP per minute
          
          // Level up if needed
          while (obj.xp >= obj.xpNeeded) {
            obj.level++;
            obj.xp = 0;
            obj.xpNeeded = Math.floor(obj.xpNeeded * 1.5);
            
            // Increase stats on level up
            obj.hp += 10;
            obj.mhp += 10;
          }
          
          // Broadcast entity level update
          io.emit('ENTITY_LEVEL_UPDATE', {
            cx: chunk.cx,
            cy: chunk.cy,
            objPos: obj.pos,
            level: obj.level,
            xp: obj.xp,
            hp: obj.hp,
            mhp: obj.mhp
          });
        }
      }
    }
  }

  // Broadcast every minute
  if (countdown % 60 === 0 || countdown <= 15) {
    console.log(countdown, "count down")
    io.emit('sync_time', {
      totalSeconds: countdown,
    });
  }

  // At 1 minute left
  if (countdown === 60) {
    io.emit('NEW_CHAT_MESSAGE', {
      message: '⚠️ One minute left!',
      x: 0,
      y: 0,
      user: 'TIMER',
    });
  }

  // When timer hits 0, reset
  if (countdown <= 0) {
    if (!resetCalled) {
      io.emit('server_ended');
      resetCalled = true;

      // Start a fresh map and reset round timer if applicable
      serverMap = new Map(Math.random());
      countdown = 15 * 60;

      if (RESTART_ON_TIMER) {
        exec('pm2 restart holes-server', (err, stdout, stderr) => {
          if (err) {
            console.error(`Restart error: ${err.message}`);
            return;
          }
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
}, 1000); // Runs every second

function ensureItemBagSchema(bag) {
  if (!bag) return null;
  if (bag.objName !== 'ItemBag') return null; // Only normalize loot bags
  // It must be an inventory object with a position
  if (bag.type !== 'InvObj') bag.type = 'InvObj';
  if (!bag.objName) bag.objName = 'ItemBag';
  if (!bag.pos || typeof bag.pos.x !== 'number' || typeof bag.pos.y !== 'number') {
    // Can't safely keep a bag without coordinates
    return null;
  }
  if (typeof bag.z !== 'number') bag.z = 0;

  // Ensure inventory block + id + items shape
  if (!bag.invBlock || typeof bag.invBlock !== 'object') bag.invBlock = {};
  if (!bag.invBlock.items || typeof bag.invBlock.items !== 'object') bag.invBlock.items = {};
  if (typeof bag.invBlock.invId !== 'number') {
    // Keep an existing id if present (even as string); otherwise create one
    const existing = bag.invBlock.invId;
    bag.invBlock.invId = typeof existing === 'number' ? existing : Math.floor(Math.random() * 1e9);
  }

  // Sanitize items: numbers only, drop empties / NaN / <=0
  for (const k of Object.keys(bag.invBlock.items)) {
    const v = bag.invBlock.items[k];
    const amt = v && typeof v.amount === 'number' ? v.amount : Number(v?.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      delete bag.invBlock.items[k];
    } else {
      bag.invBlock.items[k] = { amount: Math.floor(amt) };
    }
  }

  return bag;
}

function mergeAllChunkBags() {
  const MERGE_DISTANCE = 120;

  for (const key in serverMap.chunks) {
    const chunk = serverMap.chunks[key];
    if (!chunk || !Array.isArray(chunk.objects)) continue;

    // Derive cx/cy for emits (fallback to key if missing on chunk)
    let cx = typeof chunk.cx === 'number' ? chunk.cx : undefined;
    let cy = typeof chunk.cy === 'number' ? chunk.cy : undefined;
    if (cx === undefined || cy === undefined) {
      const [kx, ky] = key.split(',').map((n) => parseInt(n, 10));
      if (!Number.isNaN(kx) && !Number.isNaN(ky)) {
        cx = kx;
        cy = ky;
      }
    }

    let mergedSomething = true;
    while (mergedSomething) {
      mergedSomething = false;

      for (let i = 0; i < chunk.objects.length; i++) {
        let bagA = chunk.objects[i];
        if (!bagA || bagA.type !== 'InvObj' || bagA.objName !== 'ItemBag') continue;

        bagA = ensureItemBagSchema(bagA);
        if (!bagA) {
          // If schema can't be ensured, delete this bad bag
          const removed = chunk.objects.splice(i, 1)[0];
          io.emit('DELETE_OBJ', {
            cx, cy,
            objName: removed?.objName || 'ItemBag',
            pos: removed?.pos || { x: 0, y: 0 },
            z: removed?.z ?? 0,
          });
          i--; // stay at same index
          continue;
        }
        // replace in array in case we normalized fields
        chunk.objects[i] = bagA;

        for (let j = i + 1; j < chunk.objects.length; j++) {
          let bagB = chunk.objects[j];
          if (!bagB || bagB.type !== 'InvObj' || bagB.objName !== 'ItemBag') continue;

          bagB = ensureItemBagSchema(bagB);
          if (!bagB) {
            // Just remove invalid bagB
            const removed = chunk.objects.splice(j, 1)[0];
            io.emit('DELETE_OBJ', {
              cx, cy,
              objName: removed?.objName || 'ItemBag',
              pos: removed?.pos || { x: 0, y: 0 },
              z: removed?.z ?? 0,
            });
            j--; // continue at same j index after splice
            continue;
          }
          chunk.objects[j] = bagB;

          const dx = bagA.pos.x - bagB.pos.x;
          const dy = bagA.pos.y - bagB.pos.y;
          const dist = Math.hypot(dx, dy);

          if (dist <= MERGE_DISTANCE) {
            // Merge B into A (sum amounts per key)
            for (const item of Object.keys(bagB.invBlock.items)) {
              const bAmt = bagB.invBlock.items[item]?.amount || 0;
              if (!bagA.invBlock.items[item]) bagA.invBlock.items[item] = { amount: 0 };
              bagA.invBlock.items[item].amount += bAmt;
            }

            // Remove empty items if any ended up <= 0
            for (const k of Object.keys(bagA.invBlock.items)) {
              if (!Number.isFinite(bagA.invBlock.items[k].amount) || bagA.invBlock.items[k].amount <= 0) {
                delete bagA.invBlock.items[k];
              } else {
                bagA.invBlock.items[k].amount = Math.floor(bagA.invBlock.items[k].amount);
              }
            }

            // Remove B from server state
            const removed = chunk.objects.splice(j, 1)[0];

            // Notify all clients: updated inventory for A
            io.emit('UPDATE_INV', {
              cx, cy,
              objName: bagA.objName,
              pos: { x: bagA.pos.x, y: bagA.pos.y },
              z: bagA.z,
              items: bagA.invBlock.items,
            });

            // And delete B
            io.emit('DELETE_OBJ', {
              cx, cy,
              objName: removed?.objName || 'ItemBag',
              pos: removed?.pos
                ? { x: removed.pos.x, y: removed.pos.y }
                : { x: bagB.pos.x, y: bagB.pos.y },
              z: removed?.z ?? bagB.z ?? 0,
            });

            console.log(
              `[mergeAllChunkBags] Merged (${bagB.pos.x},${bagB.pos.y}) -> (${bagA.pos.x},${bagA.pos.y}) in chunk ${key}`
            );

            mergedSomething = true;
            break; // restart inner loop for fresh indices
          }
        }

        if (mergedSomething) break; // restart outer loop
      }
    }
  }
}

