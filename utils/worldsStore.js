const { Map, Chunk } = require('./map');

// Shared single-player worlds and metadata across the server
const singlePlayerWorlds = {};
const singlePlayerWorldMeta = {};

function listWorldsForBrowser(browserId) {
  if (!browserId) return [];
  const worlds = [];
  const keys = Object.keys(singlePlayerWorlds || {});
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const [bid, wid] = key.split(':');
    if (bid !== browserId) continue;
    const meta = singlePlayerWorldMeta[key] || {};
    worlds.push({
      id: wid || key,
      name: meta.name || wid || 'World',
      browserId: bid,
      createdAt: meta.createdAt || null,
      updatedAt: meta.updatedAt || null,
    });
  }
  return worlds;
}

function ensureWorld(browserId, worldId, name) {
  const bid = browserId || 'anon';
  const wid = worldId || 'default';
  const key = `${bid}:${wid}`;
  const isNew = !singlePlayerWorlds[key];
  if (isNew) {
    singlePlayerWorlds[key] = new Map(Math.random());
    console.log('[worldsStore] Created new map for world:', { key });
  }
  const nowTs = Date.now();
  const existingMeta = singlePlayerWorldMeta[key];
  singlePlayerWorldMeta[key] = {
    id: wid,
    browserId: bid,
    name: name || existingMeta?.name || wid || 'World',
    createdAt: existingMeta?.createdAt || nowTs,
    updatedAt: nowTs,
  };
  console.log('[worldsStore] ensureWorld complete:', { key, isNew, meta: singlePlayerWorldMeta[key] });
  return { key, map: singlePlayerWorlds[key], meta: singlePlayerWorldMeta[key] };
}

function deleteWorld(browserId, worldId) {
  const bid = browserId || 'anon';
  const wid = worldId || 'default';
  const key = `${bid}:${wid}`;
  if (singlePlayerWorlds[key]) delete singlePlayerWorlds[key];
  if (singlePlayerWorldMeta[key]) delete singlePlayerWorldMeta[key];
  return { key };
}

function hydrateWorldFromRaw(rawMap) {
  const spMap = new Map(rawMap.seed || Math.random());
  const ckeys = Object.keys(rawMap.chunks || {});
  for (let j = 0; j < ckeys.length; j++) {
    const key = ckeys[j];
    const raw = rawMap.chunks[key];
    const ch = new Chunk(raw.cx, raw.cy);
    ch.data = raw.data || {};
    ch.iron_data = raw.iron_data || {};
    ch.objects = raw.objects || [];
    ch.projectiles = raw.projectiles || [];
    ch.soundObjs = raw.soundObjs || [];
    spMap.chunks[key] = ch;
  }
  spMap.brains = rawMap.brains || [];
  return spMap;
}

function loadFromPersistence(worldsRaw, metaRaw) {
  try {
    const wRaw = worldsRaw || {};
    const meta = metaRaw || {};
    const wids = Object.keys(wRaw);
    for (let i = 0; i < wids.length; i++) {
      const wid = wids[i];
      const rawMap = wRaw[wid];
      singlePlayerWorlds[wid] = hydrateWorldFromRaw(rawMap);
    }
    const restoredKeys = Object.keys(singlePlayerWorlds);
    const nowTs = Date.now();
    for (let i = 0; i < restoredKeys.length; i++) {
      const key = restoredKeys[i];
      const existingMeta = meta[key];
      const parts = key.split(':');
      singlePlayerWorldMeta[key] = existingMeta || {
        id: parts[1] || key,
        browserId: parts[0] || 'unknown',
        name: parts[1] || 'World',
        createdAt: nowTs,
        updatedAt: nowTs,
      };
    }
  } catch (e) {
    console.warn('[worldsStore] Failed to load worlds from persistence', e);
  }
  return { singlePlayerWorlds, singlePlayerWorldMeta };
}

module.exports = {
  singlePlayerWorlds,
  singlePlayerWorldMeta,
  listWorldsForBrowser,
  ensureWorld,
  deleteWorld,
  loadFromPersistence,
};
