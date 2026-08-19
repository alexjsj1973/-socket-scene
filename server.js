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
// 場景底圖照片：每個房間固定使用一張指定的圖片（檔名在下面的
// ROOMS_CONFIG 裡設定），不再像之前那樣每次 join 隨機從 bg/ 資料夾裡
// 挑一張。圖片一樣是放在 ASP 主機的 bg/ 資料夾（用 FTP 或空間商的檔案
// 總管上傳即可），這裡只是組出完整網址。
//
// 注意：bg_list.asp 現在只有前端「場景調整 → 場景底圖」選單在用（讓玩家
// 自己手動瀏覽 bg/ 資料夾裡所有圖片、換成自己想要的），跟這裡「房間固定
// 底圖」是兩件獨立的事，互不影響。
// ---------------------------------------------------------------
const BG_FOLDER_URL = 'https://www.swimlife.tw/alex/game/online/bg/';

// 取得某個房間固定底圖的完整網址；房間沒設定 background 就回傳 null
// （前端看到 null 會顯示預設的漸層天空+草地底圖）。
function getRoomBackgroundUrl(room) {
  if (!room || !room.background) return null;
  // 加上 ?v=時間戳 做 cache-busting，避免玩家瀏覽器快取到舊圖片
  return `${BG_FOLDER_URL}${room.background}?v=${Date.now()}`;
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
        : 60
    };
  } catch (e) {
    // 檔案不存在（第一次啟動）或內容壞掉，都視為「還沒有人設定過」，用預設值
    return { brightness: 60 };
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
// 房間設定：每個房間有自己的場景（角色、聊天紀錄），玩家在某個房間
// 只看得到、聊得到同房間的人，跟其他房間的人是分開的。
//
// portals：這個房間裡有哪些「傳送點」，每個傳送點是一張放在場景上的
// 圖片道具，x/y 是在場景裡的位置（百分比，0~100，跟角色座標系統一樣），
// to 是點下去要去的房間 id，label 是顯示給玩家看的文字（要去哪裡）。
//
// background：這個房間固定使用哪一張底圖，填 bg/ 資料夾裡的檔名就好
// （程式會自動接上 BG_FOLDER_URL），不用整段網址。沒有填的話前端會顯示
// 預設的漸層天空+草地底圖。
//
// 要新增房間或傳送點，直接在下面加一筆就好；不需要動到其他程式邏輯。
// 記得幫新房間也設定「回程」的傳送點，不然玩家進去後就出不來了。
// ---------------------------------------------------------------
const ROOMS_CONFIG = {
  main: {
    id: 'main',
    name: '大廳',
    background: 'bg1.jpg',
    portals: [
      { to: 'annex1', x: 5, y: 90, label: '活動報名' },
      { to: 'annex2', x: 15, y: 90, label: '課程教學' }
    ]
  },
  annex1: {
    id: 'annex1',
    name: '活動報名',
    background: 'bg2.jpg',
    portals: [
      { to: 'main', x: 10, y: 78, label: '大廳' }
    ]
  },
  annex2: {
    id: 'annex2',
    name: '課程教學',
    background: 'bg3.jpg',
    portals: [
      { to: 'main', x: 10, y: 78, label: '大廳' }
    ]
  }
};
const DEFAULT_ROOM_ID = 'main';

// 每個房間各自的即時狀態：角色清單、聊天紀錄。重啟伺服器會清空
// （如需持久化可換成資料庫）。
const rooms = Object.create(null);
Object.keys(ROOMS_CONFIG).forEach((roomId) => {
  const cfg = ROOMS_CONFIG[roomId];
  rooms[roomId] = {
    id: cfg.id,
    name: cfg.name,
    background: cfg.background || null,
    portals: cfg.portals || [],
    characters: Object.create(null), // id -> {id,name,hair,body,x,y,ownerSocketId}
    chatLog: []                      // {who, charId, text, isSystem, ts}
  };
});

function getRoom(roomId) {
  return rooms[roomId] || null;
}



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

// ---------------------------------------------------------------
// 活動分類傳送點：跟 verify_token.asp 一樣，向 ASP 那邊的
// event_api.asp 做 server-to-server 查詢，取得：
//   1. 大廳要顯示哪些活動分類傳送點（event_sort 表）
//   2. 進入某個活動分類房間時，該分類目前上架中的活動連結（event 表）
//
// EVENT_API_URL / EVENT_API_KEY 請改成實際部署位置，且 KEY 要跟
// event_api.asp 裡設定的 API_KEY 完全一致，兩邊都建議改成環境變數。
// ---------------------------------------------------------------
const EVENT_API_URL = process.env.EVENT_API_URL || 'https://www.swimlife.tw/alex/game/online/event_api.asp';
const EVENT_API_KEY = process.env.EVENT_API_KEY || 'a1b2c3d4e5';

function fetchEventApiJson(query) {
  return new Promise((resolve) => {
    const url = `${EVENT_API_URL}?${query}&key=${encodeURIComponent(EVENT_API_KEY)}`;
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ ok: false, error: 'event_api.asp 回傳格式錯誤' });
        }
      });
    }).on('error', (err) => {
      resolve({ ok: false, error: '無法連線到 event_api.asp：' + err.message });
    });
  });
}

