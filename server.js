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
// 場景底圖照片：每個房間可以在後台指定固定使用哪一張圖片（存在下面
// ROOMS_CONFIG 或 background-state.json 裡的 background 欄位）；沒有
// 指定的房間，預設改成從 bg/ 資料夾裡隨機挑一張「檔名開頭為 bg、副檔名
// 為 .jpg」的圖片（每次玩家 join / 傳送到該房間都會重新抽一次）。
// 圖片一樣是放在 ASP 主機的 bg/ 資料夾（用 FTP 或空間商的檔案總管上傳
// 即可），這裡只是組出完整網址。
// ---------------------------------------------------------------
const BG_FOLDER_URL = 'https://www.swimlife.tw/alex/game/online/bg/';

// bg_list.asp：回傳 bg/ 資料夾裡目前有哪些圖檔（見 bg_list.asp 本身的說明），
// 這裡用來實作「房間沒有指定底圖時，預設從 bg/ 隨機挑一張開頭為 bg 的 jpg
// 圖片」。清單短時間內快取一下，避免每次有人 join / 傳送就打一次 ASP。
const BG_LIST_URL = 'https://www.swimlife.tw/alex/game/online/bg_list.asp';
const BG_LIST_CACHE_MS = 60 * 1000; // 1 分鐘，admin 上傳新圖後最多等這麼久才會被抽到
let bgListCache = { files: null, expiresAt: 0 };

function fetchBgFileList() {
  return new Promise((resolve) => {
    if (bgListCache.files && bgListCache.expiresAt > Date.now()) {
      return resolve(bgListCache.files);
    }
    https.get(BG_LIST_URL, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let files = [];
        try {
          const parsed = JSON.parse(body);
          if (parsed && parsed.ok && Array.isArray(parsed.files)) files = parsed.files;
        } catch (e) {
          // bg_list.asp 掛掉或回傳格式錯誤，就當作沒有清單，維持空陣列
        }
        bgListCache = { files, expiresAt: Date.now() + BG_LIST_CACHE_MS };
        resolve(files);
      });
    }).on('error', () => {
      // 連不到 bg_list.asp：不快取失敗結果，讓下一次呼叫可以重試
      resolve(bgListCache.files || []);
    });
  });
}

// 從 bg/ 資料夾的清單裡，篩出「檔名開頭是指定 prefix、副檔名是 .jpg」的
// 圖片，隨機挑一張回傳檔名；沒有符合的圖片就回傳 null（前端會顯示預設
// 漸層底圖）。prefix 預設為 'bg'。
async function pickRandomDefaultBg(prefix) {
  const p = prefix || 'bg';
  const files = await fetchBgFileList();
  const re = new RegExp('^' + p, 'i');
  const candidates = files.filter((name) => re.test(name) && /\.jpg$/i.test(name));
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// 房間沒有指定固定底圖時，預設要從 bg/ 隨機挑「哪個字首開頭」的圖：
// 「菁英計畫」這個分類房間用 sp 開頭，其他所有房間一律用 bg 開頭。
// 用房間名稱判斷，之後如果分類名稱在後台改了，這裡也要跟著改。
function defaultBgPrefixForRoom(room) {
  if (room && room.name === '菁英計畫') return 'sp';
  return 'bg';
}

// 取得某個房間目前該用哪張底圖的完整網址：
// - 集會廣場（main）固定用 room1.jpg（見 ROOMS_CONFIG）
// - 房間有指定 background（管理員在後台選過）→ 用那張
// - 沒指定 → 從 bg/ 資料夾裡隨機挑一張當預設底圖，字首依
//   defaultBgPrefixForRoom 決定（菁英計畫用 sp，其他房間用 bg）；
//   如果連一張符合的圖都找不到，才退回 null（前端顯示預設漸層底圖）
async function getRoomBackgroundUrl(room) {
  if (!room) return null;
  let filename = room.background;
  if (!filename && Array.isArray(room.backgroundPool) && room.backgroundPool.length) {
    // 房間指定了隨機底圖的候選清單（例如線上競賽只用 bg1～bg4）
    filename = room.backgroundPool[Math.floor(Math.random() * room.backgroundPool.length)];
  }
  if (!filename) {
    filename = await pickRandomDefaultBg(defaultBgPrefixForRoom(room));
    if (!filename) return null;
  }
  // 加上 ?v=時間戳 做 cache-busting，避免玩家瀏覽器快取到舊圖片
  return `${BG_FOLDER_URL}${filename}?v=${Date.now()}`;
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
        : 60,
      // 每個房間管理員自己選過的底圖檔名（roomId -> 檔名），沒被選過的房間
      // 不會出現在這裡，會繼續用 ROOMS_CONFIG 裡寫的預設值。
      roomBackgrounds: (parsed && parsed.roomBackgrounds && typeof parsed.roomBackgrounds === 'object')
        ? parsed.roomBackgrounds
        : {}
    };
  } catch (e) {
    // 檔案不存在（第一次啟動）或內容壞掉，都視為「還沒有人設定過」，用預設值
    return { brightness: 60, roomBackgrounds: {} };
  }
}

