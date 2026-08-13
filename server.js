// server.js — Socket.io 多人即時後端
// 每個連進來的瀏覽器分頁 = 一位玩家 = 一個場景中的角色。
// 伺服器保存「唯一的真相版本」(characters / chatLog)，
// 所有動作（移動、換裝、改名、聊天）都先送到伺服器，
// 伺服器驗證後再廣播給所有人，確保每個人畫面一致。

const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// ---------------------------------------------------------------
// 場景底圖照片：不再由管理員上傳單一固定的圖片，改成直接把想要輪流
// 顯示的圖片放進 ASP 主機上的 bg/ 資料夾（用 FTP 或空間商的檔案總管
// 上傳即可），玩家「登入、加入場景」的當下由這裡的 Node 後端隨機挑一張
// 給他。bg_list.asp 負責列出資料夾裡目前有哪些圖片，這裡把清單快取
// 一段時間，避免每個玩家 join 都重打一次 ASP。
// ---------------------------------------------------------------
const BG_FOLDER_URL = 'https://www.swimlife.tw/alex/game/online/bg/';
const BG_LIST_URL = process.env.BG_LIST_URL || 'https://www.swimlife.tw/alex/game/online/bg_list.asp';
const BG_LIST_REFRESH_MS = 5 * 60 * 1000; // 5 分鐘重新跟 ASP 要一次最新清單

let bgFileList = [];      // 快取的圖片檔名清單，例如 ['bg1.jpg','bg2.jpg']
let bgListFetchedAt = 0;

// 跟 bg_list.asp 要一次 bg/ 資料夾裡的檔名清單。失敗或格式不對就回傳空陣列，
// 呼叫端會退回使用預設漸層底圖，不會讓整個 join 流程掛掉。
function fetchBgList() {
  return new Promise((resolve) => {
    https.get(BG_LIST_URL, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data && data.ok && Array.isArray(data.files)) {
            resolve(data.files.filter(name => typeof name === 'string' && name.length > 0));
            return;
          }
        } catch (e) {
          // 格式不對，往下走回傳空陣列
        }
        resolve([]);
      });
    }).on('error', () => resolve([]));
  });
}

// 取得一個隨機的場景底圖網址；資料夾抓不到清單或是空的，就回傳 null
// （前端看到 null 會顯示預設的漸層天空+草地底圖）。
async function getRandomBackgroundUrl() {
  const now = Date.now();
  if (bgFileList.length === 0 || now - bgListFetchedAt > BG_LIST_REFRESH_MS) {
    const files = await fetchBgList();
    if (files.length > 0) {
      bgFileList = files;
      bgListFetchedAt = now;
    }
  }
  if (bgFileList.length === 0) return null;
  const picked = bgFileList[Math.floor(Math.random() * bgFileList.length)];
  // 加上 ?v=時間戳 做 cache-busting，避免玩家瀏覽器快取到舊圖片
  return `${BG_FOLDER_URL}${picked}?v=${Date.now()}`;
}

// ---------------------------------------------------------------
// 亮度狀態持久化：把「目前的亮度」寫進一個小 JSON 檔，這樣伺服器重啟
// （例如 Render 免費方案閒置一段時間被休眠、之後重新啟動）不會讓亮度
// 自動變回預設，只有管理員自己調整才會改變。
// ---------------------------------------------------------------
const STATE_DIR = path.join(__dirname, 'data');
fs.mkdirSync(STATE_DIR, { recursive: true });
const BACKGROUND_STATE_FILE = path.join(STATE_DIR, 'background-state.json');

function loadBackgroundState() {
  try {
    const raw = fs.readFileSync(BACKGROUND_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      // 亮度用百分比表示，100 = 原始亮度，數字愈小愈暗、愈大愈亮
      brightness: (parsed && typeof parsed.brightness === 'number' && isFinite(parsed.brightness))
        ? parsed.brightness
        : 100
    };
  } catch (e) {
    // 檔案不存在（第一次啟動）或內容壞掉，都視為「還沒有人設定過」，用預設值
    return { brightness: 100 };
  }
}

// 讀目前的全域亮度（currentBrightness）寫進狀態檔，呼叫時不用傳參數，
// 直接以當下的全域變數為準。
function saveBackgroundState() {
  try {
    fs.writeFileSync(
      BACKGROUND_STATE_FILE,
      JSON.stringify({ brightness: currentBrightness, updatedAt: Date.now() }),
      'utf8'
    );
  } catch (e) {
    console.error('❌ 寫入亮度狀態檔失敗，重啟後可能會變回預設值：', e.message);
  }
}

// 目前場景底圖亮度（百分比，100 為原始亮度）。
// 啟動時先從狀態檔讀回上次管理員設定的值，而不是每次都從預設值開始。
const initialBackgroundState = loadBackgroundState();
let currentBrightness = initialBackgroundState.brightness;


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
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'alex6227';

// ---------------------------------------------------------------
// 登入 Token 驗證：向 ASP 那邊的 verify_token.asp 做 server-to-server 驗證。
// VERIFY_TOKEN_URL 請改成實際部署位置；VERIFY_API_KEY 要跟 verify_token.asp
// 裡設定的 API_KEY 完全一致，兩邊都建議改成從環境變數讀取，不要留在程式碼裡。
// ---------------------------------------------------------------
const VERIFY_TOKEN_URL = process.env.VERIFY_TOKEN_URL || 'https://www.swimlife.tw/alex/game/online/verify_token.asp';
const VERIFY_API_KEY = process.env.VERIFY_API_KEY || 'a1b2c3d4e5';

