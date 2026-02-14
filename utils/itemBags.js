const { TILESIZE, CHUNKSIZE, Placeable } = require('./map');
const { chunkRoom } = require('./chunkRooms');

function sanitizeItems(items) {
  const cleaned = {};
  if (!items || typeof items !== 'object') return cleaned;
  for (const k of Object.keys(items)) {
    const v = items[k];
    const amt = v && typeof v.amount === 'number' ? v.amount : Number(v?.amount);
    if (Number.isFinite(amt) && amt > 0) cleaned[k] = { amount: Math.floor(amt) };
  }
  return cleaned;
}

function spawnItemBag(chunk, data, io, mergeCallback) {
  if (data.cost != undefined) {
    if (data.cost.length > 0) {
      let itemBag = new Placeable(
        'ItemBag',
        data.pos.x,
        data.pos.y,
        0,
        12 * 3,
        13 * 3,
        1,
        11,
        '',
        '',
      );
      itemBag.type = 'InvObj';
      itemBag.invBlock = { items: {} };
      itemBag.invBlock.invId = Math.random() * 100000;
      for (let i = 0; i < data.cost.length; i++) {
        if (data.cost[i][0] == 'dirt') {
        } else {
          if (data.cost[i][1] >= 1) {
            itemBag.invBlock.items[data.cost[i][0]] = {};
            itemBag.invBlock.items[data.cost[i][0]].amount = Math.round(
              data.cost[i][1] * (Math.random() * 0.4 + 0.5),
            );
          } else {
            if (Math.random() < data.cost[i][1]) {
              itemBag.invBlock.items[data.cost[i][0]] = {};
              itemBag.invBlock.items[data.cost[i][0]].amount = 1;
            }
          }
        }
      }
      // Only create the bag if it actually has items (skip empty bags from all-dirt or failed probability)
      if (Object.keys(itemBag.invBlock.items).length > 0) {
        chunk.objects.push(itemBag);
        io.emit('NEW_OBJECT', {
          cx: chunk.cx,
          cy: chunk.cy,
          obj: itemBag,
        });
      }
    }
  }

  if (mergeCallback) mergeCallback();
}

function ensureItemBagSchema(bag) {
  if (!bag) return null;
  if (bag.objName !== 'ItemBag') return null;
  if (bag.type !== 'InvObj') bag.type = 'InvObj';
  if (!bag.objName) bag.objName = 'ItemBag';
  if (!bag.pos || typeof bag.pos.x !== 'number' || typeof bag.pos.y !== 'number') {
    return null;
  }
  if (typeof bag.z !== 'number') bag.z = 0;

  if (!bag.invBlock || typeof bag.invBlock !== 'object') bag.invBlock = {};
  if (!bag.invBlock.items || typeof bag.invBlock.items !== 'object') bag.invBlock.items = {};
  if (typeof bag.invBlock.invId !== 'number') {
    const existing = bag.invBlock.invId;
    bag.invBlock.invId = typeof existing === 'number' ? existing : Math.floor(Math.random() * 1e9);
  }

  for (const k of Object.keys(bag.invBlock.items)) {
    const v = bag.invBlock.items[k];
    const amt = v && typeof v.amount === 'number' ? v.amount : Number(v?.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      delete bag.invBlock.items[k];
    } else {
      bag.invBlock.items[k] = { amount: Math.floor(amt) };
    }
  }

  return bag;
}

