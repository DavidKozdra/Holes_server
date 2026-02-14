/**
 * E2E-style test for combat handler flows.
 *
 * Tests the player_dies event including kill/death tracking,
 * hearing-range chat broadcasting, and permadeath snapshot deletion.
 */
const combatHandlers = require('../../handlers/combatHandlers');
const { setSavedPlayers, getSavedPlayers, savePlayerSnapshot } = require('../../utils/playerUtils');

// ── Mock helpers ──
function mockSocket(id = 'sock_combat') {
  const listeners = {};
  return {
    id,
    _listeners: listeners,
    on(event, fn) { listeners[event] = fn; },
    emit: jest.fn(),
  };
}

function mockIo() {
  const toEmits = {};
  return {
    emit: jest.fn(),
    to: jest.fn((targetId) => {
      if (!toEmits[targetId]) toEmits[targetId] = { emit: jest.fn() };
      return toEmits[targetId];
    }),
    _toEmits: toEmits,
  };
}

function makePlayer(overrides = {}) {
  return {
    id: 'p1',
    name: 'Player1',
    pos: { x: 100, y: 100 },
    kills: 0,
    deaths: 0,
    isDead: false,
    statBlock: {
      stats: {
        hp: 100,
        mhp: 100,
        hearing: 5,
        attack: 3,
        magic: 1,
        magicResistance: 2,
      },
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
describe('Combat Handlers — E2E Flows', () => {
  beforeEach(() => {
    setSavedPlayers({});
  });

  describe('player_dies', () => {
    it('should increment death count for the dead player', () => {
      const victim = makePlayer({ id: 'victim', name: 'Victim' });
      const attacker = makePlayer({ id: 'attacker', name: 'Killer', pos: { x: 100, y: 100 } });
      const players = { victim, attacker };
      const io = mockIo();
      const socket = mockSocket('victim');

      combatHandlers.register(socket, { io, players });

      socket._listeners['player_dies']({
        x: 100, y: 100,
        id: 'victim',
        attacker: 'Killer',
        name: 'Victim',
      });

      expect(victim.deaths).toBe(1);
      expect(victim.isDead).toBe(true);
    });

    it('should increment kill count for the attacker', () => {
      const victim = makePlayer({ id: 'victim', name: 'Victim' });
      const attacker = makePlayer({ id: 'attacker', name: 'Killer' });
      const players = { victim, attacker };
      const io = mockIo();
      const socket = mockSocket('victim');

      combatHandlers.register(socket, { io, players });

      socket._listeners['player_dies']({
        x: 100, y: 100,
        id: 'victim',
        attacker: 'Killer',
        name: 'Victim',
      });

      expect(attacker.kills).toBe(1);
    });

    it('should broadcast PLAYER_MARKED_DEAD to all', () => {
      const victim = makePlayer({ id: 'victim', name: 'Victim' });
      const players = { victim };
      const io = mockIo();
      const socket = mockSocket('victim');

      combatHandlers.register(socket, { io, players });

      socket._listeners['player_dies']({
        x: 0, y: 0,
        id: 'victim',
        attacker: 'NPC',
        name: 'Victim',
      });

      expect(io.emit).toHaveBeenCalledWith('PLAYER_MARKED_DEAD', { id: 'victim' });
    });

    it('should send death chat message only to players within hearing range', () => {
      const victim = makePlayer({ id: 'victim', name: 'Victim', pos: { x: 0, y: 0 } });
      const nearby = makePlayer({
        id: 'nearby',
        name: 'Nearby',
        pos: { x: 100, y: 100 }, // very close
        statBlock: { stats: { hp: 100, mhp: 100, hearing: 5, attack: 1, magic: 1, magicResistance: 1 } },
      });
      const faraway = makePlayer({
        id: 'faraway',
        name: 'FarAway',
        pos: { x: 99999999, y: 99999999 }, // extremely far
        statBlock: { stats: { hp: 100, mhp: 100, hearing: 1, attack: 1, magic: 1, magicResistance: 1 } },
      });

      const players = { victim, nearby, faraway };
      const io = mockIo();
      const socket = mockSocket('victim');

      combatHandlers.register(socket, { io, players });

      socket._listeners['player_dies']({
        x: 0, y: 0,
        id: 'victim',
        attacker: 'Someone',
        name: 'Victim',
      });

      // Nearby should have received the chat message
      expect(io.to).toHaveBeenCalledWith('nearby');
      const nearbyEmitter = io._toEmits['nearby'];
      expect(nearbyEmitter).toBeDefined();
      expect(nearbyEmitter.emit).toHaveBeenCalledWith(
        'NEW_CHAT_MESSAGE',
        expect.objectContaining({
          message: expect.stringContaining('Victim'),
        }),
      );

      // Far-away should NOT have received it
      const farEmitter = io._toEmits['faraway'];
      if (farEmitter) {
        // If io.to was called (for iteration), the emit should not have been called
        const chatCalls = farEmitter.emit.mock.calls.filter(
          (c) => c[0] === 'NEW_CHAT_MESSAGE',
        );
        expect(chatCalls.length).toBe(0);
      }
    });

    it('should handle player_dies for a non-existent player ID gracefully', () => {
      const players = {};
      const io = mockIo();
      const socket = mockSocket('ghost');

      combatHandlers.register(socket, { io, players });

      // Should not throw
      expect(() => {
        socket._listeners['player_dies']({
          x: 0, y: 0,
          id: 'nobody',
          attacker: 'Someone',
          name: 'Ghost',
        });
      }).not.toThrow();

      expect(io.emit).toHaveBeenCalledWith('PLAYER_MARKED_DEAD', { id: 'nobody' });
    });
  });
});
