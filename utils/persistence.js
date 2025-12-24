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

function saveState({ players, serverMap, chatMessages, teams }) {
  try {
    ensureDir();
    const payload = {
      savedAt: Date.now(),
      playersSnapshot: {}, // players are volatile; keeping minimal snapshot
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
