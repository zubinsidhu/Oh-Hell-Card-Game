// ── Oh Hell – Core Game Logic ──────────────────────────────────────────────

const SUITS = ['♠', '♥', '♣', '♦'];
const SUIT_ORDER = { '♠': 0, '♥': 1, '♣': 2, '♦': 3 };
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

function sortHand(hand) {
  return [...hand].sort((a, b) => {
    const suitDiff = SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
    if (suitDiff !== 0) return suitDiff;
    return a.value - b.value; // 2->A ascending
  });
}

function buildRoundSequence() {
  const rounds = [];
  for (let i = 10; i >= 1; i--) rounds.push(i);
  for (let i = 2; i <= 10; i++) rounds.push(i);
  return rounds;
}

function cardId(card) { return `${card.rank}${card.suit}`; }

function compareCards(a, b, leadSuit, trumpSuit) {
  const aIsTrump = a.suit === trumpSuit;
  const bIsTrump = b.suit === trumpSuit;
  const aIsLead  = a.suit === leadSuit;
  const bIsLead  = b.suit === leadSuit;
  if (aIsTrump && !bIsTrump) return 1;
  if (!aIsTrump && bIsTrump) return -1;
  if (aIsLead && !bIsLead)   return 1;
  if (!aIsLead && bIsLead)   return -1;
  return a.value - b.value;
}

function resolveTrick(trick, trumpSuit) {
  const leadSuit = trick[0].card.suit;
  let winner = trick[0];
  for (let i = 1; i < trick.length; i++) {
    if (compareCards(trick[i].card, winner.card, leadSuit, trumpSuit) > 0)
      winner = trick[i];
  }
  return winner.playerId;
}

// Scoring: Exact bid = +10 + tricks. Over/Under = just tricks won (no bonus).
function calcScore(bid, tricks) {
  if (bid === tricks) return 10 + tricks;
  return tricks; // over or under: no bonus, but still earn tricks taken
}

function legalCards(hand, leadSuit) {
  if (!leadSuit) return hand;
  const suited = hand.filter(c => c.suit === leadSuit);
  return suited.length > 0 ? suited : hand;
}

// ── Bot AI ─────────────────────────────────────────────────────────────────

function botChooseBid(hand, numCards, bidsSoFar, isDealer, trumpSuit) {
  let strength = 0;
  for (const card of hand) {
    if (card.suit === trumpSuit) {
      strength += card.value >= 10 ? 1 : 0.5;
    } else {
      if (card.value === 12) strength += 0.9;
      else if (card.value === 11) strength += 0.6;
      else if (card.value === 10) strength += 0.3;
    }
  }
  let bid = Math.round(strength);
  bid = Math.max(0, Math.min(bid, numCards));
  if (isDealer) {
    const total = Object.values(bidsSoFar).reduce((s, b) => s + (b ?? 0), 0);
    const forbidden = numCards - total;
    if (bid === forbidden) bid = bid > 0 ? bid - 1 : bid + 1;
    bid = Math.max(0, Math.min(bid, numCards));
  }
  return bid;
}

function botChooseCard(hand, currentTrick, trumpSuit, bid, tricksTaken) {
  const leadSuit = currentTrick.length > 0 ? currentTrick[0].card.suit : null;
  const legal = legalCards(hand, leadSuit);
  const tricksNeeded = bid - tricksTaken;
  const refSuit = leadSuit || legal[0]?.suit;

  if (tricksNeeded <= 0) {
    return legal.reduce((low, c) => compareCards(c, low, refSuit, trumpSuit) < 0 ? c : low);
  }
  const currentWinner = currentTrick.length > 0
    ? currentTrick.reduce((w, t) => compareCards(t.card, w.card, leadSuit, trumpSuit) > 0 ? t : w).card
    : null;
  const winning = legal.filter(c => !currentWinner || compareCards(c, currentWinner, refSuit, trumpSuit) > 0);
  if (winning.length > 0) {
    return winning.reduce((low, c) => compareCards(c, low, refSuit, trumpSuit) < 0 ? c : low);
  }
  return legal.reduce((low, c) => compareCards(c, low, refSuit, trumpSuit) < 0 ? c : low);
}

// ── Game State ─────────────────────────────────────────────────────────────

function createGameState(players) {
  return {
    phase: 'waiting',
    roundSequence: buildRoundSequence(),
    roundIndex: 0,
    dealerIndex: 0,
    currentPlayerIndex: 0,
    trumpCard: null,
    trumpSuit: null,
    hands: {},
    bids: {},
    tricks: {},
    scores: {},
    roundScores: [],   // array of {playerId: delta} per completed round
    currentTrick: [],
    trickLeaderIndex: 0,
    lastTrickWinner: null,
    lastTrickCards: null,
    players: players.map(p => ({ id: p.id, name: p.name, emoji: p.emoji || '🎴', isBot: p.isBot || false })),
    readyForNextRound: {},
    log: [],
  };
}

