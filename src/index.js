const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const game = require("./game");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// rooms: code -> room object
const rooms = {};
// playerRoom: socketId -> room code
const playerRoom = {};

function broadcast(room) {
  room.players.forEach(p => {
    if (p.isBot) return; // bots have no socket
    const socket = io.sockets.sockets.get(p.id);
    if (!socket) return;
    socket.emit("game_state", game.publicStateFor(room, p.id));
    const priv = game.privateInfoFor(room, p.id);
    if (priv) socket.emit("private_info", priv);
  });
}

// ── Bot AI ────────────────────────────────────────────────────────────────

function botDelay() {
  return 1000 + Math.random() * 1500;
}

function decideBotVote(room, botId) {
  const role = room.roles[botId];
  const nominatedRole = room.roles[room.nominatedHighPriest];

  if (role === "warden") {
    // Wardens vote Faith mostly, growing doubt as bad omens accumulate
    const skepticism = room.badOmensEnacted * 0.08;
    return Math.random() > (0.3 + skepticism) ? "faith" : "doubt";
  } else {
    // Zealots/Prophet vote Faith for allies, Doubt for Wardens
    const isAlly = nominatedRole === "zealot" || nominatedRole === "prophet";
    return Math.random() < (isAlly ? 0.85 : 0.35) ? "faith" : "doubt";
  }
}

function pickBotNominee(room, botId) {
  const role = room.roles[botId];
  const aliveCount = room.players.filter(p => p.isAlive).length;

  const eligible = room.players.filter(p => {
    if (!p.isAlive || p.id === botId) return false;
    if (p.id === room.previousHighPriestId) return false;
    if (aliveCount > 5 && p.id === room.previousAscendantId) return false;
    return true;
  });

  if (eligible.length === 0) return null;

  if (role === "zealot" || role === "prophet") {
    // Prefer Zealot allies
    const allies = eligible.filter(p => room.roles[p.id] === "zealot" || room.roles[p.id] === "prophet");
    if (allies.length > 0) return allies[Math.floor(Math.random() * allies.length)].id;
  }

  return eligible[Math.floor(Math.random() * eligible.length)].id;
}

function pickBotAscendantDiscard(room, botId) {
  const role = room.roles[botId];
  const omens = room.drawnOmens;

  if (role === "warden") {
    const badIdx = omens.findIndex(o => o.type === "bad");
    return badIdx !== -1 ? badIdx : Math.floor(Math.random() * omens.length);
  } else {
    const goodIdx = omens.findIndex(o => o.type === "good");
    return goodIdx !== -1 ? goodIdx : Math.floor(Math.random() * omens.length);
  }
}

function pickBotHighPriestEnact(room, botId) {
  const role = room.roles[botId];
  const options = room.highPriestOptions;

  if (role === "warden") {
    const goodIdx = options.findIndex(o => o.type === "good");
    return goodIdx !== -1 ? goodIdx : 0;
  } else {
    const badIdx = options.findIndex(o => o.type === "bad");
    return badIdx !== -1 ? badIdx : 0;
  }
}

function processBots(room) {
  if (room.phase === "game_over") return;

  if (room.phase === "election") {
    const unvoted = room.players.filter(p => p.isBot && p.isAlive && room.votes[p.id] === undefined);
    if (unvoted.length === 0) return;

    unvoted.forEach((bot, i) => {
      setTimeout(() => {
        if (room.phase !== "election" || room.votes[bot.id] !== undefined) return;
        const vote = decideBotVote(room, bot.id);
        const result = game.castVote(room, bot.id, vote);
        if (!result.error) {
          broadcast(room);
          if (room.phase !== "election") processBots(room);
        }
      }, botDelay() + i * 700);
    });
    return;
  }

  setTimeout(() => {
    if (room.phase === "game_over") return;
    let result = null;

    if (room.phase === "nomination") {
      const asc = room.players[room.ascendantIndex];
      if (!asc || !asc.isBot) return;
      const targetId = pickBotNominee(room, asc.id);
      if (!targetId) return;
      result = game.nominate(room, asc.id, targetId);

    } else if (room.phase === "legislative_ascendant") {
      const asc = room.players[room.ascendantIndex];
      if (!asc || !asc.isBot) return;
      const cardIdx = pickBotAscendantDiscard(room, asc.id);
      result = game.ascendantDiscard(room, asc.id, cardIdx);

    } else if (room.phase === "legislative_high_priest") {
      const hp = room.players.find(p => p.id === room.previousHighPriestId);
      if (!hp || !hp.isBot) return;
      const cardIdx = pickBotHighPriestEnact(room, hp.id);
      result = game.highPriestEnact(room, hp.id, cardIdx);

    } else if (room.phase === "executive") {
      const asc = room.players[room.ascendantIndex];
      if (!asc || !asc.isBot) return;
      const role = room.roles[asc.id];

      if (room.executivePower === "peek") {
        result = game.peekOmens(room, asc.id);
        // Bot discards the peek info; game advances normally

      } else if (room.executivePower === "investigate") {
        const targets = room.players.filter(p => p.isAlive && p.id !== asc.id);
        if (!targets.length) return;
        const target = targets[Math.floor(Math.random() * targets.length)];
        result = game.investigateLoyalty(room, asc.id, target.id);

      } else if (room.executivePower === "execute") {
        let targets = room.players.filter(p => p.isAlive && p.id !== asc.id);
        if (role === "zealot" || role === "prophet") {
          // Zealot bots know everyone's role — target Wardens only
          const wardens = targets.filter(p => room.roles[p.id] === "warden");
          if (wardens.length) targets = wardens;
        }
        const target = targets[Math.floor(Math.random() * targets.length)];
        result = game.executePlayer(room, asc.id, target.id);

      } else if (room.executivePower === "special_election") {
        let targets = room.players.filter(p => p.isAlive && p.id !== asc.id);
        if (role === "zealot" || role === "prophet") {
          const allies = targets.filter(p => room.roles[p.id] === "zealot" || room.roles[p.id] === "prophet");
          if (allies.length) targets = allies;
        }
        const target = targets[Math.floor(Math.random() * targets.length)];
        result = game.specialElection(room, asc.id, target.id);
      }
    }

    if (result && !result.error) {
      broadcast(room);
      processBots(room);
    }
  }, botDelay());
}

