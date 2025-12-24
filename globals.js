const { Map } = require('./utils/map');

let players = {};
let traps = {};
let serverMap = new Map(Math.random());
let chatMessages = [
  {
    message: 'Hello, welcome to the chat!',
    x: 0,
    y: 0,
    user: 'Server',
  },
];
let serverStartTime = Date.now(); // Capture startup timestamp in milliseconds

function getGlobals() {
  // needs to request to the server no ?
  // might send too much text maybe filtering the last chats 
  // this should be more functional ...
  return { players, traps, serverMap, chatMessages, serverStartTime };
}

// Ensure correct export
module.exports = { getGlobals };
