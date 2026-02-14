const {
  normalizePos,
  cloneHolding,
  sanitizePlayerForClient,
  ensureCompleteStats,
  snapshotPlayersForBroadcast,
  savePlayerSnapshot,
  deletePlayerSnapshotByName,
  getSavedPlayers,
  setSavedPlayers,
} = require('../../utils/playerUtils');

// ── Helper: build a full mock player ──
function mockPlayer(overrides = {}) {
  return {
    id: 'sock_123',
    name: 'TestPlayer',
    pos: { x: 100, y: 200 },
    race: 0,
    color: 3,
    holding: { w: true, a: false, s: false, d: true },
    kills: 5,
    deaths: 2,
    teamId: 'team1',
    maxDirtInv: 800,
    passwordHash: '$2a$10$fakehashvalue',
    statBlock: {
      level: 3,
      xp: 50,
      xpNeeded: 100,
      stats: {
        hp: 90,
        mhp: 100,
        attack: 5,
        magic: 2,
        magicResistance: 3,
        hearing: 2,
      },
    },
    invBlock: {
      items: { Gem: { amount: 5 }, Bomb: { amount: 2 } },
      hotbar: ['Gem', '', 'Bomb', '', ''],
      selectedHotBar: 0,
      equiped: { head: '', neck: '', chest: 'IronArmor', legs: '', feet: '' },
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
describe('normalizePos', () => {
  it('should return {x, y} for a valid pos', () => {
    expect(normalizePos({ x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
  });

  it('should return {0,0} for null/undefined', () => {
    expect(normalizePos(null)).toEqual({ x: 0, y: 0 });
    expect(normalizePos(undefined)).toEqual({ x: 0, y: 0 });
  });

  it('should return {0,0} if x or y is not a number', () => {
    expect(normalizePos({ x: 'foo', y: 5 })).toEqual({ x: 0, y: 0 });
    expect(normalizePos({ x: 5 })).toEqual({ x: 0, y: 0 });
  });
});

// ═══════════════════════════════════════════════════════════
describe('cloneHolding', () => {
  it('should deep-clone a holding object', () => {
    const original = { w: true, a: false, s: true, d: false };
    const clone = cloneHolding(original);
    expect(clone).toEqual(original);
    expect(clone).not.toBe(original);
  });

  it('should return null/undefined for non-objects', () => {
    expect(cloneHolding(null)).toBeNull();
    expect(cloneHolding(undefined)).toBeUndefined();
    expect(cloneHolding('string')).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════
describe('sanitizePlayerForClient', () => {
  it('should strip sensitive fields (invBlock, passwordHash)', () => {
    const player = mockPlayer();
    const result = sanitizePlayerForClient(player);

    expect(result.invBlock).toBeNull(); // inventory is never sent via broadcast
    expect(result.passwordHash).toBeUndefined();
    expect(result.maxDirtInv).toBeUndefined();
  });

  it('should preserve public fields', () => {
    const player = mockPlayer();
    const result = sanitizePlayerForClient(player);

    expect(result.id).toBe('sock_123');
    expect(result.name).toBe('TestPlayer');
    expect(result.pos).toEqual({ x: 100, y: 200 });
    expect(result.kills).toBe(5);
    expect(result.deaths).toBe(2);
    expect(result.teamId).toBe('team1');
  });

  it('should include only whitelisted statBlock.stats fields', () => {
    const player = mockPlayer();
    const result = sanitizePlayerForClient(player);
    const stats = result.statBlock.stats;

    expect(stats.hp).toBe(90);
    expect(stats.mhp).toBe(100);
    expect(stats.attack).toBe(5);
    expect(stats.magic).toBe(2);
    expect(stats.magicResistance).toBe(3);
    // hearing should NOT leak to the client
    expect(stats.hearing).toBeUndefined();
  });

  it('should return null/falsy for a null player', () => {
    expect(sanitizePlayerForClient(null)).toBeNull();
  });

  it('should handle a player with no statBlock', () => {
    const player = mockPlayer({ statBlock: null });
    const result = sanitizePlayerForClient(player);
    expect(result.statBlock).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
describe('ensureCompleteStats', () => {
  it('should fill in missing base stats for race 0 (gnome)', () => {
    const partial = { hp: 50, mhp: 50 };
    const result = ensureCompleteStats(partial, 0);

    expect(result.hp).toBe(50); // overridden
    expect(result.mhp).toBe(50); // overridden
    expect(result.attack).toBeDefined(); // filled from base
    expect(result.magic).toBeDefined();
    expect(result.runningSpeed).toBeDefined();
    // growth should be stripped
    expect(result.growth).toBeUndefined();
  });

  it('should return stats unchanged if race is invalid', () => {
    const stats = { hp: 10 };
    expect(ensureCompleteStats(stats, 99)).toBe(stats);
    expect(ensureCompleteStats(stats, 'abc')).toBe(stats);
  });

  it('should return stats unchanged if stats is null', () => {
    expect(ensureCompleteStats(null, 0)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
describe('snapshotPlayersForBroadcast', () => {
  it('should sanitize each player', () => {
    const players = {
      a: mockPlayer({ id: 'a', name: 'Alice' }),
      b: mockPlayer({ id: 'b', name: 'Bob' }),
    };
    const snap = snapshotPlayersForBroadcast(players);

    expect(Object.keys(snap)).toEqual(['a', 'b']);
    expect(snap.a.name).toBe('Alice');
    expect(snap.a.invBlock).toBeNull(); // sanitized
    expect(snap.b.name).toBe('Bob');
  });

  it('should skip null entries', () => {
    const players = { a: null, b: mockPlayer({ id: 'b' }) };
    const snap = snapshotPlayersForBroadcast(players);
    expect(snap.a).toBeUndefined();
    expect(snap.b).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
describe('savePlayerSnapshot / deletePlayerSnapshotByName', () => {
  beforeEach(() => {
    // Reset the saved-players map before each test
    setSavedPlayers({});
  });

  it('should save a player snapshot keyed by name', () => {
    const player = mockPlayer();
    const ok = savePlayerSnapshot(player);
    expect(ok).toBe(true);

    const saved = getSavedPlayers();
    expect(saved['TestPlayer']).toBeDefined();
    expect(saved['TestPlayer'].name).toBe('TestPlayer');
    expect(saved['TestPlayer'].pos).toEqual({ x: 100, y: 200 });
  });

  it('should return false for a player with no name', () => {
    expect(savePlayerSnapshot({ id: 'x' })).toBe(false);
    expect(savePlayerSnapshot(null)).toBe(false);
  });

  it('should deep-clone statBlock so mutations do not leak', () => {
    const player = mockPlayer();
    savePlayerSnapshot(player);
    player.statBlock.level = 999;

    const saved = getSavedPlayers();
    expect(saved['TestPlayer'].statBlock.level).toBe(3); // original value
  });

  it('deletePlayerSnapshotByName should remove a saved snapshot', () => {
    savePlayerSnapshot(mockPlayer());
    expect(deletePlayerSnapshotByName('TestPlayer')).toBe(true);
    expect(getSavedPlayers()['TestPlayer']).toBeUndefined();
  });

  it('deletePlayerSnapshotByName should return false for unknown name', () => {
    expect(deletePlayerSnapshotByName('Nobody')).toBe(false);
  });
});
