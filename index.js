// ── Oh Hell – Server ───────────────────────────────────────────────────────
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const cors     = require('cors');
const path     = require('path');

const {
  createGameState, dealRound, placeBid, playCard, resolveTrickEnd,
  nextRound, markReady, publicState, botChooseBid, botChooseCard, legalCards
} = require('./server/gameLogic');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'client/dist')));

const rooms = {};
// Track auto-next timers per room
const autoNextTimers = {};
// Track bot turn timers
const botTimers = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function broadcastState(roomCode) {
  const room = rooms[roomCode];
  if (!room?.state) return;
  const { state } = room;
  state.players.forEach(player => {
    if (player.isBot) return;
    const socketId = room.playerSockets[player.id];
    if (socketId) {
      io.to(socketId).emit('gameState', publicState(state, player.id));
    }
  });
}

// ── Bot helpers ────────────────────────────────────────────────────────────

function scheduleBotTurn(roomCode) {
  if (botTimers[roomCode]) clearTimeout(botTimers[roomCode]);
  botTimers[roomCode] = setTimeout(() => runBotTurnIfNeeded(roomCode), 1200);
}

function runBotTurnIfNeeded(roomCode) {
  const room = rooms[roomCode];
  if (!room?.state) return;
  const { state } = room;
  const currentPlayer = state.players[state.currentPlayerIndex];
  if (!currentPlayer) return;

  // Check if current player is a bot OR a disconnected human
  const isDisconnected = !currentPlayer.isBot && !room.playerSockets[currentPlayer.id];
  if (!currentPlayer.isBot && !isDisconnected) return;

  if (state.phase === 'bidding') {
    const bidsSoFar = { ...state.bids };
    const numCards = state.roundSequence[state.roundIndex];
    const isDealer = state.currentPlayerIndex === state.dealerIndex;
    const bid = botChooseBid(state.hands[currentPlayer.id], numCards, bidsSoFar, isDealer, state.trumpSuit);
    placeBid(state, currentPlayer.id, bid);
    broadcastState(roomCode);
    // Check if next player is also bot/disconnected
    const next = state.players[state.currentPlayerIndex];
    const nextIsBot = next?.isBot || !room.playerSockets[next?.id];
    if (state.phase === 'bidding' && nextIsBot) scheduleBotTurn(roomCode);
    if (state.phase === 'playing') scheduleBotTurn(roomCode);
  } else if (state.phase === 'playing') {
    const hand = state.hands[currentPlayer.id];
    const card = botChooseCard(hand, state.currentTrick, state.trumpSuit,
      state.bids[currentPlayer.id], state.tricks[currentPlayer.id]);
    const cid = `${card.rank}${card.suit}`;
    const result = playCard(state, currentPlayer.id, cid);
    if (result.ok && result.trickComplete) {
      broadcastState(roomCode);
      // Animate trick end then resolve
      setTimeout(() => {
        resolveTrickEnd(state);
        broadcastState(roomCode);
        if (state.phase === 'playing' || state.phase === 'bidding') scheduleBotTurn(roomCode);
        if (state.phase === 'roundEnd') scheduleAutoNext(roomCode);
      }, 1800);
    } else {
      broadcastState(roomCode);
      const next = state.players[state.currentPlayerIndex];
      const nextIsBot = next?.isBot || !room.playerSockets[next?.id];
      if (nextIsBot) scheduleBotTurn(roomCode);
    }
  }
}

// ── Auto next round ────────────────────────────────────────────────────────

function scheduleAutoNext(roomCode) {
  if (autoNextTimers[roomCode]) clearTimeout(autoNextTimers[roomCode]);
  const room = rooms[roomCode];
  if (!room?.state || room.state.phase === 'gameEnd') return;

  io.to(roomCode).emit('autoNextCountdown', { seconds: 10 });

  autoNextTimers[roomCode] = setTimeout(() => {
    const r = rooms[roomCode];
    if (!r?.state || r.state.phase !== 'roundEnd') return;
    nextRound(r.state);
    broadcastState(roomCode);
    io.to(roomCode).emit('roundStarted'); // closes overlay on all clients
    scheduleBotTurn(roomCode);
  }, 10000);
}

