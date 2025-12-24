const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const RETENTION_DAYS = 7;

function ensureLogsDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  } catch (e) {
    // fallthrough; logging may fail if dir can't be ensured
  }
}

function todayFile() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(LOGS_DIR, `${yyyy}-${mm}-${dd}.log`);
}

function serialize(meta) {
  if (meta == null) return '';
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

function append(level, message, meta) {
  try {
    const line = `${new Date().toISOString()} [${level}] ${message}${meta ? ' ' + serialize(meta) : ''}\n`;
    fs.appendFileSync(todayFile(), line);
  } catch (e) {
    // ignore logging failures
  }
}

function pruneOldLogs() {
  try {
    const now = Date.now();
    const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(LOGS_DIR);
    for (const file of files) {
      const full = path.join(LOGS_DIR, file);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(full, { force: true });
        }
      } catch {}
    }
  } catch {}
}

function scheduleWeeklyPrune() {
  // Run on startup and then every 24 hours
  pruneOldLogs();
  const DAY_MS = 24 * 60 * 60 * 1000;
  setInterval(pruneOldLogs, DAY_MS).unref?.();
}

ensureLogsDir();
scheduleWeeklyPrune();

const logger = {
  info: (msg, meta) => append('INFO', msg, meta),
  warn: (msg, meta) => append('WARN', msg, meta),
  error: (msg, meta) => append('ERROR', msg, meta),
  event: (name, meta) => append('EVENT', name, meta),
};

module.exports = { logger, LOGS_DIR, DATA_DIR };
