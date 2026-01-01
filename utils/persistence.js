const fs = require('fs');
const path = require('path');
const fsp = fs.promises;

const SAVE_PATH = path.join(__dirname, '..', 'data', 'world.json');
const WORLDS_DIR = path.join(__dirname, '..', 'data', 'worlds');

// Async save queue to avoid blocking the event loop with full JSON writes
let pendingPayload = null;
let flushScheduled = false;
let isFlushing = false;
const waiters = [];

function ensureDir() {
  const dir = path.dirname(SAVE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function writePayload(payload) {
  await ensureDir();
  const tmpPath = `${SAVE_PATH}.tmp`;
  await fsp.writeFile(tmpPath, JSON.stringify(payload));
  await fsp.rename(tmpPath, SAVE_PATH);
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(async () => {
    flushScheduled = false;
    if (isFlushing || !pendingPayload) return;
    isFlushing = true;
    const payload = pendingPayload;
    pendingPayload = null;

    try {
      await writePayload(payload);
      while (waiters.length) {
        const { resolve } = waiters.shift();
        resolve(true);
      }
    } catch (e) {
      console.error('Error saving world state (async queue):', e);
      while (waiters.length) {
        const { reject } = waiters.shift();
        reject(e);
      }
    } finally {
      isFlushing = false;
      if (pendingPayload) scheduleFlush();
    }
  });
}

function enqueueSave(payload) {
  // Keep only the latest payload; persistence is snapshot-based
  pendingPayload = payload;
  return new Promise((resolve, reject) => {
    waiters.push({ resolve, reject });
    scheduleFlush();
  });
}

function clearState() {
  try {
    // Remove main world snapshot
    if (fs.existsSync(SAVE_PATH)) {
      fs.unlinkSync(SAVE_PATH);
    }

    // Remove any saved world variants
    if (fs.existsSync(WORLDS_DIR)) {
      fs.rmSync(WORLDS_DIR, { recursive: true, force: true });
    }

    // Recreate data directory so future saves succeed
    ensureDir();
    return true;
  } catch (e) {
    console.error('Error clearing world state:', e);
    return false;
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
      passwordHash: p.passwordHash || null,
    };
  }
  return out;
}

function saveState({ players, serverMap, chatMessages, teams, playersSnapshot }) {
  const payload = {
    savedAt: Date.now(),
    playersSnapshot: playersSnapshot || serializePlayersSnapshot(players),
    serverMap: serializeServerMap(serverMap),
    chatMessages: chatMessages || [],
    teams: teams || {},
  };
  // Fire-and-forget compatibility: callers still get a truthy value, while we enqueue async write
  enqueueSave(payload).catch(() => {});
  return true;
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

module.exports = { saveState, loadState, clearState, enqueueSave };
