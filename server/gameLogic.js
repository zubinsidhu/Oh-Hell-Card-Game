// ── Oh Hell – Core Game Logic ──────────────────────────────────────────────

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i]));

function createDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ suit, rank, value: RANK_VALUE[rank] });
  return deck;
}

function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// Rounds: 10 → 1 → 10  (standard Oh Hell)
function buildRoundSequence() {
  const rounds = [];
  for (let i = 10; i >= 1; i--) rounds.push(i);
  for (let i = 2; i <= 10; i++) rounds.push(i);
  return rounds; // 19 rounds total
}

function cardId(card) { return `${card.rank}${card.suit}`; }

function compareCards(a, b, leadSuit, trumpSuit) {
  const aIsLead  = a.suit === leadSuit;
  const bIsLead  = b.suit === leadSuit;
  const aIsTrump = a.suit === trumpSuit;
  const bIsTrump = b.suit === trumpSuit;

  if (aIsTrump && !bIsTrump) return 1;
  if (!aIsTrump && bIsTrump) return -1;
  if (aIsLead && !bIsLead)   return 1;
  if (!aIsLead && bIsLead)   return -1;
  return a.value - b.value;
}

function resolveTrick(trick, trumpSuit) {
  // trick: [{playerId, card}, …]
  const leadSuit = trick[0].card.suit;
  let winner = trick[0];
  for (let i = 1; i < trick.length; i++) {
    if (compareCards(trick[i].card, winner.card, leadSuit, trumpSuit) > 0)
      winner = trick[i];
  }
  return winner.playerId;
}

function calcScore(bid, tricks) {
  if (bid === tricks) return 10 + tricks;
  return -Math.abs(bid - tricks);  // penalty variant (common & fun)
}

// ── Game State Factory ─────────────────────────────────────────────────────

function createGameState(players) {
  return {
    phase: 'waiting',       // waiting | bidding | playing | roundEnd | gameEnd
    roundSequence: buildRoundSequence(),
    roundIndex: 0,
    dealerIndex: 0,
    currentPlayerIndex: 0,
    trumpCard: null,
    trumpSuit: null,
    hands: {},              // playerId → [card]
    bids: {},               // playerId → number
    tricks: {},             // playerId → number
    scores: {},             // playerId → cumulative score
    currentTrick: [],       // [{playerId, card}]
    trickLeaderIndex: 0,
    players: players.map(p => ({ id: p.id, name: p.name })),
    log: [],
  };
}

// ── Deal a Round ───────────────────────────────────────────────────────────

function dealRound(state) {
  const numCards = state.roundSequence[state.roundIndex];
  const deck = shuffle(createDeck());
  const numPlayers = state.players.length;

  state.hands = {};
  state.bids  = {};
  state.tricks = {};

  state.players.forEach((p, i) => {
    state.hands[p.id]  = deck.splice(0, numCards);
    state.bids[p.id]   = null;
    state.tricks[p.id] = 0;
  });

  // Trump card = next card after dealing (unless 1-card round, use top remaining)
  const trumpCard = deck.length > 0 ? deck[0] : null;
  state.trumpCard = trumpCard;
  state.trumpSuit = trumpCard ? trumpCard.suit : null;

  state.currentTrick = [];
  state.phase = 'bidding';

  // Bidding starts left of dealer
  state.currentPlayerIndex = (state.dealerIndex + 1) % numPlayers;
  state.trickLeaderIndex   = state.currentPlayerIndex;
  state.log.push(`Round ${state.roundIndex + 1}: ${numCards} card(s). Trump: ${state.trumpCard ? cardId(state.trumpCard) : 'None'}`);
}

// ── Bidding ────────────────────────────────────────────────────────────────

function isLastBidder(state) {
  return state.currentPlayerIndex === state.dealerIndex;
}

function forbiddenBid(state) {
  // Hook rule: dealer cannot make total bids === tricks this round
  const numCards = state.roundSequence[state.roundIndex];
  const bidSoFar = Object.values(state.bids).reduce((s, b) => s + (b ?? 0), 0);
  return numCards - bidSoFar;
}

