// Ascendancy — game logic (Secret Hitler reskin)

const BOT_NAMES = [
  "Archivist Vex", "Sentinel Kor", "Watcher Daal", "Herald Sorn",
  "Keeper Yl", "Seeker Ash", "Lector Onyr", "Augur Feth",
  "Envoy Caul", "Cipher Ruen",
];

const ROLE_COUNTS = {
  5:  { wardens: 3, zealots: 1 },
  6:  { wardens: 4, zealots: 1 },
  7:  { wardens: 4, zealots: 2 },
  8:  { wardens: 5, zealots: 2 },
  9:  { wardens: 5, zealots: 3 },
  10: { wardens: 6, zealots: 3 },
};

// Executive powers triggered by bad omens enacted, per player count bracket
const EXECUTIVE_POWERS = {
  "5-6":  { 3: "peek",        4: "execute",          5: "execute" },
  "7-8":  { 2: "investigate", 3: "special_election", 4: "execute", 5: "execute" },
  "9-10": { 1: "investigate", 2: "investigate",      3: "special_election", 4: "execute", 5: "execute" },
};

function playerCountBracket(n) {
  if (n <= 6) return "5-6";
  if (n <= 8) return "7-8";
  return "9-10";
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDeck() {
  const deck = [];
  for (let i = 1; i <= 6;  i++) deck.push({ type: "good", id: i });
  for (let i = 1; i <= 11; i++) deck.push({ type: "bad",  id: i });
  return shuffle(deck);
}

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom(hostId, hostName) {
  return {
    code: generateCode(),
    phase: "lobby",
    host: hostId,
    players: [{ id: hostId, name: hostName, isAlive: true, isAscendant: false, isHighPriest: false, isBot: false }],
    ascendantIndex: 0,
    nominatedHighPriest: null,
    previousAscendantId: null,
    previousHighPriestId: null,
    votes: {},
    lastVotes: {},
    goodOmensEnacted: 0,
    badOmensEnacted: 0,
    drawPile: [],
    discardPile: [],
    drawnOmens: [],
    highPriestOptions: [],
    electionTracker: 0,
    executivePower: null,
    winner: null,
    winReason: null,
    // private — roles assigned per player
    roles: {},
  };
}

function addBot(room) {
  if (room.phase !== "lobby") return { error: "Game already started" };
  if (room.players.length >= 10) return { error: "Room is full" };

  const usedNames = new Set(room.players.map(p => p.name));
  const name = BOT_NAMES.find(n => !usedNames.has(n));
  if (!name) return { error: "No bot names available" };

  const id = `bot_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
  room.players.push({ id, name, isAlive: true, isAscendant: false, isHighPriest: false, isBot: true });
  return { ok: true };
}

function removeBot(room, botId) {
  if (room.phase !== "lobby") return { error: "Game already started" };
  const bot = room.players.find(p => p.id === botId && p.isBot);
  if (!bot) return { error: "Bot not found" };
  room.players = room.players.filter(p => p.id !== botId);
  return { ok: true };
}

function assignRoles(room) {
  const n = room.players.length;
  const counts = ROLE_COUNTS[n];
  if (!counts) return false;

  const roleList = [
    ...Array(counts.wardens).fill("warden"),
    ...Array(counts.zealots).fill("zealot"),
    "prophet",
  ];
  const shuffled = shuffle(roleList);
  room.roles = {};
  room.players.forEach((p, i) => { room.roles[p.id] = shuffled[i]; });
  return true;
}

function startGame(room) {
  if (room.players.length < 5) return { error: "Need at least 5 players" };
  if (!assignRoles(room)) return { error: "Unsupported player count" };

  room.drawPile = buildDeck();
  room.discardPile = [];
  room.goodOmensEnacted = 0;
  room.badOmensEnacted = 0;
  room.electionTracker = 0;
  room.ascendantIndex = Math.floor(Math.random() * room.players.length);
  room.players[room.ascendantIndex].isAscendant = true;
  room.phase = "nomination";
  room.nominatedHighPriest = null;
  room.votes = {};
  room.drawnOmens = [];
  room.highPriestOptions = [];

  return { ok: true };
}

function nominate(room, ascendantId, targetId) {
  if (room.phase !== "nomination") return { error: "Not nomination phase" };
  const ascendant = room.players[room.ascendantIndex];
  if (ascendant.id !== ascendantId) return { error: "Not your turn to nominate" };
  const target = room.players.find(p => p.id === targetId);
  if (!target || !target.isAlive) return { error: "Invalid target" };
  if (targetId === ascendantId) return { error: "Cannot nominate yourself" };
  if (targetId === room.previousHighPriestId) return { error: "Cannot re-nominate previous High Priest" };
  if (room.players.filter(p => p.isAlive).length > 5 && targetId === room.previousAscendantId) {
    return { error: "Cannot nominate previous Ascendant (5+ alive players)" };
  }

  room.nominatedHighPriest = targetId;
  room.phase = "election";
  room.votes = {};
  return { ok: true };
}

function castVote(room, playerId, vote) {
  if (room.phase !== "election") return { error: "Not election phase" };
  const player = room.players.find(p => p.id === playerId);
  if (!player || !player.isAlive) return { error: "Not a living player" };
  if (room.votes[playerId] !== undefined) return { error: "Already voted" };
  if (vote !== "faith" && vote !== "doubt") return { error: "Invalid vote" };

  room.votes[playerId] = vote;

  const alivePlayers = room.players.filter(p => p.isAlive);
  if (Object.keys(room.votes).length < alivePlayers.length) return { ok: true, waiting: true };

  // Tally
  const faithCount = Object.values(room.votes).filter(v => v === "faith").length;
  const doubtCount = Object.values(room.votes).filter(v => v === "doubt").length;
  const passed = faithCount > doubtCount;

  // Persist votes for post-election display before any branch clears them
  room.lastVotes = { ...room.votes };

  if (passed) {
    // Check Prophet win condition (3+ bad omens, Prophet becomes High Priest)
    const nominatedRole = room.roles[room.nominatedHighPriest];
    if (room.badOmensEnacted >= 3 && nominatedRole === "prophet") {
      room.winner = "zealots";
      room.winReason = "The Prophet ascended to High Priest.";
      room.phase = "game_over";
      return { ok: true, electionPassed: true, gameOver: true };
    }

    room.previousAscendantId = room.players[room.ascendantIndex].id;
    room.previousHighPriestId = room.nominatedHighPriest;
    room.players.forEach(p => { p.isHighPriest = p.id === room.nominatedHighPriest; });
    room.electionTracker = 0;
    room.phase = "legislative_ascendant";
    drawOmens(room);
  } else {
    room.electionTracker++;
    if (room.electionTracker >= 3) {
      // Force enact top omen
      forceEnact(room);
    } else {
      advanceAscendant(room);
      room.phase = "nomination";
      room.nominatedHighPriest = null;
      room.votes = {};
    }
  }

  return { ok: true, electionPassed: passed, faithCount, doubtCount };
}

function drawOmens(room) {
  if (room.drawPile.length < 3) {
    room.drawPile = shuffle([...room.drawPile, ...room.discardPile]);
    room.discardPile = [];
  }
  room.drawnOmens = room.drawPile.splice(0, 3);
}

function forceEnact(room) {
  if (room.drawPile.length < 1) {
    room.drawPile = shuffle([...room.discardPile]);
    room.discardPile = [];
  }
  const card = room.drawPile.shift();
  enactOmen(room, card);
  room.electionTracker = 0;
  advanceAscendant(room);
  room.phase = "nomination";
  room.nominatedHighPriest = null;
  room.votes = {};
}

function ascendantDiscard(room, playerId, cardIndex) {
  if (room.phase !== "legislative_ascendant") return { error: "Not Ascendant legislative phase" };
  const ascendant = room.players[room.ascendantIndex];
  if (ascendant.id !== playerId) return { error: "Not the Ascendant" };
  if (cardIndex < 0 || cardIndex >= room.drawnOmens.length) return { error: "Invalid card" };

  const discarded = room.drawnOmens.splice(cardIndex, 1)[0];
  room.discardPile.push(discarded);
  room.highPriestOptions = [...room.drawnOmens];
  room.drawnOmens = [];
  room.phase = "legislative_high_priest";
  return { ok: true };
}

function highPriestEnact(room, playerId, cardIndex) {
  if (room.phase !== "legislative_high_priest") return { error: "Not High Priest legislative phase" };
  const highPriest = room.players.find(p => p.id === room.previousHighPriestId);
  if (!highPriest || highPriest.id !== playerId) return { error: "Not the High Priest" };
  if (cardIndex < 0 || cardIndex >= room.highPriestOptions.length) return { error: "Invalid card" };

  const discardIndex = cardIndex === 0 ? 1 : 0;
  room.discardPile.push(room.highPriestOptions[discardIndex]);
  const enacted = room.highPriestOptions[cardIndex];
  room.highPriestOptions = [];

  enactOmen(room, enacted);

  if (room.phase !== "game_over") {
    const power = checkExecutivePower(room);
    if (power && enacted.type === "bad") {
      room.executivePower = power;
      room.phase = "executive";
    } else {
      advanceAscendant(room);
      room.phase = "nomination";
      room.nominatedHighPriest = null;
      room.votes = {};
    }
  }

  return { ok: true, enacted };
}

function enactOmen(room, card) {
  if (card.type === "good") {
    room.goodOmensEnacted++;
    if (room.goodOmensEnacted >= 5) {
      room.winner = "wardens";
      room.winReason = "Five Good Omens have been fulfilled.";
      room.phase = "game_over";
    }
  } else {
    room.badOmensEnacted++;
    if (room.badOmensEnacted >= 6) {
      room.winner = "zealots";
      room.winReason = "Six Bad Omens have been unleashed.";
      room.phase = "game_over";
    }
  }
}

function checkExecutivePower(room) {
  const bracket = playerCountBracket(room.players.filter(p => p.isAlive).length);
  const powers = EXECUTIVE_POWERS[bracket];
  return powers[room.badOmensEnacted] || null;
}

function executePlayer(room, ascendantId, targetId) {
  if (room.phase !== "executive" || room.executivePower !== "execute") return { error: "Wrong phase" };
  if (room.players[room.ascendantIndex].id !== ascendantId) return { error: "Not the Ascendant" };

  const target = room.players.find(p => p.id === targetId);
  if (!target || !target.isAlive) return { error: "Invalid target" };

  target.isAlive = false;
  room.executivePower = null;

  if (room.roles[targetId] === "prophet") {
    room.winner = "wardens";
    room.winReason = "The Prophet has been executed.";
    room.phase = "game_over";
    return { ok: true, gameOver: true };
  }

  const aliveCount = room.players.filter(p => p.isAlive).length;
  if (aliveCount < 3) {
    room.winner = "wardens";
    room.winReason = "Too few players remain.";
    room.phase = "game_over";
    return { ok: true, gameOver: true };
  }

  advanceAscendant(room);
  room.phase = "nomination";
  room.nominatedHighPriest = null;
  room.votes = {};
  return { ok: true };
}

function investigateLoyalty(room, ascendantId, targetId) {
  if (room.phase !== "executive" || room.executivePower !== "investigate") return { error: "Wrong phase" };
  if (room.players[room.ascendantIndex].id !== ascendantId) return { error: "Not the Ascendant" };
  const target = room.players.find(p => p.id === targetId && p.isAlive);
  if (!target) return { error: "Invalid target" };

  const role = room.roles[targetId];
  const faction = role === "warden" ? "warden" : "zealot";
  room.executivePower = null;
  advanceAscendant(room);
  room.phase = "nomination";
  room.nominatedHighPriest = null;
  room.votes = {};
  return { ok: true, faction, targetName: target.name };
}

function peekOmens(room, ascendantId) {
  if (room.phase !== "executive" || room.executivePower !== "peek") return { error: "Wrong phase" };
  if (room.players[room.ascendantIndex].id !== ascendantId) return { error: "Not the Ascendant" };

  if (room.drawPile.length < 3) {
    room.drawPile = shuffle([...room.drawPile, ...room.discardPile]);
    room.discardPile = [];
  }
  const top3 = room.drawPile.slice(0, 3);
  room.executivePower = null;
  advanceAscendant(room);
  room.phase = "nomination";
  room.nominatedHighPriest = null;
  room.votes = {};
  return { ok: true, cards: top3 };
}

function specialElection(room, ascendantId, targetId) {
  if (room.phase !== "executive" || room.executivePower !== "special_election") return { error: "Wrong phase" };
  if (room.players[room.ascendantIndex].id !== ascendantId) return { error: "Not the Ascendant" };
  const targetIndex = room.players.findIndex(p => p.id === targetId && p.isAlive);
  if (targetIndex === -1) return { error: "Invalid target" };

  room.players.forEach(p => { p.isAscendant = false; });
  room.ascendantIndex = targetIndex;
  room.players[targetIndex].isAscendant = true;
  room.executivePower = null;
  room.phase = "nomination";
  room.nominatedHighPriest = null;
  room.votes = {};
  return { ok: true };
}

function advanceAscendant(room) {
  room.players.forEach(p => { p.isAscendant = false; p.isHighPriest = false; });
  let next = (room.ascendantIndex + 1) % room.players.length;
  while (!room.players[next].isAlive) {
    next = (next + 1) % room.players.length;
  }
  room.ascendantIndex = next;
  room.players[next].isAscendant = true;
}

// Build the public state a specific player is allowed to see
function publicStateFor(room, playerId) {
  const myRole = room.roles[playerId];
  const isZealot = myRole === "zealot" || myRole === "prophet";

  return {
    code: room.code,
    phase: room.phase,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isAlive: p.isAlive,
      isAscendant: p.isAscendant,
      isHighPriest: p.isHighPriest,
      isBot: p.isBot ?? false,
    })),
    ascendantIndex: room.ascendantIndex,
    nominatedHighPriest: room.nominatedHighPriest,
    goodOmensEnacted: room.goodOmensEnacted,
    badOmensEnacted: room.badOmensEnacted,
    electionTracker: room.electionTracker,
    executivePower: room.executivePower,
    winner: room.winner,
    winReason: room.winReason,
    host: room.host,
    drawPileCount: room.drawPile.length,
    discardPileCount: room.discardPile.length,
    votesCast: Object.keys(room.votes).length,
    totalAlive: room.players.filter(p => p.isAlive).length,
    // votes revealed after all cast; hidden during active election to prevent bias
    votes: room.phase !== "election" ? room.votes : undefined,
    // last election's votes persist for display until the next election resolves
    lastVotes: room.phase !== "election" ? room.lastVotes : undefined,
    // all roles revealed at game over
    revealedRoles: room.phase === "game_over" ? room.roles : undefined,
  };
}

function privateInfoFor(room, playerId) {
  const myRole = room.roles[playerId];
  if (!myRole) return null;

  const isZealot = myRole === "zealot" || myRole === "prophet";
  let zealotAllies = [];

  if (isZealot) {
    zealotAllies = room.players
      .filter(p => p.id !== playerId && (room.roles[p.id] === "zealot" || room.roles[p.id] === "prophet"))
      .map(p => ({ id: p.id, name: p.name, role: room.roles[p.id] }));
  }

  return {
    role: myRole,
    zealotAllies,
    // Ascendant gets to see drawn omens
    drawnOmens: room.players[room.ascendantIndex]?.id === playerId ? room.drawnOmens : [],
    // High Priest gets their 2 options
    highPriestOptions: room.previousHighPriestId === playerId ? room.highPriestOptions : [],
  };
}

module.exports = {
  createRoom,
  addBot,
  removeBot,
  startGame,
  nominate,
  castVote,
  ascendantDiscard,
  highPriestEnact,
  executePlayer,
  investigateLoyalty,
  peekOmens,
  specialElection,
  publicStateFor,
  privateInfoFor,
};
