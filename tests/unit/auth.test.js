const { hashPassword, verifyPassword, PASSWORD_SALT_ROUNDS } = require('../../utils/auth');

describe('Auth Utilities', () => {
  // ── hashPassword ──
  describe('hashPassword', () => {
    it('should return a bcrypt hash string for a valid password', () => {
      const hash = hashPassword('mySecret123');
      expect(hash).toBeTruthy();
      expect(typeof hash).toBe('string');
      expect(hash.startsWith('$2a$') || hash.startsWith('$2b$')).toBe(true);
    });

    it('should return null for an empty string', () => {
      expect(hashPassword('')).toBeNull();
    });

    it('should return null for undefined', () => {
      expect(hashPassword()).toBeNull();
    });

    it('should return null for a non-string value', () => {
      expect(hashPassword(12345)).toBeNull();
      expect(hashPassword(null)).toBeNull();
      expect(hashPassword({})).toBeNull();
    });

    it('should produce different hashes for the same password (salted)', () => {
      const h1 = hashPassword('samePass');
      const h2 = hashPassword('samePass');
      expect(h1).not.toEqual(h2);
    });
  });

  // ── verifyPassword ──
  describe('verifyPassword', () => {
    it('should return true when plaintext matches the hash', () => {
      const hash = hashPassword('hunter2');
      expect(verifyPassword('hunter2', hash)).toBe(true);
    });

    it('should return false when plaintext does not match the hash', () => {
      const hash = hashPassword('hunter2');
      expect(verifyPassword('wrongPassword', hash)).toBe(false);
    });

    it('should return false when plaintext is empty', () => {
      const hash = hashPassword('something');
      expect(verifyPassword('', hash)).toBe(false);
    });

    it('should return false when hash is empty', () => {
      expect(verifyPassword('hello', '')).toBe(false);
    });

    it('should return false when both args are empty', () => {
      expect(verifyPassword('', '')).toBe(false);
    });

    it('should return false for non-string arguments', () => {
      expect(verifyPassword(123, 'hash')).toBe(false);
      expect(verifyPassword('pass', 456)).toBe(false);
      expect(verifyPassword(null, null)).toBe(false);
    });

    it('should return false for a malformed hash string', () => {
      expect(verifyPassword('pass', 'not-a-real-hash')).toBe(false);
    });
  });

  // ── PASSWORD_SALT_ROUNDS ──
  describe('PASSWORD_SALT_ROUNDS', () => {
    it('should be a number between 4 and 14', () => {
      expect(typeof PASSWORD_SALT_ROUNDS).toBe('number');
      expect(PASSWORD_SALT_ROUNDS).toBeGreaterThanOrEqual(4);
      expect(PASSWORD_SALT_ROUNDS).toBeLessThanOrEqual(14);
    });
  });
});
