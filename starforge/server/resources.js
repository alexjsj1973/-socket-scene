// ============================================================
// resources.js - Starforge 資源節點與物品（伺服器與瀏覽器共用同一份）
//
// 做什麼：
//   * 物品清單（名稱、圖示）、資源種類（產出物品、喜歡長在哪種地形、再生速度）
//   * 每個隊伍插旗後，在「該隊領地」裡依後台設定生成資源節點：
//       - 每種資源出現幾個（例如共 100 個：樹木 30、石礦 30、鐵礦 15…）
//       - 每個節點可採集的數量範圍（例如一棵樹 10～20 個木材，每棵樹各自抽一個值）
//     設定來自世界場次（後台 admin_session_edit.asp →  game_api.asp act=world 的 resources），
//     開場後鎖定；沒有設定時用下面的 DEFAULT_SPAWN。
//   * 位置與每個節點的蘊藏量由「場次 seed + 隊伍編號 + 旗子位置」決定，伺服器與瀏覽器算出來一定一樣；
//     資料庫只存「被採過、數量變了」的節點（GDD 28.1）
//   * 再生：被採過的節點每隔一段時間恢復 1 單位（不超過該節點的蘊藏量），速度再乘上場次的「資源再生倍率」
// 為什麼共用：伺服器用來驗證採集，瀏覽器用來畫資源、顯示剩餘量，兩邊結果一定一致。
// 瀏覽器從遊戲服務的 /starforge/resources.js 載入（要先載入 terrain.js）。
// 注意：
//   * 物品代碼、資源代碼發出去後不要刪（玩家背包、資料庫裡會有）；不想出現就把數量設 0
//   * 新增資源種類：這裡的 ITEMS / NODE_TYPES / DEFAULT_SPAWN 加一筆，
//     ASP 的 inc/inc_sf_settings.asp 的 SF_RESOURCES 也要加同一個代碼（兩邊預設值一致），
//     前端 main.js 的 NODE_LOOK（外觀）與 DEBRIS（採集碎屑）補上顏色
//   * 改生成規則會改變已插旗隊伍的資源位置，進行中的場次不要改
// ============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./terrain'));
  else root.SfResources = factory(root.SfTerrain);
})(typeof self !== 'undefined' ? self : this, function (SfTerrain) {
  'use strict';
  const CHUNK = SfTerrain.CHUNK, T = SfTerrain.T;

  // 物品：代碼 → 名稱、圖示
  const ITEMS = {
    wood:         { name: '木材',   icon: '🪵' },
    stone:        { name: '石材',   icon: '🪨' },
    iron_ore:     { name: '鐵礦石', icon: '⛓️' },
    coal:         { name: '煤炭',   icon: '⚫' },
    aluminum_ore: { name: '鋁礦石', icon: '🔘' },
    silver_ore:   { name: '銀礦石', icon: '⚪' },
    gold_ore:     { name: '金礦石', icon: '🟡' },
    copper_ore:   { name: '銅礦石', icon: '🟠' }
  };
  // 資源種類：產出物品、名稱、喜歡的地形（plain 平原 / hill 丘陵；不夠時會放到另一種）、每恢復 1 單位需要的秒數
  // 順序 = 後台表格的順序
  const NODE_TYPES = {
    tree:     { item: 'wood',         name: '樹木', terrain: 'plain', regenSec: 60 },
    rock:     { item: 'stone',        name: '石礦', terrain: 'hill',  regenSec: 120 },
    iron:     { item: 'iron_ore',     name: '鐵礦', terrain: 'hill',  regenSec: 180 },
    coal:     { item: 'coal',         name: '煤礦', terrain: 'hill',  regenSec: 180 },
    aluminum: { item: 'aluminum_ore', name: '鋁礦', terrain: 'hill',  regenSec: 240 },
    silver:   { item: 'silver_ore',   name: '銀礦', terrain: 'hill',  regenSec: 420 },
    gold:     { item: 'gold_ore',     name: '金礦', terrain: 'hill',  regenSec: 600 },
    copper:   { item: 'copper_ore',   name: '銅礦', terrain: 'hill',  regenSec: 180 }
  };
  // 預設分佈（每隊領地）：count 個數、min～max 每個節點可採集的數量
  // 與 inc/inc_sf_settings.asp 的 SF_RESOURCES 預設值一致，改一邊就要改另一邊
  const DEFAULT_SPAWN = {
    tree:     { count: 30, min: 10, max: 20 },
    rock:     { count: 30, min: 10, max: 20 },
    iron:     { count: 15, min: 8,  max: 15 },
    coal:     { count: 10, min: 8,  max: 15 },
    aluminum: { count: 10, min: 6,  max: 12 },
    silver:   { count: 3,  min: 3,  max: 6 },
    gold:     { count: 2,  min: 2,  max: 4 },
    copper:   { count: 0,  min: 8,  max: 15 }
  };
  // 上下限（與 ASP 驗證、SQL CHECK 一致）
  const LIMITS = { countMax: 500, totalMax: 1000, amountMax: 999 };
  const GATHER_RANGE = 1.8;     // 角色離節點多近才能採（格）
  const GATHER_COOLDOWN = 900;  // 每次採集的間隔（毫秒）
  const STACK_MAX = 999;        // 每種物品最多帶多少
  const BAG_KINDS = 20;         // 背包最多幾種物品
  const TILES_PER_NODE = 6;     // 每個資源大約要佔幾格陸地（插旗時檢查領地放不放得下）
  const FLAG_CLEAR = 3;         // 旗子周圍幾格內不放資源（留給基地）

  // 整理設定：沒給設定 → 全部用預設；有給 → 沒列到的種類數量為 0；數值夾在合法範圍內
  function normalizeConfig(cfg) {
    const out = {};
    for (const type of Object.keys(NODE_TYPES)) {
      const d = DEFAULT_SPAWN[type];
      const c = cfg ? cfg[type] : d;
      if (!c) { out[type] = { count: 0, min: d.min, max: d.max }; continue; }
      const int = (v, lo, hi, def) => { v = Math.floor(Number(v)); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; };
      const count = int(c.count, 0, LIMITS.countMax, 0);
      const min = int(c.min, 1, LIMITS.amountMax, d.min);
      const max = Math.max(min, int(c.max, 1, LIMITS.amountMax, d.max));
      out[type] = { count, min, max };
    }
    return out;
  }
  const totalCount = (cfg) => Object.keys(cfg).reduce((s, k) => s + cfg[k].count, 0);

  // 可重現的亂數（mulberry32）
  function rng32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- 生成某隊領地裡的資源節點 ----
  // 做法：把領地裡的平原、丘陵格子各自洗牌當候選位置；稀有的先放（金、銀…最後才是樹），
  //       每種先放在喜歡的地形，不夠再放另一種；節點之間至少隔 3 格（曼哈頓距離），真的放不下才放寬成 2 格。
  //       放不下的數量會少放（插旗時已檢查陸地夠大，正常不會發生）。
  function generateTeamNodes(terrain, team, blocks, cfg) {
    const seed = (terrain.seed * 2654435761) ^ (team.id * 40503) ^ (Math.floor(team.flagX) * 73856093) ^ (Math.floor(team.flagY) * 19349663);
    const rnd = rng32(seed);
    const plains = [], hills = [];
    for (const b of blocks) {
      for (let y = b.cy * CHUNK; y < (b.cy + 1) * CHUNK; y++) for (let x = b.cx * CHUNK; x < (b.cx + 1) * CHUNK; x++) {
        if (Math.abs(x + 0.5 - team.flagX) + Math.abs(y + 0.5 - team.flagY) < FLAG_CLEAR) continue;
        const t = terrain.at(x + 0.5, y + 0.5);
        if (t === T.PLAIN) plains.push([x, y]); else if (t === T.HILL) hills.push([x, y]);
      }
    }
    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } };
    shuffle(plains); shuffle(hills);
    const used = new Set();
    const free = (x, y, gap) => {
      for (let dy = -(gap - 1); dy <= gap - 1; dy++) for (let dx = -(gap - 1); dx <= gap - 1; dx++) {
        if (Math.abs(dx) + Math.abs(dy) < gap && used.has((x + dx) + ',' + (y + dy))) return false;
      }
      return true;
    };
    const take = (list, gap) => {
      for (let i = 0; i < list.length; i++) {
        const [x, y] = list[i];
        if (!used.has(x + ',' + y) && free(x, y, gap)) { list.splice(i, 1); used.add(x + ',' + y); return [x, y]; }
      }
      return null;
    };
    // 稀有的先放（數量少的先挑位置），同數量照 NODE_TYPES 順序
    const order = Object.keys(NODE_TYPES).filter((k) => cfg[k] && cfg[k].count > 0).sort((a, b) => cfg[a].count - cfg[b].count);
    const nodes = [];
    let k = 0;
    for (const type of order) {
      const c = cfg[type], pref = NODE_TYPES[type].terrain === 'plain' ? [plains, hills] : [hills, plains];
      for (let i = 0; i < c.count; i++) {
        const pos = take(pref[0], 3) || take(pref[1], 3) || take(pref[0], 2) || take(pref[1], 2);
        if (!pos) break;
        const max = c.min + Math.floor(rnd() * (c.max - c.min + 1));
        nodes.push({ id: 't' + team.id + '_' + (k++), type, x: pos[0] + 0.5, y: pos[1] + 0.5, max, teamId: team.id });
      }
    }
    return nodes;
  }

  // ---- 節點索引：掛在 terrain 物件上（每個場次一份） ----
  function index(terrain) {
    if (!terrain._res) terrain._res = { byChunk: new Map(), byId: new Map(), teams: new Map() };
    return terrain._res;
  }
  // 登記一個已插旗的隊伍（重複呼叫沒關係，同一隊同一個旗子只生成一次）
  function registerTeam(terrain, team, blocks, cfg) {
    if (!team || team.flagX == null) return [];
    const ix = index(terrain), key = team.flagX + ',' + team.flagY;
    const old = ix.teams.get(team.id);
    if (old && old.key === key) return old.nodes;
    if (old) old.nodes.forEach((n) => {                       // 旗子換了（理論上不會）：先拿掉舊的
      ix.byId.delete(n.id);
      const ck = Math.floor(n.x / CHUNK) + ',' + Math.floor(n.y / CHUNK), list = ix.byChunk.get(ck);
      if (list) ix.byChunk.set(ck, list.filter((m) => m !== n));
    });
    const nodes = generateTeamNodes(terrain, team, blocks, normalizeConfig(cfg));
    for (const n of nodes) {
      ix.byId.set(n.id, n);
      const ck = Math.floor(n.x / CHUNK) + ',' + Math.floor(n.y / CHUNK);
      if (!ix.byChunk.has(ck)) ix.byChunk.set(ck, []);
      ix.byChunk.get(ck).push(n);
    }
    ix.teams.set(team.id, { key, nodes });
    return nodes;
  }
  const EMPTY = [];
  function nodesInChunk(terrain, cx, cy) { return index(terrain).byChunk.get(cx + ',' + cy) || EMPTY; }
  function nodeById(terrain, id) { return index(terrain).byId.get(String(id || '')) || null; }

  // 目前剩餘量：state = { amount, t(上次變動的毫秒時間) }；沒有 state = 滿的（該節點自己的蘊藏量）
  function currentAmount(node, state, now, regenMult) {
    const def = NODE_TYPES[node.type];
    if (!state) return node.max;
    const interval = def.regenSec * 1000 / Math.max(0.1, regenMult || 1);
    const regen = Math.floor(Math.max(0, now - state.t) / interval);
    return Math.min(node.max, state.amount + regen);
  }

  // 插旗用：領地裡的陸地（平原 + 丘陵）要放得下設定的資源總數
  function territoryResourceError(terrain, blocks, cfg) {
    const total = totalCount(normalizeConfig(cfg));
    let land = 0;
    for (const b of blocks) {
      for (let y = b.cy * CHUNK; y < (b.cy + 1) * CHUNK; y++) for (let x = b.cx * CHUNK; x < (b.cx + 1) * CHUNK; x++) {
        const t = terrain.at(x + 0.5, y + 0.5);
        if (t === T.PLAIN || t === T.HILL) land++;
      }
    }
    if (land < total * TILES_PER_NODE) return '這裡的陸地太少，放不下 ' + total + ' 個資源，換個平原或丘陵多一點的位置';
    return null;
  }

  // 點在不在某些區塊裡
  function inBlocks(blocks, x, y) {
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
    return blocks.some((b) => b.cx === cx && b.cy === cy);
  }

  return { ITEMS, NODE_TYPES, DEFAULT_SPAWN, LIMITS, GATHER_RANGE, GATHER_COOLDOWN, STACK_MAX, BAG_KINDS,
           normalizeConfig, totalCount, generateTeamNodes, registerTeam,
           nodesInChunk, nodeById, currentAmount, territoryResourceError, inBlocks };
});
