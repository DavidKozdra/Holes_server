const { listWorldsForBrowser, ensureWorld, deleteWorld } = require('../../utils/worldsStore');
const { saveState, saveWorldFile, deleteWorldFile } = require('../../utils/persistence');

// Dependency bag to avoid requiring server.js directly
function getDeps(req) {
  return req.app.locals.stateRefs || {};
}

async function listWorlds(req, res) {
  try {
    const browserId = (req.query.browserId || '').trim();
    if (!browserId) return res.status(400).json({ error: 'browserId is required' });
    const worlds = listWorldsForBrowser(browserId);
    return res.json({ worlds });
  } catch (e) {
    console.error('[REST] GET /worlds failed', e);
    return res.status(500).json({ error: 'internal_error' });
  }
}

async function createWorld(req, res) {
  try {
    const { browserId, name, worldId } = req.body || {};
    if (!browserId) return res.status(400).json({ error: 'browserId is required' });
    const trimmedName = (name || '').trim();
    const id = (worldId || '').trim() || `w-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    
    console.log('[REST] Creating world:', { browserId, id, name: trimmedName });
    
    const { meta, map } = ensureWorld(browserId, id, trimmedName);
    
    console.log('[REST] World created successfully:', { id, meta });

    // Save this world to its own file
    const { singlePlayerWorlds } = getDeps(req);
    const worldKey = `${browserId}:${id}`;
    if (singlePlayerWorlds[worldKey]) {
      saveWorldFile(browserId, id, singlePlayerWorlds[worldKey]);
      console.log('[REST] World saved to file:', { browserId, id });
    }

    return res.status(201).json({ world: meta });
  } catch (e) {
    console.error('[REST] POST /worlds failed', e);
    return res.status(500).json({ error: 'internal_error' });
  }
}

async function deleteWorldHandler(req, res) {
  try {
    const browserId = (req.query.browserId || '').trim();
    const id = (req.params.id || '').trim();
    if (!browserId || !id) return res.status(400).json({ error: 'browserId and id are required' });

    deleteWorld(browserId, id);
    
    // Delete the world file
    deleteWorldFile(browserId, id);

    return res.json({ ok: true });
  } catch (e) {
    console.error('[REST] DELETE /worlds/:id failed', e);
    return res.status(500).json({ error: 'internal_error' });
  }
}

module.exports = { listWorlds, createWorld, deleteWorldHandler };