// 把目前的全域亮度（currentBrightness）跟每個房間目前的底圖檔名一起寫進
// 狀態檔，呼叫時不用傳參數，直接以當下的全域變數 / rooms 物件為準。
function saveBackgroundState() {
  try {
    const roomBackgrounds = {};
    Object.keys(rooms).forEach((roomId) => {
      roomBackgrounds[roomId] = rooms[roomId].background || null;
    });
    fs.writeFileSync(
      BACKGROUND_STATE_FILE,
      JSON.stringify({ brightness: currentBrightness, roomBackgrounds, updatedAt: Date.now() }),
      'utf8'
    );
  } catch (e) {
    console.error('❌ 寫入場景狀態檔失敗，重啟後可能會變回預設值：', e.message);
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
// （程式會自動接上 BG_FOLDER_URL），不用整段網址。沒有填（或留 null）的話，
// 改成從 bg/ 資料夾隨機挑一張「檔名開頭為 bg、副檔名為 .jpg」的圖片當底圖
// （每次玩家 join / 傳送到這個房間都會重新抽一次，不是固定同一張）；
// 如果 bg/ 裡連一張符合的圖都沒有，才會顯示前端預設的漸層天空+草地底圖。
//
// 要新增房間或傳送點，直接在下面加一筆就好；不需要動到其他程式邏輯。
// 記得幫新房間也設定「回程」的傳送點，不然玩家進去後就出不來了。
// ---------------------------------------------------------------
// 所有平面房間的「回程」傳送點統一放在同一個位置（右側偏下）。
// 原本放在 (92, 86)，傳送門的名稱標籤剛好被右下角的「場景縮放」控制列蓋住，
// 點不到、也看不到；往上移到 78，標籤就會在控制列上方。要調整位置改這裡就好。
const RETURN_PORTAL_POS = { x: 92, y: 78 };

const ROOMS_CONFIG = {
  main: {
    id: 'main',
    name: '集會廣場',
    // 大廳底圖：room1 系列（room1-001.jpg ~ room1-007.jpg，同一個廣場的 7 種主題）。
    // 2.5D 佈局共用 SCENE_LAYOUTS.room1；每位玩家登入時由前端隨機挑一個主題，
    // 也可以從場景右上角切換（只影響自己看到的畫面，大家仍在同一個廣場）。
    background: 'room1-001.jpg',
    // 四周建築就是傳送點：只有「中文名稱招牌內與附近」可以點（滑鼠變成手指），點了角色走到入口自動進入。
    //   可點範圍優先用目前主題的招牌框（SCENE_LAYOUTS.room1.skins[].signs，每個主題招牌位置略有不同）；
    //   zone = 備用的可點範圍（7 個主題招牌框的聯集再往外留一點），主題沒有 signs 時才用。
    //   點地面（滑鼠是十字）只會走路，就算走到入口旁邊也不會進入。
    // sign = 招牌在底圖上的大約中心位置（7 種主題平均）
    // x/y = 「招牌前」的入口：可走範圍內離招牌最近的地方，點了招牌後角色走到這裡才進入
    //       （前端判定抵達，伺服器 teleport 再檢查距離 8 以內）
    // spawn = 從該建築回到廣場時出現的位置，離入口約 6 以上，回來時不會被立刻再傳進去
    // 調整位置時：遊戲網址加 &scene_debug=1，點畫面看百分比座標
    portals: [
      { to: 'b_sport', label: '運動人生', sign: [13.3, 25.8], x: 24.5, y: 34.8, spawn: [29.6, 38.8], zone: [[5.5, 17.5], [22, 17.5], [22, 31.5], [5.5, 31.5]] },
      { to: 'b_assoc', label: '協辦與自辦', sign: [29.5, 14.5], x: 31, y: 30.2, spawn: [34.9, 35.3], zone: [[21, 8], [37, 8], [37, 21], [21, 21]] },
      { to: 'b_hq', label: '泳渡人生總部', sign: [50, 11.5], x: 50, y: 30.5, spawn: [50.0, 37.0], zone: [[42.5, 5.5], [58, 5.5], [58, 17], [42.5, 17]] },
      { to: 'annex1', label: '活動報名', sign: [69.5, 15.5], x: 68.6, y: 30.2, spawn: [64.7, 35.4], zone: [[61.5, 9], [78, 9], [78, 21.5], [61.5, 21.5]] },
      { to: 'b_pool', label: '團練泳池', sign: [87.5, 25], x: 74.9, y: 34, spawn: [69.9, 38.2], zone: [[79.5, 18.5], [95.5, 18.5], [95.5, 31.5], [79.5, 31.5]] },
      { to: 'b_shop', label: '購物商城', sign: [11.5, 46], x: 20.8, y: 47, spawn: [27, 48.5], zone: [[4.5, 37], [19.5, 37], [19.5, 53.5], [4.5, 53.5]] },
      { to: 'b_member', label: '會員專區', sign: [89, 47.8], x: 78.8, y: 48, spawn: [72.5, 49.5], zone: [[82.5, 41], [98, 41], [98, 53.5], [82.5, 53.5]] },
      { to: 'b_match', label: '專業媒合', sign: [11.5, 73], x: 20.5, y: 66.3, spawn: [26.8, 63.7], zone: [[3.5, 61.5], [20.5, 61.5], [20.5, 81.5], [3.5, 81.5]] },
      // 新聞資訊的招牌在建築右側，入口放在招牌右邊的南側步道邊（原本在建築上方的廣場邊緣，離招牌太遠）
      { to: 'b_news', label: '新聞資訊', sign: [36.5, 81], x: 46, y: 81, spawn: [50, 76], zone: [[26.5, 73.5], [45, 73.5], [45, 88], [26.5, 88]] },
      { to: 'annex2', label: '教學課程', sign: [85, 74], x: 78, y: 64.5, spawn: [71.4, 62.4], zone: [[78.5, 66], [95.5, 66], [95.5, 81.5], [78.5, 81.5]] },
      // 廣場正中間下方空地的金色傳送門；spawn 放在傳送門上方一段距離，從線上競賽回來時站在門外
      { to: 'contest', label: '線上競賽', x: 52.5, y: 85, spawn: [52.5, 74] }
    ]
  },
  annex1: {
    id: 'annex1',
    name: '活動報名',
    background: null, // 沒指定 → 隨機挑一張 bg 開頭的 jpg（見 getRoomBackgroundUrl）
    // 活動分類傳送點會在 refreshEventPortals() 加進這個房間
    portals: [
      { to: 'main', x: RETURN_PORTAL_POS.x, y: RETURN_PORTAL_POS.y, label: '回到廣場' }
    ]
  },
  annex2: {
    id: 'annex2',
    name: '教學課程',
    background: null,
    portals: [
      { to: 'main', x: RETURN_PORTAL_POS.x, y: RETURN_PORTAL_POS.y, label: '回到廣場' }
    ]
  },
  // ---- 廣場四周其他建築對應的房間（內容之後再設計，目前是隨機底圖 + 回廣場的傳送點）----
  b_sport: {
    id: 'b_sport',
    name: '運動人生',
    background: null,
    portals: [ { to: 'main', x: RETURN_PORTAL_POS.x, y: RETURN_PORTAL_POS.y, label: '回到廣場' } ]
  },
  b_assoc: {
    id: 'b_assoc',
    name: '協辦與自辦',
    background: null,
    portals: [ { to: 'main', x: RETURN_PORTAL_POS.x, y: RETURN_PORTAL_POS.y, label: '回到廣場' } ]
  },
  b_hq: {
    id: 'b_hq',
    name: '泳渡人生總部',
    background: null,
    portals: [ { to: 'main', x: RETURN_PORTAL_POS.x, y: RETURN_PORTAL_POS.y, label: '回到廣場' } ]
  },
  b_pool: {
    id: 'b_pool',
    name: '團練泳池',
    background: null,
    portals: [ { to: 'main', x: RETURN_PORTAL_POS.x, y: RETURN_PORTAL_POS.y, label: '回到廣場' } ]
  },
  b_shop: {
    id: 'b_shop',
    name: '購物商城',
    background: null,
    portals: [ { to: 'main', x: RETURN_PORTAL_POS.x, y: RETURN_PORTAL_POS.y, label: '回到廣場' } ]
  },
  b_member: {
    id: 'b_member',
    name: '會員專區',
    background: null,
    portals: [ { to: 'main', x: RETURN_PORTAL_POS.x, y: RETURN_PORTAL_POS.y, label: '回到廣場' } ]
  },
  b_match: {
    id: 'b_match',
    name: '專業媒合',
    background: null,
    portals: [ { to: 'main', x: RETURN_PORTAL_POS.x, y: RETURN_PORTAL_POS.y, label: '回到廣場' } ]
  },
  b_news: {
    id: 'b_news',
    name: '新聞資訊',
    background: null,
    portals: [ { to: 'main', x: RETURN_PORTAL_POS.x, y: RETURN_PORTAL_POS.y, label: '回到廣場' } ]
  },
  // 線上競賽：從廣場中間下方的金色傳送門進來。地面先從 bg1～bg4 隨機挑一張（backgroundPool），
  // 每次玩家進來都重新抽；之後有專屬底圖時，改成 background: '檔名' 或從後台指定即可
  contest: {
    id: 'contest',
    name: '線上競賽',
    background: null,
    backgroundPool: ['bg1.jpg', 'bg2.jpg', 'bg3.jpg', 'bg4.jpg'],
    portals: [
      { to: 'main', x: RETURN_PORTAL_POS.x, y: RETURN_PORTAL_POS.y, label: '回到廣場' },
      // 場景正中間：戶外泳池入口（藍色 hue）。進入前會跑 ROOM_ENTRY_CHECKS.swim_race 的會員檢查
      { to: 'swim_race', label: '🏊 線上多人競泳', x: 50, y: 55, spawn: [50, 70], hue: 170 },
      // 線上多人競泳右邊：Project Starforge 入口（橘色 hue）。這是「外部連結傳送點」：
      // 帶 link 的傳送點不是房間，前端走到之後直接把整頁換到對應網址（見 index.asp 的 PORTAL_LINKS），
      // 不會送 teleport；to 只用來當唯一識別，用 'link:' 開頭避免跟房間 id 撞名。
      { to: 'link:starforge', link: 'starforge', label: '🚀 Starforge 星球工業', x: 65, y: 55, hue: 30 }
    ]
  },
  // 線上多人競泳（戶外泳池）：多人小遊戲之後在這裡開發，目前是準備區。
  // 底圖暫用 bg1～bg4 隨機，之後有泳池底圖時改成 background: '檔名' 或從後台指定
  swim_race: {
    id: 'swim_race',
    name: '線上多人競泳',
    background: null,
    backgroundPool: ['bg1.jpg', 'bg2.jpg', 'bg3.jpg', 'bg4.jpg'],
    portals: [ { to: 'contest', x: RETURN_PORTAL_POS.x, y: RETURN_PORTAL_POS.y, label: '回到線上競賽' } ]
  }
};

// ---------------------------------------------------------------
// 房間進入檢查：傳送到這些房間前，伺服器先跑對應的檢查函式，
// 回傳 { ok:true } 才放行，{ ok:false, error } 會回 teleport-error 給玩家。
// 「線上多人競泳」是之後多人小遊戲的入口，會員資格、報名、人數上限、
// 比賽是否開放等規則都加在這裡（可以是 async，例如呼叫 ASP API 查資料庫）。
// socket.data 裡有 memberId（資料庫會員編號）、charId、roomId 可用。
// ---------------------------------------------------------------
const ROOM_ENTRY_CHECKS = {
  swim_race: async (socket) => {
    // 目前規則：必須是已驗證登入的會員（進場時 verify_token.asp 驗證過才會有 memberId）
    if (!socket.data.memberId) return { ok: false, error: '請先登入會員才能進入線上多人競泳' };
    return { ok: true };
  }
};
const DEFAULT_ROOM_ID = 'main';

// 每個房間各自的即時狀態：角色清單、聊天紀錄。重啟伺服器會清空
// （如需持久化可換成資料庫）。
const rooms = Object.create(null);

// 建立一個房間的即時狀態。固定房間（ROOMS_CONFIG）跟動態建立的活動分類房間
// 都走這裡，新增房間狀態欄位（例如地上道具）只要改這一處，不會漏掉其中一種。
function createRoomState(fields) {
  return Object.assign({
    characters: Object.create(null), // id -> {id,name,hair,body,x,y,ownerSocketId}
    chatLog: [],                     // {who, charId, text, isSystem, ts}
    groundItems: new Map(),          // 地上的道具：id -> {id,code,qty,x,y,source,expiresAt}，見「背包與地上道具」
    lastItemSpawnAt: 0               // 這個房間上一次自動刷道具的時間（見 tickGroundItems）
  }, fields);
}

Object.keys(ROOMS_CONFIG).forEach((roomId) => {
  const cfg = ROOMS_CONFIG[roomId];
  rooms[roomId] = createRoomState({
    id: cfg.id,
    name: cfg.name,
    background: cfg.background || null,
    backgroundPool: cfg.backgroundPool || null,
    portals: cfg.portals || []
  });
});

// 啟動時把管理員之前透過後台選過的房間底圖蓋回去，這樣重啟伺服器
// 不會跳回 ROOMS_CONFIG 裡寫死的預設圖，只有管理員自己在後台改過的
// 房間才會被蓋掉，沒改過的房間維持 ROOMS_CONFIG 的預設值。
Object.keys(initialBackgroundState.roomBackgrounds || {}).forEach((roomId) => {
  if (rooms[roomId]) {
    rooms[roomId].background = initialBackgroundState.roomBackgrounds[roomId] || null;
  }
});

function getRoom(roomId) {
  return rooms[roomId] || null;
}

// ---------------------------------------------------------------
// 2.5D 場景佈局：可走範圍、障礙物、遠近縮放、前景遮擋
//
// 佈局是「跟著底圖檔名」走的（不是跟著房間走）：同一張底圖不管被哪個
// 房間使用，地板、櫃台的位置都一樣。只有房間「有固定底圖」且那張底圖
// 在 SCENE_LAYOUTS 裡有設定時才會啟用 2.5D；隨機底圖的房間（每個玩家
// 抽到的圖都不一樣）維持原本的平面模式。
//
// 座標一律是「佔底圖寬高的百分比」（0~100），跟角色座標同一套系統；
// 前端會把場景固定成底圖的長寬比（aspect），所以百分比可以直接對上圖片。
//
//   aspect      底圖寬 / 高（room1.jpg 是 1536x1024 → 1.5）
//   walkArea    可走範圍的外框多邊形 [[x,y], ...]（腳踩的位置必須在裡面）
//   blocked     障礙物在「地板上的投影範圍」多邊形，腳不能踩進去
//   depth       遠近縮放：腳的 y 在 farY 時，角色高度佔場景高度 farHeight%，
//               在 nearY 時佔 nearHeight%，中間線性內插
//   occluders   前景遮擋圖（從底圖切出來的去背 PNG，放在 SCENE_ASSET_URL 下）
//               x/y/w/h 是圖片在場景上的位置與大小；baseline 是物件「前緣」
//               的地面線 [[x,y], ...]，角色腳的 y 在這條線上方（比較遠）時，
//               會被這張圖蓋住，在線的下方（比較近）時，角色會在圖的前面
//   portalSlots 這張底圖上適合擺傳送點的位置（大廳的活動分類傳送點依序套用）
//
// 新增其他房間的 2.5D 佈局：在下面加一筆以底圖檔名為 key 的設定即可。
// 量座標時可以在遊戲網址後面加 &scene_debug=1，畫面會畫出可走範圍，
// 點一下場景就會在提示列顯示該點的百分比座標。
// ---------------------------------------------------------------
const SCENE_ASSET_URL = process.env.SCENE_ASSET_URL || 'https://www.swimlife.tw/alex/game/online/scene/';

const SCENE_LAYOUTS = {
  // 大廳 room1 系列：7 張同一個廣場、不同主題的底圖共用這個佈局（見 getRoomLayout）
  'room1': {
    aspect: 1659 / 948,
    walkArea: [[30, 29], [70, 29], [76, 33], [80, 40], [80, 52], [84, 57], [79, 65], [68, 71], [60, 77], [60, 92], [45, 92], [45, 77], [40, 73], [23, 71], [18, 65], [14, 58], [17, 52], [20, 47], [20, 38], [24, 33]],
    blocked: [],
    depth: { farY: 29, farHeight: 8, nearY: 92, nearHeight: 13 },
    occluders: [],
    // 可以切換的主題（每位玩家自己選，只影響自己的畫面）
    skins: [
      // signs = 這個主題各建築中文招牌的範圍 [左, 上, 右, 下]（百分比座標），前端會再往外留一點當可點範圍
      { file: 'room1-001.jpg', name: '未來城市', thumb: 'room1/thumb-001.jpg',
        signs: { b_sport: [8.5, 23, 17.8, 28.5], b_assoc: [23.5, 12, 35, 16.5], b_hq: [44.5, 8.5, 55.5, 13], annex1: [65, 14, 74, 19], b_pool: [81.5, 22, 91, 27], b_shop: [7, 42, 16.5, 47.5], b_member: [86, 45, 95.5, 50], b_match: [5.5, 68.5, 14.5, 73.5], b_news: [30.5, 76.5, 39.5, 81.5], annex2: [83.5, 69, 93, 74.5] } },
      { file: 'room1-002.jpg', name: '海濱主題', thumb: 'room1/thumb-002.jpg',
        signs: { b_sport: [9, 22.5, 20, 28.5], b_assoc: [25.5, 13, 35, 17], b_hq: [44.5, 8, 55.5, 13], annex1: [65.5, 13.5, 74.5, 18], b_pool: [82.5, 23, 92.5, 28], b_shop: [7, 41.5, 17.5, 47], b_member: [84.5, 43.5, 93.5, 48], b_match: [7.5, 69, 17.5, 74], b_news: [32.5, 77, 41.5, 82], annex2: [82, 69.5, 91.5, 74.5] } },
      { file: 'room1-003.jpg', name: '霓虹遊戲', thumb: 'room1/thumb-003.jpg',
        signs: { b_sport: [8.5, 20, 17.5, 25], b_assoc: [24.5, 10.5, 34.5, 15], b_hq: [44.5, 8, 55.5, 13], annex1: [63.5, 11.5, 73, 16], b_pool: [83, 21, 93, 25.5], b_shop: [8.5, 39.5, 17, 44.5], b_member: [86.5, 44.5, 96, 49.5], b_match: [7.5, 64, 15.5, 69], b_news: [28.5, 76.5, 38.5, 82], annex2: [83, 68.5, 92.5, 73.5] } },
      { file: 'room1-004.jpg', name: '奇幻城鎮', thumb: 'room1/thumb-004.jpg',
        signs: { b_sport: [7.5, 22.5, 16.5, 28.5], b_assoc: [25.5, 14, 34, 18], b_hq: [44.5, 8, 55.5, 12.5], annex1: [66, 14, 74, 18.5], b_pool: [85, 21.5, 93.5, 25.5], b_shop: [6.5, 41.5, 16.5, 48], b_member: [84.5, 44, 92.5, 49], b_match: [7, 70, 16.5, 75], b_news: [29.5, 76.5, 39.5, 82], annex2: [83.5, 72, 92, 77] } },
      { file: 'room1-005.jpg', name: '櫻花城鎮', thumb: 'room1/thumb-005.jpg',
        signs: { b_sport: [8, 23, 18, 28.5], b_assoc: [23, 13, 33.5, 17.5], b_hq: [44.5, 8, 55.5, 13], annex1: [66, 14.5, 76, 19], b_pool: [83, 24.5, 93.5, 29], b_shop: [7.5, 41.5, 17.5, 47.5], b_member: [85.5, 44, 95, 49.5], b_match: [7, 71, 16.5, 75.5], b_news: [30.5, 76, 39.5, 81], annex2: [83.5, 74, 93.5, 79] } },
      { file: 'room1-006.jpg', name: '夢幻水都', thumb: 'room1/thumb-006.jpg',
        signs: { b_sport: [8, 23, 18, 28.5], b_assoc: [23.5, 14, 34, 18.5], b_hq: [44.5, 9.5, 55.5, 14], annex1: [64.5, 14.5, 74.5, 19], b_pool: [83.5, 24.5, 93, 29], b_shop: [7, 45, 16.5, 50], b_member: [86.5, 46, 95.5, 51], b_match: [8, 72, 17.5, 77], b_news: [32, 76.5, 40, 81.5], annex2: [82.5, 71.5, 92.5, 77] } },
      { file: 'room1-007.jpg', name: '古風', thumb: 'room1/thumb-007.jpg',
        signs: { b_sport: [9, 23.5, 18, 29], b_assoc: [24.5, 13.5, 34.5, 17.5], b_hq: [44.5, 9.5, 56, 14.5], annex1: [66, 13.5, 75, 17.5], b_pool: [84, 24, 93.5, 29], b_shop: [7.5, 45.5, 16.5, 51], b_member: [84.5, 44.5, 95, 50], b_match: [8.5, 74, 18.5, 79], b_news: [33, 80.5, 43, 85.5], annex2: [80.5, 73.5, 90.5, 79] } }
    ]
  },
  'room1.jpg': {
    aspect: 1536 / 1024,
    walkArea: [[0, 73], [4, 72.5], [20, 67.5], [31, 64.5], [45, 63.5], [76, 63.5], [88, 65], [100, 65], [100, 97], [0, 97]],
    blocked: [
      // 接待櫃台
      [[31.2, 67], [31.2, 74.8], [51.9, 81], [58, 81], [62.8, 76.8], [63.6, 69], [61, 67]],
      // 圓形腳凳
      [[73.8, 84], [75.5, 82.6], [78.5, 82.2], [81.5, 82.6], [83.2, 84], [83.2, 86.8], [81, 88], [77, 88.2], [74.5, 87.4], [73.8, 86]],
      // 右下角前排沙發
      [[80.4, 88.5], [82, 86], [85, 84.8], [91, 84.2], [95, 84.6], [97, 82.5], [100, 77.5], [100, 100], [80.4, 100]],
      // 右側弧形沙發 + 茶几 + 盆栽
      [[83, 65], [100, 64], [100, 77.5], [97, 82.5], [95, 84.6], [91, 84.2], [87, 85.2], [84.5, 82], [84.5, 75], [83.5, 70]],
      // 左側盆栽
      [[0, 60], [4, 60], [4.5, 73.2], [0, 73.5]]
    ],
    depth: { farY: 63.5, farHeight: 11, nearY: 97, nearHeight: 27 },
    occluders: [
      { src: 'room1/desk.png', x: 31.185, y: 54.492, w: 32.487, h: 26.27, baseline: [[31, 71], [52, 74], [64, 73]] },
      { src: 'room1/ottoman.png', x: 73.893, y: 77.246, w: 9.375, h: 10.84, baseline: [[73.5, 85.5], [83.5, 85.5]] },
      { src: 'room1/table.png', x: 84.44, y: 73.145, w: 12.5, h: 12.988, baseline: [[84.5, 84], [97, 84]] },
      { src: 'room1/sofa.png', x: 80.404, y: 77.441, w: 19.596, h: 22.559, baseline: [[80, 100], [100, 100]] }
    ],
    portalSlots: [[8, 82], [20, 74], [14, 93], [29, 88], [43, 93], [57, 91], [69, 86], [71, 70]]
  },
  // 大廳（地中海風廣場，黃昏原圖）：支援依玩家當地時間切換光照（lighting）
  'plaza.jpg': {
    aspect: 1536 / 1024,
    walkArea: [[15.62, 48.83], [16.6, 42.97], [21.48, 42.97], [25.72, 39.06], [31.9, 39.26], [37.76, 39.06], [39.06, 33.69], [45.57, 32.23], [50.78, 32.71], [52.08, 36.13], [58.59, 36.52], [65.1, 35.35], [68.68, 39.06], [70.31, 45.9], [74.54, 51.27], [81.38, 55.66], [80.4, 59.08], [79.75, 68.36], [79.75, 73.44], [67.71, 79.3], [64.45, 80.66], [55.34, 83.01], [55.01, 91.8], [27.34, 91.8], [21.48, 92.58], [7.81, 92.77], [7.16, 83.01], [7.49, 75.2], [13.02, 74.22], [15.1, 70.31], [14.84, 58.59]],
    blocked: [
      // 中央橄欖樹花台
      [[59.44, 54.69], [58.96, 56.35], [57.58, 57.84], [55.41, 59.03], [52.69, 59.8], [49.67, 60.06], [46.66, 59.8], [43.93, 59.03], [41.77, 57.84], [40.39, 56.35], [39.91, 54.69], [40.39, 53.03], [41.77, 51.53], [43.93, 50.34], [46.66, 49.58], [49.67, 49.32], [52.69, 49.58], [55.41, 50.34], [57.58, 51.53], [58.96, 53.03]],
      // 前方盆栽、路燈
      [[55.21, 88.38], [60.87, 85.94], [64.13, 83.98], [67.71, 83.98], [68.88, 85.94], [68.36, 96.19], [55.21, 96.19]],
      // 左下盆栽
      [[9.11, 87.4], [20.83, 87.4], [20.83, 93.26], [9.11, 93.26]]
    ],
    depth: { farY: 31, farHeight: 6, nearY: 93, nearHeight: 17.2 },
    occluders: [
      { src: 'plaza/tree.png', x: 39.909, y: 32.715, w: 19.661, h: 27.734, baseline: [[40, 54.7], [59.5, 54.7]] },
      { src: 'plaza/front.png', x: 55.208, y: 76.074, w: 13.672, h: 20.508, baseline: [[55, 93], [69, 93]] },
      { src: 'plaza/olive.png', x: 68.88, y: 68.262, w: 10.417, h: 21.094, baseline: [[68.5, 88.5], [79.5, 88.5]] },
      { src: 'plaza/left.png', x: 9.44, y: 80.176, w: 11.328, h: 12.402, baseline: [[9, 92], [21, 92]] }
    ],
    // 傳送點位置（依活動分類順序）：咖啡廳樓梯口、左後拱門、後方中央、右後拱門、
    // 街機店門口、右側空地、下方階梯、左側空地。彼此保持距離，名稱標籤才不會重疊，
    // 也避開前景盆栽（不然標籤會被遮住）
    portalSlots: [[17.06, 48.83], [28.65, 39.55], [44.92, 34.67], [61.2, 36.91], [79.43, 55.47], [65.1, 62.5], [39.06, 89.36], [21.48, 74.22]],
    // 時間光照：底圖本身是「黃昏」，另外準備清晨 / 白天 / 夜晚三個版本
    // （scene/plaza/dawn.jpg、day.jpg、night.jpg），前景遮擋圖也各有一份
    // （例如 tree_night.png）。前端依玩家電腦的本地時間在版本之間淡入淡出。
    lighting: { base: 'golden', variants: ['night', 'dawn', 'day'], dir: 'plaza/' }
  },
  // 大廳（海港城市，白天原圖）：依玩家當地時間切換清晨 / 黃昏 / 夜晚
  'city.jpg': {
    aspect: 2048 / 1170,
    walkArea: [[0.0, 34.17], [6.51, 34.17], [16.93, 34.17], [26.04, 37.59], [28.65, 42.37], [39.06, 42.37], [45.57, 39.86], [60.55, 40.09], [64.13, 45.79], [71.61, 46.47], [75.85, 48.41], [78.12, 51.25], [78.45, 54.67], [74.87, 61.5], [69.01, 65.83], [65.1, 68.34], [61.85, 70.39], [57.29, 72.89], [52.93, 75.17], [49.48, 78.59], [45.57, 78.59], [40.36, 84.05], [35.16, 87.13], [32.55, 89.52], [27.34, 94.53], [21.48, 98.63], [0.0, 98.63]],
    blocked: [
      // 前排商場大樓
      [[21.48, 56.95], [24.09, 51.82], [36.46, 50.68], [45.57, 54.67], [45.57, 68.34], [41.67, 74.6], [26.04, 74.03], [20.96, 69.48]],
      // 玻璃溫室
      [[8.33, 53.53], [9.77, 51.48], [16.6, 51.48], [17.58, 53.53], [17.45, 59.0], [8.46, 59.0]],
      // 地球噴泉
      [[58.4, 47.38], [58.17, 48.26], [57.5, 49.05], [56.47, 49.68], [55.16, 50.09], [53.71, 50.23], [52.26, 50.09], [50.96, 49.68], [49.92, 49.05], [49.25, 48.26], [49.02, 47.38], [49.25, 46.5], [49.92, 45.71], [50.96, 45.08], [52.26, 44.67], [53.71, 44.53], [55.16, 44.67], [56.47, 45.08], [57.5, 45.71], [58.17, 46.5]],
      // 公園噴水池
      [[19.4, 45.33], [19.25, 45.86], [18.8, 46.33], [18.11, 46.71], [17.24, 46.96], [16.28, 47.04], [15.31, 46.96], [14.44, 46.71], [13.75, 46.33], [13.3, 45.86], [13.15, 45.33], [13.3, 44.8], [13.75, 44.33], [14.44, 43.95], [15.31, 43.71], [16.28, 43.62], [17.24, 43.71], [18.11, 43.95], [18.8, 44.33], [19.25, 44.8]],
      // 公園雕塑
      [[17.19, 42.37], [17.14, 42.58], [17.01, 42.77], [16.81, 42.92], [16.56, 43.02], [16.28, 43.05], [15.99, 43.02], [15.74, 42.92], [15.54, 42.77], [15.41, 42.58], [15.36, 42.37], [15.41, 42.16], [15.54, 41.97], [15.74, 41.82], [15.99, 41.72], [16.28, 41.69], [16.56, 41.72], [16.81, 41.82], [17.01, 41.97], [17.14, 42.16]]
    ],
    depth: { farY: 34, farHeight: 7.5, nearY: 99, nearHeight: 11.5 },
    occluders: [
      { src: 'city/globe.png', x: 49.268, y: 38.034, w: 9.717, h: 13.162, baseline: [[49.15, 48.06], [58.92, 48.06]] },
      { src: 'city/sculpture.png', x: 15.039, y: 32.735, w: 2.637, h: 10.684, baseline: [[14.65, 42.6], [17.9, 42.6]] }
    ],
    // 傳送點位置：廣場左側、廣場右側、地球噴泉前、海濱路口、公園、籃球場旁、海濱步道、碼頭
    portalSlots: [[36.46, 45.56], [70.31, 50.68], [46.22, 59.79], [62.5, 59.23], [21.48, 47.84], [7.81, 68.34], [30.6, 83.14], [57.29, 70.05]],
    // 時間光照：原圖是白天（base: 'day'），另外有 night / dawn / golden 三個版本
    lighting: { base: 'day', variants: ['night', 'dawn', 'golden'], dir: 'city/' }
  }
};

// 房間目前生效的佈局（沒有就回傳 null = 平面模式）
function getRoomLayout(room) {
  if (!room || !room.background) return null;
  // room1-001.jpg ~ room1-999.jpg 都使用同一個 room1 佈局
  if (/^room1-\d{3}\.jpg$/i.test(room.background)) return SCENE_LAYOUTS['room1'];
  return SCENE_LAYOUTS[room.background] || null;
}

// 送給前端的佈局資料（前端用來縮放、排前後、畫前景；可走範圍也一起送，
// 給 scene_debug 模式畫出來用，真正的檢查一律在伺服器做）
function getRoomScenePayload(room) {
  const layout = getRoomLayout(room);
  if (!layout) return null;
  return {
    aspect: layout.aspect,
    walkArea: layout.walkArea,
    blocked: layout.blocked,
    depth: layout.depth,
    occluders: (layout.occluders || []).map((o) => {
      const item = Object.assign({}, o, { src: SCENE_ASSET_URL + o.src });
      // 有時間光照的佈局：每張遮擋圖附上各時段版本的網址（tree.png → tree_night.png）
      if (layout.lighting) {
        item.variants = {};
        layout.lighting.variants.forEach((v) => {
          item.variants[v] = SCENE_ASSET_URL + o.src.replace(/\.png$/i, '_' + v + '.png');
        });
      }
      return item;
    }),
    skins: layout.skins ? layout.skins.map((sk) => ({
      file: sk.file, name: sk.name, url: BG_FOLDER_URL + sk.file, thumb: SCENE_ASSET_URL + sk.thumb,
      signs: sk.signs || null   // 各建築招牌範圍，前端用來決定哪裡可以點（滑鼠變手指）
    })) : null,
    lighting: layout.lighting ? {
      base: layout.lighting.base || 'golden',
      order: layout.lighting.variants.slice(),
      variants: layout.lighting.variants.reduce((acc, v) => {
        acc[v] = SCENE_ASSET_URL + layout.lighting.dir + v + '.jpg';
        return acc;
      }, {})
    } : null
  };
}

// ---- 幾何小工具（座標都是百分比） ----
function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function isWalkable(layout, x, y) {
  if (!pointInPolygon(x, y, layout.walkArea)) return false;
  return !(layout.blocked || []).some((poly) => pointInPolygon(x, y, poly));
}

function nearestOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return [ax + t * dx, ay + t * dy];
}

function polygonCentroid(poly) {
  let sx = 0, sy = 0;
  poly.forEach((p) => { sx += p[0]; sy += p[1]; });
  return [sx / poly.length, sy / poly.length];
}

// 點到不能走的地方（牆外、櫃台裡）時，改成「離它最近、而且可以走」的點，
// 這樣玩家點櫃台，角色會走到櫃台邊停下來，而不是完全不理他。
function clampToWalkable(layout, x, y) {
  x = Number(x); y = Number(y);
  if (!isFinite(x) || !isFinite(y)) return null;
  if (isWalkable(layout, x, y)) return [x, y];

  const NUDGE = 0.6; // 從邊界往可走區內推一點點，避免剛好卡在線上
  const candidates = [];
  const addEdges = (poly, towardInside) => {
    const c = polygonCentroid(poly);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const p = nearestOnSegment(x, y, a[0], a[1], b[0], b[1]);
      // 外框：往多邊形中心推；障礙物：往遠離障礙物中心的方向推
      let vx = towardInside ? c[0] - p[0] : p[0] - c[0];
      let vy = towardInside ? c[1] - p[1] : p[1] - c[1];
      const vl = Math.sqrt(vx * vx + vy * vy) || 1;
      candidates.push([p[0] + (vx / vl) * NUDGE, p[1] + (vy / vl) * NUDGE]);
    }
  };
  addEdges(layout.walkArea, true);
  (layout.blocked || []).forEach((poly) => addEdges(poly, false));

  let best = null, bestD = Infinity;
  candidates.forEach((p) => {
    if (!isWalkable(layout, p[0], p[1])) return;
    const d = (p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y);
    if (d < bestD) { bestD = d; best = p; }
  });
  return best ? [Math.round(best[0] * 100) / 100, Math.round(best[1] * 100) / 100] : null;
}

