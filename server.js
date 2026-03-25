const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const HCUT = 0.015;
const MAX_PLAYERS = 6;

const NAMES = [
  'CryptoKing','LuckyLucy','NightOwl','BettyBoom','IceCold420',
  'HighRoller','StackMaster','ChipWizard','PotHunter','RiskTaker',
  'MoonShot','DegenKing','BigBluff','CoinFlip','AllInAndy',
  'DiceDemon','JackpotJoe','WildCard','AcesHigh','PokerFace'
];

const COLORS = ['#f0c040','#3498db','#2ecc71','#9b59b6','#e67e22','#1abc9c'];

// ===== ROOMS =====
const rooms = new Map();

function genRoomId() {
  return crypto.randomBytes(3).toString('hex'); // 6 char hex
}

function pickName(room) {
  const taken = new Set(room.players.map(p => p.name));
  const avail = NAMES.filter(n => !taken.has(n));
  if (avail.length) return avail[Math.floor(Math.random() * avail.length)];
  return 'Player' + (room.players.length + 1);
}

function createRoom(id) {
  return {
    id,
    players: [],       // [{id, name, col, ws, bal, drops}]
    stack: [],         // [{pidx, id}] — server only tracks count + owner
    busy: false,
    collapsed: false,
    house: 0,
    roundNum: 1,
  };
}

function broadcast(room, msg, excludeWs) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.ws !== excludeWs && p.ws.readyState === 1) {
      p.ws.send(data);
    }
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function roomState(room, forPlayerIdx) {
  return {
    type: 'state',
    roomId: room.id,
    players: room.players.map((p, i) => ({
      name: p.name,
      col: p.col,
      bal: p.bal,
      drops: p.drops,
      isYou: i === forPlayerIdx,
    })),
    stackCount: room.stack.length,
    stack: room.stack.map(ch => ({ pidx: ch.pidx })),
    house: room.house,
    roundNum: room.roundNum,
    collapsed: room.collapsed,
    busy: room.busy,
  };
}

// ===== GAME LOGIC =====
function handleDrop(room, playerIdx) {
  const player = room.players[playerIdx];
  if (!player) return;
  if (room.collapsed) return;
  if (room.busy) return;
  if (player.bal < 1) return;

  room.busy = true;
  player.bal -= 1;
  player.drops++;

  // Random horizontal offset for the drop
  const ox = (Math.random() - 0.5) * 22;

  const chip = { pidx: playerIdx };
  room.stack.push(chip);

  // Broadcast the drop to all players
  broadcast(room, {
    type: 'drop',
    pidx: playerIdx,
    name: player.name,
    ox: ox,
    stackCount: room.stack.length,
    bal: player.bal,
  });

  // Check collapse after a short delay (simulating chip landing)
  setTimeout(() => {
    if (room.collapsed) return;

    const len = room.stack.length;
    const collapseChance = len <= 4 ? 0 : 0.03 + (len - 4) * 0.025;
    const roll = Math.random();

    if (roll < collapseChance) {
      doCollapse(room, playerIdx);
    } else {
      room.busy = false;
      broadcast(room, {
        type: 'landed',
        stackCount: room.stack.length,
        collapsed: false,
      });
    }
  }, 600);
}

function doCollapse(room, winnerIdx) {
  room.collapsed = true;
  const total = room.stack.length;
  const cut = Math.round(total * HCUT * 100) / 100;
  const net = total - cut;
  room.house += cut;

  const winner = room.players[winnerIdx];
  if (winner) winner.bal += net;

  broadcast(room, {
    type: 'collapse',
    winnerIdx: winnerIdx,
    winnerName: winner ? winner.name : '???',
    total: total,
    net: net,
    cut: cut,
    house: room.house,
  });

  room.stack = [];
  room.roundNum++;

  // Resume after animation
  setTimeout(() => {
    room.collapsed = false;
    room.busy = false;

    // Send fresh state to everyone
    for (let i = 0; i < room.players.length; i++) {
      sendTo(room.players[i].ws, roomState(room, i));
    }

    broadcast(room, { type: 'newRound', roundNum: room.roundNum });
  }, 2800);
}

function removePlayer(room, playerIdx) {
  const player = room.players[playerIdx];
  if (!player) return;

  room.players.splice(playerIdx, 1);

  // Fix stack pidx references
  room.stack = room.stack.filter(ch => ch.pidx !== playerIdx).map(ch => ({
    ...ch,
    pidx: ch.pidx > playerIdx ? ch.pidx - 1 : ch.pidx,
  }));

  broadcast(room, {
    type: 'playerLeft',
    name: player.name,
    playerCount: room.players.length,
  });

  // Send updated state to remaining players
  for (let i = 0; i < room.players.length; i++) {
    sendTo(room.players[i].ws, roomState(room, i));
  }

  // Clean up empty rooms after a delay
  if (room.players.length === 0) {
    setTimeout(() => {
      if (rooms.has(room.id) && rooms.get(room.id).players.length === 0) {
        rooms.delete(room.id);
      }
    }, 60000);
  }
}

// ===== WEBSOCKET =====
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let roomId = url.searchParams.get('room');

  // Create room if none specified
  if (!roomId || !rooms.has(roomId)) {
    if (!roomId) roomId = genRoomId();
    if (!rooms.has(roomId)) rooms.set(roomId, createRoom(roomId));
  }

  const room = rooms.get(roomId);

  if (room.players.length >= MAX_PLAYERS) {
    sendTo(ws, { type: 'error', msg: 'Room is full (6/6)' });
    ws.close();
    return;
  }

  const playerIdx = room.players.length;
  const player = {
    id: crypto.randomBytes(4).toString('hex'),
    name: pickName(room),
    col: COLORS[playerIdx % COLORS.length],
    ws: ws,
    bal: 100,
    drops: 0,
  };
  room.players.push(player);

  // Tell the new player their info + full state
  sendTo(ws, {
    type: 'welcome',
    roomId: room.id,
    yourIdx: playerIdx,
    yourName: player.name,
    yourCol: player.col,
  });
  sendTo(ws, roomState(room, playerIdx));

  // Tell everyone else
  broadcast(room, {
    type: 'playerJoined',
    name: player.name,
    col: player.col,
    playerCount: room.players.length,
  }, ws);

  // Send updated state to all existing players
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].ws !== ws) {
      sendTo(room.players[i].ws, roomState(room, i));
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Find current index (may shift if someone left)
    const idx = room.players.findIndex(p => p.ws === ws);
    if (idx === -1) return;

    if (msg.type === 'drop') {
      handleDrop(room, idx);
    }
  });

  ws.on('close', () => {
    const idx = room.players.findIndex(p => p.ws === ws);
    if (idx !== -1) removePlayer(room, idx);
  });
});

// ===== SERVE STATIC =====
app.get('/', (req, res) => {
  // If no room param, create one and redirect
  if (!req.query.room) {
    const roomId = genRoomId();
    rooms.set(roomId, createRoom(roomId));
    return res.redirect(`/?room=${roomId}`);
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Chip Stacker running on http://localhost:${PORT}`);
});
