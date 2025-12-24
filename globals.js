const { Map } = require('./utils/map');

// Central shared state (single object so mutations are visible everywhere)
const state = {
  players: {},
  traps: {},
  serverMap: new Map(Math.random()),
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

module.exports = { getGlobals };