// 直線從 a 走到 b 會不會穿過障礙物或走出可走範圍（每 0.5% 取樣檢查一次，
// 障礙物都是手量的粗略多邊形，取樣法比精確的線段相交更不容易出錯）
function segmentWalkable(layout, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const steps = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / 0.5));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (!isWalkable(layout, a[0] + dx * t, a[1] + dy * t)) return false;
  }
  return true;
}

// 路徑節點：每個障礙物頂點往外推一點（繞過轉角用），預先算好快取起來
function getLayoutNavNodes(layout) {
  if (layout._navNodes) return layout._navNodes;
  const nodes = [];
  const OFFSET = 1.4;
  (layout.blocked || []).forEach((poly) => {
    const c = polygonCentroid(poly);
    poly.forEach((p) => {
      const vx = p[0] - c[0], vy = p[1] - c[1];
      const vl = Math.sqrt(vx * vx + vy * vy) || 1;
      const n = [p[0] + (vx / vl) * OFFSET, p[1] + (vy / vl) * OFFSET];
      if (isWalkable(layout, n[0], n[1])) nodes.push(n);
    });
  });
  layout._navNodes = nodes;
  return nodes;
}

// 找一條從 from 走到 to 不會穿過障礙物的路線（可視圖 + Dijkstra），
// 回傳中途要經過的點（不含起點，含終點）。節點只有二、三十個，算很快。
// 找不到路的時候直接回傳 [to]（等同直線走過去，至少不會卡住不動）。
function findScenePath(layout, from, to) {
  if (segmentWalkable(layout, from, to)) return [to];
  const pts = [from, to].concat(getLayoutNavNodes(layout));
  const n = pts.length;
  const dist = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const done = new Array(n).fill(false);
  dist[0] = 0;
  for (let iter = 0; iter < n; iter++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && (u === -1 || dist[i] < dist[u])) u = i;
    if (u === -1 || dist[u] === Infinity) break;
    if (u === 1) break;
    done[u] = true;
    for (let v = 0; v < n; v++) {
      if (done[v] || v === u) continue;
      if (!segmentWalkable(layout, pts[u], pts[v])) continue;
      const d = dist[u] + Math.hypot(pts[v][0] - pts[u][0], pts[v][1] - pts[u][1]);
      if (d < dist[v]) { dist[v] = d; prev[v] = u; }
    }
  }
  if (prev[1] === -1) return [to];
  const path = [];
  for (let v = 1; v !== 0; v = prev[v]) {
    path.unshift([Math.round(pts[v][0] * 100) / 100, Math.round(pts[v][1] * 100) / 100]);
  }
  return path;
}

