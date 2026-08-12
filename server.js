// server.js — Socket.io 多人即時後端
// 每個連進來的瀏覽器分頁 = 一位玩家 = 一個場景中的角色。
// 伺服器保存「唯一的真相版本」(characters / chatLog)，
// 所有動作（移動、換裝、改名、聊天）都先送到伺服器，
// 伺服器驗證後再廣播給所有人，確保每個人畫面一致。

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// ---------------------------------------------------------------
// CORS：因為前端會放在 alex.tw（和這台後端不同網域），
// 瀏覽器的跨網域安全機制需要後端明確允許來源，否則連不上。
// 如果之後有其他網域也要連，就加進這個陣列裡。
// ---------------------------------------------------------------
const ALLOWED_ORIGINS = [
  'http://www.swimlife.tw',
  'https://www.swimlife.tw',
  'http://swimlife.tw',
  'https://swimlife.tw'
];

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST']
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------------------------------------------------------------
// 管理密碼：清除聊天紀錄前必須提供這組密碼，避免任何人都能亂清。
// 到 Render 的 Environment 分頁設定 ADMIN_SECRET 這個環境變數，
// 自己取一組不容易猜的密碼（不要用下面這個預設值）。
// ---------------------------------------------------------------
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me';

function setCorsForAdmin(res) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret');
}

// 清除所有聊天紀錄的管理 API
app.options('/admin/clear-chat', (req, res) => {
  setCorsForAdmin(res);
  res.sendStatus(204);
});

app.post('/admin/clear-chat', (req, res) => {
  setCorsForAdmin(res);
  const secret = req.headers['x-admin-secret'] || (req.body && req.body.secret);
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(403).json({ ok: false, error: '密碼錯誤' });
  }
  chatLog.length = 0;
  io.emit('chat-cleared');
  return res.json({ ok: true, cleared: true });
});

// ---------------------------------------------------------------
// In-memory 狀態（重啟伺服器會清空；如需持久化可換成資料庫）
// ---------------------------------------------------------------
const characters = Object.create(null); // id -> {id,name,hair,body,x,y,ownerSocketId}
const chatLog = [];                     // {who, charId, text, isSystem, ts}
const MAX_CHAT = 200;

const HAIR_COLORS = ["#3b2a20", "#8a5a34", "#c99a4a", "#d94f4f", "#5c7a5e", "#4a5b8a"];
const BODY_COLORS = ["#b5623f", "#e8b559", "#5c7a5e", "#4a5b8a", "#8a5a8a", "#3b2a20"];

let charCounter = 0;

function pushChat(entry) {
  chatLog.push(entry);
  if (chatLog.length > MAX_CHAT) chatLog.shift();
}

function broadcastCount() {
  io.emit('online-count', Object.keys(characters).length);
}

function clampX(x) { return Math.min(95, Math.max(5, Number(x) || 0)); }
function clampY(y) { return Math.min(92, Math.max(20, Number(y) || 0)); }

io.on('connection', (socket) => {
  // ---- 玩家送出名字/外觀，加入場景 ----
  socket.on('join', (data) => {
    // 每個 socket 只能建立一個角色；避免重複 join 造成殭屍角色
    if (socket.data.charId) return;

    const name = (data && String(data.name || '').trim().slice(0, 16)) || '無名旅人';
    const hair = HAIR_COLORS.includes(data && data.hair) ? data.hair : HAIR_COLORS[Math.floor(Math.random() * HAIR_COLORS.length)];
    const body = BODY_COLORS.includes(data && data.body) ? data.body : BODY_COLORS[Math.floor(Math.random() * BODY_COLORS.length)];

    charCounter++;
    const id = `c${charCounter}_${socket.id.slice(0, 5)}`;
    const c = {
      id,
      name,
      hair,
      body,
      x: 20 + Math.random() * 60,
      y: 30 + Math.random() * 50,
      ownerSocketId: socket.id
    };
    characters[id] = c;
    socket.data.charId = id;

    // 只回給這位新玩家：完整現況快照
    socket.emit('init', {
      selfId: id,
      characters: Object.values(characters),
      chatLog
    });

    // 廣播給其他人：有新角色加入
    socket.broadcast.emit('char-joined', c);

    const sysMsg = { who: '系統', text: `${name} 加入了場景`, isSystem: true, ts: Date.now() };
    pushChat(sysMsg);
    io.emit('chat-message', sysMsg);
    broadcastCount();
  });

  // ---- 移動：只能移動自己的角色 ----
  socket.on('move', (data) => {
    const id = socket.data.charId;
    if (!id || !characters[id] || !data) return;
    const x = clampX(data.x);
    const y = clampY(data.y);
    characters[id].x = x;
    characters[id].y = y;
    io.emit('char-moved', { id, x, y });
  });

  // ---- 捏一捏：換髮色/衣服色，只能改自己的 ----
  socket.on('customize', (data) => {
    const id = socket.data.charId;
    if (!id || !characters[id] || !data) return;
    if (HAIR_COLORS.includes(data.hair)) characters[id].hair = data.hair;
    if (BODY_COLORS.includes(data.body)) characters[id].body = data.body;
    io.emit('char-customized', { id, hair: characters[id].hair, body: characters[id].body });
  });

  // ---- 改名：只能改自己的 ----
  socket.on('rename', (data) => {
    const id = socket.data.charId;
    if (!id || !characters[id]) return;
    const name = (data && String(data.name || '').trim().slice(0, 16)) || characters[id].name;
    characters[id].name = name;
    io.emit('char-renamed', { id, name });
  });

  // ---- 聊天 ----
  socket.on('chat', (data) => {
    const id = socket.data.charId;
    if (!id || !characters[id]) return;
    const text = (data && String(data.text || '').trim().slice(0, 60)) || '';
    if (!text) return;
    const msg = { who: characters[id].name, charId: id, text, isSystem: false, ts: Date.now() };
    pushChat(msg);
    io.emit('chat-message', msg);
    io.emit('char-bubble', { id, text });
  });

  // ---- 離線：把角色從場景移除，通知大家 ----
  socket.on('disconnect', () => {
    const id = socket.data.charId;
    if (id && characters[id]) {
      const name = characters[id].name;
      delete characters[id];
      io.emit('char-left', { id });
      const sysMsg = { who: '系統', text: `${name} 離開了場景`, isSystem: true, ts: Date.now() };
      pushChat(sysMsg);
      io.emit('chat-message', sysMsg);
      broadcastCount();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ 伺服器已啟動： http://localhost:${PORT}`);
});
