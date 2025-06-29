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
    io.to(roomId).emit('room state', playersWithNames);
}

function startGame(roomId) {
    const room = rooms[roomId];
    if (!room || room.players.length < 2) return;

    console.log(`Starting/Restarting game in room ${roomId}`);
    const deck = shuffle(generateDeck());
    const handSize = Math.floor(deck.length / 2);

    room.hands = {};
    room.hands[room.players[0]] = deck.slice(0, handSize);
    room.hands[room.players[1]] = deck.slice(handSize, handSize * 2);

    room.tableCards = [];
    room.lastPlayed = null;
    room.turnIndex = Math.floor(Math.random() * room.players.length);
    room.skippedPlayers = [];
    
    io.to(roomId).emit('deal cards', room.hands);
    const currentTurn = room.players[room.turnIndex];
    io.to(roomId).emit('turn', currentTurn);
}

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('join room', ({ roomId, playerName }) => {
    socket.join(roomId);
    if (!rooms[roomId]) {
      rooms[roomId] = { players: [], names: {}, hands: {}, tableCards: [], lastPlayed: null, turnIndex: 0, skippedPlayers: [] };
    }
    const room = rooms[roomId];

    if (!room.players.includes(socket.id)) {
      room.players.push(socket.id);
      room.names[socket.id] = playerName || `Player #${room.players.length}`;
    }

    emitRoomState(roomId);

    if (room.players.length === 2 && Object.keys(room.hands).length === 0) {
      startGame(roomId);
    }
  });

  socket.on('set name', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (room && room.names[socket.id]) {
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

    // Enforce the declared rank if one is already set for the round
    if (room.lastPlayed && room.lastPlayed.declaredRank && declaredRank !== room.lastPlayed.declaredRank) {
        return socket.emit('error message', `You must play the declared rank of ${room.lastPlayed.declaredRank}.`);
    }

    room.hands[socket.id] = playerHand.filter(c => !playedCards.includes(c));
    room.tableCards.push(...playedCards);
    room.lastPlayed = { playerId: socket.id, cards: playedCards, declaredRank };
    // A successful play resets the skip counter for the round
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

      // Check if all active players have skipped
      if (room.skippedPlayers.length >= room.players.length) {
          room.tableCards = [];
          room.lastPlayed = null; // This clears the declared rank for the new round
          room.skippedPlayers = [];
          io.to(roomId).emit('message', 'All players skipped. The pile is cleared.');
          io.to(roomId).emit('table cleared');
      }
      
      // Always advance the turn
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
      
      // A bluff call ends the round, so clear the table and ranks
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
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (room.players.includes(socket.id)) {
        room.players = room.players.filter(id => id !== socket.id);
        delete room.names[socket.id];
        delete room.hands[socket.id];
        if (room.players.length > 0) {
            emitRoomState(roomId);
        } else {
            delete rooms[roomId];
        }
      }
    }
  });
});

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