// 在可走範圍裡隨機挑一個點（進場、傳送時沒有指定位置用）
function randomWalkablePoint(layout) {
  const xs = layout.walkArea.map((p) => p[0]), ys = layout.walkArea.map((p) => p[1]);
  const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
  const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
  for (let i = 0; i < 200; i++) {
    // 先四捨五入再檢查，避免剛好在邊界上的點四捨五入後跑到範圍外
    const x = Math.round((minX + Math.random() * (maxX - minX)) * 100) / 100;
    const y = Math.round((minY + Math.random() * (maxY - minY)) * 100) / 100;
    if (isWalkable(layout, x, y)) return [x, y];
  }
  return [50, 90];
}

// 角色要出現在房間的某個位置：2.5D 房間會修正到可走範圍內，平面房間維持原本的夾值
function placeInRoom(room, x, y) {
  const layout = getRoomLayout(room);
  if (!layout) return [clampX(x), clampY(y)];
  if (x === undefined || y === undefined) return randomWalkablePoint(layout);
  return clampToWalkable(layout, x, y) || randomWalkablePoint(layout);
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

// 分類清單（哪些傳送點要顯示在大廳）不常變動，快取久一點。
const SORTS_CACHE_MS = 5 * 60 * 1000;   // 5 分鐘

let sortsCache = { data: null, expiresAt: 0 };

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

// 活動分類房間內的連結：不再逐筆列出資料庫裡每一筆上架活動，
// 改成點下去直接開啟該分類的報名總覽頁面（signup_main.asp?event_sort_no=N），
// 頁面裡有哪些活動、上下架狀態都交給那個頁面自己處理，這裡不用再打一次
// event_api.asp 查活動清單。要改網址規則的話，只要改這個函式就好。
const SIGNUP_PAGE_URL = process.env.SIGNUP_PAGE_URL || 'https://www.swimlife.tw/signup/signup_main.asp';

function buildEventRoomLinks(sortNo, sortName) {
  return [
    {
      name: `前往「${sortName}」報名頁`,
      weblink: `${SIGNUP_PAGE_URL}?event_sort_no=${encodeURIComponent(sortNo)}`
    }
  ];
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

// ---------------------------------------------------------------
// 「捏一捏 -> 身體選擇與皮膚調整」：跟 verify_token.asp / event_api.asp
// 一樣，向 ASP 那邊的 character_api.asp 做 server-to-server 存取，
// 全程用 member_no（= verifyLoginToken 回傳的 memberId）當關聯 key，
// 瀏覽器端完全不會、也不需要直接打到 ASP。
//
// CHARACTER_API_URL / CHARACTER_API_KEY 請改成實際部署位置，且 KEY 要跟
// character_api.asp 裡設定的 API_KEY 完全一致，兩邊都建議改成環境變數。
// ---------------------------------------------------------------
const CHARACTER_API_URL = process.env.CHARACTER_API_URL || 'https://www.swimlife.tw/alex/game/online/character_api.asp';
const CHARACTER_API_KEY = process.env.CHARACTER_API_KEY || 'a1b2c3d4e5';

const HEX_COLOR_STRICT_RE = /^#[0-9a-fA-F]{6}$/;

// 讀取某會員目前的身體部位設定 + 膚色（GET action=get）
function fetchCharacterCustomization(memberNo) {
  return new Promise((resolve) => {
    const url = `${CHARACTER_API_URL}?action=get&member_no=${encodeURIComponent(memberNo)}&key=${encodeURIComponent(CHARACTER_API_KEY)}`;
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ ok: false, error: 'character_api.asp 回傳格式錯誤' });
        }
      });
    }).on('error', (err) => {
      resolve({ ok: false, error: '無法連線到 character_api.asp：' + err.message });
    });
  });
}

// 存檔（POST action=save）：body part 陣列在這裡組成 ASP 那邊要解析的
// "CODE,visible,hex|CODE2,visible,hex2" 字串，欄位驗證（hex 格式、
// visible 只能 0/1）在送出前先做一次，ASP 那邊也會再驗證一次。
function saveCharacterCustomization(memberNo, skinColorId, parts) {
  return new Promise((resolve) => {
    const partsStr = (Array.isArray(parts) ? parts : [])
      .filter((p) => p && typeof p.code === 'string' && /^[A-Z0-9_]{1,30}$/.test(p.code))
      .map((p) => {
        const visible = p.visible ? '1' : '0';
        const hex = HEX_COLOR_STRICT_RE.test(p.colorHex) ? p.colorHex : '';
        return `${p.code},${visible},${hex}`;
      })
      .join('|');

    const form = new URLSearchParams({
      member_no: String(memberNo),
      skin_color_id: String(skinColorId),
      parts: partsStr,
      key: CHARACTER_API_KEY
    }).toString();

    const target = new URL(`${CHARACTER_API_URL}?action=save`);
    const req = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(form)
      }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ ok: false, error: 'character_api.asp 回傳格式錯誤' });
        }
      });
    });
    req.on('error', (err) => {
      resolve({ ok: false, error: '無法連線到 character_api.asp：' + err.message });
    });
    req.write(form);
    req.end();
  });
}

// ---------------------------------------------------------------
// 紙娃娃角色（figure/doll/）：玩家選 1 位角色 + 5 個部位的顏色
//   doll = { character: 'female_03', colors: { hair, skin, top, bottom, shoes } }
//   顏色是 #RRGGBB，或 null（= 使用角色原本的顏色）
// 存在資料庫 dbo.game_UserDoll，透過 character_api.asp 的 getdoll / savedoll 讀寫。
// 新增角色時：把圖放進 figure/doll/、更新 manifest.json，並把代碼加進下面這個清單。
// ---------------------------------------------------------------
const DOLL_CHARACTERS = [
  'female_01', 'female_02', 'female_03', 'female_04', 'female_05',
  'male_01', 'male_02', 'male_03', 'male_04', 'male_05'
];
const DOLL_PARTS = ['hair', 'skin', 'top', 'bottom', 'shoes'];

// 驗證並整理前端送來的紙娃娃設定，不合法回傳 null
function sanitizeDoll(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!DOLL_CHARACTERS.includes(raw.character)) return null;
  const colors = {};
  const src = (raw.colors && typeof raw.colors === 'object') ? raw.colors : {};
  DOLL_PARTS.forEach((part) => {
    colors[part] = HEX_COLOR_STRICT_RE.test(src[part]) ? String(src[part]).toUpperCase() : null;
  });
  return { character: raw.character, colors };
}

// 讀取會員的紙娃娃設定：{ ok:true, doll:null|{...} } 或 { ok:false, error }
function fetchDoll(memberNo) {
  return new Promise((resolve) => {
    const url = `${CHARACTER_API_URL}?action=getdoll&member_no=${encodeURIComponent(memberNo)}&key=${encodeURIComponent(CHARACTER_API_KEY)}`;
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed || !parsed.ok) return resolve({ ok: false, error: (parsed && parsed.error) || 'getdoll 失敗' });
          resolve({ ok: true, doll: parsed.doll ? sanitizeDoll(parsed.doll) : null });
        } catch (e) {
          resolve({ ok: false, error: 'character_api.asp（getdoll）回傳格式錯誤' });
        }
      });
    }).on('error', (err) => {
      resolve({ ok: false, error: '無法連線到 character_api.asp：' + err.message });
    });
  });
}

