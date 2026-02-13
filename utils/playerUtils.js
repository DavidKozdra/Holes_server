const { enqueueSave } = require('./persistence');
const { BASE_STATS, PLAYER_SAVE_DEBOUNCE_MS } = require('./gameConfig');
const { getGlobals } = require('../globals');

const pendingPlayerSaveTimers = new Map();

// Persisted player snapshots keyed by name
let savedPlayersByName = {};

function getSavedPlayers() {
  return savedPlayersByName;
}

function setSavedPlayers(obj) {
  savedPlayersByName = obj;
}

// Normalize position to plain {x, y} object
function normalizePos(pos) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return { x: 0, y: 0 };
  return { x: pos.x, y: pos.y };
}

// Clone holding object to prevent circular references
function cloneHolding(holding) {
  if (!holding || typeof holding !== 'object') return holding;
  try {
    return JSON.parse(JSON.stringify(holding));
  } catch (e) {
    return null;
  }
}

function sanitizePlayerForClient(player) {
  if (!player) return player;
  return {
    id: player.id,
    name: player.name,
    pos: player.pos ? { x: player.pos.x, y: player.pos.y } : null,
    race: player.race ?? null,
    color: player.color ?? 0,
    holding: player.holding || { w: false, a: false, s: false, d: false },
    statBlock: player.statBlock
      ? {
          level: player.statBlock.level,
          xp: player.statBlock.xp,
          xpNeeded: player.statBlock.xpNeeded,
          stats: player.statBlock.stats
            ? {
                hp: player.statBlock.stats.hp,
                mhp: player.statBlock.stats.mhp,
                attack: player.statBlock.stats.attack,
                magic: player.statBlock.stats.magic,
                magicResistance: player.statBlock.stats.magicResistance,
              }
            : null,
        }
      : null,
    invBlock: null,
    teamId: player.teamId || null,
    kills: player.kills || 0,
    deaths: player.deaths || 0,
  };
}

// Ensure stats have all properties from BASE_STATS
function ensureCompleteStats(stats, race) {
  if (!stats || typeof race !== 'number' || !BASE_STATS[race]) return stats;
  const baseStats = JSON.parse(JSON.stringify(BASE_STATS[race]));
  delete baseStats.growth;
  return Object.assign({}, baseStats, stats);
}

function snapshotPlayersForBroadcast(players) {
  const out = {};
  for (const id of Object.keys(players)) {
    const p = players[id];
    if (!p) continue;
    out[id] = sanitizePlayerForClient(p);
  }
  return out;
}

function queueWorldSave(reason = 'unspecified') {
  const globals = getGlobals();
  const { players, serverMap, chatMessages, teams } = globals;
  return enqueueSave({ players, serverMap, chatMessages, teams, playersSnapshot: savedPlayersByName })
    .catch((e) => {
      console.error(`[Persistence] Async save failed (${reason}):`, e);
      return false;
    });
}

function schedulePlayerSnapshotPersist(playerName) {
  if (!playerName) return;
  const existing = pendingPlayerSaveTimers.get(playerName);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingPlayerSaveTimers.delete(playerName);
    queueWorldSave('player-snapshot');
  }, PLAYER_SAVE_DEBOUNCE_MS);
  pendingPlayerSaveTimers.set(playerName, timer);
}

// Save a player's current state into the savedPlayersByName cache and disk
function savePlayerSnapshot(player) {
  if (!player || !player.name) return false;

  const cleanInv = player.invBlock
    ? {
        items: player.invBlock.items || {},
        hotbar: Array.isArray(player.invBlock.hotbar)
          ? player.invBlock.hotbar
          : ["","","","",""],
        selectedHotBar:
          typeof player.invBlock.selectedHotBar === 'number'
            ? player.invBlock.selectedHotBar
            : 0,
        equiped: player.invBlock.equiped || {
          head: "",
          neck: "",
          chest: "",
          legs: "",
          feet: "",
        },
        movesSlots: Array.isArray(player.movesSlots) ? player.movesSlots.slice() : undefined
      }
    : null;

  savedPlayersByName[player.name] = {
    name: player.name,
    pos: player.pos || { x: 0, y: 0 },
    race: player.race || null,
    color: player.color ?? 0,
    maxDirtInv: Number.isFinite(player.maxDirtInv) ? player.maxDirtInv : 600,
    statBlock: player.statBlock ? JSON.parse(JSON.stringify(player.statBlock)) : null,
    invBlock: cleanInv,
    teamId: player.teamId || null,
    passwordHash: player.passwordHash || null,
  };

  schedulePlayerSnapshotPersist(player.name);
  return true;
}

// Delete a player's snapshot from persistent storage (used for permadeath)
function deletePlayerSnapshotByName(playerName) {
  if (!playerName) return false;
  if (!savedPlayersByName[playerName]) return false;
  delete savedPlayersByName[playerName];
  schedulePlayerSnapshotPersist(playerName);
  return true;
}

module.exports = {
  getSavedPlayers,
  setSavedPlayers,
  normalizePos,
  cloneHolding,
  sanitizePlayerForClient,
  ensureCompleteStats,
  snapshotPlayersForBroadcast,
  queueWorldSave,
  schedulePlayerSnapshotPersist,
  savePlayerSnapshot,
  deletePlayerSnapshotByName,
};
