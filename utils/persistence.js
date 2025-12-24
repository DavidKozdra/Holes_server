const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SAVE_PATH = path.join(DATA_DIR, 'world.json');
const WORLDS_DIR = path.join(DATA_DIR, 'worlds');

function ensureDir(dirPath = DATA_DIR) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getWorldPath(browserId, worldId) {
  // Path: data/worlds/${browserId}/${worldId}.json
  return path.join(WORLDS_DIR, String(browserId), `${worldId}.json`);
}

function serializeServerMap(serverMap) {
  const chunksOut = {};
  const keys = Object.keys(serverMap.chunks || {});
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const chunk = serverMap.chunks[key];
    if (!chunk) continue;
    chunksOut[key] = {
      cx: chunk.cx,
      cy: chunk.cy,
      data: chunk.data,
      iron_data: chunk.iron_data,
      objects: chunk.objects,
      projectiles: chunk.projectiles,
      soundObjs: chunk.soundObjs,
    };
  }
  return {
    chunks: chunksOut,
    brains: serverMap.brains || [],
    seed: serverMap.seed || null,
  };
}

function serializePlayersSnapshot(players) {
  const out = {};
  const ids = Object.keys(players || {});
  for (let i = 0; i < ids.length; i++) {
    const p = players[ids[i]];
    if (!p || !p.name) continue;
    out[p.name] = {
      name: p.name,
      pos: p.pos || { x: 0, y: 0 },
      race: p.race || null,
      color: p.color || 0,
      statBlock: p.statBlock || null,
      invBlock: p.invBlock
        ? {
            items: p.invBlock.items || {},
            hotbar: p.invBlock.hotbar || ["","","","",""],
            selectedHotBar: typeof p.invBlock.selectedHotBar === 'number' ? p.invBlock.selectedHotBar : 0,
            equiped: p.invBlock.equiped || { head: "", neck: "", chest: "", legs: "", feet: "" },
          }
        : null,
      teamId: p.teamId || null,
    };
  }
  return out;
}

// Save a single SP world to its own file
function saveWorldFile(browserId, worldId, worldMap) {
  try {
    ensureDir(WORLDS_DIR);
    const browserDir = path.join(WORLDS_DIR, String(browserId));
    ensureDir(browserDir);
    
    const worldPath = getWorldPath(browserId, worldId);
    const payload = {
      browserId,
      worldId,
      savedAt: Date.now(),
      map: serializeServerMap(worldMap),
    };
    fs.writeFileSync(worldPath, JSON.stringify(payload));
    console.log('[Persistence] Saved SP world:', { browserId, worldId, path: worldPath });
    return true;
  } catch (e) {
    console.error('[Persistence] Error saving SP world file:', { browserId, worldId, error: String(e) });
    return false;
  }
}

// Load a single SP world from its file
function loadWorldFile(browserId, worldId) {
  try {
    const worldPath = getWorldPath(browserId, worldId);
    if (!fs.existsSync(worldPath)) return null;
    const raw = fs.readFileSync(worldPath, 'utf-8');
    const payload = JSON.parse(raw);
    console.log('[Persistence] Loaded SP world:', { browserId, worldId });
    return payload.map;
  } catch (e) {
    console.error('[Persistence] Error loading SP world file:', { browserId, worldId, error: String(e) });
    return null;
  }
}

// Delete a SP world file
function deleteWorldFile(browserId, worldId) {
  try {
    const worldPath = getWorldPath(browserId, worldId);
    if (fs.existsSync(worldPath)) {
      fs.rmSync(worldPath, { force: true });
      console.log('[Persistence] Deleted SP world:', { browserId, worldId });
    }
    return true;
  } catch (e) {
    console.error('[Persistence] Error deleting SP world file:', { browserId, worldId, error: String(e) });
    return false;
  }
}

function saveState({ players, serverMap, chatMessages, teams, playersSnapshot, singlePlayerWorlds, singlePlayerWorldMeta }) {
  try {
    ensureDir();
    // Save main server state (MP world only, no SP worlds in here)
    const payload = {
      savedAt: Date.now(),
      playersSnapshot: playersSnapshot || serializePlayersSnapshot(players),
      serverMap: serializeServerMap(serverMap),
      chatMessages: chatMessages || [],
      teams: teams || {},
    };
    fs.writeFileSync(SAVE_PATH, JSON.stringify(payload));
    
    // Also save each SP world to its own file
    const spWorldIds = Object.keys(singlePlayerWorlds || {});
    for (let i = 0; i < spWorldIds.length; i++) {
      const key = spWorldIds[i];
      const [browserId, worldId] = key.split(':');
      if (browserId && worldId && singlePlayerWorlds[key]) {
        saveWorldFile(browserId, worldId, singlePlayerWorlds[key]);
      }
    }
    
    return true;
  } catch (e) {
    console.error('Error saving world state:', e);
    return false;
  }
}

function loadState() {
  try {
    if (!fs.existsSync(SAVE_PATH)) return null;
    const raw = fs.readFileSync(SAVE_PATH, 'utf-8');
    const payload = JSON.parse(raw);
    return payload;
  } catch (e) {
    console.error('Error loading world state:', e);
    return null;
  }
}

module.exports = { saveState, loadState, saveWorldFile, loadWorldFile, deleteWorldFile, getWorldPath };