// 儲存會員的紙娃娃設定（doll 必須先經過 sanitizeDoll）
function saveDoll(memberNo, doll) {
  return new Promise((resolve) => {
    const fields = { member_no: String(memberNo), character: doll.character, key: CHARACTER_API_KEY };
    DOLL_PARTS.forEach((part) => { fields[part] = doll.colors[part] || ''; });
    const form = new URLSearchParams(fields).toString();
    const target = new URL(`${CHARACTER_API_URL}?action=savedoll`);
    const req = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(form)
      }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(parsed && parsed.ok ? { ok: true } : { ok: false, error: (parsed && parsed.error) || 'savedoll 失敗' });
        } catch (e) {
          resolve({ ok: false, error: 'character_api.asp（savedoll）回傳格式錯誤' });
        }
      });
    });
    req.on('error', (err) => {
      resolve({ ok: false, error: '無法連線到 character_api.asp：' + err.message });
    });
    req.write(form);
    req.end();
  });
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
      // 活動分類房間預設沒有指定固定底圖，會改用 getRoomBackgroundUrl 的
      // 隨機邏輯（一般分類隨機挑 bg 開頭的 jpg，「菁英計畫」隨機挑 sp
      // 開頭的 jpg，見 defaultBgPrefixForRoom）。但如果管理員之前已經
      // 透過後台幫這個房間選過固定底圖並存進狀態檔，這裡要蓋回去，
      // 不然每次伺服器重啟、這個分類房間重新被建立時又會變回沒有指定。
      const persistedBg = (initialBackgroundState.roomBackgrounds || {})[roomId] || null;
      rooms[roomId] = createRoomState({
        id: roomId,
        name: sort.name,
        background: persistedBg, // 沒有另外指定底圖時，套用隨機底圖邏輯
        portals: [
          // 回程傳送點跟其他房間放在同一個位置（RETURN_PORTAL_POS），所有場景操作一致
          { to: 'annex1', x: RETURN_PORTAL_POS.x, y: RETURN_PORTAL_POS.y, label: '回到活動報名' }
        ],
        isEventRoom: true,
        sortNo: sort.no
      });
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
  // 新版大廳的四周建築就是入口，活動分類的傳送點改放在「活動報名」房間裡
  const signupRoom = getRoom('annex1');
  if (signupRoom) {
    signupRoom.portals = [{ to: DEFAULT_ROOM_ID, x: RETURN_PORTAL_POS.x, y: RETURN_PORTAL_POS.y, label: '回到廣場' }].concat(eventPortals);
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
// 各房間底圖管理 API：讓管理頁面可以列出目前有哪些房間、每個房間
// 目前用哪張底圖，並且針對單一房間指定要用 bg/ 資料夾裡的哪張圖。
// 檔案本身還是放在 ASP 主機的 bg/ 資料夾（跟 bg_list.asp 用同一份），
// 這裡只負責記錄「哪個房間要用哪個檔名」。
// ---------------------------------------------------------------

// 讀取的部分不需要密碼（純讀取，方便管理頁一開啟就能列出房間清單/
// 目前底圖），套用亮度、清聊天紀錄那些「會改變狀態」的動作才需要密碼。
app.options('/admin/rooms', (req, res) => {
  setCorsForAdmin(res);
  res.sendStatus(204);
});

app.get('/admin/rooms', (req, res) => {
  setCorsForAdmin(res);
  const list = Object.keys(rooms).map((roomId) => ({
    id: roomId,
    name: rooms[roomId].name,
    background: rooms[roomId].background || null
  }));
  res.json({ ok: true, rooms: list });
});

// 檔名格式檢查：只允許英數字、底線、連字號、點，副檔名限定圖片格式，
// 避免有人把奇怪的字串（例如帶路徑的字串）存進狀態檔或拼進網址裡。
const BG_FILENAME_RE = /^[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp|gif)$/i;

app.options('/admin/set-room-background', (req, res) => {
  setCorsForAdmin(res);
  res.sendStatus(204);
});

app.post('/admin/set-room-background', async (req, res) => {
  setCorsForAdmin(res);
  const secret = req.headers['x-admin-secret'] || (req.body && req.body.secret);
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(403).json({ ok: false, error: '密碼錯誤' });
  }

  const roomId = req.body && req.body.roomId;
  const room = getRoom(roomId);
  if (!room) {
    return res.status(404).json({ ok: false, error: '房間不存在' });
  }

  // background 傳空字串／null／不帶這個欄位，都視為「恢復成沒有指定底圖」，
  // 也就是改回預設行為：從 bg/ 資料夾隨機挑一張 bg 開頭的 jpg（不是漸層
  // 底圖了，見 getRoomBackgroundUrl 說明）；否則就是 bg/ 資料夾裡的檔名。
  let background = req.body && req.body.background;
  if (background === null || background === undefined || background === '') {
    background = null;
  } else {
    background = String(background).trim();
    if (!BG_FILENAME_RE.test(background)) {
      return res.status(400).json({ ok: false, error: '檔名格式不正確（只接受 bg/ 資料夾裡的圖片檔名）' });
    }
  }

  room.background = background;
  saveBackgroundState();

  // 廣播給「目前在這個房間裡」的玩家立即套用新底圖；其他房間的玩家不受影響。
  const url = await getRoomBackgroundUrl(room);
  const scene = getRoomScenePayload(room);
  io.to(roomId).emit('room-background-changed', { background: url, scene });

  // 換成有 2.5D 佈局的底圖時，房間裡現有的角色可能剛好站在新底圖的櫃台
  // 或牆上，把他們移到最近的可走位置。
  const layout = getRoomLayout(room);
  if (layout) {
    Object.values(room.characters).forEach((ch) => {
      const p = clampToWalkable(layout, ch.x, ch.y) || randomWalkablePoint(layout);
      if (p[0] !== ch.x || p[1] !== ch.y) {
        ch.x = p[0];
        ch.y = p[1];
        io.to(roomId).emit('char-moved', { id: ch.id, x: ch.x, y: ch.y, path: [p] });
      }
    });
  }

  return res.json({ ok: true, roomId, background, url });
});

// ---------------------------------------------------------------
// 背包與地上道具
//
// 資料形狀：
//   ITEM_CATEGORIES 道具分類（依 emoji 主題分組，後台與背包依這個順序顯示）
//   ITEM_CATALOG   道具種類登錄表 code -> { name, icon, category, maxStack }。目前沒有道具美術，
//                  icon 先用 emoji；之後有圖再加欄位即可。**不要刪除已發出去的 code**，
//                  sanitizeInventory 會丟掉不在表裡的 code，等於玩家的道具會在下次存檔時消失。
//   背包 slots     [{ code, qty }]，同種道具堆疊在同一格，所以最多 50 種；以陣列順序為格子順序。
//   地上道具       room.groundItems：id -> { id, code, qty, x, y, source, expiresAt }
//                  source = 'spawn'（伺服器自動刷）/ 'admin'（後台放置）/ 'drop'（玩家丟下）
//                  expiresAt = 到期時間（毫秒）：不分來源，放下後 GROUND_ITEM_TTL_MS 沒人撿就自動清除
//
// 伺服器是唯一真相：背包記憶體版（inventories）在伺服器執行期間是權威，每次變動後
// 把「完整背包」排進存檔佇列寫回資料庫（inventory_api.asp）；前端只能送 pickup-item /
// drop-item / discard-item，伺服器驗證後才改。
// ---------------------------------------------------------------
// 已發出去的 code（shell、starfish、goggles、medal、towel、bottle、swim_cap、pearl…）不能改名或刪除
const ITEM_CATEGORIES = [
  { id: 'sea', name: '海洋生物' },
  { id: 'swim', name: '游泳用品' },
  { id: 'award', name: '運動獎勵' },
  { id: 'food', name: '食物飲料' },
  { id: 'nature', name: '自然寶物' },
  { id: 'fun', name: '收藏小物' }
];
const ITEM_CATALOG = Object.create(null);
[
  ['shell', '貝殼', '🐚', 'sea'],
  ['starfish', '海星', '⭐', 'sea'],
  ['pearl', '珍珠', '🦪', 'sea'],
  ['fish', '小魚', '🐟', 'sea'],
  ['tropical_fish', '熱帶魚', '🐠', 'sea'],
  ['blowfish', '河豚', '🐡', 'sea'],
  ['octopus', '章魚', '🐙', 'sea'],
  ['crab', '螃蟹', '🦀', 'sea'],
  ['shrimp', '蝦子', '🦐', 'sea'],
  ['squid', '小卷', '🦑', 'sea'],
  ['turtle', '海龜', '🐢', 'sea'],
  ['dolphin', '海豚', '🐬', 'sea'],
  ['whale', '鯨魚', '🐳', 'sea'],
  ['coral', '珊瑚', '🪸', 'sea'],
  ['goggles', '泳鏡', '🥽', 'swim'],
  ['swim_cap', '泳帽', '🧢', 'swim'],
  ['towel', '毛巾', '🧣', 'swim'],
  ['bottle', '水壺', '🥤', 'swim'],
  ['swimsuit', '連身泳衣', '🩱', 'swim'],
  ['swim_shorts', '泳褲', '🩳', 'swim'],
  ['bikini', '比基尼', '👙', 'swim'],
  ['lifebuoy', '救生圈', '🛟', 'swim'],
  ['sunglasses', '太陽眼鏡', '🕶️', 'swim'],
  ['parasol', '海灘傘', '⛱️', 'swim'],
  ['flipflops', '夾腳拖', '🩴', 'swim'],
  ['medal', '獎牌', '🏅', 'award'],
  ['gold_medal', '金牌', '🥇', 'award'],
  ['silver_medal', '銀牌', '🥈', 'award'],
  ['bronze_medal', '銅牌', '🥉', 'award'],
  ['trophy', '獎盃', '🏆', 'award'],
  ['honor_medal', '榮譽勳章', '🎖️', 'award'],
  ['stopwatch', '碼錶', '⏱️', 'award'],
  ['watermelon', '西瓜', '🍉', 'food'],
  ['ice_cream', '冰淇淋', '🍦', 'food'],
  ['shaved_ice', '剉冰', '🍧', 'food'],
  ['juice', '果汁', '🧃', 'food'],
  ['coconut', '椰子', '🥥', 'food'],
  ['banana', '香蕉', '🍌', 'food'],
  ['rice_ball', '飯糰', '🍙', 'food'],
  ['bubble_tea', '珍珠奶茶', '🧋', 'food'],
  ['clover', '幸運草', '🍀', 'nature'],
  ['sakura', '櫻花', '🌸', 'nature'],
  ['sunflower', '向日葵', '🌻', 'nature'],
  ['maple_leaf', '楓葉', '🍁', 'nature'],
  ['mushroom', '蘑菇', '🍄', 'nature'],
  ['feather', '羽毛', '🪶', 'nature'],
  ['gem', '寶石', '💎', 'nature'],
  ['crystal_ball', '水晶球', '🔮', 'nature'],
  ['balloon', '氣球', '🎈', 'fun'],
  ['gift', '禮物', '🎁', 'fun'],
  ['teddy_bear', '泰迪熊', '🧸', 'fun'],
  ['old_key', '古老鑰匙', '🗝️', 'fun'],
  ['coin', '金幣', '🪙', 'fun'],
  ['ticket', '票券', '🎫', 'fun'],
  ['kite', '風箏', '🪁', 'fun'],
  ['love_letter', '情書', '💌', 'fun']
].forEach(([code, name, icon, category]) => {
  ITEM_CATALOG[code] = { name, icon, category, maxStack: 99 };
});
// 送給前端 / 後台的是一般物件（目錄本身是無原型物件，避免 code 剛好叫 constructor 之類時查到內建屬性）
const ITEM_CATALOG_PAYLOAD = Object.assign({}, ITEM_CATALOG);
const ITEM_CODE_RE = /^[a-z0-9_]{1,20}$/;

const INVENTORY_MAX_SLOTS = 50;               // 背包格數上限（同種道具堆疊同一格）
const MAX_GROUND_ITEMS_PER_ROOM = 40;         // 每個房間地上最多同時有幾個道具
const PICKUP_RANGE = 6;                       // 撿取距離（百分比座標，跟傳送點門口檢查同一套單位）
const GROUND_ITEM_TTL_MS = 30 * 60 * 1000;    // 地上道具（自動刷 / 後台放 / 玩家丟）30 分鐘沒人撿就清除
const ITEM_ACTION_MIN_INTERVAL_MS = 300;      // 撿取 / 丟下 / 丟棄的節流間隔
const GROUND_ITEM_TICK_MS = 5 * 1000;         // 自動刷道具 + 清除過期道具的檢查週期

// 自動刷道具：每個房間（含動態建立的活動分類房間）各自每 ITEM_SPAWN_EVERY_MS 在隨機位置刷出一個道具。
// 不另設數量上限：每個道具 30 分鐘沒人撿就清除（GROUND_ITEM_TTL_MS），所以一個房間自然最多累積約 10 個，
// 再加上整個房間 MAX_GROUND_ITEMS_PER_ROOM 的總量上限。
// 會刷出哪些道具由後台設定（見下方「自動刷道具的道具池」與 /admin/set-spawn-pool）。
// ITEM_SPAWN_EVERY_MS_BY_ROOM 讓個別房間用不同頻率（集會廣場人最多，每分鐘一個，最多累積約 30 個）。
const ITEM_SPAWN_EVERY_MS = 3 * 60 * 1000;
const ITEM_SPAWN_EVERY_MS_BY_ROOM = {
  main: 60 * 1000
};
// 第一次啟動（還沒有狀態檔）時的預設：這幾個房間刷符合主題的道具，其他房間跟「預設道具池」（null = 全部道具）
const DEFAULT_ROOM_SPAWN_POOLS = {
  main:    ['shell', 'starfish', 'pearl', 'fish', 'tropical_fish', 'crab', 'clover', 'balloon'],
  annex1:  ['towel', 'bottle', 'medal', 'ticket', 'gift'],
  b_pool:  ['goggles', 'swim_cap', 'towel', 'bottle', 'lifebuoy', 'swimsuit', 'swim_shorts'],
  b_sport: ['medal', 'bottle', 'goggles', 'gold_medal', 'silver_medal', 'bronze_medal', 'trophy', 'stopwatch']
};

// 背包資料庫存取（inventory_api.asp）：跟 character_api.asp 一樣是 server-to-server，
// KEY 要跟 inventory_api.asp 裡的 API_KEY 一致，兩邊都建議改成環境變數。
const INVENTORY_API_URL = process.env.INVENTORY_API_URL || 'https://www.swimlife.tw/alex/game/online/inventory_api.asp';
const INVENTORY_API_KEY = process.env.INVENTORY_API_KEY || 'a1b2c3d4e5';
const INVENTORY_API_TIMEOUT_MS = 8000; // ASP 沒回應時不要讓玩家的 join 一直卡住

// 驗證並整理背包：只留目錄裡有的 code、數量為 1..maxStack 的整數、同 code 只留第一筆、最多 50 格
function sanitizeInventory(raw) {
  const slots = [];
  const seen = new Set();
  (Array.isArray(raw) ? raw : []).forEach((s) => {
    if (slots.length >= INVENTORY_MAX_SLOTS || !s || typeof s.code !== 'string') return;
    const def = ITEM_CATALOG[s.code];
    const qty = Number(s.qty);
    if (!def || seen.has(s.code) || !Number.isInteger(qty) || qty < 1 || qty > def.maxStack) return;
    seen.add(s.code);
    slots.push({ code: s.code, qty });
  });
  return slots;
}

