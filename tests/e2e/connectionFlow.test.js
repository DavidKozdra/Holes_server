/**
 * E2E-style test for the connection handler flows.
 *
 * We mock Socket.IO and test the full new_player → disconnect lifecycle,
 * including name validation, bad-word filtering, password protection,
 * max-player enforcement, and snapshot persistence on disconnect.
 */
const { setSavedPlayers, getSavedPlayers } = require('../../utils/playerUtils');
const connectionHandlers = require('../../handlers/connectionHandlers');

// ── Mock helpers ──
function mockSocket(id = 'sock_abc') {
  const listeners = {};
  return {
    id,
    _listeners: listeners,
    on(event, fn) { listeners[event] = fn; },
    emit: jest.fn(),
    broadcast: { emit: jest.fn() },
    join: jest.fn(),
    leave: jest.fn(),
    disconnect: jest.fn(),
    use: jest.fn((middleware) => {
      // Store middleware but don't exercise it in these tests
    }),
  };
}

function mockIo() {
  const emitted = [];
  const io = {
    _emitted: emitted,
    emit: jest.fn((...args) => emitted.push(args)),
    to: jest.fn(() => ({
      emit: jest.fn((...args) => emitted.push(args)),
    })),
    sockets: { on: jest.fn() },
  };
  return io;
}

function makeCtx(overrides = {}) {
  const players = overrides.players || {};
  const teams = overrides.teams || {};
  const io = overrides.io || mockIo();
  return {
    io,
    players,
    teams,
    globals: { players, teams, serverMap: null, chatMessages: [] },
    broadcast: {
      emitToAll: jest.fn(),
      emitToRoom: jest.fn(),
      isUdpReady: () => false,
      setUdpReady: jest.fn(),
      init: jest.fn(),
    },
    getServerMap: () => ({ chunks: {} }),
    udpReady: false,
    countdown: 0,
    timerEndAt: null,
    TIMER_DISABLED: true,
  };
}

