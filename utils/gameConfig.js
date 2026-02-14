const dotenv = require('dotenv');
dotenv.config();

// Permadeath toggle (set PERMA_DEATH=true in environment to enable)
const PERMA_DEATH_ENABLED = (process.env.PERMA_DEATH || 'false').toLowerCase() === 'true';

// Timer/Restart configuration
const SERVER_TIME_ENV = process.env.SERVER_TIME;
const TIMER_DISABLED = !SERVER_TIME_ENV || (typeof SERVER_TIME_ENV === 'string' && SERVER_TIME_ENV.toUpperCase() === 'NO TIME');
const RESTART_ON_TIMER = (process.env.RESTART_ON_TIMER || 'true').toLowerCase() === 'true';

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = parseInt(process.env.MAX, 10) || 10;
const SAVE_INTERVAL_HOURS = parseFloat(process.env.SAVE_INTERVAL_HOURS || '0.25');
const SUMMARY_INTERVAL_MS = parseInt(process.env.SUMMARY_INTERVAL_MS || '30000', 10);
const PLAYER_SAVE_DEBOUNCE_MS = parseInt(process.env.PLAYER_SAVE_DEBOUNCE_MS || '400', 10);

const NODE_FLUSH_INTERVAL_MS = 30;  // was 75 — reduced for faster terrain broadcast to other players
const BAG_MERGE_INTERVAL_MS = 150;
const BAG_MERGE_BUDGET = 25;
const CHUNK_EVICTION_INTERVAL_MS = 60 * 1000;
const CHUNK_KEEP_RADIUS = 4;

// ── AI Entity Spawning ──
const ENTITY_RESPAWN_INTERVAL_S = 45;              // seconds between respawn sweeps
const MAX_ENTITIES_PER_CHUNK = 5;                   // hard cap on brain entities per chunk
const ANT_SPAWN_CHANCE = 1.0;                       // chance to spawn ants on chunk gen
const ANT_MIN_PER_CHUNK = 1;                        // min ants on fresh chunk
const ANT_MAX_PER_CHUNK = 3;                        // max ants on fresh chunk
const RACE_ENTITY_SPAWN_CHANCE = 0.65;              // chance to spawn a race entity on chunk gen
const RACE_MAX_PER_CHUNK = 2;                       // max race entities on fresh chunk
const RESPAWN_CHANCE_ANT = 0.4;                     // per-chunk chance to respawn an ant each tick
const RESPAWN_CHANCE_RACE = 0.15;                   // per-chunk chance to respawn a race entity each tick
const RESPAWN_NEARBY_RADIUS = 3;                    // only respawn in chunks within this radius of players

const BAD_WORDS = ['shit', 'fuck', 'bitch', 'cunt', 'nigg', 'asshole', 'cock', 'dick', 'fag', 'kike'];
const BAD_WORD_REGEX = new RegExp(BAD_WORDS.join('|'), 'i');

const SERVER_WELCOME_NEW = process.env.Server_Welcome || 'Please Welcome';
const SERVER_WELCOME_RETURNING = process.env.Server_Welcome_Returning || 'Welcome back';

const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : true;

// Base stats for each race - must match client-side
const BASE_STATS = [
  {
    name: "gnome",
    hp: 100, mhp: 100, healthRegen: 0.2, attack: 2, magic: 1, mp: 100, mmp: 100,
    magicResistance: 2, luck: 10, credit: 1, hearing: 1, speakingRange: 2,
    Fear: 1, powerLevel: 1, handDigSpeed: 0.05, runningSpeed: 1.3,
    growth: { hp: 10, mhp: 10, attack: 2, magic: 0.5, healthRegen: 0.05, mp: 1, mmp: 1, magicResistance: 0.2, luck: 1, runningSpeed: 0.05 }
  },
  {
    name: "aylah",
    hp: 100, mhp: 100, healthRegen: 0.1, attack: 1, magic: 5, mp: 150, mmp: 150,
    magicResistance: 5, luck: 1, credit: 1, hearing: 5, speakingRange: 1,
    Fear: 1, powerLevel: 1, handDigSpeed: 0.07, runningSpeed: 1,
    growth: { hp: 5, mhp: 5, attack: 0.5, magic: 2, healthRegen: 0.02, mp: 20, mmp: 20, magicResistance: 0.25, luck: 0.5, runningSpeed: 0.2 }
  },
  {
    name: "skizzard",
    hp: 100, mhp: 100, healthRegen: 5, attack: 1, magic: 1, mp: 100, mmp: 100,
    magicResistance: 1, luck: 1, credit: 1, hearing: 5, speakingRange: 1,
    Fear: 2, powerLevel: 1, handDigSpeed: 0.08, runningSpeed: 1.2,
    growth: { hp: 8, mhp: 8, attack: 0.5, magic: 0.5, healthRegen: 0.06, mp: 10, mmp: 10, magicResistance: 0.1, luck: 0.5, runningSpeed: 0.11 }
  }
];

module.exports = {
  PERMA_DEATH_ENABLED,
  SERVER_TIME_ENV,
  TIMER_DISABLED,
  RESTART_ON_TIMER,
  PORT,
  MAX_PLAYERS,
  SAVE_INTERVAL_HOURS,
  SUMMARY_INTERVAL_MS,
  PLAYER_SAVE_DEBOUNCE_MS,
  NODE_FLUSH_INTERVAL_MS,
  BAG_MERGE_INTERVAL_MS,
  BAG_MERGE_BUDGET,
  CHUNK_EVICTION_INTERVAL_MS,
  CHUNK_KEEP_RADIUS,
  ENTITY_RESPAWN_INTERVAL_S,
  MAX_ENTITIES_PER_CHUNK,
  ANT_SPAWN_CHANCE,
  ANT_MIN_PER_CHUNK,
  ANT_MAX_PER_CHUNK,
  RACE_ENTITY_SPAWN_CHANCE,
  RACE_MAX_PER_CHUNK,
  RESPAWN_CHANCE_ANT,
  RESPAWN_CHANCE_RACE,
  RESPAWN_NEARBY_RADIUS,
  BAD_WORDS,
  BAD_WORD_REGEX,
  SERVER_WELCOME_NEW,
  SERVER_WELCOME_RETURNING,
  CORS_ORIGINS,
  BASE_STATS,
};
