const { Map: GameMap, Chunk, Placeable, TILESIZE, CHUNKSIZE } = require('../../utils/map');

describe('Map Module', () => {
  // ── Constants ──
  describe('constants', () => {
    it('TILESIZE should be 32', () => {
      expect(TILESIZE).toBe(32);
    });

    it('CHUNKSIZE should be 50', () => {
      expect(CHUNKSIZE).toBe(50);
    });
  });

  // ── Placeable ──
  describe('Placeable', () => {
    it('should construct with all expected properties', () => {
      const p = new Placeable('Tree', 100, 200, 45, 120, 120, 0, 5, 'Alice', 'id1', 80);

      expect(p.objName).toBe('Tree');
      expect(p.pos).toEqual({ x: 100, y: 200 });
      expect(p.rot).toBe(45);
      expect(p.size).toEqual({ w: 120, h: 120 });
      expect(p.z).toBe(0);
      expect(p.color).toBe(5);
      expect(p.ownerName).toBe('Alice');
      expect(p.id).toBe('id1');
      expect(p.hp).toBe(80);
      expect(p.mhp).toBe(80); // mhp mirrors initial hp
      expect(p.level).toBe(1);
      expect(p.xp).toBe(0);
      expect(p.xpNeeded).toBe(10);
    });

    it('should default openBool to true and deleteTag to false', () => {
      const p = new Placeable('Wall', 0, 0, 0, 10, 10, 0, 0, '', '', 100);
      expect(p.openBool).toBe(true);
      expect(p.deleteTag).toBe(false);
    });
  });

  // ── Chunk ──
  describe('Chunk', () => {
    it('should initialize with the given chunk coordinates', () => {
      const c = new Chunk(3, -2);
      expect(c.cx).toBe(3);
      expect(c.cy).toBe(-2);
      expect(c.objects).toEqual([]);
      expect(c.projectiles).toEqual([]);
      expect(c.soundObjs).toEqual([]);
    });

    it('generate() should populate data and iron_data arrays', () => {
      const c = new Chunk(0, 0);
      c.generate();

      expect(c.data.length).toBeGreaterThan(0);
      expect(c.iron_data.length).toBeGreaterThan(0);
      // Each tile in a CHUNKSIZE×CHUNKSIZE grid
      expect(c.data.length).toBeLessThanOrEqual(CHUNKSIZE * CHUNKSIZE);
    });

    it('generate() should create bear traps for far-out chunks (|cx|>25)', () => {
      const c = new Chunk(26, 0);
      c.generate();

      const traps = c.objects.filter((o) => o.objName === 'BearTrap');
      expect(traps.length).toBeGreaterThan(0);
    });

    it('generate() should produce all data values between 0 and ~1.5 for normal chunks', () => {
      const c = new Chunk(0, 0);
      c.generate();

      for (const val of c.data) {
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(2); // small tolerance
      }
    });
  });

  // ── GameMap ──
  describe('GameMap', () => {
    it('should auto-generate chunk (0,0) on creation', () => {
      const m = new GameMap(42);
      expect(m.chunks['0,0']).toBeDefined();
      expect(m.chunks['0,0']).toBeInstanceOf(Chunk);
    });

    it('getChunk should generate and cache a new chunk', () => {
      const m = new GameMap(42);
      expect(m.chunks['5,5']).toBeUndefined();

      const chunk = m.getChunk(5, 5);
      expect(chunk).toBeInstanceOf(Chunk);
      expect(chunk.cx).toBe(5);
      expect(chunk.cy).toBe(5);

      // Second call should return the cached chunk, not regenerate
      const chunk2 = m.getChunk(5, 5);
      expect(chunk2).toBe(chunk);
    });

    it('should produce deterministic terrain from the same seed (far-out chunk)', () => {
      // Far-out chunks (|cx|>25) have simple deterministic generation
      // (bear traps only, no Math.random()-based structure placement)
      const m1 = new GameMap(12345);
      const c1 = m1.getChunk(30, 30);
      const data1 = [...c1.data];
      const iron1 = [...c1.iron_data];

      const m2 = new GameMap(12345);
      const c2 = m2.getChunk(30, 30);

      expect(c2.data).toEqual(data1);
      expect(c2.iron_data).toEqual(iron1);
    });

    it('should produce DIFFERENT terrain from different seeds', () => {
      const m1 = new GameMap(111);
      const c1 = m1.getChunk(30, 30);

      const m2 = new GameMap(999);
      const c2 = m2.getChunk(30, 30);

      // Terrain data should differ (extremely unlikely to be identical)
      const same = c1.data.every((v, i) => v === c2.data[i]);
      expect(same).toBe(false);
    });

    it('should store the seed', () => {
      const m = new GameMap(99);
      expect(m.seed).toBe(99);
    });

    it('should initialize brains array', () => {
      const m = new GameMap(1);
      expect(Array.isArray(m.brains)).toBe(true);
    });
  });
});
