const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3001;

const rooms = {};

function generateDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push(`${rank}${suit}`);
    }
  }
  return deck;
}

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

function emitRoomState(roomId) {
    if (!rooms[roomId]) return;
    const room = rooms[roomId];
    const playersWithNames = room.players.map(id => ({
        id,
        name: room.names[id] || 'Player',
    }));
    // --- DEBUG LOG ---
    console.log(`[emitRoomState in ${roomId}]: Emitting players:`, JSON.stringify(playersWithNames));
    io.to(roomId).emit('room state', playersWithNames);
}

function startGame(roomId) {
    const room = rooms[roomId];
    if (!room || room.players.length < 2) return;

    // --- DEBUG LOG ---
    console.log(`[startGame]: Starting/Restarting game in room ${roomId}.`);
    const deck = shuffle(generateDeck());
    const handSize = Math.floor(deck.length / 2);

    room.hands = {};
    room.hands[room.players[0]] = deck.slice(0, handSize);
    room.hands[room.players[1]] = deck.slice(handSize, handSize * 2);

    room.tableCards = [];
    room.lastPlayed = null;
    room.turnIndex = Math.floor(Math.random() * room.players.length);
    room.skippedPlayers = [];
    
    const gameStartPayload = {
        hands: room.hands,
        turn: room.players[room.turnIndex],
        players: room.players.map(id => ({ id, name: room.names[id] || 'Player' }))
    };
     // --- DEBUG LOG ---
    console.log(`[startGame]: Emitting 'game started' with payload:`, JSON.stringify(gameStartPayload));
    io.to(roomId).emit('game started', gameStartPayload);
}

io.on('connection', (socket) => {
  // --- DEBUG LOG ---
  console.log(`[connection]: A user connected with ID: ${socket.id}`);

  socket.on('join room', ({ roomId, playerName }) => {
    // --- DEBUG LOG ---
    console.log(`[join room]: Received join request from ${socket.id} (${playerName}) for room ${roomId}`);

    socket.join(roomId);
    if (!rooms[roomId]) {
      // --- DEBUG LOG ---
      console.log(`[join room]: Room ${roomId} not found. Creating it.`);
      rooms[roomId] = { players: [], names: {}, hands: {}, tableCards: [], lastPlayed: null, turnIndex: 0, skippedPlayers: [] };
    }
    const room = rooms[roomId];

    if (!room.players.includes(socket.id)) {
      // --- DEBUG LOG ---
      console.log(`[join room]: Adding ${socket.id} to room ${roomId}.`);
      room.players.push(socket.id);
    }
    room.names[socket.id] = playerName || `Player #${room.players.length}`;
    
    // --- DEBUG LOG ---
    console.log(`[join room]: Current players in ${roomId}:`, JSON.stringify(room.players));

    if (room.players.length === 2 && Object.keys(room.hands).length === 0) {
      startGame(roomId);
    } else {
      emitRoomState(roomId);
    }
  });

  socket.on('set name', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (room && room.names[socket.id]) {
      // --- DEBUG LOG ---
      console.log(`[set name]: Setting name for ${socket.id} to ${name}`);
      room.names[socket.id] = name;
      emitRoomState(roomId);
    }
  });

  socket.on('play cards', ({ roomId, playedCards, declaredRank }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.players[room.turnIndex]) return;

    const playerHand = room.hands[socket.id];
    if (!playedCards.every(c => playerHand.includes(c))) {
        return socket.emit('error message', "You don't have those cards!");
    }

    if (room.lastPlayed && room.lastPlayed.declaredRank && declaredRank !== room.lastPlayed.declaredRank) {
        return socket.emit('error message', `You must play the declared rank of ${room.lastPlayed.declaredRank}.`);
    }

    room.hands[socket.id] = playerHand.filter(c => !playedCards.includes(c));
    room.tableCards.push(...playedCards);
    room.lastPlayed = { playerId: socket.id, cards: playedCards, declaredRank };
    room.skippedPlayers = [];

    io.to(roomId).emit('cards played', { whoPlayed: socket.id, playedCards, declaredRank });
    io.to(roomId).emit('update hands', room.hands);

    if (room.hands[socket.id].length === 0) {
      io.to(roomId).emit('game over', { winnerName: room.names[socket.id] });
    } else {
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
      io.to(roomId).emit('turn', room.players[room.turnIndex]);
    }
  });
  
  socket.on('skip turn', ({ roomId }) => {
      const room = rooms[roomId];
      if (!room || socket.id !== room.players[room.turnIndex]) return;
      if (!room.skippedPlayers.includes(socket.id)) {
          room.skippedPlayers.push(socket.id);
      }

      if (room.skippedPlayers.length >= room.players.length) {
          room.tableCards = [];
          room.lastPlayed = null;
          room.skippedPlayers = [];
          io.to(roomId).emit('message', 'All players skipped. The pile is cleared.');
          io.to(roomId).emit('table cleared');
      }
      
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
      io.to(roomId).emit('turn', room.players[room.turnIndex]);
  });

  socket.on('call bluff', ({ roomId }) => {
      const room = rooms[roomId];
      if (!room || !room.lastPlayed || socket.id === room.lastPlayed.playerId) return;

      io.to(roomId).emit('reveal cards', room.lastPlayed.cards);

      const { declaredRank, cards, playerId: bluffedPlayerId } = room.lastPlayed;
      const isBluff = cards.some(c => !c.startsWith(declaredRank));
      const callerId = socket.id;

      const loserId = isBluff ? bluffedPlayerId : callerId;
      room.hands[loserId].push(...room.tableCards);
      io.to(roomId).emit('message', `${room.names[callerId]} called bluff. It was ${isBluff ? 'a bluff!' : 'not a bluff!'} ${room.names[loserId]} takes the pile.`);
      
      room.tableCards = [];
      room.lastPlayed = null;
      room.skippedPlayers = [];
      io.to(roomId).emit('table cleared');
      io.to(roomId).emit('update hands', room.hands);
  });
  
  socket.on('request new game', ({ roomId }) => {
      if (rooms[roomId]) {
          startGame(roomId);
      }
  });

  socket.on('disconnect', () => {
    // --- DEBUG LOG ---
    console.log(`[disconnect]: User ${socket.id} disconnected.`);
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (room.players.includes(socket.id)) {
        const oldPlayerName = room.names[socket.id];
        // --- DEBUG LOG ---
        console.log(`[disconnect]: Removing ${socket.id} (${oldPlayerName}) from room ${roomId}.`);
        room.players = room.players.filter(id => id !== socket.id);
        delete room.names[socket.id];
        delete room.hands[socket.id];
        if (room.players.length > 0) {
            // --- DEBUG LOG ---
            console.log(`[disconnect]: Room ${roomId} still has players. Emitting updated state.`);
            emitRoomState(roomId);
        } else {
            // --- DEBUG LOG ---
            console.log(`[disconnect]: Room ${roomId} is now empty. Deleting room.`);
            delete rooms[roomId];
        }
      }
    }
  });
});

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
