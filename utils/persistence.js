const fs = require('fs');
const path = require('path');

const SAVE_PATH = path.join(__dirname, '..', 'data', 'world.json');

function ensureDir() {
  const dir = path.dirname(SAVE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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

function saveState({ players, serverMap, chatMessages, teams, playersSnapshot }) {
  try {
    ensureDir();
    const payload = {
      savedAt: Date.now(),
      playersSnapshot: playersSnapshot || serializePlayersSnapshot(players),
      serverMap: serializeServerMap(serverMap),
      chatMessages: chatMessages || [],
      teams: teams || {},
    };
    fs.writeFileSync(SAVE_PATH, JSON.stringify(payload));
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

module.exports = { saveState, loadState };