// 分類清單（哪些傳送點要顯示在大廳）不常變動，快取久一點；
// 每個分類底下的活動清單（上架連結）變動較頻繁，快取短一點，
// 但也不用每次有人進房間就重打一次 ASP。
const SORTS_CACHE_MS = 5 * 60 * 1000;   // 5 分鐘
const EVENTS_CACHE_MS = 60 * 1000;      // 1 分鐘

let sortsCache = { data: null, expiresAt: 0 };
const eventsCache = new Map(); // sortNo -> { data, expiresAt }

async function fetchEventSorts() {
  if (sortsCache.data && sortsCache.expiresAt > Date.now()) return sortsCache.data;
  const result = await fetchEventApiJson('action=sorts');
  if (result.ok && Array.isArray(result.sorts)) {
    sortsCache = { data: result.sorts, expiresAt: Date.now() + SORTS_CACHE_MS };
    return result.sorts;
  }
  console.error('❌ 取得活動分類清單失敗：', result.error || result);
  // 拿舊快取撐著（就算過期），總比整個大廳沒有傳送點好
  return sortsCache.data || [];
}

async function fetchEventsForSort(sortNo) {
  const cached = eventsCache.get(sortNo);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const result = await fetchEventApiJson(`action=events&sort=${encodeURIComponent(sortNo)}`);
  if (result.ok && Array.isArray(result.events)) {
    eventsCache.set(sortNo, { data: result.events, expiresAt: Date.now() + EVENTS_CACHE_MS });
    return result.events;
  }
  console.error(`❌ 取得分類 ${sortNo} 的上架活動失敗：`, result.error || result);
  return (cached && cached.data) || [];
}

// 傳送點在場景上的位置：固定放在左下角，由左到右排列。
// x 從 5% 開始，每個間隔 9%（8 個分類剛好排到約 68%，不會擠到畫面右側）；
// y 固定 90%（貼近底部），跟原本 annex1/annex2 的傳送點同一條基準線。
function computeEventPortalPosition(index) {
  return { x: 5 + index * 9, y: 90 };
}

// 每個傳送點的圖片要用不同顏色：用 CSS hue-rotate 角度區分，
// 8 個分類平均分散在色環上（360/8=45 度一格），不需要另外準備 8 張圖片。
function computeEventPortalHue(index) {
  return (index * 45) % 360;
}

// 把 event_sort 清單轉成大廳(main)房間要用的傳送點陣列，
// 同時確保每個分類都有一個對應的 Socket.io 房間可以傳送過去
// （房間不存在就建立一個，portals 裡固定放一個「回大廳」的傳送點）。
function ensureEventRoomsAndPortals(sorts) {
  const portals = [];
  sorts.forEach((sort, index) => {
    const roomId = `event_${sort.no}`;
    const pos = computeEventPortalPosition(index);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        id: roomId,
        name: sort.name,
        background: null, // 沒有另外指定底圖，前端會顯示預設漸層底圖
        portals: [
          // 位置跟大廳最左下角那個傳送點（第一個分類，index 0）一致，
          // 這樣「回大廳」的傳送點視覺上跟玩家記憶中的位置對得起來。
          { to: DEFAULT_ROOM_ID, x: computeEventPortalPosition(0).x, y: computeEventPortalPosition(0).y, label: '大廳' }
        ],
        characters: Object.create(null),
        chatLog: [],
        isEventRoom: true,
        sortNo: sort.no
      };
    } else {
      // 分類名稱可能之後在後台改過，房間名稱跟著更新
      rooms[roomId].name = sort.name;
      rooms[roomId].sortNo = sort.no;
    }

    portals.push({
      to: roomId,
      x: pos.x,
      y: pos.y,
      label: sort.name,
      hue: computeEventPortalHue(index)
    });
  });
  return portals;
}

// 啟動時先抓一次，之後背景定期刷新（分類新增/改名不用重新部署就會生效）。
// 大廳原本設定裡的 annex1/annex2 傳送點是舊的示範資料，這裡直接把它們
// 換掉，改成完全由資料庫 event_sort 表驅動；如果還想保留 annex1/annex2，
// 把下面這行的 `= eventPortals` 改成 `.push(...eventPortals)` 即可。
async function refreshEventPortals() {
  const sorts = await fetchEventSorts();
  if (!sorts || sorts.length === 0) return;
  const eventPortals = ensureEventRoomsAndPortals(sorts);
  const mainRoom = getRoom(DEFAULT_ROOM_ID);
  if (mainRoom) {
    mainRoom.portals = eventPortals;
  }
}