// 讀取會員背包：{ ok:true, slots } 或 { ok:false, error }
function fetchInventory(memberNo) {
  return new Promise((resolve) => {
    const url = `${INVENTORY_API_URL}?action=getinv&member_no=${encodeURIComponent(memberNo)}&key=${encodeURIComponent(INVENTORY_API_KEY)}`;
    const req = https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed || !parsed.ok) return resolve({ ok: false, error: (parsed && parsed.error) || 'getinv 失敗' });
          resolve({ ok: true, slots: sanitizeInventory(parsed.items) });
        } catch (e) {
          resolve({ ok: false, error: 'inventory_api.asp（getinv）回傳格式錯誤' });
        }
      });
    });
    req.setTimeout(INVENTORY_API_TIMEOUT_MS, () => req.destroy(new Error('逾時')));
    req.on('error', (err) => {
      resolve({ ok: false, error: '無法連線到 inventory_api.asp：' + err.message });
    });
  });
}

// 儲存會員背包（一律寫入完整內容，slots 必須已經過 sanitizeInventory 或由 addToInventory 等產生）
function saveInventory(memberNo, slots) {
  return new Promise((resolve) => {
    const form = new URLSearchParams({
      member_no: String(memberNo),
      items: slots.map((s) => `${s.code}:${s.qty}`).join('|'),
      key: INVENTORY_API_KEY
    }).toString();
    const target = new URL(`${INVENTORY_API_URL}?action=saveinv`);
    const req = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(form)
      }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(parsed && parsed.ok ? { ok: true } : { ok: false, error: (parsed && parsed.error) || 'saveinv 失敗' });
        } catch (e) {
          resolve({ ok: false, error: 'inventory_api.asp（saveinv）回傳格式錯誤' });
        }
      });
    });
    req.setTimeout(INVENTORY_API_TIMEOUT_MS, () => req.destroy(new Error('逾時')));
    req.on('error', (err) => {
      resolve({ ok: false, error: '無法連線到 inventory_api.asp：' + err.message });
    });
    req.write(form);
    req.end();
  });
}

// ---- 背包的記憶體狀態 ----
// inventories：memberId -> slots。讀取資料庫失敗時**不放進去**（絕不用空背包蓋掉資料庫），
// 沒有這筆就代表「背包沒載入」，撿取 / 丟下 / 丟棄都會被拒絕。slots 陣列一律視為不可變，
// 每次變動都換成新陣列，所以排進存檔佇列的內容不會被後續操作改到。
const inventories = new Map();
const inventoryLoading = new Map(); // memberId -> 進行中的讀取 Promise（同時多次讀取只打一次 ASP）

// 取得會員背包：記憶體有就直接用，沒有才讀資料庫；讀取失敗回傳 null
function ensureInventoryLoaded(memberId) {
  if (inventories.has(memberId)) return Promise.resolve(inventories.get(memberId));
  let loading = inventoryLoading.get(memberId);
  if (!loading) {
    loading = fetchInventory(memberId).then((r) => {
      inventoryLoading.delete(memberId);
      if (!r.ok) {
        console.error('❌ 讀取背包失敗：', r.error);
        return null;
      }
      if (!inventories.has(memberId)) inventories.set(memberId, r.slots);
      return inventories.get(memberId);
    });
    inventoryLoading.set(memberId, loading);
  }
  return loading;
}

// 存檔佇列：同一個會員的寫入排成一串依序送出，避免兩次存檔在網路上交錯、讓舊內容後到蓋掉新內容。
// 每次都寫完整背包，所以中間某次失敗，下一次成功就會補回來。
const inventorySaveChains = new Map(); // memberId -> 最後一個存檔的 Promise
function queueInventorySave(memberId, slots) {
  const prev = inventorySaveChains.get(memberId) || Promise.resolve();
  const next = prev.then(() => saveInventory(memberId, slots)).then((r) => {
    if (!r.ok) console.error('❌ 儲存背包失敗：', r.error);
  });
  inventorySaveChains.set(memberId, next);
  next.then(() => {
    if (inventorySaveChains.get(memberId) === next) inventorySaveChains.delete(memberId);
  });
}

// 背包運算（純函式，回傳新陣列，不改傳進來的 slots）
// 成功回傳 { slots }，失敗回傳 { error }
function addToInventory(slots, code, qty) {
  const def = ITEM_CATALOG[code];
  if (!def) return { error: '不明的道具' };
  const idx = slots.findIndex((s) => s.code === code);
  if (idx >= 0) {
    if (slots[idx].qty + qty > def.maxStack) return { error: '這個道具已達堆疊上限' };
    const next = slots.slice();
    next[idx] = { code, qty: slots[idx].qty + qty };
    return { slots: next };
  }
  if (slots.length >= INVENTORY_MAX_SLOTS) return { error: `背包已滿（${INVENTORY_MAX_SLOTS} 格）` };
  return { slots: slots.concat([{ code, qty }]) };
}

// 整格移除（丟下 / 丟棄都是整疊），成功回傳 { slots, removed: {code, qty} }
function removeFromInventory(slots, code) {
  const idx = slots.findIndex((s) => s.code === code);
  if (idx < 0) return { error: '背包裡沒有這個道具' };
  return { slots: slots.filter((_, i) => i !== idx), removed: slots[idx] };
}

// ---- 地上道具 ----
let groundItemCounter = 0;

// 給前端的地上道具資料（不含 source / expiresAt 等內部欄位）
function publicGroundItem(it) {
  return { id: it.id, code: it.code, qty: it.qty, x: it.x, y: it.y };
}

function groundItemsPayload(room) {
  return Array.from(room.groundItems.values()).map(publicGroundItem);
}

// 在房間裡放一個地上道具並廣播給同房間的人
function addGroundItem(room, fields) {
  groundItemCounter++;
  const item = {
    id: `g${groundItemCounter}`,
    code: fields.code,
    qty: fields.qty,
    x: fields.x,
    y: fields.y,
    source: fields.source,
    expiresAt: Date.now() + GROUND_ITEM_TTL_MS
  };
  room.groundItems.set(item.id, item);
  io.to(room.id).emit('ground-item-added', { item: publicGroundItem(item) });
  return item;
}

function removeGroundItem(room, itemId) {
  if (!room.groundItems.delete(itemId)) return false;
  io.to(room.id).emit('ground-item-removed', { id: itemId });
  return true;
}

// 房間裡隨機一個放道具的位置：2.5D 房間在可走範圍內挑；平面房間避開上下邊緣
// （下方 y 80 以後常有傳送點）
// 道具不放在傳送點 / 建築入口附近：玩家走過去撿的時候會停在入口上，
// 容易被誤會成「撿星星卻被傳送走」。前端撿道具的那段路也不會觸發傳送（見 index.asp checkDoorArrival）。
const ITEM_PORTAL_CLEARANCE = 10;   // 跟傳送點 / 入口至少保持的距離（百分比座標）
function randomGroundPoint(room) {
  const layout = getRoomLayout(room);
  const pick = () => layout
    ? randomWalkablePoint(layout)
    : [
        Math.round(clampX(10 + Math.random() * 80) * 100) / 100,
        Math.round(clampY(28 + Math.random() * 50) * 100) / 100
      ];
  const portals = room.portals || [];
  let p = pick();
  for (let i = 0; i < 30; i++) {
    if (!portals.some((pt) => Math.hypot(pt.x - p[0], pt.y - p[1]) < ITEM_PORTAL_CLEARANCE)) return p;
    p = pick();
  }
  return p;   // 房間太擠、找不到空位時就用最後一次抽到的位置
}

// ---- 自動刷道具的道具池（後台設定，存在 data/item-spawn-state.json，重啟後保留）----
// spawnPools.default：沒有個別設定的房間用這個，null = 全部道具
// spawnPools.rooms[roomId]：這個房間自己的清單；沒有這筆 = 跟預設；空陣列 = 這個房間不刷道具
const ITEM_SPAWN_STATE_FILE = path.join(STATE_DIR, 'item-spawn-state.json');
const ALL_ITEM_CODES = Object.keys(ITEM_CATALOG);

// 只留目錄裡有的 code、去重；不是陣列回傳 null
function sanitizeCodeList(raw) {
  if (!Array.isArray(raw)) return null;
  return Array.from(new Set(raw.filter((c) => typeof c === 'string' && ITEM_CATALOG[c])));
}

function loadSpawnPools() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ITEM_SPAWN_STATE_FILE, 'utf8'));
    const roomsCfg = Object.create(null);
    Object.keys((parsed && parsed.rooms) || {}).forEach((roomId) => {
      const list = sanitizeCodeList(parsed.rooms[roomId]);
      if (list) roomsCfg[roomId] = list;
    });
    return { default: sanitizeCodeList(parsed && parsed.default), rooms: roomsCfg };
  } catch (e) {
    // 檔案不存在（第一次啟動）或壞掉：用程式裡的預設值
    const roomsCfg = Object.create(null);
    Object.keys(DEFAULT_ROOM_SPAWN_POOLS).forEach((roomId) => { roomsCfg[roomId] = sanitizeCodeList(DEFAULT_ROOM_SPAWN_POOLS[roomId]); });
    return { default: null, rooms: roomsCfg };
  }
}

function saveSpawnPools() {
  try {
    fs.writeFileSync(ITEM_SPAWN_STATE_FILE, JSON.stringify({ default: spawnPools.default, rooms: spawnPools.rooms, updatedAt: Date.now() }), 'utf8');
  } catch (e) {
    console.error('❌ 寫入道具池設定失敗，重啟後可能會變回預設值：', e.message);
  }
}

const spawnPools = loadSpawnPools();

function getSpawnPool(roomId) {
  if (spawnPools.rooms[roomId]) return spawnPools.rooms[roomId];
  return spawnPools.default || ALL_ITEM_CODES;
}

function spawnPoolsPayload() {
  return { default: spawnPools.default, rooms: Object.assign({}, spawnPools.rooms) };
}

// 定時檢查（idempotent，只看目前狀態）：先清掉過期的道具，再幫距離上次刷出已超過 ITEM_SPAWN_EVERY_MS 的房間刷一個
function tickGroundItems() {
  const now = Date.now();
  Object.keys(rooms).forEach((roomId) => {
    const room = rooms[roomId];
    room.groundItems.forEach((it) => {
      if (it.expiresAt <= now) removeGroundItem(room, it.id);
    });
    if (now - room.lastItemSpawnAt < (ITEM_SPAWN_EVERY_MS_BY_ROOM[roomId] || ITEM_SPAWN_EVERY_MS)) return;
    if (room.groundItems.size >= MAX_GROUND_ITEMS_PER_ROOM) return;
    const pool = getSpawnPool(roomId);
    if (!pool.length) return;   // 後台把這個房間設成「不刷道具」
    const code = pool[Math.floor(Math.random() * pool.length)];
    const p = randomGroundPoint(room);
    addGroundItem(room, { code, qty: 1, x: p[0], y: p[1], source: 'spawn' });
    room.lastItemSpawnAt = now;
  });
}
setInterval(tickGroundItems, GROUND_ITEM_TICK_MS);

// ---- 後台：地上道具管理 ----
app.options('/admin/items', (req, res) => {
  setCorsForAdmin(res);
  res.sendStatus(204);
});

// 讀取不需要密碼（跟 /admin/rooms 一樣）：道具目錄 + 各房間目前地上有幾個道具
app.get('/admin/items', (req, res) => {
  setCorsForAdmin(res);
  const list = Object.keys(rooms).map((roomId) => ({
    id: roomId,
    name: rooms[roomId].name,
    groundCount: rooms[roomId].groundItems.size
  }));
  res.json({ ok: true, catalog: ITEM_CATALOG_PAYLOAD, categories: ITEM_CATEGORIES, rooms: list, spawnPools: spawnPoolsPayload() });
});

app.options('/admin/set-spawn-pool', (req, res) => {
  setCorsForAdmin(res);
  res.sendStatus(204);
});

// 設定自動刷道具的道具池：
//   roomId = '*'  → 設定預設道具池，codes = null 代表全部道具
//   roomId = 房間 → codes = null 代表跟預設；[] 代表這個房間不刷道具
app.post('/admin/set-spawn-pool', (req, res) => {
  setCorsForAdmin(res);
  const secret = req.headers['x-admin-secret'] || (req.body && req.body.secret);
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(403).json({ ok: false, error: '密碼錯誤' });
  }
  const body = req.body || {};
  const roomId = body.roomId;
  if (roomId !== '*' && !getRoom(roomId)) return res.status(404).json({ ok: false, error: '房間不存在' });
  let codes = null;
  if (body.codes !== null && body.codes !== undefined) {
    codes = sanitizeCodeList(body.codes);
    if (!codes) return res.status(400).json({ ok: false, error: 'codes 必須是陣列或 null' });
  }
  if (roomId === '*') {
    spawnPools.default = codes;
  } else if (codes) {
    spawnPools.rooms[roomId] = codes;
  } else {
    delete spawnPools.rooms[roomId];
  }
  saveSpawnPools();
  return res.json({ ok: true, spawnPools: spawnPoolsPayload() });
});

app.options('/admin/spawn-item', (req, res) => {
  setCorsForAdmin(res);
  res.sendStatus(204);
});

