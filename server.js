// Bluff-backend/server.js

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
//     turnIndex: 0,
//     skippedPlayers: [] // Tracks players who skipped the current round
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

// Helper to emit the current state of the room to all players
function emitRoomState(roomId) {
    if (!rooms[roomId]) return;
    const room = rooms[roomId];
    const playersWithNames = room.players.map(id => ({
        id,
        name: room.names[id] || 'Player',
    }));
    io.to(roomId).emit('room state', playersWithNames);
}


io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('join room', (roomId) => {
    console.log(`User ${socket.id} joined room ${roomId}`);
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [],
        names: {},
        hands: {},
        tableCards: [],
        lastPlayed: null,
        turnIndex: 0,
        skippedPlayers: []
      };
    }
    const room = rooms[roomId];

    if (!room.players.includes(socket.id)) {
      room.players.push(socket.id);
      room.names[socket.id] = 'Player'; // default name until set
    }

    emitRoomState(roomId);

    // Start game when 2 players join and cards haven't been dealt
    if (room.players.length === 2 && !room.hands[room.players[0]]) {
      const deck = shuffle(generateDeck());
      const handSize = Math.floor(deck.length / 2);

      room.hands[room.players[0]] = deck.slice(0, handSize);
      room.hands[room.players[1]] = deck.slice(handSize);
      room.tableCards = [];
      room.lastPlayed = null;
      room.turnIndex = 0;
      room.skippedPlayers = [];

      io.to(room.players[0]).emit('deal cards', room.hands[room.players[0]]);
      io.to(room.players[1]).emit('deal cards', room.hands[room.players[1]]);

      const currentTurn = room.players[room.turnIndex];
      io.to(roomId).emit('turn', currentTurn);
    }
  });

  socket.on('set name', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.names[socket.id] = name || 'Player';
    emitRoomState(roomId);
  });

  socket.on('play cards', ({ roomId, playedCards, declaredRank }) => {
    const room = rooms[roomId];
    if (!room) return;

    const currentPlayerId = room.players[room.turnIndex];
    if (socket.id !== currentPlayerId) {
      return socket.emit('error message', "It's not your turn!");
    }

    // If a rank is already on the table, the new declaration must match
    if (room.lastPlayed && room.lastPlayed.declaredRank && declaredRank !== room.lastPlayed.declaredRank) {
        return socket.emit('error message', `You must play the declared rank of ${room.lastPlayed.declaredRank}.`);
    }

    const playerHand = room.hands[socket.id];
    const hasAllCards = playedCards.every(card => playerHand.includes(card));
    if (!hasAllCards) {
      return socket.emit('error message', "You don't have those cards!");
    }

    room.hands[socket.id] = playerHand.filter(card => !playedCards.includes(card));
    room.tableCards.push(...playedCards);

    room.lastPlayed = {
      playerId: socket.id,
      cards: playedCards,
      declaredRank,
    };

    // A play resets the skip counter for the round
    room.skippedPlayers = [];

    io.to(roomId).emit('cards played', { playerId: socket.id, playedCards, declaredRank });

    // Check for a winner
    if (room.hands[socket.id].length === 0) {
        io.to(roomId).emit('game over', { winnerName: room.names[socket.id] });
    } else {
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
        io.to(roomId).emit('turn', room.players[room.turnIndex]);
        io.to(roomId).emit('update hands', room.hands);
    }
  });

  // NEW: Handle a player skipping their turn
  socket.on('skip turn', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;

    const currentPlayerId = room.players[room.turnIndex];
    if (socket.id !== currentPlayerId) {
      return socket.emit('error message', "It's not your turn!");
    }

    // Add player to skipped list if they haven't already skipped this round
    if (!room.skippedPlayers.includes(socket.id)) {
      room.skippedPlayers.push(socket.id);
    }
    
    io.to(roomId).emit('player skipped', socket.id);

    // Check if all players have now skipped
    if (room.skippedPlayers.length === room.players.length) {
      // All players have skipped, the round is over. Clear the table and the declared rank.
      room.tableCards = [];
      room.lastPlayed = null; // This clears the declaredRank
      room.skippedPlayers = [];
      io.to(roomId).emit('message', `All players skipped. The pile is cleared.`);
      io.to(roomId).emit('table cleared');
    }

    // Advance to the next player's turn regardless
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    io.to(roomId).emit('turn', room.players[room.turnIndex]);
  });


  socket.on('call bluff', (roomId) => {
    const room = rooms[roomId];
    if (!room || !room.lastPlayed) {
      return socket.emit('error message', 'No cards have been played to call bluff on.');
    }

    io.to(roomId).emit('reveal cards', room.lastPlayed.cards);

    const callerId = socket.id;
    const bluffedPlayerId = room.lastPlayed.playerId;

    if (callerId === bluffedPlayerId) {
      return socket.emit('error message', 'You cannot call bluff on yourself.');
    }

    const { declaredRank, cards } = room.lastPlayed;
    const actualRanks = cards.map(card => card.replace(/♠|♥|♦|♣/, ''));

    const isBluff = actualRanks.some(rank => rank !== declaredRank);

    if (isBluff) {
      // Bluff was successful, the player who bluffed takes the pile
      room.hands[bluffedPlayerId].push(...room.tableCards);
      io.to(roomId).emit('message', `Bluff call successful! ${room.names[bluffedPlayerId]} was bluffing and picks up the pile.`);
    } else {
      // Bluff call failed, the caller takes the pile
      room.hands[callerId].push(...room.tableCards);
      io.to(roomId).emit('message', `Bluff call failed! ${room.names[callerId]} was wrong and picks up the pile.`);
    }

    room.tableCards = [];
    room.lastPlayed = null; // Clears declared rank for the next round
    room.skippedPlayers = [];

    io.to(roomId).emit('update hands', room.hands);
    io.to(roomId).emit('table cleared');
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (!room || !room.players.includes(socket.id)) continue;

      room.players = room.players.filter(id => id !== socket.id);
      delete room.names[socket.id];
      delete room.hands[socket.id];

      if (room.players.length > 0) {
        emitRoomState(roomId);
      } else {
        delete rooms[roomId]; // Delete room if empty
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});