function cancelAutoNext(roomCode) {
  if (autoNextTimers[roomCode]) {
    clearTimeout(autoNextTimers[roomCode]);
    delete autoNextTimers[roomCode];
  }
}

// Feature #7: detect all-bot game and terminate
function checkAllBots(roomCode) {
  const room = rooms[roomCode];
  if (!room?.state) return;
  const humanConnected = room.state.players.some(p => !p.isBot && room.playerSockets[p.id]);
  if (!humanConnected) {
    console.log(`Room ${roomCode}: all players are bots/disconnected — terminating game`);
    if (botTimers[roomCode]) clearTimeout(botTimers[roomCode]);
    cancelAutoNext(roomCode);
    room.state.phase = 'gameEnd';
    room.state.log.push('Game ended: no human players remaining.');
  }
}

// ── Socket Events ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // Create room
  socket.on('createRoom', ({ playerName, emoji }, cb) => {
    const roomCode = generateCode();
    const playerId = socket.id;
    const player   = { id: playerId, name: playerName || 'Host', emoji: emoji || '🎴', isBot: false };
    rooms[roomCode] = {
      state: null,
      hostId: playerId,
      players: [player],
      playerSockets: { [playerId]: socket.id },
    };
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerId = playerId;
    cb({ ok: true, roomCode, playerId });
    io.to(roomCode).emit('lobby', { players: rooms[roomCode].players, hostId: rooms[roomCode].hostId });
  });

  // Join room — also handles name-based rejoin (Feature #11)
  socket.on('joinRoom', ({ roomCode, playerName, emoji }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ ok: false, error: 'Room not found' });

    const trimmedName = (playerName || '').trim();
    if (!trimmedName) return cb({ ok: false, error: 'Name is required' });

    // Feature #11: name-based rejoin during active game
    if (room.state && room.state.phase !== 'waiting' && room.state.phase !== 'gameEnd') {
      const existing = room.state.players.find(p =>
        p.name.toLowerCase() === trimmedName.toLowerCase()
      );
      if (existing) {
        // Rejoin as that player
        room.playerSockets[existing.id] = socket.id;
        // Un-bot them if they were subbed
        existing.isBot = false;
        socket.join(roomCode);
        socket.data.roomCode = roomCode;
        socket.data.playerId = existing.id;
        cb({ ok: true, roomCode, playerId: existing.id, rejoined: true });
        socket.emit('gameState', publicState(room.state, existing.id));
        io.to(roomCode).emit('chat', { name: 'Game', message: `${trimmedName} has rejoined!` });
        return;
      }
      return cb({ ok: false, error: 'Game in progress. If you were playing, use your exact original name to rejoin.' });
    }

    if ((room.players || []).length >= 7)
      return cb({ ok: false, error: 'Room is full (max 7)' });

    const playerId = socket.id;
    const player   = { id: playerId, name: trimmedName, emoji: emoji || '🎴', isBot: false };
    room.players = room.players || [];
    room.players.push(player);
    room.playerSockets[playerId] = socket.id;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerId = playerId;
    cb({ ok: true, roomCode, playerId });
    io.to(roomCode).emit('lobby', { players: room.players, hostId: room.hostId });
  });

  // Reconnect by socket session
  socket.on('reconnectRoom', ({ roomCode, playerId }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ ok: false, error: 'Room not found' });
    const existingPlayer = (room.state?.players || room.players || []).find(p => p.id === playerId);
    if (!existingPlayer) return cb({ ok: false, error: 'Player not found' });
    room.playerSockets[playerId] = socket.id;
    existingPlayer.isBot = false;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerId = playerId;
    cb({ ok: true });
    if (room.state) {
      socket.emit('gameState', publicState(room.state, playerId));
    } else {
      socket.emit('lobby', { players: room.players, hostId: room.hostId });
    }
  });

  // Update emoji
  socket.on('setEmoji', ({ emoji }) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    if (!room) return;
    const player = (room.state?.players || room.players || []).find(p => p.id === playerId);
    if (player) player.emoji = emoji;
    if (room.state) broadcastState(roomCode);
    else io.to(roomCode).emit('lobby', { players: room.players, hostId: room.hostId });
  });

  // Start game
  socket.on('startGame', (_, cb) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    if (!room)                    return cb?.({ ok: false, error: 'No room' });
    if (room.hostId !== playerId) return cb?.({ ok: false, error: 'Only host can start' });
    if (room.players.length < 2)  return cb?.({ ok: false, error: 'Need at least 2 players' });
    room.state = createGameState(room.players);
    room.state.scores = Object.fromEntries(room.players.map(p => [p.id, 0]));
    dealRound(room.state);
    broadcastState(roomCode);
    cb?.({ ok: true });
    scheduleBotTurn(roomCode);
  });

  // Place bid
  socket.on('placeBid', ({ bid }, cb) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    if (!room?.state) return cb?.({ ok: false, error: 'No active game' });
    const result = placeBid(room.state, playerId, bid);
    if (result.ok) {
      broadcastState(roomCode);
      scheduleBotTurn(roomCode);
    }
    cb?.(result);
  });

  // Play card
  socket.on('playCard', ({ cardId }, cb) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    if (!room?.state) return cb?.({ ok: false, error: 'No active game' });
    if (room.state.phase !== 'playing') return cb?.({ ok: false, error: 'Not play phase' });
    const result = playCard(room.state, playerId, cardId);
    if (result.ok) {
      broadcastState(roomCode);
      if (result.trickComplete) {
        // Give clients 1.8s to animate, then resolve
        setTimeout(() => {
          resolveTrickEnd(room.state);
          broadcastState(roomCode);
          if (room.state.phase === 'roundEnd') {
            scheduleAutoNext(roomCode);
          } else {
            scheduleBotTurn(roomCode);
          }
        }, 1800);
      } else {
        scheduleBotTurn(roomCode);
      }
    }
    cb?.(result);
  });

  // Player ready for next round
  socket.on('readyNextRound', (_, cb) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    if (!room?.state || room.state.phase !== 'roundEnd') return cb?.({ ok: false });
    const allReady = markReady(room.state, playerId);
    broadcastState(roomCode); // sync ready counts to everyone
    if (allReady) {
      cancelAutoNext(roomCode);
      nextRound(room.state);
      broadcastState(roomCode);
      io.to(roomCode).emit('roundStarted'); // closes overlay on all clients
      scheduleBotTurn(roomCode);
    }
    cb?.({ ok: true });
  });

  // Chat
  socket.on('chat', ({ message }) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    if (!room) return;
    const player = (room.state?.players || room.players || []).find(p => p.id === playerId);
    io.to(roomCode).emit('chat', { name: player?.name || 'Unknown', message });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const { roomCode, playerId } = socket.data || {};
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];
    room.playerSockets[playerId] = null;
    const player = room.state?.players.find(p => p.id === playerId);
    if (player) {
      io.to(roomCode).emit('chat', {
        name: 'Game',
        message: `${player.name} disconnected. Bot is filling in. Rejoin with the same name to take back over.`
      });
      setTimeout(() => {
        if (!room.playerSockets[playerId]) {
          checkAllBots(roomCode); // terminate if everyone left
          scheduleBotTurn(roomCode);
        }
      }, 5000);
    }
    io.to(roomCode).emit('playerDisconnected', { playerId });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Oh Hell server on :${PORT}`));