function mergeAllChunkBags(serverMap, io, maxMerges = Infinity) {
  const MERGE_DISTANCE = TILESIZE * 5.5;
  const CELL = MERGE_DISTANCE;
  let mergesLeft = maxMerges;

  outer: for (const key in serverMap.chunks) {
    const chunk = serverMap.chunks[key];
    if (!chunk || !Array.isArray(chunk.objects) || chunk.objects.length < 2) continue;

    const roomCx = typeof chunk.cx === 'number' ? chunk.cx : parseInt(key.split(',')[0], 10);
    const roomCy = typeof chunk.cy === 'number' ? chunk.cy : parseInt(key.split(',')[1], 10);
    const room = chunkRoom(roomCx, roomCy);

    const bags = [];
    for (let idx = 0; idx < chunk.objects.length; idx++) {
      let bag = chunk.objects[idx];
      if (!bag || bag.type !== 'InvObj' || bag.objName !== 'ItemBag') continue;
      bag = ensureItemBagSchema(bag);
      if (!bag) {
        const removed = chunk.objects.splice(idx, 1)[0];
        io.to(room).emit('DELETE_OBJ', {
          cx: roomCx,
          cy: roomCy,
          objName: removed?.objName || 'ItemBag',
          pos: removed?.pos || { x: 0, y: 0 },
          z: removed?.z ?? 0,
        });
        idx--;
        continue;
      }
      chunk.objects[idx] = bag;
      bags.push({ bag, idx });
    }

    if (bags.length < 2) continue;

    const cellKey = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
    const cellMap = new Map();
    for (const entry of bags) {
      const k = cellKey(entry.bag.pos.x, entry.bag.pos.y);
      const list = cellMap.get(k) || [];
      list.push(entry);
      cellMap.set(k, list);
    }

    const toRemove = new Set();
    const dirtyBags = new Set();

    for (const entry of bags) {
      if (mergesLeft <= 0) break outer;
      if (toRemove.has(entry.idx)) continue;
      const a = entry.bag;
      const baseCellX = Math.floor(a.pos.x / CELL);
      const baseCellY = Math.floor(a.pos.y / CELL);

      for (let dx = -1; dx <= 1 && mergesLeft > 0; dx++) {
        for (let dy = -1; dy <= 1 && mergesLeft > 0; dy++) {
          const list = cellMap.get(`${baseCellX + dx},${baseCellY + dy}`);
          if (!list) continue;
          for (const other of list) {
            if (other.idx === entry.idx || toRemove.has(other.idx) || mergesLeft <= 0) continue;
            const b = other.bag;
            const dist = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
            if (dist > MERGE_DISTANCE) continue;

            for (const item of Object.keys(b.invBlock.items)) {
              const bAmt = b.invBlock.items[item]?.amount || 0;
              if (!a.invBlock.items[item]) a.invBlock.items[item] = { amount: 0 };
              a.invBlock.items[item].amount += bAmt;
            }

            for (const k of Object.keys(a.invBlock.items)) {
              if (!Number.isFinite(a.invBlock.items[k].amount) || a.invBlock.items[k].amount <= 0) {
                delete a.invBlock.items[k];
              } else {
                a.invBlock.items[k].amount = Math.floor(a.invBlock.items[k].amount);
              }
            }

            toRemove.add(other.idx);
            dirtyBags.add(entry.idx);
            mergesLeft--;
            if (mergesLeft <= 0) break;
          }
        }
      }
    }

    if (toRemove.size) {
      const sorted = Array.from(toRemove).sort((a, b) => b - a);
      for (const idx of sorted) {
        const removed = chunk.objects.splice(idx, 1)[0];
        io.to(room).emit('DELETE_OBJ', {
          cx: roomCx,
          cy: roomCy,
          objName: removed?.objName || 'ItemBag',
          pos: removed?.pos || { x: 0, y: 0 },
          z: removed?.z ?? 0,
        });
      }

      // Remap dirty bag indices — each splice shifts later indices down.
      // Build a correction offset for each dirty index by counting how many
      // removed indices were below it.
      const removedArr = sorted.slice().sort((a, b) => a - b); // ascending
      const remappedDirty = [];
      for (const dIdx of dirtyBags) {
        if (toRemove.has(dIdx)) continue; // was merged away
        let shift = 0;
        for (const rIdx of removedArr) {
          if (rIdx < dIdx) shift++;
          else break;
        }
        remappedDirty.push(dIdx - shift);
      }

      for (const idx of remappedDirty) {
        const bag = chunk.objects[idx];
        if (!bag) continue;
        io.to(room).emit('UPDATE_INV', {
          cx: roomCx,
          cy: roomCy,
          objName: bag.objName,
          pos: { x: bag.pos.x, y: bag.pos.y },
          z: bag.z,
          items: bag.invBlock.items,
        });
      }
    } else {
      // No removals — indices are still valid
      for (const idx of dirtyBags) {
        const bag = chunk.objects[idx];
        if (!bag) continue;
        io.to(room).emit('UPDATE_INV', {
          cx: roomCx,
          cy: roomCy,
          objName: bag.objName,
          pos: { x: bag.pos.x, y: bag.pos.y },
          z: bag.z,
          items: bag.invBlock.items,
        });
      }
    }
  }
}

module.exports = {
  sanitizeItems,
  spawnItemBag,
  ensureItemBagSchema,
  mergeAllChunkBags,
};
