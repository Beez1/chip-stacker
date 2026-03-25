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
const DROP_COOLDOWN_MS = 200; // rate limit: 1 drop per 200ms per player
const COLLAPSE_RESUME_MS = 5500;

const NAMES = [
  'CryptoKing','LuckyLucy','NightOwl','BettyBoom','IceCold420',
  'HighRoller','StackMaster','ChipWizard','PotHunter','RiskTaker',
  'MoonShot','DegenKing','BigBluff','CoinFlip','AllInAndy',
  'DiceDemon','JackpotJoe','WildCard','AcesHigh','PokerFace'
];

const COLORS = ['#f0c040','#3498db','#2ecc71','#9b59b6','#e67e22','#1abc9c','#ff6b6b','#00bcd4','#ff9800','#8bc34a'];
const EVENTS = ['bomb','lightning','tsunami','cat','meteor','ufo'];

function pickColor(room) {
  const taken = new Set(room.players.map(p => p.col));
  for (const col of COLORS) {
    if (!taken.has(col)) return col;
  }
  return '#' + crypto.randomBytes(3).toString('hex');
}

function pickName(room) {
  const taken = new Set(room.players.map(p => p.name));
  const avail = NAMES.filter(n => !taken.has(n));
  if (avail.length) return avail[Math.floor(Math.random() * avail.length)];
  return 'Player' + (room.players.length + 1);
}

// Sanitize player name — strip anything that could be XSS
function sanitize(str) {
  return String(str).replace(/[<>&"'`]/g, '').slice(0, 20);
}

const rooms = new Map();

function genRoomId() {
  return crypto.randomBytes(3).toString('hex');
}

function createRoom(id) {
  return {
    id,
    players: [],
    stack: [],        // [{pidx}]
    seq: 0,
    house: 0,
    roundNum: 1,
    collapsed: false,
    collapseTimer: null,
  };
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
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

function broadcastFullState(room) {
  for (let i = 0; i < room.players.length; i++) {
    sendTo(room.players[i].ws, fullState(room, i));
  }
}

// ===== GAME LOGIC =====
function handleDrop(room, playerIdx, clientOx) {
  const player = room.players[playerIdx];
  if (!player || room.collapsed) return;

  // Server-authoritative balance check
  if (player.bal < 1) return;

  // Rate limit
  const now = Date.now();
  if (player.lastDrop && (now - player.lastDrop) < DROP_COOLDOWN_MS) return;
  player.lastDrop = now;

  room.seq++;
  player.bal -= 1;
  player.drops++;

  // Clamp client ox to valid range
  const ox = (typeof clientOx === 'number' && isFinite(clientOx))
    ? Math.max(-11, Math.min(11, clientOx))
    : (Math.random() - 0.5) * 22;

  room.stack.push({ pidx: playerIdx });

  const len = room.stack.length;
  const collapseChance = len <= 4 ? 0 : 0.03 + (len - 4) * 0.025;
  const willCollapse = Math.random() < collapseChance;

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
    const event = EVENTS[Math.floor(Math.random() * EVENTS.length)];
    doCollapse(room, playerIdx, event);
  }

  console.log(`[${room.id}] ${player.name} dropped (stack:${len}, bal:${player.bal}${willCollapse ? ', COLLAPSE!' : ''})`);
}

function doCollapse(room, winnerIdx, event) {
  room.collapsed = true;
  const total = room.stack.length;
  const cut = Math.round(total * HCUT * 100) / 100;
  const net = total - cut;
  room.house += cut;

  const winner = (winnerIdx >= 0 && winnerIdx < room.players.length) ? room.players[winnerIdx] : null;
  if (winner) winner.bal += net;

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

  console.log(`[${room.id}] COLLAPSE! ${event} — ${winner ? winner.name : '???'} wins ${net.toFixed(1)}p (${total} chips, house:${room.house.toFixed(1)})`);

  // Resume after cutscene
  if (room.collapseTimer) clearTimeout(room.collapseTimer);
  room.collapseTimer = setTimeout(() => {
    room.collapsed = false;
    room.collapseTimer = null;
    broadcastFullState(room);
    broadcast(room, { type: 'newRound', roundNum: room.roundNum });
  }, COLLAPSE_RESUME_MS);
}

function removePlayer(room, playerIdx) {
  const player = room.players[playerIdx];
  if (!player) return;

  console.log(`[${room.id}] ${player.name} left (${room.players.length - 1} remaining)`);

  room.players.splice(playerIdx, 1);

  // Fix stack pidx references
  room.stack = room.stack.filter(ch => ch.pidx !== playerIdx).map(ch => ({
    pidx: ch.pidx > playerIdx ? ch.pidx - 1 : ch.pidx,
  }));

  room.seq++;

  broadcast(room, {
    type: 'playerLeft',
    name: player.name,
    playerCount: room.players.length,
  });

  // Full resync fixes stale indices on all clients
  broadcastFullState(room);

  // Clean up empty rooms (check reference identity to avoid deleting recreated rooms)
  if (room.players.length === 0) {
    const roomRef = room;
    setTimeout(() => {
      if (rooms.has(roomRef.id) && rooms.get(roomRef.id) === roomRef && roomRef.players.length === 0) {
        rooms.delete(roomRef.id);
        console.log(`[${roomRef.id}] Room cleaned up (empty)`);
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
    name: sanitize(pickName(room)),
    col: pickColor(room),
    ws,
    bal: 100,
    drops: 0,
    lastDrop: 0,
  };
  room.players.push(player);
  room.seq++;

  console.log(`[${room.id}] ${player.name} joined (${room.players.length}/${MAX_PLAYERS})`);

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

  // Resync everyone
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
