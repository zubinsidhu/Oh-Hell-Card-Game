// ── Oh Hell – Server ───────────────────────────────────────────────────────
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const cors     = require('cors');
const path     = require('path');

const {
  createGameState, dealRound, placeBid,
  playCard, nextRound, publicState
} = require('./server/gameLogic');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'client/dist')));

// ── In-memory room store ──────────────────────────────────────────────────
// rooms[roomCode] = { state, hostId, playerSockets: {playerId → socketId} }
const rooms = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function broadcastState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const { state } = room;
  state.players.forEach(player => {
    const socketId = room.playerSockets[player.id];
    if (socketId) {
      io.to(socketId).emit('gameState', publicState(state, player.id));
    }
  });
}

// ── Socket Events ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('connect', socket.id);

  // Create a new room
  socket.on('createRoom', ({ playerName }, cb) => {
    const roomCode  = generateCode();
    const playerId  = socket.id;
    const player    = { id: playerId, name: playerName || 'Host' };
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

  // Join existing room
  socket.on('joinRoom', ({ roomCode, playerName }, cb) => {
    const room = rooms[roomCode];
    if (!room)              return cb({ ok: false, error: 'Room not found' });
    if (room.state && room.state.phase !== 'waiting')
      return cb({ ok: false, error: 'Game already in progress' });
    if (room.players.length >= 7)
      return cb({ ok: false, error: 'Room is full (max 7)' });

    const playerId = socket.id;
    const player   = { id: playerId, name: playerName || `Player ${room.players.length + 1}` };
    room.players.push(player);
    room.playerSockets[playerId] = socket.id;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerId = playerId;
    cb({ ok: true, roomCode, playerId });
    io.to(roomCode).emit('lobby', { players: room.players, hostId: room.hostId });
  });

  // Reconnect (player refreshed page)
  socket.on('reconnectRoom', ({ roomCode, playerId }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ ok: false, error: 'Room not found' });
    const existingPlayer = room.players.find(p => p.id === playerId);
    if (!existingPlayer) return cb({ ok: false, error: 'Player not found in room' });

    room.playerSockets[playerId] = socket.id;
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

  // Host starts the game
  socket.on('startGame', (_, cb) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    if (!room)                       return cb?.({ ok: false, error: 'No room' });
    if (room.hostId !== playerId)    return cb?.({ ok: false, error: 'Only host can start' });
    if (room.players.length < 2)     return cb?.({ ok: false, error: 'Need at least 2 players' });

    room.state = createGameState(room.players);
    room.state.scores = Object.fromEntries(room.players.map(p => [p.id, 0]));
    dealRound(room.state);
    broadcastState(roomCode);
    cb?.({ ok: true });
  });

  // Player places a bid
  socket.on('placeBid', ({ bid }, cb) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    if (!room?.state) return cb?.({ ok: false, error: 'No active game' });
    const result = placeBid(room.state, playerId, bid);
    if (result.ok) broadcastState(roomCode);
    cb?.(result);
  });

  // Player plays a card
  socket.on('playCard', ({ cardId }, cb) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    if (!room?.state) return cb?.({ ok: false, error: 'No active game' });
    const result = playCard(room.state, playerId, cardId);
    if (result.ok) broadcastState(roomCode);
    cb?.(result);
  });

  // Advance to next round (host clicks "Next Round")
  socket.on('nextRound', (_, cb) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    if (!room?.state) return cb?.({ ok: false });
    if (room.hostId !== playerId) return cb?.({ ok: false, error: 'Only host can advance rounds' });
    nextRound(room.state);
    broadcastState(roomCode);
    cb?.({ ok: true });
  });

  // Chat message
  socket.on('chat', ({ message }) => {
    const { roomCode, playerId } = socket.data;
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    io.to(roomCode).emit('chat', { name: player?.name || 'Unknown', message });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const { roomCode, playerId } = socket.data || {};
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];
    console.log(`${playerId} disconnected from ${roomCode}`);
    // Keep their spot for reconnection – just nullify socket mapping
    room.playerSockets[playerId] = null;
    io.to(roomCode).emit('playerDisconnected', { playerId });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Oh Hell server on :${PORT}`));
