# 🃏 Oh Hell – Multiplayer Card Game

A fully-featured online multiplayer implementation of **Oh Hell** (also known as Blob, Blackout, Nomination Whist, and many other names), built with Node.js, Socket.IO, and vanilla JavaScript.

---

## 🚀 Quick Start

### Prerequisites
- Node.js 16+

### Install & Run
```bash
npm install
npm start
```

Then open **http://localhost:3001** in your browser.

---

## 🎮 How to Play

1. **Create a Room** — enter your name and click "Create Room"
2. **Share the Code** — give the 4-letter room code to friends
3. **Friends Join** — they go to the same URL, enter the code and their name
4. **Host starts** — once 2–7 players have joined, the host clicks "Deal Cards"

### Game Rules

**Oh Hell** is a trick-taking card game where the goal is to win *exactly* as many tricks as you bid — no more, no less.

#### Rounds
- Starts at **10 cards**, goes down to **1 card**, then back up to **10 cards** (19 rounds total)
- The trump suit is determined by flipping the top card after dealing

#### Bidding
- Players bid in order starting left of the dealer
- **Hook Rule**: The dealer cannot bid an amount that would make the total bids equal the number of tricks available (someone *must* fail!)

#### Trick Taking
- Player left of dealer leads the first trick
- Players **must follow suit** if they can; otherwise may play any card (including trump)
- Highest card of the led suit wins, unless a trump was played — highest trump wins
- Winner of a trick leads the next

#### Scoring
- **Made your bid**: +10 points, +1 per trick won
- **Missed your bid**: Penalty equal to the difference (e.g., bid 3, got 1 → -2 points)

---

## 🏗️ Architecture

```
oh-hell/
├── index.js              # Express + Socket.IO server
├── server/
│   └── gameLogic.js      # Pure game logic (deck, bidding, trick resolution, scoring)
└── client/
    └── dist/
        └── index.html    # Single-file frontend (no build step required)
```

### Tech Stack
- **Backend**: Node.js + Express (serves static files + REST)
- **Real-time**: Socket.IO (WebSockets with fallback)
- **Frontend**: Vanilla JS + HTML/CSS (no build step, no framework dependencies)

### Key Design Decisions

| Decision | Rationale |
|---|---|
| All game logic on server | Prevents cheating; server is authoritative |
| Hands hidden per-player | Server sends only your cards; opponent hand *counts* only |
| Socket.IO rooms | Each game is isolated; events only reach room members |
| Session reconnection | `sessionStorage` stores room + player ID; reconnect on refresh |
| Hook rule enforced server-side | Client shows forbidden bid, server validates too |

---

## 🔌 Socket.IO Events

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `createRoom` | `{ playerName }` | Create a new game room |
| `joinRoom` | `{ roomCode, playerName }` | Join existing room |
| `reconnectRoom` | `{ roomCode, playerId }` | Restore connection after disconnect |
| `startGame` | — | Host starts the game |
| `placeBid` | `{ bid }` | Submit your bid for the round |
| `playCard` | `{ cardId }` | Play a card (e.g. `"A♠"`) |
| `nextRound` | — | Host advances to next round |
| `chat` | `{ message }` | Send a chat message |

### Server → Client

| Event | Payload | Description |
|---|---|---|
| `lobby` | `{ players, hostId }` | Updated player list in waiting room |
| `gameState` | State object (see below) | Full game state update (filtered per player) |
| `chat` | `{ name, message }` | Incoming chat message |
| `playerDisconnected` | `{ playerId }` | A player lost connection |

### Game State Object (client view)

```json
{
  "phase": "bidding | playing | roundEnd | gameEnd",
  "roundIndex": 0,
  "roundSequence": [10,9,8,...,1,...,10],
  "dealerIndex": 0,
  "currentPlayerIndex": 1,
  "trumpCard": { "suit": "♠", "rank": "K", "value": 11 },
  "trumpSuit": "♠",
  "players": [{ "id": "...", "name": "Alice" }],
  "bids": { "playerId": 3 },
  "tricks": { "playerId": 2 },
  "scores": { "playerId": 45 },
  "currentTrick": [{ "playerId": "...", "card": {...} }],
  "hand": [...],        // YOUR cards only
  "handCounts": { "playerId": 5 },  // opponent card counts
  "log": ["Round 1: 10 cards. Trump: K♠", ...]
}
```

---

## 🚢 Deployment

### Railway
Push to GitHub, connect repo to Railway, set start command to `node index.js`.

### Environment Variables
| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Server port |

## 📄 License
MIT
