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
// rooms structure example:
// {
//   roomId: {
//     players: [socketId1, socketId2],
//     hands: { socketId1: [...cards], socketId2: [...cards] },
//     currentTurnIndex: 0,
//     tablePile: []
//   }
// };

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
      rooms[roomId] = {
        players: [],
        hands: {},
        currentTurnIndex: 0,
        tablePile: []
      };
    }

    const room = rooms[roomId];
    if (!room.players.includes(socket.id)) {
      room.players.push(socket.id);
    }

    // When 2 players have joined, start the game
    if (room.players.length === 2) {
      const deck = shuffle(generateDeck());
      const handSize = Math.floor(deck.length / 2);

      // Deal cards to players and save in room state
      room.hands[room.players[0]] = deck.slice(0, handSize);
      room.hands[room.players[1]] = deck.slice(handSize);

      room.currentTurnIndex = Math.floor(Math.random() * 2); // random starting player
      room.tablePile = [];

      // Send hands and initial turn
      room.players.forEach(playerId => {
        io.to(playerId).emit('deal cards', room.hands[playerId]);
      });

      io.to(roomId).emit('turn', room.players[room.currentTurnIndex]);
    }

    // Update room state for all players
    io.to(roomId).emit('room state', room.players);
  });

  socket.on('play cards', ({ roomId, playedCards }) => {
    const room = rooms[roomId];
    if (!room) return;

    const currentPlayerId = room.players[room.currentTurnIndex];
    if (socket.id !== currentPlayerId) {
      socket.emit('error message', "It's not your turn");
      return;
    }

    const playerHand = room.hands[socket.id];

    // Validate player has those cards (basic check)
    for (const card of playedCards) {
      if (!playerHand.includes(card)) {
        socket.emit('error message', "You don't have those cards");
        return;
      }
    }

    // Remove played cards from player's hand
    room.hands[socket.id] = playerHand.filter(card => !playedCards.includes(card));

    // Add played cards to table pile
    room.tablePile.push(...playedCards);

    // Broadcast updated hand to current player
    socket.emit('deal cards', room.hands[socket.id]);

    // Broadcast played cards to all in room
    io.to(roomId).emit('cards played', { playerId: socket.id, playedCards });

    // Advance turn
    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
    io.to(roomId).emit('turn', room.players[room.currentTurnIndex]);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (!room) continue;

      room.players = room.players.filter(id => id !== socket.id);
      delete room.hands[socket.id];

      // If no players left, delete room
      if (room.players.length === 0) {
        delete rooms[roomId];
      } else {
        io.to(roomId).emit('room state', room.players);

        // If disconnected player was current turn, move turn to next
        if (room.players[room.currentTurnIndex] === socket.id) {
          room.currentTurnIndex = room.currentTurnIndex % room.players.length;
          io.to(roomId).emit('turn', room.players[room.currentTurnIndex]);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
