const { sanitizeItems, ensureItemBagSchema } = require('../../utils/itemBags');

describe('itemBags Utilities', () => {
  // ── sanitizeItems ──
  describe('sanitizeItems', () => {
    it('should keep valid items with positive integer amounts', () => {
      const input = {
        Gem: { amount: 5 },
        Bomb: { amount: 3.7 },
      };
      const result = sanitizeItems(input);
      expect(result.Gem.amount).toBe(5);
      expect(result.Bomb.amount).toBe(3); // floored
    });

    it('should remove items with zero or negative amounts', () => {
      const input = {
        Gem: { amount: 0 },
        Bomb: { amount: -5 },
      };
      const result = sanitizeItems(input);
      expect(result.Gem).toBeUndefined();
      expect(result.Bomb).toBeUndefined();
    });

    it('should remove items with NaN amounts', () => {
      const input = { Gem: { amount: NaN } };
      const result = sanitizeItems(input);
      expect(result.Gem).toBeUndefined();
    });

    it('should return empty object for null/undefined input', () => {
      expect(sanitizeItems(null)).toEqual({});
      expect(sanitizeItems(undefined)).toEqual({});
    });

    it('should coerce string amounts to numbers', () => {
      const input = { Gem: { amount: '10' } };
      const result = sanitizeItems(input);
      expect(result.Gem.amount).toBe(10);
    });
  });

  // ── ensureItemBagSchema ──
  describe('ensureItemBagSchema', () => {
    function validBag(overrides = {}) {
      return {
        objName: 'ItemBag',
        type: 'InvObj',
        pos: { x: 100, y: 200 },
        z: 1,
        invBlock: {
          invId: 12345,
          items: { Gem: { amount: 3 } },
        },
        ...overrides,
      };
    }

    it('should return the bag unchanged for a valid schema', () => {
      const bag = validBag();
      const result = ensureItemBagSchema(bag);
      expect(result).not.toBeNull();
      expect(result.objName).toBe('ItemBag');
      expect(result.invBlock.items.Gem.amount).toBe(3);
    });

    it('should return null for non-ItemBag objects', () => {
      expect(ensureItemBagSchema({ objName: 'Chest', type: 'InvObj', pos: { x: 0, y: 0 } })).toBeNull();
    });

    it('should return null for null/undefined', () => {
      expect(ensureItemBagSchema(null)).toBeNull();
      expect(ensureItemBagSchema(undefined)).toBeNull();
    });

    it('should return null if pos is missing or invalid', () => {
      expect(ensureItemBagSchema(validBag({ pos: null }))).toBeNull();
      expect(ensureItemBagSchema(validBag({ pos: { x: 'a', y: 0 } }))).toBeNull();
    });

    it('should fix missing type field', () => {
      const bag = validBag({ type: undefined });
      const result = ensureItemBagSchema(bag);
      expect(result.type).toBe('InvObj');
    });

    it('should strip items with invalid amounts', () => {
      const bag = validBag();
      bag.invBlock.items.Bad = { amount: -1 };
      bag.invBlock.items.Zero = { amount: 0 };
      const result = ensureItemBagSchema(bag);
      expect(result.invBlock.items.Bad).toBeUndefined();
      expect(result.invBlock.items.Zero).toBeUndefined();
      expect(result.invBlock.items.Gem.amount).toBe(3);
    });

    it('should floor fractional item amounts', () => {
      const bag = validBag();
      bag.invBlock.items.Gem.amount = 3.9;
      const result = ensureItemBagSchema(bag);
      expect(result.invBlock.items.Gem.amount).toBe(3);
    });

    it('should create invBlock and items if missing', () => {
      const bag = validBag({ invBlock: undefined });
      const result = ensureItemBagSchema(bag);
      expect(result.invBlock).toBeDefined();
      expect(result.invBlock.items).toEqual({});
    });
  });
});