// ── Socket handlers ───────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("create_room", ({ name }) => {
    if (!name) return socket.emit("error", "Name required");
    const room = game.createRoom(socket.id, name);
    rooms[room.code] = room;
    playerRoom[socket.id] = room.code;
    socket.join(room.code);
    socket.emit("room_created", { code: room.code });
    broadcast(room);
  });

  socket.on("join_room", ({ code, name }) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) return socket.emit("error", "Room not found");
    if (room.phase !== "lobby") return socket.emit("error", "Game already in progress");
    if (room.players.length >= 10) return socket.emit("error", "Room is full");
    if (room.players.find(p => p.id === socket.id)) return socket.emit("error", "Already in room");
    if (!name) return socket.emit("error", "Name required");

    room.players.push({ id: socket.id, name, isAlive: true, isAscendant: false, isHighPriest: false, isBot: false });
    playerRoom[socket.id] = room.code;
    socket.join(room.code);
    socket.emit("room_joined", { code: room.code });
    broadcast(room);
  });

  socket.on("add_bot", () => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    if (room.host !== socket.id) return socket.emit("error", "Only the host can add bots");
    const result = game.addBot(room);
    if (result.error) return socket.emit("error", result.error);
    broadcast(room);
  });

  socket.on("remove_bot", ({ botId }) => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    if (room.host !== socket.id) return socket.emit("error", "Only the host can remove bots");
    const result = game.removeBot(room, botId);
    if (result.error) return socket.emit("error", result.error);
    broadcast(room);
  });

  socket.on("start_game", () => {
    const code = playerRoom[socket.id];
    const room = rooms[code];
    if (!room) return socket.emit("error", "Not in a room");
    if (room.host !== socket.id) return socket.emit("error", "Only the host can start");
    const result = game.startGame(room);
    if (result.error) return socket.emit("error", result.error);
    broadcast(room);
    processBots(room);
  });

  socket.on("nominate", ({ targetId }) => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    const result = game.nominate(room, socket.id, targetId);
    if (result.error) return socket.emit("error", result.error);
    broadcast(room);
    processBots(room);
  });

  socket.on("vote", ({ vote }) => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    const result = game.castVote(room, socket.id, vote);
    if (result.error) return socket.emit("error", result.error);
    broadcast(room);
    // Trigger remaining bot votes if any (or next phase if election resolved)
    processBots(room);
  });

  socket.on("ascendant_discard", ({ cardIndex }) => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    const result = game.ascendantDiscard(room, socket.id, cardIndex);
    if (result.error) return socket.emit("error", result.error);
    broadcast(room);
    processBots(room);
  });

  socket.on("high_priest_enact", ({ cardIndex }) => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    const result = game.highPriestEnact(room, socket.id, cardIndex);
    if (result.error) return socket.emit("error", result.error);
    broadcast(room);
    processBots(room);
  });

  socket.on("execute_player", ({ targetId }) => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    const result = game.executePlayer(room, socket.id, targetId);
    if (result.error) return socket.emit("error", result.error);
    broadcast(room);
    processBots(room);
  });

  socket.on("investigate", ({ targetId }) => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    const result = game.investigateLoyalty(room, socket.id, targetId);
    if (result.error) return socket.emit("error", result.error);
    socket.emit("investigation_result", { faction: result.faction, targetName: result.targetName });
    broadcast(room);
    processBots(room);
  });

  socket.on("peek_omens", () => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    const result = game.peekOmens(room, socket.id);
    if (result.error) return socket.emit("error", result.error);
    socket.emit("peek_result", { cards: result.cards });
    broadcast(room);
    processBots(room);
  });

  socket.on("special_election", ({ targetId }) => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    const result = game.specialElection(room, socket.id, targetId);
    if (result.error) return socket.emit("error", result.error);
    broadcast(room);
    processBots(room);
  });

  socket.on("disconnect", () => {
    const code = playerRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room) return;

    if (room.phase === "lobby") {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.filter(p => !p.isBot).length === 0) {
        delete rooms[code];
      } else {
        if (room.host === socket.id) {
          room.host = room.players.find(p => !p.isBot)?.id ?? room.players[0].id;
        }
        broadcast(room);
      }
    } else {
      const player = room.players.find(p => p.id === socket.id);
      if (player) player.isAlive = false;
      broadcast(room);
      processBots(room);
    }

    delete playerRoom[socket.id];
    console.log("Disconnected:", socket.id);
  });
});

app.get("/health", (_, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Arctavus server running on port ${PORT}`));
