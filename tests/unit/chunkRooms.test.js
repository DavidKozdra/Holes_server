const { chunkRoom, chunkCoordsFromPos, isValidPos, getNeighborRooms } = require('../../utils/chunkRooms');
const { TILESIZE, CHUNKSIZE } = require('../../utils/map');

describe('chunkRooms Utilities', () => {
  // ── chunkRoom ──
  describe('chunkRoom', () => {
    it('should return a formatted room string', () => {
      expect(chunkRoom(0, 0)).toBe('chunk_0_0');
      expect(chunkRoom(3, -2)).toBe('chunk_3_-2');
      expect(chunkRoom(-1, 5)).toBe('chunk_-1_5');
    });
  });

  // ── chunkCoordsFromPos ──
  describe('chunkCoordsFromPos', () => {
    const tileChunk = TILESIZE * CHUNKSIZE; // 32 * 50 = 1600

    it('should return {cx:0, cy:0} for origin', () => {
      expect(chunkCoordsFromPos({ x: 0, y: 0 })).toEqual({ cx: 0, cy: 0 });
    });

    it('should compute correct chunk for positive coords', () => {
      // x = 1600 => cx = 1, y = 3200 => cy = 2
      expect(chunkCoordsFromPos({ x: tileChunk, y: tileChunk * 2 })).toEqual({ cx: 1, cy: 2 });
    });

    it('should compute correct chunk for negative coords', () => {
      // x = -1 => floor(-1/1600) = -1
      expect(chunkCoordsFromPos({ x: -1, y: -1 })).toEqual({ cx: -1, cy: -1 });
    });

    it('should return null for invalid positions', () => {
      expect(chunkCoordsFromPos(null)).toBeNull();
      expect(chunkCoordsFromPos({})).toBeNull();
      expect(chunkCoordsFromPos({ x: 'abc', y: 5 })).toBeNull();
    });
  });

  // ── isValidPos ──
  describe('isValidPos', () => {
    it('should return true for valid finite positions', () => {
      expect(isValidPos({ x: 0, y: 0 })).toBe(true);
      expect(isValidPos({ x: -500, y: 12345.67 })).toBe(true);
    });

    it('should return false for null/undefined/missing', () => {
      expect(isValidPos(null)).toBeFalsy();
      expect(isValidPos(undefined)).toBeFalsy();
      expect(isValidPos({})).toBeFalsy();
    });

    it('should return false for NaN or Infinity', () => {
      expect(isValidPos({ x: NaN, y: 0 })).toBeFalsy();
      expect(isValidPos({ x: 0, y: Infinity })).toBeFalsy();
    });
  });

  // ── getNeighborRooms ──
  describe('getNeighborRooms', () => {
    it('should return 9 rooms in a 3×3 grid', () => {
      const rooms = getNeighborRooms(0, 0);
      expect(rooms).toHaveLength(9);
      expect(rooms).toContain('chunk_0_0');
      expect(rooms).toContain('chunk_-1_-1');
      expect(rooms).toContain('chunk_1_1');
    });

    it('should center on the given coords', () => {
      const rooms = getNeighborRooms(5, 5);
      expect(rooms).toContain('chunk_5_5');
      expect(rooms).toContain('chunk_4_4');
      expect(rooms).toContain('chunk_6_6');
      expect(rooms).not.toContain('chunk_3_3');
    });
  });
});
