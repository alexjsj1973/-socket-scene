// ============================================================
// Starforge 遊戲服務（第一版）- 掛在既有 socket-scene 服務上的獨立模組
//
// 用法（server.js 裡）：
//   require('./starforge/server')({ io, app, verifyLoginToken, verifyTokenUrl: VERIFY_TOKEN_URL, apiKey: VERIFY_API_KEY });
//
// 做什麼：
//   * Socket.io namespace「/starforge」：跟社群平台的連線完全分開，互不影響
//   * 進場：token → verify_token.asp 取會員編號 → game_api.asp 取角色與隊伍；
//     沒有角色或隊伍就回 join-error { needLobby:true }，前端導回大廳
//   * 地形：依場次 seed 用 terrain.js 生成（瀏覽器載入同一支 /starforge/terrain.js）
//   * 移動：前端送目的地，伺服器檢查可走、每 100ms 依速度移動、廣播位置（伺服器是唯一真相）
//   * 插旗：只有隊長、隊伍還沒插旗；伺服器檢查地形、間距、水源，再寫入資料庫，廣播給所有人
//   * 位置存檔：離線時、以及每 2 分鐘寫回資料庫；重新進場從上次位置出現
//   * 資源：隊伍插旗後，依後台的「資源分佈」在該隊領地裡一個一個生成資源，位置與可採數量寫進資料庫後就固定；
//     管理員隨時改數量 / 範圍 / 按「重置所有資源」，這裡每 30 秒向 game_api.asp 確認一次，有變就同步並通知所有玩家
//     （調高 = 隱藏的放回原位、不夠再長新的；調低 = 編號大的先隱藏；改範圍只影響新長的；重置 = 換一個 epoch 全部重來）
//   * 採集：只能採自己隊伍領地內的；伺服器檢查距離、冷卻、剩餘量、背包容量。背包與資源每 30 秒批次寫回資料庫
//     採光的資源會「搬家」：原位置消失，在同隊領地裡另找一個空位重新長出來，剩餘量從 0 開始慢慢長到可採數量上限
//     （可採數量用現在的資源分佈設定重新抽；同一筆資料、同一個代碼，只是換位置，所以資料庫不用改）
//   * 資源設定（後台「資源分佈」）：每種的數量、可採範圍、再生秒數、野外密度、樹木 / 花朵品種比例，每 30 秒同步一次；
//     再生秒數、野外密度、品種比例改了馬上生效（野外資源依新密度重算，前端收到 nodes-sync 也會重算）
//   * 資源擋路：所有可採的東西（領地裡的資源節點 + 野外的樹、礦、花）都有圓形佔地，玩家走不進去；
//     移動時撞到會沿邊緣繞過去，繞不過去（3 秒沒有更接近目的地）就停下。野外資源由 wild.js 依 seed 算出（與瀏覽器同一份）
//   * 換造型（2026-11-22 起）：角色改成 output/character-design-v1 的骨架角色（前端 js/sf-avatar.js），
//     造型代碼 look.code = 'v2:<m|f>:<髮型>:<衣服>:<鞋子>[:<色名>=<rrggbb>,…]'（normalizeLookCode，規則與 sf-avatar.js、
//     inc_sf_character.asp 的 SfLookCodeOk 一致）；玩家隨時可以換，ASP 再檢查一次並存檔，成功後廣播給所有人。
//     舊的 40 種公仔造型（look.char）不能進世界：join 回 needLook，前端導回大廳重新捏角色
//   * 走路 / 跑步 / 跳躍：move 帶 run:true 用跑速；positions 的移動旗標 1 = 走、2 = 跑；jump 只是動作展示（限速後廣播 char-jump）
//   * 背包：可以放棄（直接消失）或丟在地上；地上的物品任何人都能撿，10 分鐘沒人撿就消失（只放記憶體，重啟會清空）
//   * 工廠流水線（2026-11-13）：factory-server.js（模擬在 factory.js，前後端共用）；這裡只在載入世界、插旗、採集、
//     進場 / 離線、場次切換時呼叫它（搜尋 fac.）。設計見 docs/FACTORY_DESIGN.md
//   * 戰鬥（2026-11-22）：combat.js（生物資料與漫遊在 creatures.js，前後端共用）。角色有血量、經驗值、等級；
//     點動物 / 怪物走過去攻擊，怪物會主動追打、猛獸被打才還手、草食動物會逃；打倒給經驗值與掉落物品；
//     角色倒下 5 秒後在隊伍旗子旁復活。倒下時不能移動、採集、撿東西。經驗值與等級寫回資料庫（act=saveexp）
//   * 聊天：跟社群平台集會廣場同一套玩法（對話紀錄 + 頭上泡泡 + 進出世界的系統訊息），分「全體」與「隊伍」兩個頻道；
//     紀錄只放記憶體（各留最近 CHAT_LOG_MAX 則），換場次或重啟就清空；隊伍頻道只送給同隊（Socket.io room team:<隊伍編號>）
// 狀態只放在記憶體（Render 重啟會清空），需要保留的（旗子、位置）都寫進資料庫，
// 啟動或場次切換時從資料庫重新載入（GDD 34.3）。
// ============================================================
const path = require('path');
const SfTerrain = require('./terrain');
const SfResources = require('./resources');
const SfWild = require('./wild');
const createAspApi = require('./asp-api');
const createFactoryServer = require('./factory-server');   // 工廠流水線（2026-11-13，設計見 docs/FACTORY_DESIGN.md）
const createCombat = require('./combat');                  // 戰鬥（2026-11-22）：血量、攻擊、經驗值、掉落