function placeBid(state, playerId, bid) {
  const numPlayers = state.players.length;
  const player = state.players[state.currentPlayerIndex];
  if (player.id !== playerId) return { ok: false, error: 'Not your turn to bid' };

  const numCards = state.roundSequence[state.roundIndex];
  if (bid < 0 || bid > numCards) return { ok: false, error: 'Invalid bid' };

  if (isLastBidder(state)) {
    const forbidden = forbiddenBid(state);
    if (bid === forbidden) return { ok: false, error: `Dealer cannot bid ${forbidden} (hook rule)` };
  }

  state.bids[playerId] = bid;
  state.log.push(`${player.name} bids ${bid}`);

  // Check if all bids placed
  const allBid = state.players.every(p => state.bids[p.id] !== null);
  if (allBid) {
    state.phase = 'playing';
    // Lead = left of dealer
    state.currentPlayerIndex = (state.dealerIndex + 1) % numPlayers;
    state.trickLeaderIndex   = state.currentPlayerIndex;
  } else {
    state.currentPlayerIndex = (state.currentPlayerIndex + 1) % numPlayers;
  }
  return { ok: true };
}

// ── Card Play ──────────────────────────────────────────────────────────────

function legalCards(hand, leadSuit) {
  if (!leadSuit) return hand;  // leading – any card
  const suited = hand.filter(c => c.suit === leadSuit);
  return suited.length > 0 ? suited : hand;
}

function playCard(state, playerId, cardId) {
  const numPlayers = state.players.length;
  const player = state.players[state.currentPlayerIndex];
  if (player.id !== playerId) return { ok: false, error: 'Not your turn' };

  const hand = state.hands[playerId];
  const cardIndex = hand.findIndex(c => `${c.rank}${c.suit}` === cardId);
  if (cardIndex === -1) return { ok: false, error: 'Card not in hand' };

  const leadSuit = state.currentTrick.length > 0 ? state.currentTrick[0].card.suit : null;
  const legal = legalCards(hand, leadSuit);
  const card = hand[cardIndex];
  if (!legal.some(c => `${c.rank}${c.suit}` === cardId))
    return { ok: false, error: 'Must follow suit' };

  // Remove from hand
  hand.splice(cardIndex, 1);
  state.currentTrick.push({ playerId, card });
  state.log.push(`${player.name} plays ${cardId}`);

  if (state.currentTrick.length === numPlayers) {
    // Resolve trick
    const winnerId = resolveTrick(state.currentTrick, state.trumpSuit);
    state.tricks[winnerId]++;
    const winnerName = state.players.find(p => p.id === winnerId).name;
    state.log.push(`${winnerName} wins the trick`);
    state.currentTrick = [];

    // Check if round over
    const handsEmpty = state.players.every(p => state.hands[p.id].length === 0);
    if (handsEmpty) {
      endRound(state);
    } else {
      // Winner leads next trick
      const winnerIdx = state.players.findIndex(p => p.id === winnerId);
      state.currentPlayerIndex = winnerIdx;
      state.trickLeaderIndex   = winnerIdx;
    }
  } else {
    state.currentPlayerIndex = (state.currentPlayerIndex + 1) % numPlayers;
  }
  return { ok: true };
}

function endRound(state) {
  // Score
  state.players.forEach(p => {
    const delta = calcScore(state.bids[p.id], state.tricks[p.id]);
    state.scores[p.id] = (state.scores[p.id] || 0) + delta;
  });
  state.phase = 'roundEnd';
  state.log.push('Round over! Scores updated.');

  state.roundIndex++;
  if (state.roundIndex >= state.roundSequence.length) {
    state.phase = 'gameEnd';
    state.log.push('Game over!');
  }
}

function nextRound(state) {
  if (state.phase !== 'roundEnd') return;
  const numPlayers = state.players.length;
  state.dealerIndex = (state.dealerIndex + 1) % numPlayers;
  dealRound(state);
}

// ── Public view (hides opponent hands) ───────────────────────────────────

function publicState(state, forPlayerId) {
  return {
    phase: state.phase,
    roundIndex: state.roundIndex,
    roundSequence: state.roundSequence,
    dealerIndex: state.dealerIndex,
    currentPlayerIndex: state.currentPlayerIndex,
    trumpCard: state.trumpCard,
    trumpSuit: state.trumpSuit,
    players: state.players,
    bids: state.bids,
    tricks: state.tricks,
    scores: state.scores,
    currentTrick: state.currentTrick,
    trickLeaderIndex: state.trickLeaderIndex,
    hand: state.hands[forPlayerId] || [],
    handCounts: Object.fromEntries(
      state.players.map(p => [p.id, (state.hands[p.id] || []).length])
    ),
    log: state.log.slice(-20),
  };
}

module.exports = { createGameState, dealRound, placeBid, playCard, nextRound, publicState, cardId };