function dealRound(state) {
  const numCards = state.roundSequence[state.roundIndex];
  const deck = shuffle(createDeck());
  const numPlayers = state.players.length;

  state.hands = {};
  state.bids  = {};
  state.tricks = {};
  state.readyForNextRound = {};
  state.lastTrickWinner = null;
  state.lastTrickCards  = null;

  state.players.forEach(p => {
    state.hands[p.id]  = sortHand(deck.splice(0, numCards));
    state.bids[p.id]   = null;
    state.tricks[p.id] = 0;
  });

  const trumpCard = deck.length > 0 ? deck[0] : null;
  state.trumpCard = trumpCard;
  state.trumpSuit = trumpCard ? trumpCard.suit : null;
  state.currentTrick = [];
  state.phase = 'bidding';
  state.currentPlayerIndex = (state.dealerIndex + 1) % numPlayers;
  state.trickLeaderIndex   = state.currentPlayerIndex;
  state.log.push(`Round ${state.roundIndex + 1}: ${numCards} card(s). Trump: ${state.trumpCard ? cardId(state.trumpCard) : 'None'}`);
}

function isLastBidder(state) {
  return state.currentPlayerIndex === state.dealerIndex;
}

function forbiddenBid(state) {
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
  const allBid = state.players.every(p => state.bids[p.id] !== null);
  if (allBid) {
    state.phase = 'playing';
    state.currentPlayerIndex = (state.dealerIndex + 1) % numPlayers;
    state.trickLeaderIndex   = state.currentPlayerIndex;
  } else {
    state.currentPlayerIndex = (state.currentPlayerIndex + 1) % numPlayers;
  }
  return { ok: true };
}

function playCard(state, playerId, cId) {
  const numPlayers = state.players.length;
  const player = state.players[state.currentPlayerIndex];
  if (player.id !== playerId) return { ok: false, error: 'Not your turn' };
  const hand = state.hands[playerId];
  const cardIndex = hand.findIndex(c => `${c.rank}${c.suit}` === cId);
  if (cardIndex === -1) return { ok: false, error: 'Card not in hand' };
  const leadSuit = state.currentTrick.length > 0 ? state.currentTrick[0].card.suit : null;
  const legal = legalCards(hand, leadSuit);
  const card = hand[cardIndex];
  if (!legal.some(c => `${c.rank}${c.suit}` === cId))
    return { ok: false, error: 'Must follow suit' };
  hand.splice(cardIndex, 1);
  state.currentTrick.push({ playerId, card });
  state.log.push(`${player.name} plays ${cId}`);

  if (state.currentTrick.length === numPlayers) {
    const winnerId = resolveTrick(state.currentTrick, state.trumpSuit);
    state.tricks[winnerId]++;
    const winnerName = state.players.find(p => p.id === winnerId).name;
    state.log.push(`${winnerName} wins the trick`);
    state.lastTrickWinner = winnerId;
    state.lastTrickCards  = [...state.currentTrick];
    state.phase = 'trickEnd';
    return { ok: true, trickComplete: true, winnerId };
  } else {
    state.currentPlayerIndex = (state.currentPlayerIndex + 1) % numPlayers;
    return { ok: true };
  }
}

function resolveTrickEnd(state) {
  const winnerId = state.lastTrickWinner;
  state.currentTrick = [];
  state.lastTrickCards = null;
  const handsEmpty = state.players.every(p => state.hands[p.id].length === 0);
  if (handsEmpty) {
    endRound(state);
  } else {
    const winnerIdx = state.players.findIndex(p => p.id === winnerId);
    state.currentPlayerIndex = winnerIdx;
    state.trickLeaderIndex   = winnerIdx;
    state.phase = 'playing';
  }
}

function endRound(state) {
  const roundEntry = {};
  state.players.forEach(p => {
    const delta = calcScore(state.bids[p.id], state.tricks[p.id]);
    state.scores[p.id] = (state.scores[p.id] || 0) + delta;
    roundEntry[p.id] = delta;
  });
  state.roundScores = state.roundScores || [];
  state.roundScores.push(roundEntry);
  state.phase = 'roundEnd';
  state.log.push('Round over! Scores updated.');
  state.roundIndex++;
  if (state.roundIndex >= state.roundSequence.length) {
    state.phase = 'gameEnd';
    state.log.push('Game over!');
  }
}

function markReady(state, playerId) {
  state.readyForNextRound[playerId] = true;
  return state.players.every(p => state.readyForNextRound[p.id]);
}

function nextRound(state) {
  if (state.phase !== 'roundEnd') return;
  state.dealerIndex = (state.dealerIndex + 1) % state.players.length;
  dealRound(state);
}

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
    roundScores: state.roundScores || [],
    currentTrick: state.currentTrick,
    lastTrickWinner: state.lastTrickWinner,
    lastTrickCards: state.lastTrickCards,
    trickLeaderIndex: state.trickLeaderIndex,
    hand: sortHand(state.hands[forPlayerId] || []),
    handCounts: Object.fromEntries(
      state.players.map(p => [p.id, (state.hands[p.id] || []).length])
    ),
    readyForNextRound: state.readyForNextRound || {},
    log: state.log.slice(-20),
  };
}

module.exports = {
  createGameState, dealRound, placeBid, playCard, resolveTrickEnd,
  nextRound, markReady, publicState, cardId, sortHand,
  botChooseBid, botChooseCard, legalCards, calcScore
};
