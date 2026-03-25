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

const COLORS = ['#f0c040','#3498db','#2ecc71','#9b59b6','#e67e22','#1abc9c','#ff6b6b','#00bcd4','#ff9800','#8bc34a'];

function pickColor(room) {
  const taken = new Set(room.players.map(p => p.col));
  for (const col of COLORS) {
    if (!taken.has(col)) return col;
  }
  return '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6,'0');
}

const rooms = new Map();

function genRoomId() {
  return crypto.randomBytes(3).toString('hex');
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
    players: [],
    stack: [],        // [{pidx}]
    seq: 0,           // global sequence counter
    house: 0,
    roundNum: 1,
    collapsed: false,
    collapseTimer: null,
  };
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.ws.readyState === 1) p.ws.send(data);
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function fullState(room, forIdx) {
  return {
    type: 'state',
    roomId: room.id,
    seq: room.seq,
    players: room.players.map((p, i) => ({
      name: p.name, col: p.col, bal: p.bal, drops: p.drops, isYou: i === forIdx,
    })),
    stack: room.stack.map(ch => ({ pidx: ch.pidx })),
    house: room.house,
    roundNum: room.roundNum,
    collapsed: room.collapsed,
  };
}

// ===== GAME LOGIC =====
function handleDrop(room, playerIdx, clientOx) {
  const player = room.players[playerIdx];
  if (!player || room.collapsed || player.bal < 1) return;

  room.seq++;
  player.bal -= 1;
  player.drops++;

  // Use the ox from the dropping client so their optimistic animation matches
  const ox = (typeof clientOx === 'number') ? Math.max(-11, Math.min(11, clientOx)) : (Math.random() - 0.5) * 22;
  room.stack.push({ pidx: playerIdx });

  const len = room.stack.length;
  const collapseChance = len <= 4 ? 0 : 0.03 + (len - 4) * 0.025;
  const willCollapse = Math.random() < collapseChance;

  // Send drop + collapse info in ONE message — no delay
  broadcast(room, {
    type: 'drop',
    seq: room.seq,
    pidx: playerIdx,
    name: player.name,
    col: player.col,
    ox: ox,
    stackCount: len,
    bal: player.bal,
    collapse: willCollapse,
  });

  if (willCollapse) {
    // Pick a random collapse event — server decides so all clients see same one
    const EVENTS = ['bomb','lightning','tsunami','cat','meteor','ufo'];
    const event = EVENTS[Math.floor(Math.random() * EVENTS.length)];
    doCollapse(room, playerIdx, event);
  }
}

function doCollapse(room, winnerIdx, event) {
  room.collapsed = true;
  const total = room.stack.length;
  const cut = Math.round(total * HCUT * 100) / 100;
  const net = total - cut;
  room.house += cut;

  const winner = room.players[winnerIdx];
  if (winner) winner.bal += net;

  // Collapse details sent separately so clients can sequence the animation
  broadcast(room, {
    type: 'collapse',
    seq: room.seq,
    winnerIdx,
    winnerName: winner ? winner.name : '???',
    total,
    net,
    cut,
    house: room.house,
    event: event,
    balances: room.players.map(p => p.bal),
  });

  room.stack = [];
  room.roundNum++;

  // Resume after clients finish animation
  if (room.collapseTimer) clearTimeout(room.collapseTimer);
  room.collapseTimer = setTimeout(() => {
    room.collapsed = false;
    room.collapseTimer = null;

    // Fresh state sync to correct any drift
    for (let i = 0; i < room.players.length; i++) {
      sendTo(room.players[i].ws, fullState(room, i));
    }
    broadcast(room, { type: 'newRound', roundNum: room.roundNum });
  }, 2800);
}

function removePlayer(room, playerIdx) {
  const player = room.players[playerIdx];
  if (!player) return;

  room.players.splice(playerIdx, 1);

  // Fix stack references
  room.stack = room.stack.filter(ch => ch.pidx !== playerIdx).map(ch => ({
    pidx: ch.pidx > playerIdx ? ch.pidx - 1 : ch.pidx,
  }));

  room.seq++;

  broadcast(room, {
    type: 'playerLeft',
    name: player.name,
    playerCount: room.players.length,
  });

  // Full state resync for everyone
  for (let i = 0; i < room.players.length; i++) {
    sendTo(room.players[i].ws, fullState(room, i));
  }

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
    col: pickColor(room),
    ws,
    bal: 100,
    drops: 0,
  };
  room.players.push(player);
  room.seq++;

  sendTo(ws, {
    type: 'welcome',
    roomId: room.id,
    yourIdx: playerIdx,
    yourName: player.name,
    yourCol: player.col,
  });
  sendTo(ws, fullState(room, playerIdx));

  broadcast(room, {
    type: 'playerJoined',
    name: player.name,
    col: player.col,
    playerCount: room.players.length,
  });

  // Resync everyone so they see the new player
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].ws !== ws) {
      sendTo(room.players[i].ws, fullState(room, i));
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const idx = room.players.findIndex(p => p.ws === ws);
    if (idx === -1) return;
    if (msg.type === 'drop') handleDrop(room, idx, msg.ox);
  });

  ws.on('close', () => {
    const idx = room.players.findIndex(p => p.ws === ws);
    if (idx !== -1) removePlayer(room, idx);
  });
});

// ===== SERVE STATIC =====
app.get('/', (req, res) => {
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
