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

    const deck = shuffle(generateDeck());
    const handSize = Math.floor(deck.length / 2);

    room.hands = {};
    room.hands[room.players[0]] = deck.slice(0, handSize);
    room.hands[room.players[1]] = deck.slice(handSize, handSize * 2);

    room.tableCards = [];
    room.lastPlayed = null;
    room.turnIndex = Math.floor(Math.random() * room.players.length);
    room.skippedPlayers = [];
    
    io.to(roomId).emit('game started', {
        hands: room.hands,
        turn: room.players[room.turnIndex],
        players: room.players.map(id => ({ id, name: room.names[id] || 'Player' }))
    });
}

io.on('connection', (socket) => {
  socket.on('join room', ({ roomId, playerName }) => {
    socket.join(roomId);
    if (!rooms[roomId]) {
      rooms[roomId] = { players: [], names: {}, hands: {}, tableCards: [], lastPlayed: null, turnIndex: 0, skippedPlayers: [] };
    }
    const room = rooms[roomId];

    if (!room.players.includes(socket.id)) {
      room.players.push(socket.id);
    }
    room.names[socket.id] = playerName || `Player #${room.players.length}`;

    if (room.players.length === 2 && Object.keys(room.hands).length === 0) {
      startGame(roomId);
    } else {
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

    // **THE FIX**: We no longer check for a winner immediately.
    // The turn always passes to the next player, giving them a chance to call bluff on the final play.
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    io.to(roomId).emit('turn', room.players[room.turnIndex]);
  });
  
  socket.on('skip turn', ({ roomId }) => {
      const room = rooms[roomId];
      if (!room || socket.id !== room.players[room.turnIndex]) return;

      // **THE FIX**: When a player skips, we check if the person who played last just won.
      // If the opponent chooses not to call bluff on the final play, the player with 0 cards wins.
      const lastPlayerId = room.lastPlayed?.playerId;
      if (lastPlayerId && room.hands[lastPlayerId]?.length === 0) {
        return io.to(roomId).emit('game over', { winnerName: room.names[lastPlayerId] });
      }

      io.to(roomId).emit('message', `${room.names[socket.id]} skipped.`);

      if (!room.skippedPlayers.includes(socket.id)) {
          room.skippedPlayers.push(socket.id);
      }

      if (room.skippedPlayers.length >= room.players.length) {
          const firstSkipperId = room.skippedPlayers[0];
          room.tableCards = [];
          room.lastPlayed = null;
          room.skippedPlayers = [];
          io.to(roomId).emit('message', 'All players skipped. The pile is cleared.');
          io.to(roomId).emit('table cleared');
          
          room.turnIndex = room.players.findIndex(p => p === firstSkipperId);
      } else {
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
      }
      
      io.to(roomId).emit('turn', room.players[room.turnIndex]);
  });

  socket.on('call bluff', ({ roomId }) => {
      const room = rooms[roomId];
      if (!room || !room.lastPlayed || socket.id === room.lastPlayed.playerId) return;

      io.to(roomId).emit('reveal cards', room.lastPlayed.cards);

      const { declaredRank, cards, playerId: bluffedPlayerId } = room.lastPlayed;
      const isBluff = cards.some(c => !c.startsWith(declaredRank));
      const callerId = socket.id;

      let nextPlayerId;

      if (isBluff) {
        room.hands[bluffedPlayerId].push(...room.tableCards);
        nextPlayerId = callerId;
        io.to(roomId).emit('message', `${room.names[callerId]} called bluff correctly! ${room.names[bluffedPlayerId]} takes the pile.`);
      } else {
        room.hands[callerId].push(...room.tableCards);
        nextPlayerId = bluffedPlayerId;
        io.to(roomId).emit('message', `${room.names[callerId]} called bluff incorrectly! They take the pile.`);
        
        // **THE FIX**: After a failed bluff call, we check if the player who was telling the truth now has 0 cards. If so, they win.
        if (room.hands[bluffedPlayerId]?.length === 0) {
            return io.to(roomId).emit('game over', { winnerName: room.names[bluffedPlayerId] });
        }
      }
      
      room.tableCards = [];
      room.lastPlayed = null;
      room.skippedPlayers = [];
      io.to(roomId).emit('table cleared');
      io.to(roomId).emit('update hands', room.hands);
      
      room.turnIndex = room.players.findIndex(p => p === nextPlayerId);
      io.to(roomId).emit('turn', room.players[room.turnIndex]);
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
