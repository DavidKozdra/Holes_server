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
    const { players } = globals;
    const { savePlayerSnapshot } = require('../../utils/playerUtils');
    
    if (!playerData || !playerData.playerName) {
      return res.status(400).json({ error: 'Invalid player data' });
    }

    // Find the player by name — only save what the SERVER already holds
    let playerSocket = null;
    for (let socketId in players) {
      if (players[socketId] && players[socketId].name === playerData.playerName) {
        playerSocket = players[socketId];
        break;
      }
    }

    if (!playerSocket) {
      return res.status(404).json({ error: 'Player not found on server' });
    }

    // Save the server-authoritative data — do NOT trust req.body fields
    const ok = savePlayerSnapshot(playerSocket);
    console.log(`[API] Player snapshot persisted for "${playerData.playerName}"`);

    res.json({ success: ok, message: ok ? 'Player data saved' : 'Save failed' });
  } catch (error) {
    console.error('Error saving player data:', error);
    res.status(500).json({ error: 'Failed to save player data' });
  }
};