// verify_token.asp 驗證成功後會把 token 標記為「已使用」，所以同一個 token
// 不能打第二次。這裡把驗證結果快取一段時間，讓 Socket.io 斷線重連（同一個
// token 會再送一次 join）不用重新打一次 ASP，也不會因為 used=1 被擋下來。
const verifiedTokenCache = new Map(); // token -> { result, expiresAt }
const TOKEN_CACHE_MS = 10 * 60 * 1000; // 10 分鐘，跟 login_token 的 5 分鐘到期時間分開設計，可自行調整

function verifyLoginToken(token) {
  return new Promise((resolve) => {
    if (!token) return resolve({ ok: false, error: 'missing token' });

    const cached = verifiedTokenCache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      return resolve(cached.result);
    }

    const url = `${VERIFY_TOKEN_URL}?t=${encodeURIComponent(token)}&key=${encodeURIComponent(VERIFY_API_KEY)}`;
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let result;
        try {
          result = JSON.parse(body);
        } catch (e) {
          result = { ok: false, error: 'verify_token.asp 回傳格式錯誤' };
        }
        if (result.ok) {
          verifiedTokenCache.set(token, { result, expiresAt: Date.now() + TOKEN_CACHE_MS });
        }
        resolve(result);
      });
    }).on('error', (err) => {
      resolve({ ok: false, error: '無法連線到 verify_token.asp：' + err.message });
    });
  });
}

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
// 調整場景底圖亮度的管理 API：body 帶一個 brightness 數值（百分比，
// 例如 60 代表調暗到只剩 60% 亮度，150 代表調亮到 150%）。不管目前是
// 自訂上傳的底圖還是預設的漸層底圖，都可以套用，並廣播給所有連線中
// 的玩家立即套用；同時寫進狀態檔，伺服器重啟也不會跳回 100%。
// ---------------------------------------------------------------
const BRIGHTNESS_MIN = 20;
const BRIGHTNESS_MAX = 180;

app.options('/admin/set-brightness', (req, res) => {
  setCorsForAdmin(res);
  res.sendStatus(204);
});

app.post('/admin/set-brightness', (req, res) => {
  setCorsForAdmin(res);
  const secret = req.headers['x-admin-secret'] || (req.body && req.body.secret);
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(403).json({ ok: false, error: '密碼錯誤' });
  }
  const brightness = Number(req.body && req.body.brightness);
  if (!Number.isFinite(brightness) || brightness < BRIGHTNESS_MIN || brightness > BRIGHTNESS_MAX) {
    return res.status(400).json({ ok: false, error: `亮度數值必須介於 ${BRIGHTNESS_MIN} 到 ${BRIGHTNESS_MAX} 之間` });
  }
  currentBrightness = brightness;
  saveBackgroundState();
  // 每個玩家的場景底圖是登入當下各自隨機挑的，這裡只廣播亮度變化，
  // 不會動到大家目前各自顯示的底圖。
  io.emit('brightness-changed', { brightness: currentBrightness });
  return res.json({ ok: true, brightness: currentBrightness });
});

// 給後臺管理頁面用：讀取目前的亮度，不需要密碼（純讀取、內容跟所有
// 玩家畫面上套用的是同一份），方便管理頁一開啟就能把滑桿定位到正確
// 的目前值，而不是每次都從 100% 開始。
app.get('/admin/background-status', (req, res) => {
  setCorsForAdmin(res);
  res.json({ ok: true, brightness: currentBrightness });
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
  // ---- 玩家剛連上時，前端先用網址帶的 token 問一次「這個人是誰」，
  // 讓畫面可以把會員暱稱直接帶進名字欄位（欄位鎖定，不開放手動輸入）----
  socket.on('check-token', async (data) => {
    const verify = await verifyLoginToken(data && data.token);
    if (verify.ok) {
      socket.emit('token-checked', { ok: true, displayName: verify.displayName });
    } else {
      socket.emit('token-checked', { ok: false, error: verify.error || '登入已過期，請重新登入' });
    }
  });

  // ---- 玩家送出外觀，加入場景 ----
  socket.on('join', async (data) => {
    // 每個 socket 只能建立一個角色；避免重複 join 造成殭屍角色
    if (socket.data.charId) return;

    // 先驗證登入 token，沒通過就不建立角色，也不讓玩家連進場景
    const verify = await verifyLoginToken(data && data.token);
    if (!verify.ok) {
      socket.emit('join-error', { error: verify.error || '登入已過期，請重新登入' });
      return;
    }
    // 這個 join 事件是 async 觸發的，理論上一個 socket 短時間內可能被觸發兩次
    // join；驗證完再檢查一次，避免競爭狀態下建立出兩個角色
    if (socket.data.charId) return;

    // 名字一律採用 verify_token.asp 驗證回來的會員暱稱，不採信前端送來的 data.name，
    // 這樣就算有人繞過前端把欄位改掉（例如改 DOM），伺服器還是只認會員本人的暱稱
    const name = (verify.displayName && String(verify.displayName).trim().slice(0, 16)) || '無名旅人';
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

    // 場景底圖：登入這一刻才從 bg/ 資料夾的清單裡隨機挑一張給這位玩家，
    // 抓不到清單或資料夾是空的就回傳 null（前端會顯示預設漸層底圖）。
    const background = await getRandomBackgroundUrl();

    // 只回給這位新玩家：完整現況快照
    socket.emit('init', {
      selfId: id,
      characters: Object.values(characters),
      chatLog,
      background,
      brightness: currentBrightness
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
    const text = (data && String(data.text || '').trim().slice(0, 100)) || '';
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