// 在指定房間的隨機位置放 count 個道具（每個數量 qty），來源記為 admin（一樣 30 分鐘沒人撿就清除）
app.post('/admin/spawn-item', (req, res) => {
  setCorsForAdmin(res);
  const secret = req.headers['x-admin-secret'] || (req.body && req.body.secret);
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(403).json({ ok: false, error: '密碼錯誤' });
  }
  const body = req.body || {};
  const room = getRoom(body.roomId);
  if (!room) return res.status(404).json({ ok: false, error: '房間不存在' });
  const code = typeof body.code === 'string' && ITEM_CODE_RE.test(body.code) ? body.code : null;
  const def = code && ITEM_CATALOG[code];
  if (!def) return res.status(400).json({ ok: false, error: '道具不存在' });
  const qty = Number(body.qty);
  const count = Number(body.count);
  if (!Number.isInteger(qty) || qty < 1 || qty > def.maxStack) {
    return res.status(400).json({ ok: false, error: `數量必須是 1 到 ${def.maxStack} 的整數` });
  }
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    return res.status(400).json({ ok: false, error: '個數必須是 1 到 10 的整數' });
  }

  let placed = 0;
  while (placed < count && room.groundItems.size < MAX_GROUND_ITEMS_PER_ROOM) {
    const p = randomGroundPoint(room);
    addGroundItem(room, { code, qty, x: p[0], y: p[1], source: 'admin' });
    placed++;
  }
  if (placed === 0) {
    return res.status(400).json({ ok: false, error: `這個房間地上的道具已達上限（${MAX_GROUND_ITEMS_PER_ROOM} 個）` });
  }
  return res.json({ ok: true, placed, requested: count, groundCount: room.groundItems.size });
});

app.options('/admin/clear-items', (req, res) => {
  setCorsForAdmin(res);
  res.sendStatus(204);
});

// 清空指定房間地上所有道具（包含玩家丟的、自動刷的）
app.post('/admin/clear-items', (req, res) => {
  setCorsForAdmin(res);
  const secret = req.headers['x-admin-secret'] || (req.body && req.body.secret);
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(403).json({ ok: false, error: '密碼錯誤' });
  }
  const room = getRoom(req.body && req.body.roomId);
  if (!room) return res.status(404).json({ ok: false, error: '房間不存在' });
  const ids = Array.from(room.groundItems.keys());
  ids.forEach((itemId) => removeGroundItem(room, itemId));
  return res.json({ ok: true, removed: ids.length, groundCount: room.groundItems.size });
});

// ---------------------------------------------------------------
// In-memory 狀態（重啟伺服器會清空；如需持久化可換成資料庫）
// 角色跟聊天紀錄已經改成「每個房間各自一份」，存在上面的 rooms 物件裡；
// 這裡只留跨房間共用的東西（角色外觀色票、角色編號流水號）。
// ---------------------------------------------------------------
const MAX_CHAT = 200;

const HAIR_COLORS = ["#3b2a20", "#8a5a34", "#c99a4a", "#d94f4f", "#5c7a5e", "#4a5b8a"];
const BODY_COLORS = ["#b5623f", "#e8b559", "#5c7a5e", "#4a5b8a", "#8a5a8a", "#3b2a20"];

// 角色的陰影顏色 / 背景光暈顏色：前端改成調色盤自由選色，不再是固定色票，
// 所以這裡不用色票陣列做白名單比對，改用正則驗證是不是合法的 #rrggbb 色碼；
// 沒帶、或帶了不合法的值，就退回下面這兩個預設色。
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_SHADOW_COLOR = "#2b2420";
const DEFAULT_GLOW_COLOR = "#ffe9a8";

let charCounter = 0;

