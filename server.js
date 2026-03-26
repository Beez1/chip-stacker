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
const MAX_PLAYERS = 20;
const DROP_COOLDOWN = 250;
const EMOJI_COOLDOWN = 2000;
const COUNTDOWN_SEC = 4;
const COLLAPSE_ANIM_MS = 5500;
const EVENTS = ['bomb','lightning','tsunami','cat','meteor','ufo'];
const NAMES = [
  'CryptoKing','LuckyLucy','NightOwl','BettyBoom','IceCold420',
  'HighRoller','StackMaster','ChipWizard','PotHunter','RiskTaker',
  'MoonShot','DegenKing','BigBluff','CoinFlip','AllInAndy',
  'DiceDemon','JackpotJoe','WildCard','AcesHigh','PokerFace'
];
const COLORS = ['#f0c040','#3498db','#2ecc71','#9b59b6','#e67e22','#1abc9c','#ff6b6b','#00bcd4','#ff9800','#8bc34a'];

// Wobble physics constants
const WOBBLE_BASE = 0.02;       // per chip
const WOBBLE_OFFSET_FACTOR = 0.06; // max extra from off-center
const WOBBLE_MAX_OX = 11;
const COLLAPSE_SCALE = 0.8;
const GRACE_CHIPS = 3;          // first N chips can't collapse

// Multiplier
const MULTI_PER_CHIP = 0.15;

