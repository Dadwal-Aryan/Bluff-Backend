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

// --- UTILITY FUNCTIONS ---
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

// ** This function gets the complete game state to send to clients **
function getGameState(roomId) {
    const room = rooms[roomId];
    if (!room) return null;

    return {
        players: room.players.map(id => ({ id, name: room.names[id] || 'Player' })),
        hands: room.hands,
        turn: room.players[room.turnIndex],
        lastPlayed: room.lastPlayed,
        declaredRank: room.lastPlayed ? room.lastPlayed.declaredRank : '',
    };
}

// ** This function broadcasts the single, true game state to all players **
function broadcastGameState(roomId) {
    const gameState = getGameState(roomId);
    if (gameState) {
        io.to(roomId).emit('game update', gameState);
    }
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
    
    broadcastGameState(roomId);
}

// --- SOCKET EVENT HANDLERS ---
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
      broadcastGameState(roomId);
    }
  });

  socket.on('play cards', ({ roomId, playedCards, declaredRank }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.players[room.turnIndex]) return;

    const playerHand = room.hands[socket.id];
    if (!playedCards.every(c => playerHand.includes(c))) return;
    if (room.lastPlayed && room.lastPlayed.declaredRank && declaredRank !== room.lastPlayed.declaredRank) return;

    room.hands[socket.id] = playerHand.filter(c => !playedCards.includes(c));
    room.tableCards.push(...playedCards);
    room.lastPlayed = { playerId: socket.id, cards: playedCards, declaredRank };
    room.skippedPlayers = [];
    
    // Always advance the turn. The win is checked when the opponent acts.
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    broadcastGameState(roomId);
  });
  
  socket.on('skip turn', ({ roomId }) => {
      const room = rooms[roomId];
      if (!room || socket.id !== room.players[room.turnIndex]) return;

      const lastPlayerId = room.lastPlayed?.playerId;
      // If the opponent skips the final winning play, the game is over.
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
          room.turnIndex = room.players.findIndex(p => p === firstSkipperId);
      } else {
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
      }
      broadcastGameState(roomId);
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
        
        // If the bluff call fails, check if the truthful player has won.
        if (room.hands[bluffedPlayerId]?.length === 0) {
            return io.to(roomId).emit('game over', { winnerName: room.names[bluffedPlayerId] });
        }
      }
      
      room.tableCards = [];
      room.lastPlayed = null;
      room.skippedPlayers = [];
      room.turnIndex = room.players.findIndex(p => p === nextPlayerId);
      
      broadcastGameState(roomId);
  });
  
  socket.on('request new game', ({ roomId }) => {
      if (rooms[roomId]) startGame(roomId);
  });

  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (room.players.includes(socket.id)) {
        room.players = room.players.filter(id => id !== socket.id);
        delete room.names[socket.id];
        delete room.hands[socket.id];
        if (room.players.length > 0) {
            broadcastGameState(roomId);
        } else {
            delete rooms[roomId];
        }
      }
    }
  });
});

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