// ---------------------------------------------------------------
// 同帳號同時上線管制：memberId -> 目前代表這個會員的 socket.id。
// 同一個會員（同一組 member_no）不管開幾個分頁、幾台裝置登入，
// 遊戲場景裡永遠只能有「最新的那一條連線」在線上——舊的連線
// join 成功後，一旦有更新的連線用同一個 memberId 進來，就會被踢掉。
// 這是「新登入為主」的策略；如果想改成「已登入時擋新登入」，
// 請參考下面 join 事件裡的註解。
// ---------------------------------------------------------------
const onlineMembers = new Map(); // memberId -> socket.id

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
      // 順便帶上這位會員存過的紙娃娃設定：
      //   dollStatus = 'saved'（有存過，前端直接用它進場）/ 'none'（第一次，必須先選角色）
      //   / 'error'（資料庫讀不到，前端仍讓玩家選角色進場）
      const dollResult = await fetchDoll(verify.memberId);
      if (!dollResult.ok) console.error('❌ 讀取紙娃娃設定失敗：', dollResult.error);
      socket.emit('token-checked', {
        ok: true,
        displayName: verify.displayName,
        doll: dollResult.ok ? dollResult.doll : null,
        dollStatus: dollResult.ok ? (dollResult.doll ? 'saved' : 'none') : 'error'
      });
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

    // ---- 同帳號同時上線管制 ----
    // verify_token.asp 回傳的 memberId 是資料庫裡真正的會員編號，不像 token
    // 每次登入都不一樣，同一個會員不管開幾個分頁重新登入，memberId 都相同，
    // 可以拿來判斷「這個人是不是已經在別的地方上線了」。
    const memberId = verify.memberId;

    // ---- 紙娃娃：一定要有角色才能進場 ----
    // 資料庫有存過就用存的；沒有的話用這次前端送來的（第一次選角），並存進資料庫。
    // 兩邊都沒有 → 回 join-error（needDoll），前端會打開選角畫面。
    const requestedDoll = sanitizeDoll(data && data.doll);
    const storedDoll = await fetchDoll(memberId);
    let doll = (storedDoll.ok && storedDoll.doll) ? storedDoll.doll : null;
    if (requestedDoll && (data && data.dollChanged)) doll = requestedDoll;   // 玩家剛在選角畫面改過
    if (!doll) doll = requestedDoll;
    if (!doll) {
      socket.emit('join-error', { error: '請先選擇角色', needDoll: true });
      return;
    }
    if (!(storedDoll.ok && storedDoll.doll) || (data && data.dollChanged)) {
      saveDoll(memberId, doll).then((r) => { if (!r.ok) console.error('❌ 儲存紙娃娃設定失敗：', r.error); });
    }
    // 記下「資料庫裡目前的裝扮」，離線時比對，有改過但沒存到的才補存（見 disconnect）
    socket.data.savedDollKey = JSON.stringify(doll);
    // 背包：記憶體有就用，沒有才讀資料庫；讀取失敗不阻擋進場，只是這次不能撿東西
    await ensureInventoryLoaded(memberId);
    if (socket.data.charId) return;

    const existingSocketId = onlineMembers.get(memberId);
    if (existingSocketId && existingSocketId !== socket.id) {
      // 策略一（目前採用）：新登入為主，把舊連線踢掉 ------------------
      const oldSocket = io.sockets.sockets.get(existingSocketId);
      if (oldSocket) {
        oldSocket.emit('kicked', { reason: '您的帳號已在其他地方登入，這個連線已被登出' });
        oldSocket.disconnect(true); // 觸發舊連線的 disconnect，會自動把舊角色從房間移除
      }
      // 策略二（如果想改成「已登入就擋新登入」，把上面兩行換成下面這樣）：
      //   socket.emit('join-error', { error: '這個帳號已經在其他地方上線中' });
      //   return;
    }
    onlineMembers.set(memberId, socket.id);
    socket.data.memberId = memberId; // disconnect 時要用，見下方 disconnect 事件

    // 名字一律採用 verify_token.asp 驗證回來的會員暱稱，不採信前端送來的 data.name，
    // 這樣就算有人繞過前端把欄位改掉（例如改 DOM），伺服器還是只認會員本人的暱稱
    const name = (verify.displayName && String(verify.displayName).trim().slice(0, 16)) || '無名旅人';
    const hair = HAIR_COLORS.includes(data && data.hair) ? data.hair : HAIR_COLORS[Math.floor(Math.random() * HAIR_COLORS.length)];
    const body = BODY_COLORS.includes(data && data.body) ? data.body : BODY_COLORS[Math.floor(Math.random() * BODY_COLORS.length)];
    const shadowColor = HEX_COLOR_RE.test(data && data.shadowColor) ? data.shadowColor : DEFAULT_SHADOW_COLOR;
    const glowColor = HEX_COLOR_RE.test(data && data.glowColor) ? data.glowColor : DEFAULT_GLOW_COLOR;

    charCounter++;
    const id = `c${charCounter}_${socket.id.slice(0, 5)}`;
    const c = {
      id,
      name,
      hair,
      body,
      shadowColor,
      glowColor,
      doll,
      x: 20 + Math.random() * 60,
      y: 30 + Math.random() * 50,
      ownerSocketId: socket.id
    };

    // 一律從預設房間（大廳）開始，不管上次斷線前傳送到哪個房間，
    // 重新連線後都從大廳重新出發，行為單純、不容易出錯。
    const roomId = DEFAULT_ROOM_ID;
    const room = getRoom(roomId);

    // 2.5D 房間：出生點改成在可走範圍內隨機挑（不會生在櫃台裡或牆上）
    if (getRoomLayout(room)) {
      const spawn = placeInRoom(room);
      c.x = spawn[0];
      c.y = spawn[1];
    }
    room.characters[id] = c;
    socket.data.charId = id;
    socket.data.roomId = roomId;
    socket.join(roomId);

    // 場景底圖：房間有在後台指定就用那張，沒指定就從 bg/ 隨機挑一張
    // 「bg 開頭的 .jpg」當預設底圖（見 getRoomBackgroundUrl 說明）。
    const background = await getRoomBackgroundUrl(room);

    // 「捏一捏 -> 身體選擇與皮膚調整」：這位會員之前存過的設定，
    // 跟底圖一樣，一次跟著 init 快照送給前端，不用前端另外再要一次。
    // 拿不到（ASP 掛掉等等）就送 null，前端會顯示預設值，不影響進場景。
    // （舊版「捏一捏」身體部位設定已改成紙娃娃，doll 直接放在角色物件裡）
    const bodyCustomization = null;

    // 「記錄 event_sort_no」：把目前所在活動分類記在這條連線自己的
    // socket.data 上（等同這個玩家這次連線的 session），非活動房間
    // （例如大廳）就是 null。之後這條連線不管做什麼動作，都可以透過
    // socket.data.eventSortNo 知道「他現在是在哪個活動分類房間裡」。
    socket.data.eventSortNo = room.sortNo || null;

    // 只回給這位新玩家：完整現況快照（含目前房間的傳送點清單）
    // 如果是活動分類房間，額外附上這個分類目前上架中的活動連結清單
    const eventLinks = room.isEventRoom ? buildEventRoomLinks(room.sortNo, room.name) : null;

    socket.emit('init', {
      selfId: id,
      roomId: room.id,
      roomName: room.name,
      portals: room.portals,
      characters: Object.values(room.characters),
      chatLog: room.chatLog,
      background,
      brightness: currentBrightness,
      eventLinks,
      bodyCustomization,
      scene: getRoomScenePayload(room),
      itemCatalog: ITEM_CATALOG_PAYLOAD,
      groundItems: groundItemsPayload(room),
      inventory: inventories.get(memberId) || null // null = 背包讀取失敗
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
    const ch = room.characters[id];

    // 2.5D 房間：目的地修正到可走範圍內，並算出繞過障礙物的路線（path），
    // 前端會沿著 path 一段一段走過去。平面房間維持原本的夾值方式。
    const layout = getRoomLayout(room);
    if (layout) {
      const target = clampToWalkable(layout, data.x, data.y);
      if (!target) return;
      const path = findScenePath(layout, [ch.x, ch.y], target);
      ch.x = target[0];
      ch.y = target[1];
      io.to(roomId).emit('char-moved', { id, x: ch.x, y: ch.y, path });
      return;
    }

    const x = clampX(data.x);
    const y = clampY(data.y);
    ch.x = x;
    ch.y = y;
    io.to(roomId).emit('char-moved', { id, x, y });
  });

  // ---- 跳躍：純視覺效果，不影響座標，只廣播「誰跳了」給同房間所有人，
  // 讓其他人也能看到動畫；一樣只能觸發自己的角色。做個簡單節流
  // （跟前端的 500ms 動畫時長對齊），避免有人狂送這個事件洗版。
  const JUMP_MIN_INTERVAL_MS = 500;
  socket.on('jump', () => {
    const roomId = socket.data.roomId;
    const id = socket.data.charId;
    const room = getRoom(roomId);
    if (!room || !id || !room.characters[id]) return;
    const now = Date.now();
    if (socket.data.lastJumpAt && now - socket.data.lastJumpAt < JUMP_MIN_INTERVAL_MS) return;
    socket.data.lastJumpAt = now;
    io.to(roomId).emit('char-jumped', { id });
  });

  // ---- 捏一捏：換髮色/衣服色/陰影顏色/背景光暈顏色，只能改自己的 ----
  // 陰影顏色、背景光暈顏色是前端調色盤自由選色送上來的 #rrggbb 色碼，
  // 不是固定色票，所以用正則驗證格式，而不是白名單比對。
  socket.on('customize', (data) => {
    const roomId = socket.data.roomId;
    const id = socket.data.charId;
    const room = getRoom(roomId);
    if (!room || !id || !room.characters[id] || !data) return;
    if (HAIR_COLORS.includes(data.hair)) room.characters[id].hair = data.hair;
    if (BODY_COLORS.includes(data.body)) room.characters[id].body = data.body;
    if (HEX_COLOR_RE.test(data.shadowColor)) room.characters[id].shadowColor = data.shadowColor;
    if (HEX_COLOR_RE.test(data.glowColor)) room.characters[id].glowColor = data.glowColor;
    io.to(roomId).emit('char-customized', {
      id,
      hair: room.characters[id].hair,
      body: room.characters[id].body,
      shadowColor: room.characters[id].shadowColor || DEFAULT_SHADOW_COLOR,
      glowColor: room.characters[id].glowColor || DEFAULT_GLOW_COLOR
    });
  });

  // ---- 捏一捏：身體選擇與皮膚調整（存檔） ----
  // 跟其他動作一樣，一律只認這條連線自己的 socket.data.memberId
  // （join 成功時就設定好了，等於已經驗證過登入 token），不採信前端
  // 額外送上來的任何會員編號，避免有人改 DOM / 改封包幫別人存檔。
  // 存到 ASP/資料庫之後，把最新狀態原樣送回這個玩家，讓面板同步顯示。
  socket.on('save-body-customization', async (data) => {
    const memberId = socket.data.memberId;
    if (!memberId || !socket.data.charId) {
      socket.emit('body-customization-saved', { ok: false, error: '尚未加入場景，無法存檔' });
      return;
    }
    if (!data || !Number.isFinite(Number(data.skinColorId))) {
      socket.emit('body-customization-saved', { ok: false, error: '膚色資料不正確' });
      return;
    }
    const parts = Array.isArray(data.parts) ? data.parts.slice(0, 50) : [];
    const result = await saveCharacterCustomization(memberId, Number(data.skinColorId), parts);
    socket.emit('body-customization-saved', result);
  });

  // ---- 紙娃娃：進場後換角色 / 換顏色 ----
  // 只能改自己的角色；驗證後更新記憶體中的角色、廣播給同房間，再存進資料庫。
  socket.on('update-doll', async (data) => {
    const roomId = socket.data.roomId;
    const id = socket.data.charId;
    const room = getRoom(roomId);
    const memberId = socket.data.memberId;
    if (!room || !id || !room.characters[id] || !memberId) return;
    const now = Date.now();
    if (socket.data.lastDollAt && now - socket.data.lastDollAt < 300) return;   // 簡單節流
    socket.data.lastDollAt = now;
    const doll = sanitizeDoll(data && data.doll);
    if (!doll) {
      socket.emit('doll-saved', { ok: false, error: '角色資料不正確' });
      return;
    }
    room.characters[id].doll = doll;
    io.to(roomId).emit('char-doll-changed', { id, doll });
    const result = await saveDoll(memberId, doll);
    if (result.ok) socket.data.savedDollKey = JSON.stringify(doll);
    socket.emit('doll-saved', result);
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
    // 所有傳送點（建築入口、傳送門）：角色要真的走到門口 / 傳送點附近才放行，
    // 不能從遠處直接送 teleport 切換場景
    {
      const me = fromRoom.characters[id];
      if (Math.hypot(me.x - portal.x, me.y - portal.y) > 8) {
        socket.emit('teleport-error', { error: portal.zone ? '請先走到建築門口' : '請先走到傳送點上' });
        return;
      }
    }

    // 房間進入檢查（見 ROOM_ENTRY_CHECKS）。檢查可能是非同步的，回來後要再確認
    // 這段時間玩家沒有離線或被傳到別的房間，才繼續傳送
    const entryCheck = ROOM_ENTRY_CHECKS[toRoomId];
    if (entryCheck) {
      let result;
      try {
        result = await entryCheck(socket, toRoom);
      } catch (e) {
        console.error('❌ 房間進入檢查失敗：', toRoomId, e.message);
        result = { ok: false, error: '暫時無法進入，請稍後再試' };
      }
      if (!result || !result.ok) {
        socket.emit('teleport-error', { error: (result && result.error) || '目前無法進入' });
        return;
      }
      if (socket.data.roomId !== fromRoomId || !fromRoom.characters[id]) return;
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
    if (getRoomLayout(toRoom)) {
      // 2.5D 房間：從回程傳送點的位置出現（建築入口用 spawn，站在門口內側，不會馬上又被傳送），
      // 並修正到可走範圍內
      const sp = spawnPortal && (spawnPortal.spawn ? { x: spawnPortal.spawn[0], y: spawnPortal.spawn[1] } : spawnPortal);
      const spawn = sp ? placeInRoom(toRoom, sp.x, sp.y) : placeInRoom(toRoom);
      c.x = spawn[0];
      c.y = spawn[1];
    } else {
      const sp = spawnPortal && (spawnPortal.spawn ? { x: spawnPortal.spawn[0], y: spawnPortal.spawn[1] } : spawnPortal);
      c.x = clampX(sp ? sp.x : 20 + Math.random() * 60);
      c.y = clampY(sp ? sp.y : 30 + Math.random() * 50);
    }

    toRoom.characters[id] = c;
    socket.join(toRoomId);
    socket.data.roomId = toRoomId;

    // 更新這條連線的「目前活動分類」記錄（見 join 事件裡的說明）
    socket.data.eventSortNo = toRoom.sortNo || null;

    // 新房間的場景底圖，跟 join 邏輯一致（見 getRoomBackgroundUrl 說明）
    const background = await getRoomBackgroundUrl(toRoom);

    // 傳送到活動分類房間時，順便帶上該分類目前上架中的活動連結清單
    const eventLinks = toRoom.isEventRoom ? buildEventRoomLinks(toRoom.sortNo, toRoom.name) : null;

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
      eventLinks,
      scene: getRoomScenePayload(toRoom),
      groundItems: groundItemsPayload(toRoom)
    });

    // 廣播給新房間的其他人：有角色傳送進來了
    socket.to(toRoomId).emit('char-joined', c);
    const joinMsg = { who: '系統', text: `${c.name} 傳送進入了場景`, isSystem: true, ts: Date.now() };
    pushChat(toRoom, joinMsg);
    io.to(toRoomId).emit('chat-message', joinMsg);
    broadcastCount(toRoomId);
  });

  // ---- 背包：撿取 / 丟到地上 / 丟棄 ----
  // 共同規則：只動這條連線自己的角色與自己的背包；背包沒載入（資料庫讀取失敗）一律拒絕，
  // 避免用空背包蓋掉資料庫。每次變動後把完整背包排進存檔佇列。
  // 取得本次道具動作的上下文並節流，不合法或太頻繁回傳 null
  function getItemActionContext() {
    const room = getRoom(socket.data.roomId);
    const id = socket.data.charId;
    const memberId = socket.data.memberId;
    if (!room || !id || !room.characters[id] || !memberId) return null;
    const now = Date.now();
    if (socket.data.lastItemActionAt && now - socket.data.lastItemActionAt < ITEM_ACTION_MIN_INTERVAL_MS) return null;
    socket.data.lastItemActionAt = now;
    return { room, ch: room.characters[id], memberId };
  }

  // 背包沒載入時回報錯誤，並在背景重試讀取一次（成功就把背包推給玩家）
  function refuseUnloadedInventory(memberId, errorText) {
    socket.emit('item-error', { error: errorText });
    ensureInventoryLoaded(memberId).then((slots) => {
      if (slots) socket.emit('inventory-changed', { slots });
    });
  }

  // 撿取：玩家走到道具旁後送出。道具從房間移除必須在任何 await 之前完成（同步），
  // 兩個人同時撿同一個道具時，只有先處理到的那個拿得到。
  socket.on('pickup-item', (data) => {
    const ctx = getItemActionContext();
    if (!ctx) return;
    const itemId = data && typeof data.itemId === 'string' ? data.itemId.slice(0, 20) : '';
    const item = ctx.room.groundItems.get(itemId);
    if (!item) {
      socket.emit('item-error', { error: '這個道具已經不見了' });
      return;
    }
    if (Math.hypot(ctx.ch.x - item.x, ctx.ch.y - item.y) > PICKUP_RANGE) {
      socket.emit('item-error', { error: '離道具太遠了，請再靠近一點' });
      return;
    }
    const slots = inventories.get(ctx.memberId);
    if (!slots) return refuseUnloadedInventory(ctx.memberId, '背包讀取失敗，暫時無法撿取道具');
    const result = addToInventory(slots, item.code, item.qty);
    if (result.error) {
      socket.emit('item-error', { error: result.error });
      return;
    }
    removeGroundItem(ctx.room, item.id);
    inventories.set(ctx.memberId, result.slots);
    const def = ITEM_CATALOG[item.code];
    socket.emit('inventory-changed', { slots: result.slots, action: 'pickup', notice: `撿到 ${def.icon} ${def.name} ×${item.qty}` });
    queueInventorySave(ctx.memberId, result.slots);
  });

  // 丟到地上：整疊丟在角色腳邊，其他人可以撿，30 分鐘沒人撿就清除
  socket.on('drop-item', (data) => {
    const ctx = getItemActionContext();
    if (!ctx) return;
    const code = data && typeof data.code === 'string' && ITEM_CODE_RE.test(data.code) ? data.code : null;
    if (!code) return;
    const slots = inventories.get(ctx.memberId);
    if (!slots) return refuseUnloadedInventory(ctx.memberId, '背包讀取失敗，暫時無法丟下道具');
    if (ctx.room.groundItems.size >= MAX_GROUND_ITEMS_PER_ROOM) {
      socket.emit('item-error', { error: '這個房間地上的道具太多了，晚點再丟' });
      return;
    }
    const result = removeFromInventory(slots, code);
    if (result.error) {
      socket.emit('item-error', { error: result.error });
      return;
    }
    // 腳邊稍微錯開，連續丟好幾種才不會疊在同一個點上
    const p = placeInRoom(ctx.room, ctx.ch.x + (Math.random() - 0.5) * 4, ctx.ch.y + Math.random() * 2);
    addGroundItem(ctx.room, {
      code, qty: result.removed.qty, x: p[0], y: p[1],
      source: 'drop'
    });
    inventories.set(ctx.memberId, result.slots);
    socket.emit('inventory-changed', { slots: result.slots, action: 'drop' });
    queueInventorySave(ctx.memberId, result.slots);
  });

  // 丟棄：整疊直接刪除，不會出現在地上
  socket.on('discard-item', (data) => {
    const ctx = getItemActionContext();
    if (!ctx) return;
    const code = data && typeof data.code === 'string' && ITEM_CODE_RE.test(data.code) ? data.code : null;
    if (!code) return;
    const slots = inventories.get(ctx.memberId);
    if (!slots) return refuseUnloadedInventory(ctx.memberId, '背包讀取失敗，暫時無法丟棄道具');
    const result = removeFromInventory(slots, code);
    if (result.error) {
      socket.emit('item-error', { error: result.error });
      return;
    }
    inventories.set(ctx.memberId, result.slots);
    socket.emit('inventory-changed', { slots: result.slots, action: 'discard' });
    queueInventorySave(ctx.memberId, result.slots);
  });

  // ---- 離線：把角色從場景移除，通知大家 ----
  socket.on('disconnect', () => {
    // 只有「onlineMembers 裡記錄的還是自己這條連線」才清掉；如果這個
    // memberId 已經被更新的連線覆蓋過去（代表自己是被踢掉的那個舊連線），
    // 就不要動它，避免把新連線剛寫入的記錄誤刪。
    const isCurrentConnection = socket.data.memberId && onlineMembers.get(socket.data.memberId) === socket.id;
    if (isCurrentConnection) {
      onlineMembers.delete(socket.data.memberId);
    }

    const roomId = socket.data.roomId;
    const id = socket.data.charId;
    const room = getRoom(roomId);
    if (room && id && room.characters[id]) {
      // 登出 / 關閉分頁時保存離線當下的裝扮：只有跟資料庫不一樣（例如換裝後馬上登出、
      // 存檔被節流或失敗）才補存，下次登入就能選「上次的裝扮」。
      // 被同帳號新登入踢掉的舊連線不存，避免舊裝扮蓋掉新連線剛選的裝扮。
      const lastDoll = room.characters[id].doll;
      if (isCurrentConnection && lastDoll && JSON.stringify(lastDoll) !== socket.data.savedDollKey) {
        saveDoll(socket.data.memberId, lastDoll).then((r) => { if (!r.ok) console.error('❌ 離線時儲存紙娃娃設定失敗：', r.error); });
      }
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

// ---------------------------------------------------------------
// Project Starforge 遊戲服務：掛在同一個服務的 Socket.io namespace「/starforge」，
// 程式在 starforge/server/（部署時要把整個 starforge/server 資料夾一起放進這個 repo）。
// 跟社群平台的連線、房間、事件完全分開；沿用這裡的 token 驗證與 API Key，
// 另外可用環境變數 STARFORGE_API_URL / STARFORGE_API_KEY 覆寫。
// ---------------------------------------------------------------
try {
  require('./starforge/server')({ io, app, verifyLoginToken, verifyTokenUrl: VERIFY_TOKEN_URL, apiKey: VERIFY_API_KEY });
} catch (err) {
  console.warn('[starforge] 遊戲服務沒有啟動（社群平台不受影響）：' + err.message);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ 伺服器已啟動： http://localhost:${PORT}`);
});