// ═══════════════════════════════════════════════════════════
describe('Connection Handlers — E2E Flows', () => {
  beforeEach(() => {
    setSavedPlayers({});
    connectionHandlers.setKillsDeaths({});
  });

  // ── Server full ──
  describe('server full enforcement', () => {
    it('should reject connection when at max players', () => {
      const players = { p1: { id: 'p1' }, p2: { id: 'p2' } };
      // MAX_PLAYERS is 10 by default but we'll fill it to match
      const ctx = makeCtx({ players });
      // Temporarily override MAX_PLAYERS by filling up to the limit
      for (let i = 0; i < 10; i++) players[`p${i}`] = { id: `p${i}` };

      const socket = mockSocket('new_sock');
      const result = connectionHandlers.register(socket, ctx);
      expect(result).toBe(false);
    });
  });

  // ── new_player flow ──
  describe('new_player', () => {
    it('should register a new player and add them to the players object', () => {
      const players = {};
      const ctx = makeCtx({ players });
      const socket = mockSocket('sock_1');

      connectionHandlers.register(socket, ctx);

      // Trigger new_player event
      const ack = jest.fn();
      socket._listeners['new_player']({
        id: 'sock_1',
        name: 'Alice',
        pos: { x: 0, y: 0 },
        race: 0,
      }, ack);

      expect(players['sock_1']).toBeDefined();
      expect(players['sock_1'].name).toBe('Alice');
      expect(players['sock_1'].kills).toBe(0);
      expect(players['sock_1'].deaths).toBe(0);
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('should reject a player with no name', () => {
      const ctx = makeCtx();
      const socket = mockSocket('sock_2');
      connectionHandlers.register(socket, ctx);

      const ack = jest.fn();
      socket._listeners['new_player']({ id: 'sock_2' }, ack);

      expect(ack).toHaveBeenCalledWith(expect.objectContaining({
        ok: false,
        code: 'INVALID_NAME',
      }));
    });

    it('should filter bad words from names', () => {
      const players = {};
      const ctx = makeCtx({ players });
      const socket = mockSocket('sock_3');
      connectionHandlers.register(socket, ctx);

      const ack = jest.fn();
      socket._listeners['new_player']({
        id: 'sock_3',
        name: 'fuck_lord',
        pos: { x: 0, y: 0 },
        race: 0,
      }, ack);

      // Name should have been replaced
      expect(players['sock_3'].name).not.toContain('fuck');
      expect(players['sock_3'].name).toMatch(/^Player[0-9a-f]{4}$/);
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('should reject duplicate live names', () => {
      const players = { existing: { id: 'existing', name: 'Bob' } };
      const ctx = makeCtx({ players });
      const socket = mockSocket('sock_4');
      connectionHandlers.register(socket, ctx);

      const ack = jest.fn();
      socket._listeners['new_player']({
        id: 'sock_4',
        name: 'Bob',
        pos: { x: 0, y: 0 },
      }, ack);

      expect(ack).toHaveBeenCalledWith(expect.objectContaining({
        ok: false,
        code: 'NAME_IN_USE',
      }));
    });

    it('should require password for a saved player with one set', () => {
      const { hashPassword } = require('../../utils/auth');
      setSavedPlayers({
        SecurePlayer: {
          name: 'SecurePlayer',
          passwordHash: hashPassword('secret'),
          pos: { x: 10, y: 20 },
        },
      });

      const players = {};
      const ctx = makeCtx({ players });
      const socket = mockSocket('sock_5');
      connectionHandlers.register(socket, ctx);

      // No password supplied
      const ack1 = jest.fn();
      socket._listeners['new_player']({
        id: 'sock_5',
        name: 'SecurePlayer',
        pos: { x: 0, y: 0 },
      }, ack1);
      expect(ack1).toHaveBeenCalledWith(expect.objectContaining({
        ok: false,
        code: 'PASSWORD_REQUIRED',
      }));

      // Wrong password
      const ack2 = jest.fn();
      socket._listeners['new_player']({
        id: 'sock_5',
        name: 'SecurePlayer',
        password: 'wrong',
        pos: { x: 0, y: 0 },
      }, ack2);
      expect(ack2).toHaveBeenCalledWith(expect.objectContaining({
        ok: false,
        code: 'BAD_PASSWORD',
      }));

      // Correct password
      const ack3 = jest.fn();
      socket._listeners['new_player']({
        id: 'sock_5',
        name: 'SecurePlayer',
        password: 'secret',
        pos: { x: 0, y: 0 },
        race: 0,
      }, ack3);
      expect(ack3).toHaveBeenCalledWith(expect.objectContaining({ ok: true, isReturning: true }));
      expect(players['sock_5'].name).toBe('SecurePlayer');
    });

    it('should restore saved position and inventory for returning players', () => {
      setSavedPlayers({
        Returner: {
          name: 'Returner',
          pos: { x: 500, y: 600 },
          invBlock: {
            items: { Gem: { amount: 10 } },
            hotbar: ['Gem', '', '', '', ''],
            selectedHotBar: 1,
            equiped: { head: '', neck: '', chest: '', legs: '', feet: '' },
          },
          statBlock: { level: 5, xp: 30, xpNeeded: 100, stats: { hp: 80, mhp: 100, attack: 4, magic: 2, magicResistance: 2 } },
          maxDirtInv: 900,
        },
      });

      const players = {};
      const ctx = makeCtx({ players });
      const socket = mockSocket('sock_6');
      connectionHandlers.register(socket, ctx);

      const ack = jest.fn();
      socket._listeners['new_player']({
        id: 'sock_6',
        name: 'Returner',
        pos: { x: 0, y: 0 },
        race: 0,
      }, ack);

      expect(players['sock_6'].pos).toEqual({ x: 500, y: 600 });
      expect(players['sock_6'].invBlock.items.Gem.amount).toBe(10);
      expect(players['sock_6'].statBlock.level).toBe(5);
      expect(players['sock_6'].maxDirtInv).toBe(900);
    });
  });

  // ── disconnect flow ──
  describe('disconnect', () => {
    it('should remove player from players map and emit goodbye with correct name', () => {
      const players = {};
      const io = mockIo();
      const ctx = makeCtx({ players, io });
      const socket = mockSocket('sock_dc');
      connectionHandlers.register(socket, ctx);

      // First join a player
      socket._listeners['new_player']({
        id: 'sock_dc',
        name: 'Leaver',
        pos: { x: 0, y: 0 },
        race: 0,
      }, jest.fn());

      expect(players['sock_dc']).toBeDefined();

      // Now disconnect
      socket._listeners['disconnect']('transport close');

      // Player should be removed
      expect(players['sock_dc']).toBeUndefined();

      // Goodbye message should reference the name, not "a player"
      const chatCalls = io.emit.mock.calls.filter(
        (c) => c[0] === 'NEW_CHAT_MESSAGE',
      );
      const goodbyeCall = chatCalls.find((c) => c[1]?.message?.includes('Goodbye'));
      expect(goodbyeCall).toBeDefined();
      expect(goodbyeCall[1].message).toContain('Leaver');
      expect(goodbyeCall[1].message).not.toContain('a player');
    });

    it('should save a player snapshot on disconnect', () => {
      const players = {};
      const ctx = makeCtx({ players });
      const socket = mockSocket('sock_save');
      connectionHandlers.register(socket, ctx);

      socket._listeners['new_player']({
        id: 'sock_save',
        name: 'Saver',
        pos: { x: 100, y: 200 },
        race: 1,
        invBlock: {
          items: { Bomb: { amount: 3 } },
          hotbar: ['', '', '', '', ''],
          selectedHotBar: 0,
          equiped: { head: '', neck: '', chest: '', legs: '', feet: '' },
        },
      }, jest.fn());

      socket._listeners['disconnect']('client namespace disconnect');

      const saved = getSavedPlayers();
      expect(saved['Saver']).toBeDefined();
      expect(saved['Saver'].pos).toEqual({ x: 100, y: 200 });
    });

    it('should preserve kills/deaths across disconnect → reconnect', () => {
      const players = {};
      const ctx = makeCtx({ players });
      const socket1 = mockSocket('sock_old');
      connectionHandlers.register(socket1, ctx);

      socket1._listeners['new_player']({
        id: 'sock_old',
        name: 'Fighter',
        pos: { x: 0, y: 0 },
        race: 0,
      }, jest.fn());

      players['sock_old'].kills = 7;
      players['sock_old'].deaths = 3;

      // Disconnect
      socket1._listeners['disconnect']('transport close');
      expect(players['sock_old']).toBeUndefined();

      // kills_deaths should have been stored
      const kd = connectionHandlers.getKillsDeaths();
      expect(kd['sock_old']).toEqual({ kills: 7, deaths: 3 });

      // Reconnect with a new socket id
      const socket2 = mockSocket('sock_new');
      connectionHandlers.register(socket2, ctx);

      socket2._listeners['player_reconnected']({
        player: {
          id: 'sock_new',
          name: 'Fighter',
          pos: { x: 50, y: 50 },
          race: 0,
        },
        oldID: 'sock_old',
      });

      expect(players['sock_new']).toBeDefined();
      expect(players['sock_new'].kills).toBe(7);
      expect(players['sock_new'].deaths).toBe(3);
      // Old kd entry should be cleaned up
      expect(kd['sock_old']).toBeUndefined();
    });
  });

  // ── player_leave flow ──
  describe('player_leave', () => {
    it('should remove the player and save snapshot', () => {
      const players = {};
      const ctx = makeCtx({ players });
      const socket = mockSocket('sock_leave');
      connectionHandlers.register(socket, ctx);

      socket._listeners['new_player']({
        id: 'sock_leave',
        name: 'Quitter',
        pos: { x: 10, y: 20 },
        race: 2,
      }, jest.fn());

      socket._listeners['player_leave']({ playerName: 'Quitter' });

      expect(players['sock_leave']).toBeUndefined();
      expect(getSavedPlayers()['Quitter']).toBeDefined();
    });
  });
});
