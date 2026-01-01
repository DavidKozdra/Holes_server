const { getGlobals } = require('../../globals');
const dotenv = require('dotenv');
dotenv.config();


const globals = getGlobals();

function mapPlayers(source) {
  if (!source) return [];
  return Object.values(source)
    .filter(Boolean)
    .map((p) => ({
      name: p.name || 'Unknown',
      kills: Number.isFinite(p.kills) ? p.kills : 0,
      deaths: Number.isFinite(p.deaths) ? p.deaths : 0,
      levels: Number.isFinite(p.statBlock?.level) ? p.statBlock.level : 1,
    }));
}

exports.getPlayerInfo = (req, res) => {
  const { players, playerSnapshotCache } = globals;

  if (!players) {
    return res.status(500).json({ error: 'Player data not available.' });
  }

  let playerList = mapPlayers(players);

  // If live data is empty (e.g., just after a reset), fall back to the last cached snapshot
  if (playerList.length === 0) {
    playerList = mapPlayers(playerSnapshotCache);
  }

  res.json(playerList);
};

// Save player data when tab is closed or refreshed
exports.savePlayerData = (req, res) => {
  try {
    const playerData = req.body;
    const { players, playerSnapshotCache } = globals;
    const { saveState, loadState } = require('../../utils/persistence');
    const { getGlobals } = require('../../globals');
    
    if (!playerData || !playerData.playerName) {
      return res.status(400).json({ error: 'Invalid player data' });
    }

    // Find the player by name in the current players object
    let playerSocket = null;
    for (let socketId in players) {
      if (players[socketId] && players[socketId].name === playerData.playerName) {
        playerSocket = players[socketId];
        break;
      }
    }

    // Update player data with all latest values
    if (playerSocket) {
      // Update position
      if (playerData.pos) {
        playerSocket.pos = { x: playerData.pos.x, y: playerData.pos.y };
      }
      
      // Update stats
      if (playerData.statBlock) {
        playerSocket.statBlock = {
          race: playerData.statBlock.race ?? playerSocket.statBlock.race,
          level: playerData.statBlock.level ?? playerSocket.statBlock.level,
          xp: playerData.statBlock.xp ?? playerSocket.statBlock.xp,
          xpNeeded: playerData.statBlock.xpNeeded ?? playerSocket.statBlock.xpNeeded,
          stats: playerData.statBlock.stats ?? playerSocket.statBlock.stats
        };
      }
      
      // Update inventory
      if (playerData.invBlock) {
        playerSocket.invBlock = {
          items: playerData.invBlock.items || {},
          hotbar: playerData.invBlock.hotbar || ["","","","",""],
          selectedHotBar: playerData.invBlock.selectedHotBar ?? 0,
          equiped: playerData.invBlock.equiped || { head: "", neck: "", chest: "", legs: "", feet: "" }
        };
      }
      
      // Update team
      if (playerData.teamId !== undefined) {
        playerSocket.teamId = playerData.teamId;
      }
      
      // Update color
      if (playerData.color !== undefined) {
        playerSocket.color = playerData.color;
      }
      
      // Update race
      if (playerData.race !== undefined) {
        playerSocket.race = playerData.race;
      }
      
      // Update move slots
      if (playerData.movesSlots) {
        playerSocket.movesSlots = playerData.movesSlots;
      }
      
      console.log(`[API] Player data saved for "${playerData.playerName}" via beforeunload`);
    }

    // Save to snapshot cache for persistence
    if (playerSnapshotCache) {
      playerSnapshotCache[playerData.playerName] = playerData;
    }
    
    // Persist to disk
    try {
      const currentGlobals = getGlobals();
      saveState({ 
        players: currentGlobals.players, 
        serverMap: currentGlobals.serverMap, 
        chatMessages: currentGlobals.chatMessages, 
        teams: currentGlobals.teams,
        playersSnapshot: playerSnapshotCache 
      });
      console.log(`[API] Player snapshot persisted for "${playerData.playerName}"`);
    } catch (e) {
      console.warn(`[API] Failed to persist player snapshot:`, e);
    }

    res.json({ success: true, message: 'Player data saved' });
  } catch (error) {
    console.error('Error saving player data:', error);
    res.status(500).json({ error: 'Failed to save player data' });
  }
};