const EVENT_PORTALS_REFRESH_MS = 5 * 60 * 1000; // 5 分鐘重新整理一次
refreshEventPortals();
setInterval(refreshEventPortals, EVENT_PORTALS_REFRESH_MS);

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
  Object.keys(rooms).forEach((roomId) => { rooms[roomId].chatLog.length = 0; });
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
// 角色跟聊天紀錄已經改成「每個房間各自一份」，存在上面的 rooms 物件裡；
// 這裡只留跨房間共用的東西（角色外觀色票、角色編號流水號）。
// ---------------------------------------------------------------
const MAX_CHAT = 200;

const HAIR_COLORS = ["#3b2a20", "#8a5a34", "#c99a4a", "#d94f4f", "#5c7a5e", "#4a5b8a"];
const BODY_COLORS = ["#b5623f", "#e8b559", "#5c7a5e", "#4a5b8a", "#8a5a8a", "#3b2a20"];

let charCounter = 0;

function pushChat(room, entry) {
  room.chatLog.push(entry);
  if (room.chatLog.length > MAX_CHAT) room.chatLog.shift();
}

function broadcastCount(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  io.to(roomId).emit('online-count', Object.keys(room.characters).length);
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

    // 一律從預設房間（大廳）開始，不管上次斷線前傳送到哪個房間，
    // 重新連線後都從大廳重新出發，行為單純、不容易出錯。
    const roomId = DEFAULT_ROOM_ID;
    const room = getRoom(roomId);
    room.characters[id] = c;
    socket.data.charId = id;
    socket.data.roomId = roomId;
    socket.join(roomId);

    // 場景底圖：這個房間固定用哪張圖，在 ROOMS_CONFIG 裡設定好了，
    // 這裡直接組出網址即可，不用再隨機挑。
    const background = getRoomBackgroundUrl(room);

    // 「記錄 event_sort_no」：把目前所在活動分類記在這條連線自己的
    // socket.data 上（等同這個玩家這次連線的 session），非活動房間
    // （例如大廳）就是 null。之後這條連線不管做什麼動作，都可以透過
    // socket.data.eventSortNo 知道「他現在是在哪個活動分類房間裡」。
    socket.data.eventSortNo = room.sortNo || null;

    // 只回給這位新玩家：完整現況快照（含目前房間的傳送點清單）
    // 如果是活動分類房間，額外附上這個分類目前上架中的活動連結清單
    const eventLinks = room.isEventRoom ? await fetchEventsForSort(room.sortNo) : null;

    socket.emit('init', {
      selfId: id,
      roomId: room.id,
      roomName: room.name,
      portals: room.portals,
      characters: Object.values(room.characters),
      chatLog: room.chatLog,
      background,
      brightness: currentBrightness,
      eventLinks
    });

    // 廣播給同房間的其他人：有新角色加入
    socket.to(roomId).emit('char-joined', c);

    const sysMsg = { who: '系統', text: `${name} 加入了場景`, isSystem: true, ts: Date.now() };
    pushChat(room, sysMsg);
    io.to(roomId).emit('chat-message', sysMsg);
    broadcastCount(roomId);
  });

  // ---- 移動：只能移動自己的角色 ----
  socket.on('move', (data) => {
    const roomId = socket.data.roomId;
    const id = socket.data.charId;
    const room = getRoom(roomId);
    if (!room || !id || !room.characters[id] || !data) return;
    const x = clampX(data.x);
    const y = clampY(data.y);
    room.characters[id].x = x;
    room.characters[id].y = y;
    io.to(roomId).emit('char-moved', { id, x, y });
  });

  // ---- 捏一捏：換髮色/衣服色，只能改自己的 ----
  socket.on('customize', (data) => {
    const roomId = socket.data.roomId;
    const id = socket.data.charId;
    const room = getRoom(roomId);
    if (!room || !id || !room.characters[id] || !data) return;
    if (HAIR_COLORS.includes(data.hair)) room.characters[id].hair = data.hair;
    if (BODY_COLORS.includes(data.body)) room.characters[id].body = data.body;
    io.to(roomId).emit('char-customized', { id, hair: room.characters[id].hair, body: room.characters[id].body });
  });

  // ---- 改名：只能改自己的 ----
  socket.on('rename', (data) => {
    const roomId = socket.data.roomId;
    const id = socket.data.charId;
    const room = getRoom(roomId);
    if (!room || !id || !room.characters[id]) return;
    const name = (data && String(data.name || '').trim().slice(0, 16)) || room.characters[id].name;
    room.characters[id].name = name;
    io.to(roomId).emit('char-renamed', { id, name });
  });

  // ---- 聊天 ----
  socket.on('chat', (data) => {
    const roomId = socket.data.roomId;
    const id = socket.data.charId;
    const room = getRoom(roomId);
    if (!room || !id || !room.characters[id]) return;
    const text = (data && String(data.text || '').trim().slice(0, 100)) || '';
    if (!text) return;
    const msg = { who: room.characters[id].name, charId: id, text, isSystem: false, ts: Date.now() };
    pushChat(room, msg);
    io.to(roomId).emit('chat-message', msg);
    io.to(roomId).emit('char-bubble', { id, text });
  });

  // ---- 傳送到另一個房間：點了場景裡的傳送點道具才會觸發 ----
  socket.on('teleport', async (data) => {
    const fromRoomId = socket.data.roomId;
    const id = socket.data.charId;
    const fromRoom = getRoom(fromRoomId);
    if (!fromRoom || !id || !fromRoom.characters[id]) return;

    const toRoomId = data && data.to;
    const toRoom = getRoom(toRoomId);
    if (!toRoom) {
      socket.emit('teleport-error', { error: '目的地房間不存在' });
      return;
    }

    // 一定要現在這個房間裡真的有一個通往目的地的傳送點才放行，避免有人
    // 繞過前端直接送 teleport 事件亂跳房間。
    const portal = (fromRoom.portals || []).find(p => p.to === toRoomId);
    if (!portal) {
      socket.emit('teleport-error', { error: '這個房間沒有通往那裡的傳送點' });
      return;
    }

    // 離開原本的房間：從角色清單移除、離開 socket.io room、廣播給原房間的人
    const c = fromRoom.characters[id];
    delete fromRoom.characters[id];
    socket.leave(fromRoomId);
    io.to(fromRoomId).emit('char-left', { id });
    const leftMsg = { who: '系統', text: `${c.name} 傳送離開了場景`, isSystem: true, ts: Date.now() };
    pushChat(fromRoom, leftMsg);
    io.to(fromRoomId).emit('chat-message', leftMsg);
    broadcastCount(fromRoomId);

    // 進入新房間：如果新房間裡剛好有一個「通往原本房間」的傳送點，就從那個
    // 傳送點的位置重生（比較合理，像是從門走出來），沒有的話就隨機給個位置。
    const spawnPortal = (toRoom.portals || []).find(p => p.to === fromRoomId);
    c.x = clampX(spawnPortal ? spawnPortal.x : 20 + Math.random() * 60);
    c.y = clampY(spawnPortal ? spawnPortal.y : 30 + Math.random() * 50);

    toRoom.characters[id] = c;
    socket.join(toRoomId);
    socket.data.roomId = toRoomId;

    // 更新這條連線的「目前活動分類」記錄（見 join 事件裡的說明）
    socket.data.eventSortNo = toRoom.sortNo || null;

    // 新房間的場景底圖固定用它自己設定的那張，跟 join 邏輯一致
    const background = getRoomBackgroundUrl(toRoom);

    // 傳送到活動分類房間時，順便帶上該分類目前上架中的活動連結清單
    const eventLinks = toRoom.isEventRoom ? await fetchEventsForSort(toRoom.sortNo) : null;

    // 只回給這位玩家：新房間的完整現況快照
    socket.emit('room-changed', {
      selfId: id,
      roomId: toRoom.id,
      roomName: toRoom.name,
      portals: toRoom.portals,
      characters: Object.values(toRoom.characters),
      chatLog: toRoom.chatLog,
      background,
      brightness: currentBrightness,
      eventLinks
    });

    // 廣播給新房間的其他人：有角色傳送進來了
    socket.to(toRoomId).emit('char-joined', c);
    const joinMsg = { who: '系統', text: `${c.name} 傳送進入了場景`, isSystem: true, ts: Date.now() };
    pushChat(toRoom, joinMsg);
    io.to(toRoomId).emit('chat-message', joinMsg);
    broadcastCount(toRoomId);
  });

  // ---- 離線：把角色從場景移除，通知大家 ----
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const id = socket.data.charId;
    const room = getRoom(roomId);
    if (room && id && room.characters[id]) {
      const name = room.characters[id].name;
      delete room.characters[id];
      io.to(roomId).emit('char-left', { id });
      const sysMsg = { who: '系統', text: `${name} 離開了場景`, isSystem: true, ts: Date.now() };
      pushChat(room, sysMsg);
      io.to(roomId).emit('chat-message', sysMsg);
      broadcastCount(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ 伺服器已啟動： http://localhost:${PORT}`);
});
