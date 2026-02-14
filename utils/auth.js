const bcrypt = require('bcryptjs');

const PASSWORD_SALT_ROUNDS = Math.min(14, Math.max(4, parseInt(process.env.PASSWORD_SALT_ROUNDS || '10', 10)));

function hashPassword(plain = '') {
  if (!plain || typeof plain !== 'string') return null;
  try {
    return bcrypt.hashSync(plain, PASSWORD_SALT_ROUNDS);
  } catch (e) {
    console.warn('[Auth] Failed to hash password', e);
    return null;
  }
}

function verifyPassword(plain = '', hashed = '') {
  if (!plain || !hashed || typeof plain !== 'string' || typeof hashed !== 'string') return false;
  try {
    return bcrypt.compareSync(plain, hashed);
  } catch (e) {
    console.warn('[Auth] Failed to verify password', e);
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, PASSWORD_SALT_ROUNDS };
