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
