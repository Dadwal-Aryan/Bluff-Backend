const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = 3001;

const rooms = {}; 
// Structure:
// rooms = { 
//   roomId: { 
//     players: [socketId1, socketId2], 
//     names: { socketId1: "Alice", socketId2: "Bob" },
//     hands: {}, 
//     tableCards: [], 
//     lastPlayed: { playerId, cards, declaredRank }, 
//     turnIndex: 0 
//   } 
// }

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

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('join room', (roomId) => {
    console.log(`User ${socket.id} joined room ${roomId}`);
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = { players: [], names: {}, hands: {}, tableCards: [], lastPlayed: null, turnIndex: 0 };
    }

    if (!rooms[roomId].players.includes(socket.id)) {
      rooms[roomId].players.push(socket.id);
      rooms[roomId].names[socket.id] = 'Player'; // default name until set
    }

    // Emit updated player list with names
    io.to(roomId).emit('room state', rooms[roomId].players.map(id => ({
      id,
      name: rooms[roomId].names[id] || 'Player',
    })));

    // Start game when 2 players joined and cards not dealt yet
    if (rooms[roomId].players.length === 2 && !rooms[roomId].hands[rooms[roomId].players[0]]) {
      const deck = shuffle(generateDeck());
      const handSize = Math.floor(deck.length / 2);

      rooms[roomId].hands[rooms[roomId].players[0]] = deck.slice(0, handSize);
      rooms[roomId].hands[rooms[roomId].players[1]] = deck.slice(handSize);
      rooms[roomId].tableCards = [];
      rooms[roomId].lastPlayed = null;
      rooms[roomId].turnIndex = 0;

      io.to(rooms[roomId].players[0]).emit('deal cards', rooms[roomId].hands[rooms[roomId].players[0]]);
      io.to(rooms[roomId].players[1]).emit('deal cards', rooms[roomId].hands[rooms[roomId].players[1]]);

      const currentTurn = rooms[roomId].players[rooms[roomId].turnIndex];
      io.to(roomId).emit('turn', currentTurn);
    }
  });

  // New event: set player name
  socket.on('set name', ({ roomId, name }) => {
    if (!rooms[roomId]) return;

    rooms[roomId].names[socket.id] = name || 'Player';

    io.to(roomId).emit('room state', rooms[roomId].players.map(id => ({
      id,
      name: rooms[roomId].names[id] || 'Player',
    })));
  });

  socket.on('play cards', ({ roomId, playedCards, declaredRank }) => {
    const room = rooms[roomId];
    if (!room) return;

    const currentPlayerId = room.players[room.turnIndex];
    if (socket.id !== currentPlayerId) {
      socket.emit('error message', "It's not your turn!");
      return;
    }

    const playerHand = room.hands[socket.id];
    const hasAllCards = playedCards.every(card => playerHand.includes(card));
    if (!hasAllCards) {
      socket.emit('error message', "You don't have those cards!");
      return;
    }

    room.hands[socket.id] = playerHand.filter(card => !playedCards.includes(card));

    room.tableCards.push(...playedCards);

    room.lastPlayed = {
      playerId: socket.id,
      cards: playedCards,
      declaredRank,
    };

    // FIX: include declaredRank in event emit
    io.to(roomId).emit('cards played', { playerId: socket.id, playedCards, declaredRank });

    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    io.to(roomId).emit('turn', room.players[room.turnIndex]);
    io.to(roomId).emit('update hands', room.hands);
  });

  socket.on('call bluff', (roomId) => {
    const room = rooms[roomId];
    if (!room || !room.lastPlayed) {
      socket.emit('error message', 'No cards have been played to call bluff on.');
      return;
    }

    const callerId = socket.id;
    const bluffedPlayerId = room.lastPlayed.playerId;

    if (callerId === bluffedPlayerId) {
      socket.emit('error message', 'You cannot call bluff on yourself.');
      return;
    }

    const declaredRank = room.lastPlayed.declaredRank;
    const actualRanks = room.lastPlayed.cards.map(card => card.slice(0, -1)); // remove suit

    const isBluff = actualRanks.some(rank => rank !== declaredRank);

    if (isBluff) {
      room.hands[bluffedPlayerId].push(...room.tableCards);
      io.to(roomId).emit('message', `Bluff called! Player ${room.names[bluffedPlayerId]} was bluffing and picks up all cards.`);
    } else {
      room.hands[callerId].push(...room.tableCards);
      io.to(roomId).emit('message', `Bluff called wrongly! Player ${room.names[callerId]} picks up all cards.`);
    }

    room.tableCards = [];
    room.lastPlayed = null;

    io.to(roomId).emit('update hands', room.hands);
    io.to(roomId).emit('table cleared');
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    for (const roomId in rooms) {
      rooms[roomId].players = rooms[roomId].players.filter(id => id !== socket.id);
      delete rooms[roomId].names[socket.id];

      io.to(roomId).emit('room state', rooms[roomId].players.map(id => ({
        id,
        name: rooms[roomId].names[id] || 'Player',
      })));

      if (rooms[roomId].players.length === 0) {
        delete rooms[roomId];
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