const TICK_MS = 100;                 // 伺服器移動模擬間隔
const WALK_SPEED = 4;                // 走路速度（格 / 秒）
const RUN_SPEED = 7;                 // 跑步速度（格 / 秒；就是以前唯一的移動速度）
const JUMP_GAP_MS = 900;             // 跳躍的最短間隔（跳躍動作 0.96 秒）
const SAVE_EVERY_MS = 2 * 60 * 1000; // 定期存位置
const WORLD_REFRESH_MS = 30 * 1000;  // 定期向資料庫確認場次（GM 結束場次、換新場次、改資源分佈、改再生倍率）
const FLUSH_EVERY_MS = 30 * 1000;    // 背包、資源節點批次存檔間隔
const DROP_TTL_MS = 10 * 60 * 1000;  // 地上的物品多久沒人撿就消失
const DROP_MAX = 500;                // 整個世界最多同時有幾堆地上物品
const ITEM_OP_GAP_MS = 200;          // 丟棄 / 丟地上 / 撿起的最短間隔（防連點洗訊息）
const LOOK_GAP_MS = 1500;            // 換造型的最短間隔
// ---- 手持道具：只決定角色手上拿什麼、播什麼動作，不影響採集速度、戰鬥或其他數值 ----
// 2026-11-14 起道具是背包物品（resources.js 的 EQUIPMENT，與 assets/sunnyside/equipment/catalog.json 的 id 一致）：
//   背包裡要有才能拿；背包裡沒了（丟掉、放進機器…）會自動收起
const HELD_ITEMS = new Set(Object.keys(SfResources.EQUIPMENT));   // 含 2026-11-22 新增的 12 種石器（cat: 'stone'）
// ---- 角色造型代碼（與 js/sf-avatar.js 的 parse / encode、inc/inc_sf_character.asp 的 SfLookCodeOk 一致，改一邊就要改另一邊）----
const LOOK_HAIRS = new Set(['00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10']);   // 00 = 光頭
const LOOK_OUTFITS = new Set(['starter'].concat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => 'p' + String(n).padStart(2, '0')),
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => 'n' + String(n).padStart(2, '0'))));   // 衣服與鞋子共用同一份代碼
const LOOK_COLORS = ['skin', 'hair', 'eye', 'cloth', 'fur', 'cord', 'shoes'];
// 合法就回傳「標準寫法」（顏色依固定順序、小寫、不重複），不合法回 null
function normalizeLookCode(code) {
  if (typeof code !== 'string' || code.length > 160) return null;
  const m = /^v2:([mf]):(\d\d):(starter|[pn]\d\d):(starter|[pn]\d\d)(?::(.*))?$/.exec(code);
  if (!m || !LOOK_HAIRS.has(m[2]) || !LOOK_OUTFITS.has(m[3]) || !LOOK_OUTFITS.has(m[4])) return null;
  const colors = {};
  if (m[5]) {
    for (const part of m[5].split(',')) {
      const kv = /^([a-z]+)=([0-9a-fA-F]{6})$/.exec(part);
      if (!kv || LOOK_COLORS.indexOf(kv[1]) < 0) return null;
      colors[kv[1]] = kv[2].toLowerCase();
    }
  }
  const cs = LOOK_COLORS.filter((k) => colors[k]).map((k) => k + '=' + colors[k]);
  return 'v2:' + m[1] + ':' + m[2] + ':' + m[3] + ':' + m[4] + (cs.length ? ':' + cs.join(',') : '');
}
const HELD_CHECK_MS = 2000;          // 多久檢查一次「手上的道具還在不在背包」
const HELD_GAP_MS = 300;             // 換手持道具的最短間隔
const USE_GAP_MS = 700;              // 揮動 / 使用道具（只播動畫）的最短間隔
const CHAT_MAX_LEN = 100;            // 一則聊天最多幾個字（與前端輸入框 maxlength 一致）
const CHAT_GAP_MS = 700;             // 同一人兩則聊天的最短間隔（防洗版）
const CHAT_LOG_MAX = 60;             // 全體頻道、每個隊伍頻道各保留幾則（新進場的人看得到最近的對話）

