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
    const socket = io.sockets.sockets.get(p.id);
    if (!socket) return;
    socket.emit("game_state", game.publicStateFor(room, p.id));
    const priv = game.privateInfoFor(room, p.id);
    if (priv) socket.emit("private_info", priv);
  });
}

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

    room.players.push({ id: socket.id, name, isAlive: true, isAscendant: false, isHighPriest: false });
    playerRoom[socket.id] = room.code;
    socket.join(room.code);
    socket.emit("room_joined", { code: room.code });
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
  });

  socket.on("nominate", ({ targetId }) => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    const result = game.nominate(room, socket.id, targetId);
    if (result.error) return socket.emit("error", result.error);
    broadcast(room);
  });

  socket.on("vote", ({ vote }) => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    const result = game.castVote(room, socket.id, vote);
    if (result.error) return socket.emit("error", result.error);
    broadcast(room);
  });

  socket.on("ascendant_discard", ({ cardIndex }) => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    const result = game.ascendantDiscard(room, socket.id, cardIndex);
    if (result.error) return socket.emit("error", result.error);
    broadcast(room);
  });

  socket.on("high_priest_enact", ({ cardIndex }) => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    const result = game.highPriestEnact(room, socket.id, cardIndex);
    if (result.error) return socket.emit("error", result.error);
    broadcast(room);
  });

  socket.on("execute_player", ({ targetId }) => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    const result = game.executePlayer(room, socket.id, targetId);
    if (result.error) return socket.emit("error", result.error);
    broadcast(room);
  });

  socket.on("investigate", ({ targetId }) => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    const result = game.investigateLoyalty(room, socket.id, targetId);
    if (result.error) return socket.emit("error", result.error);
    socket.emit("investigation_result", { faction: result.faction, targetName: result.targetName });
    broadcast(room);
  });

  socket.on("peek_omens", () => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    const result = game.peekOmens(room, socket.id);
    if (result.error) return socket.emit("error", result.error);
    socket.emit("peek_result", { cards: result.cards });
    broadcast(room);
  });

  socket.on("special_election", ({ targetId }) => {
    const room = rooms[playerRoom[socket.id]];
    if (!room) return socket.emit("error", "Not in a room");
    const result = game.specialElection(room, socket.id, targetId);
    if (result.error) return socket.emit("error", result.error);
    broadcast(room);
  });

  socket.on("disconnect", () => {
    const code = playerRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room) return;

    if (room.phase === "lobby") {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        delete rooms[code];
      } else {
        if (room.host === socket.id) room.host = room.players[0].id;
        broadcast(room);
      }
    } else {
      // In-game disconnect: mark as dead
      const player = room.players.find(p => p.id === socket.id);
      if (player) player.isAlive = false;
      broadcast(room);
    }

    delete playerRoom[socket.id];
    console.log("Disconnected:", socket.id);
  });
});

app.get("/health", (_, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Arctavus server running on port ${PORT}`));
