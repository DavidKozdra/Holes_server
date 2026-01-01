const { Map } = require('./utils/map');

// Central shared state (single object so mutations are visible everywhere)
const state = {
  players: {},
  traps: {},
  serverMap: null,
  chatMessages: [
    {
      message: 'Hello, welcome to the chat!',
      x: 0,
      y: 0,
      user: 'Server',
    },
  ],
  serverStartTime: Date.now(), // Capture startup timestamp in milliseconds
  teams: {}, // { teamId: { name, color, creator, members: [], requests: [] } }
  nextTeamId: 1,
  summaryCache: null, // latest summary snapshot
  playerSnapshotCache: {}, // last known player list for pre-restart use
};

function getGlobals() {
  return state;
}

// Initialize serverMap after getGlobals is defined to pass the callback (avoids circular require)
state.serverMap = new Map(Math.random(), getGlobals);

module.exports = { getGlobals };