module.exports = function attachStarforge(opts) {
  const { io, app, verifyLoginToken } = opts;
  const apiUrl = process.env.STARFORGE_API_URL ||
    String(opts.verifyTokenUrl || '').replace(/verify_token\.asp.*$/i, 'starforge/game_api.asp');
  const api = createAspApi(apiUrl, process.env.STARFORGE_API_KEY || opts.apiKey || '');
  const nsp = io.of('/starforge');

  // 瀏覽器用的地形程式（與伺服器同一份）；factory.js = 工廠流水線的模擬（前後端同一份，畫面才會跟伺服器一致）
  // creatures.js = 野生動物與怪物的資料、生成與漫遊（2026-11-22，前後端同一份，位置才會一致）
  ['terrain.js', 'resources.js', 'wild.js', 'factory.js', 'creatures.js'].forEach((f) => {
    app.get('/starforge/' + f, (req, res) => {
      res.set('Cache-Control', 'public, max-age=300');
      res.sendFile(path.join(__dirname, f));
    });
  });
  // Godot 版用的資料（2026-11-16）：物品、資源種類、礦物權重、採集規則。
  //   網頁版直接載入 resources.js；Godot 讀不了 JS，所以把同一份資料轉成 JSON。
  //   Godot 網頁版放在 ASP 主機（別的網域），要允許跨網域讀取（只有公開的遊戲資料，沒有機密）。
  app.get('/starforge/meta.json', (req, res) => {
    const R = SfResources, pick = (o, keys) => { const r = {}; keys.forEach((k) => { if (o[k] !== undefined) r[k] = o[k]; }); return r; };
    const ITEMS = {};                       // 含工廠材料（factory.js 載入時會補進 SfResources.ITEMS）
    for (const k of Object.keys(R.ITEMS)) ITEMS[k] = pick(R.ITEMS[k], ['name', 'icon', 'art', 'equip']);
    const NODE_TYPES = {};
    for (const k of Object.keys(R.NODE_TYPES)) NODE_TYPES[k] = pick(R.NODE_TYPES[k], ['item', 'name', 'terrain', 'regenSec']);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ ITEMS, NODE_TYPES, MINERALS: R.MINERALS, EQUIPMENT: R.EQUIPMENT, GATHER_RANGE: R.GATHER_RANGE,
               GATHER_COOLDOWN: R.GATHER_COOLDOWN, PICKUP_RANGE: R.PICKUP_RANGE, BAG_KINDS: R.BAG_KINDS });
  });

  // ---- 世界狀態（目前進行中的場次） ----
  // world = { session, terrain, teams: Map(teamId → team),
  //           nodes: Map(nodeId → { id, teamId, type, idx, x, y, max, amount, t, active }), dirtyNodes: Set,
  //           teamSpots: Map(teamId → { key, plains, hills })（領地空地，找位置放新資源用）,
  //           drops: Map(dropId → { id, item, qty, x, y, t }), dropSeq }
  let world = null;
  let loading = null;    // 載入中的 Promise，避免同時載入兩次
  const players = new Map();   // socket.id → player
  let plantQueue = Promise.resolve();   // 插旗一次處理一件，避免兩隊同時插在太近的位置

  // ---- 工廠流水線（factory-server.js）：用到的世界資料都透過這裡拿，函式在呼叫時才取用 ----
  const fac = createFactoryServer({
    nsp, api, players,
    getWorld: () => world,
    teamBlocks: (team) => teamBlocks(team),
    sendChat: (msg) => sendChat(msg),
    dropAt: (item, qty, x, y) => dropAt(item, qty, x, y)
  });
  // ---- 戰鬥（combat.js）----
  const combat = createCombat({
    nsp, players, api,
    getWorld: () => world,
    obstacleFn: (w) => obstacleFn(w),
    territorySet: (w) => territorySet(w),
    dropAt: (item, qty, x, y, fx, fy) => dropAt(item, qty, x, y, fx, fy),
    sendChat: (msg) => sendChat(msg)
  });

  async function loadWorld() {
    const r = await api.world();
    if (!r.ok) throw new Error(r.error || '讀取場次失敗');
    const teams = new Map();
    (r.teams || []).forEach((t) => teams.set(t.id, t));
    const nr = await api.nodes();
    if (!nr.ok) throw new Error(nr.error || '讀取資源節點失敗');
    const w = { session: r.session, terrain: SfTerrain.create(r.session.seed, r.session.mapChunks), teams,
                nodes: new Map(), dirtyNodes: new Set(), teamSpots: new Map(), drops: new Map(), dropSeq: 0,
                chat: { world: [], teams: new Map() },     // 聊天紀錄跟著場次走：換場次就是新的世界、新的對話
                wild: null, nodeVer: 0, grid: null, gridVer: -1, terrKey: '', terrSet: new Set() };   // 資源擋路用（見 obstacleAt）
    w.cfg = SfResources.normalizeConfig(r.session.resources);              // 資源設定（數量、可採範圍、再生秒數、野外密度、品種）
    w.wild = SfWild.create(w.terrain, SfResources.wildDensities(w.cfg));
    (nr.nodes || []).forEach((row) => { const n = nodeFromDb(row); if (n) w.nodes.set(n.id, n); });
    // 已插旗的隊伍：數量跟設定不一樣就補上 / 隱藏（例如伺服器停機時管理員改過設定）
    for (const t of teams.values()) syncTeamNodes(w, t);
    // 工廠：載入各隊存檔並補算離線期間的生產（採礦機底下的資源也一併確認）
    await fac.loadAll(w);
    return w;
  }
  // game_api.asp act=nodes 的一列：[id, teamId, type, x, y, max, amount, changedMs, active]
  function nodeFromDb(row) {
    const [id, teamId, type, x, y, max, amount, t, active] = row;
    const m = /^t\d+_[a-z]+_(\d+)$/.exec(String(id || ''));
    if (!m || !SfResources.NODE_TYPES[type]) return null;
    return { id, teamId: Number(teamId), type, idx: Number(m[1]), x: Number(x), y: Number(y), max: Number(max),
             amount: Number(amount), t: Number(t), active: !!Number(active) };
  }
  // 某隊領地裡的空地（洗牌後快取；旗子不會換，所以同一隊一直用同一份）
  //   2026-11-22 礦區：sp.patches = 每種資源的礦區中心（resources.js 的 planPatches），新資源放在礦區裡；
  //   中心依「隊伍 + 旗子 + 資源 epoch」固定（重啟後一樣，重置資源會換一組），每種要開幾片跟著後台數量走（數量變了才重新規劃）
  //   sp.blocked = 工廠建築佔的格子（每次放資源前更新，新資源不會長在輸送帶、機器底下）
  function teamSpots(w, team) {
    const cfg = SfResources.normalizeConfig(w.session.resources), epoch = w.session.resourceEpoch || 0;
    const key = team.flagX + ',' + team.flagY + '|' + epoch + '|' + JSON.stringify(SfResources.patchCounts(cfg));
    let sp = w.teamSpots.get(team.id);
    if (!sp || sp.key !== key) {
      const blocks = SfTerrain.initialTerritory(team.flagX, team.flagY, w.session.initialBlocks, w.session.mapChunks);
      sp = Object.assign({ key }, SfResources.landTiles(w.terrain, blocks, team.flagX, team.flagY));
      const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } };
      shuffle(sp.plains); shuffle(sp.hills);
      const seed = Math.floor(SfTerrain.hash2(team.id, Math.floor(team.flagX) * 4096 + Math.floor(team.flagY), epoch + 1) * 1e9);
      sp.patches = SfResources.planPatches(sp, cfg, seed, fac.buildingTiles(w, team.id));
      w.teamSpots.set(team.id, sp);
    }
    sp.blocked = fac.buildingTiles(w, team.id);
    return sp;
  }
  // 讓某隊領地裡的資源數量符合目前設定；回傳有變動的資源（呼叫端負責廣播）
  //   數量不夠：先把隱藏的（編號小的先）放回原位，還不夠再找空位長新的（可採數量用「現在」的範圍抽）
  //   數量太多：編號大的先隱藏（不刪除，剩餘量保留）
  // 採光的資源搬到同隊領地裡的另一個空位，剩餘量歸 0（之後依再生速度慢慢長回可採數量上限）
  //   回傳 true = 搬好了；領地裡找不到空位就留在原地（一樣從 0 長回來）
  function respawnNode(w, n) {
    const team = w.teams.get(n.teamId);
    const cfg = SfResources.normalizeConfig(w.session.resources)[n.type];
    if (cfg) n.max = cfg.min + Math.floor(Math.random() * (cfg.max - cfg.min + 1));   // 可採數量用現在的設定重新抽
    n.amount = 0; n.t = Date.now();
    w.dirtyNodes.add(n.id);
    if (!team || team.flagX == null) return false;
    // 被佔用的位置：同隊所有資源（含隱藏的）；原本的位置也算，才不會搬回同一格
    const occupied = new Set();
    for (const m of w.nodes.values()) if (m.teamId === n.teamId) occupied.add(Math.floor(m.x) + ',' + Math.floor(m.y));
    // 搬到同一片礦區裡的另一個空位（從最近的幾個空位隨機挑，才不會老是搬回同一格）；沒有礦區時照舊散布
    const sp = teamSpots(w, team);
    const spot = SfResources.findSpot(sp, occupied, n.type, { spread: 4 });
    if (!spot) return false;
    [n.x, n.y] = spotPos(spot);
    w.nodeVer++;
    return true;
  }
  // 空地格子 → 資源位置：格子中心再錯開一點點（±0.2 格，依座標固定），礦區看起來才不會排得像棋盤；不會跑出那一格
  const spotPos = (spot) => [+(spot[0] + 0.5 + (SfTerrain.hash2(spot[0], spot[1], 4241) - 0.5) * 0.4).toFixed(2),
                             +(spot[1] + 0.5 + (SfTerrain.hash2(spot[0], spot[1], 7717) - 0.5) * 0.4).toFixed(2)];
  function syncTeamNodes(w, team) {
    if (!w || !team || team.flagX == null) return [];
    const cfg = SfResources.normalizeConfig(w.session.resources);
    const mine = [];
    for (const n of w.nodes.values()) if (n.teamId === team.id) mine.push(n);
    const occupied = new Set(mine.map((n) => Math.floor(n.x) + ',' + Math.floor(n.y)));   // 隱藏的也佔著位置，放回來才在原位
    const changed = [], now = Date.now();
    for (const type of Object.keys(SfResources.NODE_TYPES)) {
      const list = mine.filter((n) => n.type === type).sort((a, b) => a.idx - b.idx);
      const want = cfg[type].count;
      let active = list.filter((n) => n.active).length;
      for (const n of list) {
        if (active >= want) break;
        if (!n.active) { n.active = true; active++; changed.push(n); }
      }
      let nextIdx = list.length ? list[list.length - 1].idx + 1 : 0;
      while (active < want) {
        const spot = SfResources.findSpot(teamSpots(w, team), occupied, type);
        if (!spot) { console.warn('[starforge] 隊伍 ' + team.id + ' 的領地放不下更多' + SfResources.NODE_TYPES[type].name); break; }
        occupied.add(spot[0] + ',' + spot[1]);
        const c = cfg[type], max = c.min + Math.floor(Math.random() * (c.max - c.min + 1));
        const n = { id: 't' + team.id + '_' + type + '_' + nextIdx, teamId: team.id, type, idx: nextIdx,
                    x: spotPos(spot)[0], y: spotPos(spot)[1], max, amount: max, t: now, active: true };
        nextIdx++; active++;
        w.nodes.set(n.id, n);
        changed.push(n);
      }
      for (let i = list.length - 1; i >= 0 && active > want; i--) {
        if (list[i].active) { list[i].active = false; active--; changed.push(list[i]); }
      }
    }
    changed.forEach((n) => w.dirtyNodes.add(n.id));
    if (changed.length) w.nodeVer++;
    return changed;
  }
  async function ensureWorld(expectSessionId) {
    if (world && (!expectSessionId || world.session.id === expectSessionId)) return world;
    if (!loading) loading = loadWorld().finally(() => { loading = null; });
    const w = await loading;
    if (!world || world.session.id !== w.session.id) {
      if (world) fac.saveAll(world, true);      // 舊場次的工廠先存起來
      // 換場次：舊場次的玩家全部請回大廳
      for (const [sid, p] of players) {
        const s = nsp.sockets.get(sid);
        if (s) { s.emit('join-error', { error: '世界場次已更換，請回到大廳重新進入', needLobby: true }); s.disconnect(true); }
      }
      players.clear();
    }
    world = w;
    return world;
  }
  // 定期確認場次：GM 結束 / 換場次時讓玩家離開；改了資源分佈、再生倍率、按了重置就同步
  setInterval(async () => {
    if (!world) return;
    const w = world;
    const r = await api.world();
    if (w !== world) return;
    // 連線失敗之類的暫時錯誤不處理，只有「確定沒有場次」或「換了場次」才請玩家離開
    if (!r.ok && !/沒有進行中/.test(r.error || '')) return;
    if (!r.ok || r.session.id !== w.session.id) {
      for (const [sid] of players) {
        const s = nsp.sockets.get(sid);
        if (s) { s.emit('join-error', { error: r.ok ? '世界場次已更換' : '目前沒有進行中的世界', needLobby: true }); s.disconnect(true); }
      }
      players.clear();
      fac.saveAll(w, true);                      // 場次結束 / 更換前把工廠存起來
      world = null;
      return;
    }
    (r.teams || []).forEach((t) => { if (!w.teams.has(t.id)) w.teams.set(t.id, t); });
    applySessionUpdate(w, r.session);
  }, WORLD_REFRESH_MS);

  // 場次設定有變：資源重置（epoch 變了）→ 全部重新分佈；資源分佈變了 → 各隊補上 / 隱藏；再生倍率變了 → 通知前端
  function applySessionUpdate(w, s) {
    const old = w.session;
    w.session = s;
    // 資源設定（含再生秒數、野外密度、品種權重）：野外密度改了就重建野外資源（擋路判斷跟著換）
    const oldWild = JSON.stringify(SfResources.wildDensities(w.cfg));
    w.cfg = SfResources.normalizeConfig(s.resources);
    if (JSON.stringify(SfResources.wildDensities(w.cfg)) !== oldWild) { w.wild = SfWild.create(w.terrain, SfResources.wildDensities(w.cfg)); combat.onWildChange(w); }
    combat.onSessionUpdate(w);                   // 怪物密度 / 比例改了：之後生成的區塊用新設定
    if ((s.resourceEpoch || 0) !== (old.resourceEpoch || 0)) {
      // 後台已經刪掉舊的資源資料；這裡清掉記憶體（還沒存的也不要了）重新生成
      w.nodes.clear(); w.dirtyNodes.clear(); w.teamSpots.clear(); w.nodeVer++;
      for (const t of w.teams.values()) syncTeamNodes(w, t);
      for (const t of w.teams.values()) fac.revalidateMiners(w, t.id);   // 採礦機改挖範圍內的新資源，或停機
      nsp.emit('nodes-reset', { rows: activeNodeRows(w), resources: s.resources || null, regenMultiplier: s.regenMultiplier });
      flushNodes();
      console.log('[starforge] 資源已重置（epoch ' + s.resourceEpoch + '）');
      return;
    }
    const cfgChanged = JSON.stringify(s.resources || null) !== JSON.stringify(old.resources || null);
    const changed = [];
    if (cfgChanged) for (const t of w.teams.values()) { changed.push(...syncTeamNodes(w, t)); fac.revalidateMiners(w, t.id); }
    if (cfgChanged || s.regenMultiplier !== old.regenMultiplier) emitNodeSync(changed);
    if (changed.length) flushNodes();
  }
  // 通知前端：rows = 新出現 / 放回來的資源，removed = 隱藏的資源代碼，順便帶最新的資源分佈與再生倍率
  function emitNodeSync(changed) {
    if (!world) return;
    nsp.emit('nodes-sync', {
      rows: changed.filter((n) => n.active).map(nodeRow),
      removed: changed.filter((n) => !n.active).map((n) => n.id),
      resources: world.session.resources || null,
      regenMultiplier: world.session.regenMultiplier
    });
  }

  const publicPlayer = (p) => ({ id: p.charId, name: p.name, look: p.look, teamId: p.teamId, x: p.x, y: p.y, dir: p.dir, held: p.held || null,
                                 level: p.level, hp: Math.ceil(p.hp), maxHp: p.maxHp, dead: !!p.dead });   // 血量、等級（戰鬥，2026-11-22）
  const publicTeam = (t) => ({ id: t.id, name: t.name, level: t.level, flagX: t.flagX, flagY: t.flagY });
  const regenMult = () => (world && world.session.regenMultiplier) || 1;
  // 給前端的資源：[id, type, x, y, max, amount, changedMs]（只送顯示中的）
  const nodeRow = (n) => [n.id, n.type, n.x, n.y, n.max, n.amount, n.t];
  const activeNodeRows = (w) => { const out = []; for (const n of w.nodes.values()) if (n.active) out.push(nodeRow(n)); return out; };
  const dropRow = (d) => [d.id, d.item, d.qty, d.x, d.y];

  // ---- 資源擋路 ----
  // 資源節點依區塊建索引（資源有新增 / 搬家 / 隱藏時 nodeVer + 1，下次查詢才重建）
  function nodesNearFn(w) {
    if (w.gridVer !== w.nodeVer || !w.grid) {
      w.grid = new Map(); w.gridVer = w.nodeVer;
      for (const n of w.nodes.values()) {
        if (!n.active) continue;
        const k = Math.floor(n.x / SfTerrain.CHUNK) + ',' + Math.floor(n.y / SfTerrain.CHUNK);
        if (!w.grid.has(k)) w.grid.set(k, []);
        w.grid.get(k).push(n);
      }
    }
    return (x, y) => {
      const cx = Math.floor(x / SfTerrain.CHUNK), cy = Math.floor(y / SfTerrain.CHUNK), out = [];
      for (let yy = cy - 1; yy <= cy + 1; yy++) for (let xx = cx - 1; xx <= cx + 1; xx++) { const l = w.grid.get(xx + ',' + yy); if (l) out.push(...l); }
      return out;
    };
  }
  // 所有已插旗隊伍的領地區塊（野外資源不放在領地裡）
  function territorySet(w) {
    const key = Array.from(w.teams.values()).map((t) => t.id + ':' + t.flagX + ',' + t.flagY).join('|');
    if (key !== w.terrKey) {
      w.terrKey = key; w.terrSet = new Set();
      for (const t of w.teams.values()) if (t.flagX != null) {
        SfTerrain.initialTerritory(t.flagX, t.flagY, w.session.initialBlocks, w.session.mapChunks).forEach((b) => w.terrSet.add(b.cx + ',' + b.cy));
      }
    }
    return w.terrSet;
  }
  // (x, y) 被哪個資源擋住（沒有回 null）
  function obstacleFn(w) {
    const near = nodesNearFn(w), terr = territorySet(w);
    return (x, y) => w.wild.obstacleAt(x, y, terr, near);
  }

  // ---- 聊天 ----
  // 訊息格式（送給前端）：{ channel: 'world' | 'team', who, charId, teamId, text, isSystem, ts }
  // 全體頻道 nsp.emit；隊伍頻道 nsp.to('team:<id>')。前端收到非系統訊息時，同時在說話者頭上顯示泡泡。
  function teamLog(w, teamId) {
    if (!w.chat.teams.has(teamId)) w.chat.teams.set(teamId, []);
    return w.chat.teams.get(teamId);
  }
  function pushLog(list, msg) { list.push(msg); if (list.length > CHAT_LOG_MAX) list.shift(); }
  function sendChat(msg) {
    if (!world) return;
    if (msg.channel === 'team') { pushLog(teamLog(world, msg.teamId), msg); nsp.to('team:' + msg.teamId).emit('chat-message', msg); }
    else { pushLog(world.chat.world, msg); nsp.emit('chat-message', msg); }
  }
  const systemChat = (text) => sendChat({ channel: 'world', who: '系統', charId: null, teamId: null, text, isSystem: true, ts: Date.now() });
  // 進場時給的對話紀錄：全體 + 自己隊伍，依時間排好
  function chatLogFor(w, teamId) {
    return w.chat.world.concat(teamLog(w, teamId)).sort((a, b) => a.ts - b.ts).slice(-CHAT_LOG_MAX);
  }
  // 清掉控制字元與前後空白、限制長度（顯示時前端一律當純文字）
  function cleanChatText(v) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '').trim().slice(0, CHAT_MAX_LEN);
  }
  // 隊伍目前的領地（第一版：插旗位置的初始領地；擴張之後再加）
  const teamBlocks = (team) => (team && team.flagX != null)
    ? SfTerrain.initialTerritory(team.flagX, team.flagY, world.session.initialBlocks, world.session.mapChunks) : [];
  const resourceCheck = (blocks) => SfResources.territoryResourceError(world.terrain, blocks, world.session.resources);

  // 8 方向：0 朝下、2 朝右、4 朝上、6 朝左（與 sf-sprite.js 相同）
  const dirOf = (dx, dy) => ((Math.round(Math.atan2(dx, dy) / (Math.PI / 4)) % 8) + 8) % 8;

  function savePos(p) {
    if (!p || !p.charId) return;
    api.savePos(p.charId, p.x, p.y).then((r) => { if (!r.ok) console.warn('[starforge] 存位置失敗', r.error); });
  }
  function saveInv(p) {
    if (!p || !p.invDirty) return;
    p.invDirty = false;
    api.saveInv(p.charId, p.inventory).then((r) => { if (!r.ok) { p.invDirty = true; console.warn('[starforge] 存背包失敗', r.error); } });
  }
  function flushNodes() {
    if (!world || world.dirtyNodes.size === 0) return;
    const w = world, epoch = w.session.resourceEpoch || 0, ids = Array.from(w.dirtyNodes);
    w.dirtyNodes.clear();
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200).map((id) => w.nodes.get(id)).filter(Boolean);
      api.saveNodes(batch, epoch).then((r) => {
        if (r.ok) return;
        // 管理員剛按了重置（epoch 對不上）：這批是舊資料，不用再存
        if (r.staleEpoch) return;
        if (world === w && (w.session.resourceEpoch || 0) === epoch) batch.forEach((n) => w.dirtyNodes.add(n.id));
        console.warn('[starforge] 存資源節點失敗', r.error);
      });
    }
  }
  setInterval(() => { flushNodes(); for (const p of players.values()) { saveInv(p); combat.saveExp(p); } }, FLUSH_EVERY_MS);

  nsp.on('connection', (socket) => {
    fac.bind(socket);                            // 工廠操作：fac-build / fac-remove / fac-put / fac-take / craft …（factory-server.js）
    combat.bind(socket);                         // 戰鬥：attack（combat.js）
    // ---- 進場 ----
    socket.on('join', async (data) => {
      try {
        if (players.has(socket.id)) return;
        const v = await verifyLoginToken(data && data.token);
        if (!v || !v.ok) return socket.emit('join-error', { error: '登入憑證無效或已過期，請回大廳重新進入', needLobby: true });
        const pr = await api.player(v.memberId);
        if (!pr.ok) return socket.emit('join-error', { error: pr.error || '讀取角色失敗', needLobby: true });
        if (!pr.character || !pr.team) return socket.emit('join-error', { error: '請先在大廳建立角色並加入隊伍', needLobby: true });
        // 2026-11-22 換成骨架角色：還是舊造型（或代碼不合法）的要先回大廳重新捏角色
        const lookCode = normalizeLookCode(pr.character.look && pr.character.look.code);
        if (!lookCode) return socket.emit('join-error', { error: '角色外觀已全面更新，請先回大廳重新捏角色', needLobby: true, needLook: true });
        const w = await ensureWorld(pr.sessionId);

        // 同一個角色只能有一個連線：踢掉舊的（舊連線的等級、經驗值比資料庫新，接著用）
        let carried = null;
        for (const [sid, other] of players) {
          if (other.charId === pr.character.id) {
            const s = nsp.sockets.get(sid);
            if (s) { s.emit('join-error', { error: '你的角色已在其他視窗進入世界' }); s.disconnect(true); }
            if (other.charId === pr.character.id) carried = { level: other.level, exp: other.exp };
            combat.saveExp(other);
            players.delete(sid);
            nsp.emit('char-left', { id: other.charId });
          }
        }
        // 隊伍資料以最新的為準（大廳可能剛建立隊伍）
        let team = w.teams.get(pr.team.id);
        if (!team) {
          const fresh = await api.world();
          if (fresh.ok) (fresh.teams || []).forEach((t) => { if (!w.teams.has(t.id)) w.teams.set(t.id, t); });
          team = w.teams.get(pr.team.id) || { id: pr.team.id, name: pr.team.name, level: 1, flagX: null, flagY: null, leaderId: pr.team.leaderId };
          w.teams.set(team.id, team);
        }
        team.leaderId = pr.team.leaderId;

        // 出生點：上次的位置 → 隊伍旗子旁 → 地圖中央附近
        const t = w.terrain;
        let pos;
        const c = pr.character;
        if (c.x != null && c.y != null && t.walkable(c.x, c.y)) pos = { x: c.x, y: c.y };
        else if (team.flagX != null) pos = t.findWalkable(team.flagX + 2, team.flagY + 2);
        else pos = t.findWalkable(t.size / 2 + (Math.random() - 0.5) * 40, t.size / 2 + (Math.random() - 0.5) * 40);

        const p = {
          socketId: socket.id, memberId: v.memberId, charId: c.id, name: c.name, look: { code: lookCode }, level: c.level,
          teamId: team.id, x: pos.x, y: pos.y, tx: null, ty: null, dir: 0, lastSave: Date.now(),
          inventory: {}, invDirty: false, lastGather: 0, lastItemOp: 0, lastLook: 0, held: null, lastHeld: 0, lastUse: 0, run: false, lastJump: 0
        };
        (pr.inventory || []).forEach((it) => { if (SfResources.ITEMS[it.code]) p.inventory[it.code] = it.qty; });
        combat.initPlayer(p, carried ? carried.level : c.level, carried ? carried.exp : c.exp);    // 血量（滿血）、等級、經驗值
        players.set(socket.id, p);
        socket.data.charId = c.id;
        socket.join('team:' + team.id);           // 隊伍頻道聊天用

        const s = w.session;
        socket.emit('init', {
          me: Object.assign({ id: c.id, name: c.name, teamId: team.id, isLeader: team.leaderId === c.id }, combat.statsOf(p)),   // 含 level、hp、maxHp、exp、need
          world: { id: s.id, name: s.name, seed: s.seed, mapChunks: s.mapChunks, chunk: SfTerrain.CHUNK,
                   initialBlocks: s.initialBlocks, minFlagDistance: s.minFlagDistance, teamSizeMax: s.teamSizeMax,
                   resources: s.resources || null },   // 資源分佈：前端插旗預覽時檢查領地放不放得下
          players: Array.from(players.values()).map(publicPlayer),
          teams: Array.from(w.teams.values()).map(publicTeam),
          // 資源（所有顯示中的）、地上的物品、伺服器時間（前端算再生用）、再生倍率、自己的背包
          nodes: activeNodeRows(w),
          drops: Array.from(w.drops.values()).map(dropRow),
          serverNow: Date.now(),
          regenMultiplier: regenMult(),
          inventory: p.inventory,
          chatLog: chatLogFor(w, team.id),         // 最近的對話（全體 + 自己隊伍）
          combat: combat.snapshot(w)               // 戰鬥中的生物、倒下還沒重新出現的生物
        });
        socket.broadcast.emit('char-joined', publicPlayer(p));
        systemChat(p.name + ' 進入了世界');
        fac.onJoin(socket, p);                   // 工廠：自己隊伍的完整狀態 + 其他隊伍的建築外觀 + 手動合成佇列
      } catch (e) {
        console.error('[starforge] join 失敗', e);
        socket.emit('join-error', { error: '進入世界失敗：' + e.message });
      }
    });

    // ---- 移動：只收目的地，伺服器檢查並模擬 ----
    socket.on('move', (data) => {
      const p = players.get(socket.id);
      if (!p || !world || !data || p.dead) return;         // 倒下時不能動
      let x = Number(data.x), y = Number(data.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const size = world.terrain.size;
      x = Math.max(0.5, Math.min(size - 0.5, x));
      y = Math.max(0.5, Math.min(size - 0.5, y));
      if (!world.terrain.walkable(x, y)) return socket.emit('move-error', { error: '那裡過不去（水面或高山）' });
      // 目的地在資源上：改成走到那個資源的邊緣（從自己這一側靠近）
      const o = obstacleFn(world)(x, y);
      if (o) {
        let vx = p.x - o.x, vy = p.y - o.y, vd = Math.hypot(vx, vy);
        if (vd < 0.01) { vx = 0; vy = 1; vd = 1; }
        x = o.x + vx / vd * (o.r + 0.05); y = o.y + vy / vd * (o.r + 0.05);
        if (!world.terrain.walkable(x, y)) return socket.emit('move-error', { error: '那裡被擋住了' });
      }
      p.tx = x; p.ty = y; p.best = Math.hypot(x - p.x, y - p.y); p.stuck = 0;
      // 跑步：網頁版一律送 run:true/false（按住 Shift、雙擊或目的地比較遠才跑）；沒帶 run 的舊用戶端（Godot 版）照舊用跑速
      p.run = data.run !== false;
    });

    // ---- 插旗 ----
    socket.on('plant-flag', (data) => {
      plantQueue = plantQueue.then(async () => {
        const p = players.get(socket.id);
        if (!p || !world || !data) return;
        const team = world.teams.get(p.teamId);
        const x = Number(data.x), y = Number(data.y);
        if (!team) return socket.emit('flag-error', { error: '找不到你的隊伍' });
        if (team.leaderId !== p.charId) return socket.emit('flag-error', { error: '只有隊長可以插旗' });
        if (team.flagX != null) return socket.emit('flag-error', { error: '你的隊伍已經插過旗了' });
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const s = world.session;
        const flags = Array.from(world.teams.values()).filter((t) => t.flagX != null).map((t) => ({ x: t.flagX, y: t.flagY, teamId: t.id }));
        const chk = SfTerrain.checkFlagSite(world.terrain, x, y, { initialBlocks: s.initialBlocks, minFlagDistance: s.minFlagDistance, flags, teamId: team.id, extraCheck: resourceCheck });
        if (!chk.ok) return socket.emit('flag-error', { error: chk.error });
        const r = await api.plant(team.id, p.charId, x, y);
        if (!r.ok) return socket.emit('flag-error', { error: r.error || '插旗失敗' });
        team.flagX = x; team.flagY = y;
        nsp.emit('flag-planted', publicTeam(team));
        // 領地裡長出資源，馬上存檔（位置與可採數量從此固定）
        emitNodeSync(syncTeamNodes(world, team));
        flushNodes();
        fac.onFlag(world, team);                 // 建立隊伍的工廠，隊員馬上可以開始蓋
      }).catch((e) => console.error('[starforge] 插旗失敗', e));
    });

    // ---- 採集：一次採 1 單位；前端走到節點旁後每隔一段時間送一次 ----
    socket.on('gather', (data) => {
      const p = players.get(socket.id);
      if (!p || !world || !data || p.dead) return;
      const R = SfResources, now = Date.now();
      const node = world.nodes.get(String(data.nodeId || ''));
      if (!node || !node.active) return socket.emit('gather-error', { error: '這個資源已經不在了', stop: true });
      if (Math.hypot(node.x - p.x, node.y - p.y) > R.GATHER_RANGE + 0.4) return socket.emit('gather-error', { error: '離太遠了，走近一點再採', far: true });
      const team = world.teams.get(p.teamId);
      if (!team || team.flagX == null) return socket.emit('gather-error', { error: '隊伍插旗建立基地後才能採集', stop: true });
      if (!R.inBlocks(teamBlocks(team), node.x, node.y)) return socket.emit('gather-error', { error: '只能採集自己隊伍領地內的資源', stop: true });
      if (now - p.lastGather < R.GATHER_COOLDOWN - 80) return;   // 太快就忽略（不回錯誤，避免洗訊息）
      const def = R.NODE_TYPES[node.type];
      const amount = R.currentAmount(node, now, regenMult(), world.cfg);   // 再生秒數用後台設定
      if (amount <= 0) return socket.emit('gather-error', { error: def.name + '剛長出來，還要一段時間才能採', stop: true });
      const item = R.nodeItem(node, world.cfg);           // 礦物礦脈依位置決定是哪種礦物
      if (!p.inventory[item] && Object.keys(p.inventory).filter((k) => p.inventory[k] > 0).length >= R.BAG_KINDS) return socket.emit('gather-error', { error: '背包滿了', stop: true });
      if ((p.inventory[item] || 0) >= R.STACK_MAX) return socket.emit('gather-error', { error: R.ITEMS[item].name + '已經帶滿 ' + R.STACK_MAX + ' 個了', stop: true });
      p.lastGather = now;
      node.amount = amount - 1; node.t = now;
      world.dirtyNodes.add(node.id);
      p.inventory[item] = (p.inventory[item] || 0) + 1;
      p.invDirty = true;
      // 面向節點
      p.dir = dirOf(node.x - p.x, node.y - p.y);
      socket.emit('gathered', { nodeId: node.id, item, qty: p.inventory[item], left: node.amount });
      nsp.emit('node-changed', [node.id, node.amount, node.t]);
      // 採光了：等最後一下的動畫播完（約 0.6 秒）再搬家，前端才看得到敲碎的那一下
      //   有採礦機蓋在上面的不搬家（留在原地慢慢長回來，採礦機才不會突然沒東西挖）
      if (node.amount <= 0 && !fac.isNodeClaimed(world, node)) {
        const w = world, id = node.id;
        setTimeout(() => {
          const n = w.nodes.get(id);
          if (w !== world || !n || !n.active || n.amount > 0) return;
          const from = [n.x, n.y];
          respawnNode(w, n);
          nsp.emit('node-respawned', { row: nodeRow(n), from });
        }, 650);
      }
      // 給其他人播採集動畫（揮工具、資源晃動）：[角色, 節點, 面向]；轉向也一起帶過去（站著不動時 positions 不會廣播）
      socket.broadcast.emit('char-gathering', [p.charId, node.id, p.dir]);
    });

    // ---- 背包：放棄（直接消失）、丟在地上、撿起地上的物品 ----
    // 從背包拿出物品：檢查物品代碼、數量（整數、1～持有量）；成功回 { item, qty }，背包已扣掉
    function takeFromBag(p, data, check) {
      const item = String((data && data.item) || ''), have = p.inventory[item] || 0;
      const qty = Math.floor(Number(data && data.qty));
      if (!/^[a-z0-9_]{1,30}$/.test(item) || have <= 0) { socket.emit('item-error', { error: '背包裡沒有這個物品' }); return null; }
      if (!Number.isFinite(qty) || qty < 1 || qty > have) { socket.emit('item-error', { error: '數量要介於 1 到 ' + have }); return null; }
      if (check && !check()) return null;
      p.inventory[item] = have - qty;
      if (p.inventory[item] <= 0) delete p.inventory[item];
      p.invDirty = true;
      socket.emit('inventory-changed', { item, qty: p.inventory[item] || 0 });
      return { item, qty };
    }
    const itemOpOk = (p) => {
      const now = Date.now();
      if (now - p.lastItemOp < ITEM_OP_GAP_MS) return false;
      p.lastItemOp = now;
      return true;
    };
    socket.on('discard-item', (data) => {
      const p = players.get(socket.id);
      if (!p || !world || !itemOpOk(p)) return;
      takeFromBag(p, data);
    });
    socket.on('drop-item', (data) => {
      const p = players.get(socket.id);
      if (!p || !world || !itemOpOk(p)) return;
      const w = world;
      const got = takeFromBag(p, data, () => {
        if (w.drops.size < DROP_MAX) return true;
        socket.emit('item-error', { error: '地上的東西太多了，等一下再丟' });
        return false;
      });
      if (!got) return;
      // 丟在面前一點點（走不到的地方就丟在腳邊），稍微錯開避免疊在一起
      const ang = p.dir * Math.PI / 4;
      dropAt(got.item, got.qty, p.x + Math.sin(ang) * 0.8, p.y + Math.cos(ang) * 0.8, p.x, p.y);
    });
    socket.on('pickup', (data) => {
      const p = players.get(socket.id);
      if (!p || !world || !data || p.dead || !itemOpOk(p)) return;
      const R = SfResources, d = world.drops.get(String(data.dropId || ''));
      if (!d) return socket.emit('item-error', { error: '東西已經被撿走了', stop: true });
      if (Math.hypot(d.x - p.x, d.y - p.y) > R.PICKUP_RANGE + 0.4) return socket.emit('item-error', { error: '離太遠了', far: true });
      const have = p.inventory[d.item] || 0;
      if (!have && Object.keys(p.inventory).filter((k) => p.inventory[k] > 0).length >= R.BAG_KINDS) return socket.emit('item-error', { error: '背包滿了', stop: true });
      const take = Math.min(d.qty, R.STACK_MAX - have);
      if (take <= 0) return socket.emit('item-error', { error: ((R.ITEMS[d.item] || {}).name || d.item) + '已經帶滿 ' + R.STACK_MAX + ' 個了', stop: true });
      p.inventory[d.item] = have + take;
      p.invDirty = true;
      d.qty -= take;
      if (d.qty <= 0) { world.drops.delete(d.id); nsp.emit('drop-removed', { id: d.id }); }
      else nsp.emit('drop-changed', [d.id, d.qty]);      // 背包裝不下的留在地上
      socket.emit('picked', { dropId: d.id, item: d.item, gained: take, qty: p.inventory[d.item], x: d.x, y: d.y });
    });

    // ---- 換造型：先粗檢格式，白名單交給 ASP（與大廳同一份），存成功才廣播 ----
    socket.on('set-look', async (data) => {
      const p = players.get(socket.id);
      if (!p || !world || !data || typeof data !== 'object') return;
      const now = Date.now();
      if (now - p.lastLook < LOOK_GAP_MS) return socket.emit('look-error', { error: '換太快了，等一下再試' });
      const code = normalizeLookCode(data.code);
      if (!code) return socket.emit('look-error', { error: '造型選項不正確' });
      p.lastLook = now;
      const r = await api.saveLook(p.charId, code);
      if (!r.ok) return socket.emit('look-error', { error: r.error || '存檔失敗，請稍後再試' });
      if (!players.has(socket.id)) return;
      p.look = { code: normalizeLookCode(r.look && r.look.code) || code };
      nsp.emit('char-look', { id: p.charId, look: p.look });
    });

    // ---- 手持道具：白名單檢查後廣播給所有人（只存在記憶體；前端重連後會自己再送一次）----
    socket.on('set-held', (data) => {
      const p = players.get(socket.id);
      if (!p || !world || !data || typeof data !== 'object') return;
      const now = Date.now();
      if (now - p.lastHeld < HELD_GAP_MS) return;
      const item = data.item == null || data.item === '' ? null : String(data.item);
      if (item !== null && !HELD_ITEMS.has(item)) return;
      if (item !== null && !(p.inventory[item] > 0)) return socket.emit('held-error', { error: '背包裡沒有「' + SfResources.ITEMS[item].name + '」，先用手動合成或組裝機做一個' });
      p.lastHeld = now;
      if (p.held === item) return;
      p.held = item;
      nsp.emit('char-held', { id: p.charId, held: item });
    });
    // ---- 使用手持道具：只是動作展示（揮劍、施法、釣魚…），伺服器限速後轉給其他人播放 ----
    socket.on('use-held', () => {
      const p = players.get(socket.id);
      if (!p || !world || !p.held) return;
      const now = Date.now();
      if (now - p.lastUse < USE_GAP_MS) return;
      p.lastUse = now;
      socket.broadcast.emit('char-use', { id: p.charId, item: p.held, dir: p.dir });
    });

    // ---- 跳躍：只是動作展示（不影響移動、碰撞），限速後轉給其他人播放 ----
    socket.on('jump', () => {
      const p = players.get(socket.id);
      if (!p || !world) return;
      const now = Date.now();
      if (now - p.lastJump < JUMP_GAP_MS) return;
      p.lastJump = now;
      socket.broadcast.emit('char-jump', { id: p.charId });
    });

    // ---- 聊天：只收文字與頻道，說話的人、隊伍、時間都由伺服器決定 ----
    socket.on('chat', (data) => {
      const p = players.get(socket.id);
      if (!p || !world || !data || typeof data !== 'object') return;
      const text = cleanChatText(data.text);
      if (!text) return;
      const now = Date.now();
      if (now - (p.lastChat || 0) < CHAT_GAP_MS) return socket.emit('chat-error', { error: '說太快了，休息一下再說' });
      p.lastChat = now;
      const channel = data.channel === 'team' ? 'team' : 'world';
      sendChat({ channel, who: p.name, charId: p.charId, teamId: p.teamId, text, isSystem: false, ts: now });
    });

    socket.on('disconnect', () => {
      const p = players.get(socket.id);
      if (!p) return;
      players.delete(socket.id);
      fac.onLeave(p);                            // 手動合成還沒做完的退回背包（要在存背包之前）
      savePos(p);
      saveInv(p);
      combat.saveExp(p);
      nsp.emit('char-left', { id: p.charId });
      // 被同角色的新連線踢掉時 players 已經先刪掉了，不會走到這裡，所以不會多一則「離開」
      systemChat(p.name + ' 離開了世界');
    });
  });

  // 在地上放一堆物品（玩家丟的、背包裝不下的工廠退款 / 合成產品）；(fx, fy) = 走不到時改放的位置
  function dropAt(item, qty, x, y, fx, fy) {
    const w = world;
    if (!w || !SfResources.ITEMS[item] || !(qty > 0)) return;
    x += (Math.random() - 0.5) * 0.4; y += (Math.random() - 0.5) * 0.4;
    if (!w.terrain.walkable(x, y)) { x = fx != null ? fx : Math.floor(x) + 0.5; y = fy != null ? fy : Math.floor(y) + 0.5; }
    for (let left = qty; left > 0; left -= SfResources.STACK_MAX) {
      const d = { id: 'd' + (++w.dropSeq), item, qty: Math.min(left, SfResources.STACK_MAX), x: +x.toFixed(2), y: +y.toFixed(2), t: Date.now() };
      w.drops.set(d.id, d);
      nsp.emit('drop-added', dropRow(d));
    }
  }

  // 手上的道具不在背包裡了（丟掉、放進機器、拿去合成…）→ 自動收起，大家畫面同步
  setInterval(() => {
    for (const p of players.values()) {
      if (p.held && !(p.inventory[p.held] > 0)) { p.held = null; nsp.emit('char-held', { id: p.charId, held: null }); }
    }
  }, HELD_CHECK_MS);

  // 地上的物品放太久就消失
  setInterval(() => {
    if (!world) return;
    const now = Date.now();
    for (const d of world.drops.values()) {
      if (now - d.t > DROP_TTL_MS) { world.drops.delete(d.id); nsp.emit('drop-removed', { id: d.id }); }
    }
  }, 30 * 1000);

  // ---- 移動模擬：每 100ms 往目的地走一步，撞到水或山就停；有變化才廣播 ----
  setInterval(() => {
    if (!world || players.size === 0) return;
    const moved = [];
    const now = Date.now();
    const w = world, hit = obstacleFn(w), ok = (x, y) => w.terrain.walkable(x, y);
    for (const p of players.values()) {
      if (p.tx != null) {
        const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy);
        // 往目的地走一步；撞到資源沿邊緣繞，撞到水 / 山或繞不過去就停
        const step = (p.run ? RUN_SPEED : WALK_SPEED) * TICK_MS / 1000;
        const r = d < 1e-3 ? null : SfWild.stepAround(p.x, p.y, p.tx, p.ty, step, ok, hit);
        if (r) {
          p.dir = dirOf(r[0] - p.x, r[1] - p.y);
          p.x = r[0]; p.y = r[1];
          const left = Math.hypot(p.tx - p.x, p.ty - p.y);
          // 3 秒（30 步）都沒有比之前更接近目的地 → 繞不過去，停下
          if (left < (p.best == null ? Infinity : p.best) - 0.05) { p.best = left; p.stuck = 0; } else p.stuck = (p.stuck || 0) + 1;
          if (left < 0.02 || p.stuck > 30) { p.tx = null; p.ty = null; }
        } else { p.tx = null; p.ty = null; }
        moved.push([p.charId, +p.x.toFixed(2), +p.y.toFixed(2), p.dir, p.tx != null ? (p.run ? 2 : 1) : 0]);   // 移動旗標：0 停、1 走、2 跑
      }
      if (now - p.lastSave > SAVE_EVERY_MS) { p.lastSave = now; savePos(p); }
    }
    if (moved.length) nsp.emit('positions', moved);
  }, TICK_MS);

  console.log('[starforge] 遊戲服務已掛上 namespace /starforge，ASP API：' + apiUrl.replace(/key=[^&]*/i, 'key=***'));
};