function sanitize(s) { return String(s).replace(/[<>&"'`]/g, '').slice(0, 20); }
function pickColor(room) { const t = new Set(room.players.map(p => p.col)); for (const c of COLORS) { if (!t.has(c)) return c; } return '#' + crypto.randomBytes(3).toString('hex'); }
function pickName(room) { const t = new Set(room.players.map(p => p.name)); const a = NAMES.filter(n => !t.has(n)); return a.length ? a[Math.floor(Math.random() * a.length)] : 'Player' + (room.players.length + 1); }

const rooms = new Map();
function genRoomId() { return crypto.randomBytes(3).toString('hex'); }

// ===== ROOM + PLAYER =====
function createRoom(id) {
  return {
    id, players: [], stack: [], seq: 0, house: 0, roundNum: 1,
    state: 'waiting', // waiting | countdown | active | collapsing | payout
    multiplier: 1.0,
    wobble: 0.0,
    lastDropperIdx: -1,
    countdownTimer: null,
    collapseTimer: null,
    tickInterval: null,
  };
}

function createPlayer(ws, name, col) {
  return {
    id: crypto.randomBytes(4).toString('hex'),
    name, col, ws, bal: 100, drops: 0, lastDrop: 0, lastEmoji: 0,
    // Per-round
    roundBet: 0, cashedOut: false, cashOutMultiplier: 0, cashOutWinnings: 0, chipCount: 0,
  };
}

function resetPlayerRound(p) {
  p.roundBet = 0; p.cashedOut = false; p.cashOutMultiplier = 0; p.cashOutWinnings = 0; p.chipCount = 0;
}

// ===== BROADCAST =====
function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) { if (p.ws && p.ws.readyState === 1) p.ws.send(data); }
}
function sendTo(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function fullState(room, forIdx) {
  return {
    type: 'state',
    roomId: room.id, seq: room.seq, roundNum: room.roundNum,
    gameState: room.state,
    multiplier: +room.multiplier.toFixed(2),
    wobble: +room.wobble.toFixed(3),
    house: room.house,
    stack: room.stack.map(ch => ({ pidx: ch.pidx, ox: ch.ox })),
    players: room.players.map((p, i) => ({
      name: p.name, col: p.col, bal: +p.bal.toFixed(1), drops: p.drops, isYou: i === forIdx,
      roundBet: p.roundBet, cashedOut: p.cashedOut,
      cashOutMultiplier: p.cashedOut ? +p.cashOutMultiplier.toFixed(2) : 0,
    })),
  };
}

function broadcastFullState(room) {
  for (let i = 0; i < room.players.length; i++) sendTo(room.players[i].ws, fullState(room, i));
}

// ===== GAME STATE MACHINE =====
function tryStartCountdown(room) {
  if (room.state !== 'waiting') return;
  const activePlayers = room.players.filter(p => p.bal >= 1);
  if (activePlayers.length < 1) return; // need at least 1 to play (2+ preferred)

  room.state = 'countdown';
  let sec = COUNTDOWN_SEC;
  broadcast(room, { type: 'countdown', seconds: sec });

  room.countdownTimer = setInterval(() => {
    sec--;
    if (sec <= 0) {
      clearInterval(room.countdownTimer);
      room.countdownTimer = null;
      startRound(room);
    } else {
      broadcast(room, { type: 'countdown', seconds: sec });
    }
  }, 1000);
}

function startRound(room) {
  room.state = 'active';
  room.stack = [];
  room.multiplier = 1.0;
  room.wobble = 0.0;
  room.lastDropperIdx = -1;
  room.seq++;
  room.roundNum++;

  for (const p of room.players) resetPlayerRound(p);

  broadcast(room, { type: 'roundStart', roundNum: room.roundNum, seq: room.seq });
  broadcastFullState(room);

  // Periodic tick to sync multiplier/wobble
  room.tickInterval = setInterval(() => {
    if (room.state === 'active') {
      broadcast(room, { type: 'tick', multiplier: +room.multiplier.toFixed(2), wobble: +room.wobble.toFixed(3) });
    }
  }, 500);

  console.log(`[${room.id}] Round ${room.roundNum} started (${room.players.length} players)`);
}

function endRound(room) {
  if (room.tickInterval) { clearInterval(room.tickInterval); room.tickInterval = null; }
  room.state = 'waiting';

  // Auto-start next countdown after a pause
  setTimeout(() => {
    if (room.players.length > 0 && room.state === 'waiting') tryStartCountdown(room);
  }, 2000);
}

// ===== DROP =====
function handleDrop(room, pidx, clientOx) {
  if (room.state !== 'active') return;
  const player = room.players[pidx];
  if (!player || player.bal < 1 || player.cashedOut) return;

  const now = Date.now();
  if (player.lastDrop && (now - player.lastDrop) < DROP_COOLDOWN) return;
  player.lastDrop = now;

  // Debit 1 chip
  player.bal -= 1;
  player.roundBet += 1;
  player.chipCount += 1;
  player.drops++;
  room.seq++;

  // Clamp ox
  const ox = (typeof clientOx === 'number' && isFinite(clientOx)) ? Math.max(-WOBBLE_MAX_OX, Math.min(WOBBLE_MAX_OX, clientOx)) : 0;
  room.stack.push({ pidx, ox });

  // Update wobble
  const offCenterRatio = Math.abs(ox) / WOBBLE_MAX_OX;
  room.wobble += WOBBLE_BASE + offCenterRatio * WOBBLE_OFFSET_FACTOR;
  room.wobble = Math.min(room.wobble, 1.0);

  // Update multiplier
  room.multiplier = 1.0 + room.stack.length * MULTI_PER_CHIP;

  // Check collapse
  const len = room.stack.length;
  let collapseChance = 0;
  if (len > GRACE_CHIPS) {
    collapseChance = Math.pow(room.wobble, 2) * COLLAPSE_SCALE;
  }
  const willCollapse = Math.random() < collapseChance;

  broadcast(room, {
    type: 'drop', seq: room.seq, pidx, name: player.name, col: player.col,
    ox, stackCount: len, bal: +player.bal.toFixed(1),
    multiplier: +room.multiplier.toFixed(2), wobble: +room.wobble.toFixed(3),
    collapseChance: +collapseChance.toFixed(3), collapse: willCollapse,
  });

  console.log(`[${room.id}] ${player.name} dropped ox:${ox.toFixed(1)} (stack:${len}, wobble:${room.wobble.toFixed(2)}, multi:${room.multiplier.toFixed(2)}, collapse:${(collapseChance*100).toFixed(1)}%${willCollapse ? ' COLLAPSE!' : ''})`);

  if (willCollapse) {
    room.lastDropperIdx = pidx;
    doCollapse(room);
  } else {
    checkAllCashedOut(room);
  }
}

// ===== CASH OUT =====
function handleCashOut(room, pidx) {
  if (room.state !== 'active') return;
  const player = room.players[pidx];
  if (!player || player.cashedOut || player.roundBet <= 0) return;

  const winnings = player.roundBet * room.multiplier;
  const houseCut = winnings * HCUT;
  const net = winnings - houseCut;
  room.house += houseCut;

  player.bal += net;
  player.cashedOut = true;
  player.cashOutMultiplier = room.multiplier;
  player.cashOutWinnings = net;
  player.roundBet = 0;

  room.seq++;

  broadcast(room, {
    type: 'cashout', seq: room.seq, pidx, name: player.name,
    multiplier: +room.multiplier.toFixed(2), winnings: +net.toFixed(1),
    bal: +player.bal.toFixed(1),
  });

  console.log(`[${room.id}] ${player.name} cashed out at ${room.multiplier.toFixed(2)}x -> ${net.toFixed(1)}p`);

  checkAllCashedOut(room);
}

function checkAllCashedOut(room) {
  // If all players with active bets have cashed out, end round
  const activeBettors = room.players.filter(p => p.roundBet > 0 && !p.cashedOut);
  if (activeBettors.length === 0 && room.stack.length > 0) {
    // Everyone cashed out — no collapse needed
    broadcast(room, { type: 'allCashedOut', roundNum: room.roundNum });
    console.log(`[${room.id}] All players cashed out — round ends peacefully`);
    endRound(room);
  }
}

// ===== COLLAPSE =====
function doCollapse(room) {
  room.state = 'collapsing';
  if (room.tickInterval) { clearInterval(room.tickInterval); room.tickInterval = null; }

  const total = room.stack.length;
  const event = EVENTS[Math.floor(Math.random() * EVENTS.length)];
  const lastDropper = (room.lastDropperIdx >= 0 && room.lastDropperIdx < room.players.length) ? room.players[room.lastDropperIdx] : null;

  // Calculate payouts
  const payouts = [];
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (p.cashedOut) {
      payouts.push({ pidx: i, name: p.name, net: +p.cashOutWinnings.toFixed(1), status: 'cashedOut', multi: +p.cashOutMultiplier.toFixed(2) });
    } else if (i === room.lastDropperIdx) {
      // Double loss — but cap at their balance
      const penalty = Math.min(p.roundBet, p.bal);
      p.bal -= penalty;
      const totalLoss = p.roundBet + penalty;
      payouts.push({ pidx: i, name: p.name, net: -(+totalLoss.toFixed(1)), status: 'lastDropper' });
    } else if (p.roundBet > 0) {
      // Normal loss — already deducted when they dropped
      payouts.push({ pidx: i, name: p.name, net: -(+p.roundBet.toFixed(1)), status: 'lost' });
    }
    // House gets the uncashed bets as revenue
  }

  broadcast(room, {
    type: 'collapse', seq: room.seq, event, total,
    multiplier: +room.multiplier.toFixed(2), wobble: +room.wobble.toFixed(3),
    lastDropperIdx: room.lastDropperIdx,
    lastDropperName: lastDropper ? lastDropper.name : '???',
    payouts,
    house: +room.house.toFixed(1),
    balances: room.players.map(p => +p.bal.toFixed(1)),
  });

  console.log(`[${room.id}] COLLAPSE! ${event} — last dropper: ${lastDropper ? lastDropper.name : '???'} — payouts: ${JSON.stringify(payouts.map(p => p.name + ':' + p.net))}`);

  room.stack = [];

  if (room.collapseTimer) clearTimeout(room.collapseTimer);
  room.collapseTimer = setTimeout(() => {
    room.collapseTimer = null;
    room.state = 'payout';
    broadcastFullState(room);
    endRound(room);
  }, COLLAPSE_ANIM_MS);
}

// ===== EMOJI =====
function handleEmoji(room, pidx, emojiId) {
  const player = room.players[pidx];
  if (!player) return;
  const now = Date.now();
  if (player.lastEmoji && (now - player.lastEmoji) < EMOJI_COOLDOWN) return;
  player.lastEmoji = now;
  const safeId = sanitize(emojiId);
  broadcast(room, { type: 'emoji', pidx, name: player.name, id: safeId });
}

// ===== PLAYER MANAGEMENT =====
function removePlayer(room, pidx) {
  const player = room.players[pidx];
  if (!player) return;
  console.log(`[${room.id}] ${player.name} left (${room.players.length - 1} remaining)`);

  room.players.splice(pidx, 1);
  room.stack = room.stack.filter(ch => ch.pidx !== pidx).map(ch => ({
    ...ch, pidx: ch.pidx > pidx ? ch.pidx - 1 : ch.pidx,
  }));
  if (room.lastDropperIdx === pidx) room.lastDropperIdx = -1;
  else if (room.lastDropperIdx > pidx) room.lastDropperIdx--;

  room.seq++;
  broadcast(room, { type: 'playerLeft', name: player.name, playerCount: room.players.length });
  broadcastFullState(room);

  if (room.players.length === 0) {
    // Clear all timers
    if (room.countdownTimer) { clearInterval(room.countdownTimer); room.countdownTimer = null; }
    if (room.collapseTimer) { clearTimeout(room.collapseTimer); room.collapseTimer = null; }
    if (room.tickInterval) { clearInterval(room.tickInterval); room.tickInterval = null; }
    room.state = 'waiting';
    const ref = room;
    setTimeout(() => { if (rooms.has(ref.id) && rooms.get(ref.id) === ref && ref.players.length === 0) { rooms.delete(ref.id); console.log(`[${ref.id}] Room cleaned up`); } }, 60000);
  } else if (room.state === 'active') {
    checkAllCashedOut(room);
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

  const pidx = room.players.length;
  const player = createPlayer(ws, sanitize(pickName(room)), pickColor(room));
  room.players.push(player);
  room.seq++;

  console.log(`[${room.id}] ${player.name} joined (${room.players.length}/${MAX_PLAYERS})`);

  sendTo(ws, { type: 'welcome', roomId: room.id, yourIdx: pidx, yourName: player.name, yourCol: player.col });
  sendTo(ws, fullState(room, pidx));
  broadcast(room, { type: 'playerJoined', name: player.name, col: player.col, playerCount: room.players.length });

  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].ws !== ws) sendTo(room.players[i].ws, fullState(room, i));
  }

  // Auto-start countdown if enough players and in waiting state
  if (room.state === 'waiting') tryStartCountdown(room);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const idx = room.players.findIndex(p => p.ws === ws);
    if (idx === -1) return;

    switch (msg.type) {
      case 'drop': handleDrop(room, idx, msg.ox); break;
      case 'cashout': handleCashOut(room, idx); break;
      case 'emoji': handleEmoji(room, idx, msg.id); break;
    }
  });

  ws.on('close', () => {
    const idx = room.players.findIndex(p => p.ws === ws);
    if (idx !== -1) removePlayer(room, idx);
  });
});

app.get('/', (req, res) => {
  if (!req.query.room) {
    const roomId = genRoomId();
    rooms.set(roomId, createRoom(roomId));
    return res.redirect(`/?room=${roomId}`);
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(PORT, () => console.log(`Chip Stacker v2 running on http://localhost:${PORT}`));
