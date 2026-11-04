// ============================================================
// resources.js - Starforge 資源與物品（伺服器與瀏覽器共用同一份）
//
// 做什麼：
//   * 物品清單（名稱、圖示）、資源種類（產出物品、喜歡長在哪種地形、再生速度）
//   * 資源分佈設定（後台 admin_session_edit.asp「資源分佈（每隊領地）」）的預設值與整理
//   * 剩餘量與再生的計算、插旗時「領地放不放得下」的檢查
//   * 伺服器專用：在某隊領地裡找一個空位放新資源（findSpot）
//
// 資源節點怎麼來（GDD 28.1 的調整版）：
//   隊伍插旗後，遊戲服務依資源分佈在該隊領地裡「一個一個」生成資源，並把每個資源的
//   位置、種類、可採數量（在當時設定的範圍內抽）寫進資料庫（game_sf_resource_node）。
//   之後位置與可採數量就固定了：
//     - 管理員隨時調高數量 → 先把之前隱藏的同種資源放回原位，不夠再長新的；舊的不動
//     - 調低數量 → 編號最大的先隱藏（不刪除，剩餘量保留，調回來就在原位出現）
//     - 改可採範圍 → 只影響之後新長出來的資源
//     - 後台「重置所有資源」→ 全部清掉重新分佈
//   瀏覽器不自己算位置，一律用伺服器送來的節點清單。
// 瀏覽器從遊戲服務的 /starforge/resources.js 載入（要先載入 terrain.js）。
// 注意：
//   * 物品代碼、資源代碼發出去後不要刪（玩家背包、資料庫裡會有）；不想出現就把數量設 0
//   * 新增資源種類：這裡的 ITEMS / NODE_TYPES / DEFAULT_SPAWN 加一筆，
//     ASP 的 inc/inc_sf_settings.asp 的 SF_RESOURCES 也要加同一個代碼（兩邊預設值一致），
//     前端 main.js 的 NODE_LOOK（外觀）與 DEBRIS（採集碎屑）補上顏色
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
    copper_ore:   { name: '銅礦石', icon: '🟠' },
    coal:         { name: '煤炭',   icon: '⚫' },
    aluminum_ore: { name: '鋁礦石', icon: '🔘' },
    silver_ore:   { name: '銀礦石', icon: '⚪' },
    gold_ore:     { name: '金礦石', icon: '🟡' },
    flower:       { name: '花朵',   icon: '🌸' }      // 2026-11-04 新增
  };
  // 資源種類：產出物品、名稱、喜歡的地形（plain 平原 / hill 丘陵；不夠時會放到另一種）、每恢復 1 單位需要的秒數
  // 代碼只能用小寫英文（會出現在節點代碼裡）；順序 = 後台表格的順序
  const NODE_TYPES = {
    tree:     { item: 'wood',         name: '樹木', terrain: 'plain', regenSec: 60 },
    rock:     { item: 'stone',        name: '石礦', terrain: 'hill',  regenSec: 120 },
    iron:     { item: 'iron_ore',     name: '鐵礦', terrain: 'hill',  regenSec: 180 },
    copper:   { item: 'copper_ore',   name: '銅礦', terrain: 'hill',  regenSec: 180 },
    coal:     { item: 'coal',         name: '煤礦', terrain: 'hill',  regenSec: 180 },
    aluminum: { item: 'aluminum_ore', name: '鋁礦', terrain: 'hill',  regenSec: 240 },
    silver:   { item: 'silver_ore',   name: '銀礦', terrain: 'hill',  regenSec: 420 },
    gold:     { item: 'gold_ore',     name: '金礦', terrain: 'hill',  regenSec: 600 },
    flower:   { item: 'flower',       name: '花朵', terrain: 'plain', regenSec: 90 }    // 51 種花的外觀由前端依位置挑
  };
  // 預設分佈（每隊領地）：count 個數、min～max 每個資源可採集的數量
  // 與 inc/inc_sf_settings.asp 的 SF_RESOURCES 預設值一致，改一邊就要改另一邊
  const DEFAULT_SPAWN = {
    tree:     { count: 30, min: 10, max: 20 },
    rock:     { count: 30, min: 10, max: 20 },
    iron:     { count: 15, min: 8,  max: 15 },
    copper:   { count: 10, min: 8,  max: 15 },
    coal:     { count: 10, min: 8,  max: 15 },
    aluminum: { count: 10, min: 6,  max: 12 },
    silver:   { count: 3,  min: 3,  max: 6 },
    gold:     { count: 2,  min: 2,  max: 4 },
    flower:   { count: 20, min: 3,  max: 8 }
  };
  // 上下限（與 ASP 驗證、SQL CHECK 一致）
  const LIMITS = { countMax: 500, totalMax: 1000, amountMax: 999 };
  const GATHER_RANGE = 1.8;     // 角色離資源多近才能採（格）
  const GATHER_COOLDOWN = 900;  // 每次採集的間隔（毫秒）
  const PICKUP_RANGE = 1.5;     // 角色離地上物品多近才能撿（格）
  const STACK_MAX = 999;        // 每種物品最多帶多少
  const BAG_KINDS = 20;         // 背包最多幾種物品
  const TILES_PER_NODE = 6;     // 每個資源大約要佔幾格陸地（插旗時檢查領地放不放得下）
  const FLAG_CLEAR = 3;         // 旗子周圍幾格內不放資源（留給基地）

  // 整理設定：沒給設定 → 全部用預設；有給 → 沒列到的種類（之後才新增的，例如花朵）也用預設；數值夾在合法範圍內
  //   （2026-11-04 改：原本沒列到的當 0，新增花朵後進行中的場次也要長出花，所以改成用預設；不想要就在後台把數量設 0）
  function normalizeConfig(cfg) {
    const out = {};
    const int = (v, lo, hi, def) => { v = Math.floor(Number(v)); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; };
    for (const type of Object.keys(NODE_TYPES)) {
      const d = DEFAULT_SPAWN[type];
      const c = cfg ? cfg[type] : d;
      if (!c) { out[type] = { count: d.count, min: d.min, max: d.max }; continue; }
      const min = int(c.min, 1, LIMITS.amountMax, d.min);
      out[type] = { count: int(c.count, 0, LIMITS.countMax, 0), min, max: Math.max(min, int(c.max, 1, LIMITS.amountMax, d.max)) };
    }
    return out;
  }
  const totalCount = (cfg) => Object.keys(cfg).reduce((s, k) => s + cfg[k].count, 0);

  // 目前剩餘量：node 要有 max（這個資源的可採數量）、amount（最後變動時的剩餘量）、t（最後變動的毫秒時間）
  function currentAmount(node, now, regenMult) {
    const def = NODE_TYPES[node.type];
    if (!def) return 0;
    const interval = def.regenSec * 1000 / Math.max(0.1, regenMult || 1);
    const regen = Math.floor(Math.max(0, now - node.t) / interval);
    return Math.min(node.max, node.amount + regen);
  }

  // 領地裡的陸地格子（平原、丘陵分開；旗子旁邊留空）
  function landTiles(terrain, blocks, flagX, flagY) {
    const plains = [], hills = [];
    for (const b of blocks) {
      for (let y = b.cy * CHUNK; y < (b.cy + 1) * CHUNK; y++) for (let x = b.cx * CHUNK; x < (b.cx + 1) * CHUNK; x++) {
        if (flagX != null && Math.abs(x + 0.5 - flagX) + Math.abs(y + 0.5 - flagY) < FLAG_CLEAR) continue;
        const t = terrain.at(x + 0.5, y + 0.5);
        if (t === T.PLAIN) plains.push([x, y]); else if (t === T.HILL) hills.push([x, y]);
      }
    }
    return { plains, hills };
  }

  // 插旗用：領地裡的陸地要放得下設定的資源總數
  function territoryResourceError(terrain, blocks, cfg) {
    const total = totalCount(normalizeConfig(cfg));
    const land = landTiles(terrain, blocks, null, null);
    if (land.plains.length + land.hills.length < total * TILES_PER_NODE) return '這裡的陸地太少，放不下 ' + total + ' 個資源，換個平原或丘陵多一點的位置';
    return null;
  }

  // 伺服器用：找一個空位放新資源。
  //   spots = landTiles 的結果（呼叫端先洗牌、快取）；occupied = Set('x,y')（這隊所有資源，含隱藏的）
  //   先找喜歡的地形、彼此至少隔 3 格（曼哈頓距離），找不到再找另一種地形，最後放寬成隔 2 格；都沒有回 null
  function findSpot(spots, occupied, type) {
    const pref = NODE_TYPES[type] && NODE_TYPES[type].terrain === 'plain' ? [spots.plains, spots.hills] : [spots.hills, spots.plains];
    const free = (x, y, gap) => {
      for (let dy = -(gap - 1); dy <= gap - 1; dy++) for (let dx = -(gap - 1); dx <= gap - 1; dx++) {
        if (Math.abs(dx) + Math.abs(dy) < gap && occupied.has((x + dx) + ',' + (y + dy))) return false;
      }
      return true;
    };
    for (const gap of [3, 2]) for (const list of pref) {
      for (const [x, y] of list) if (free(x, y, gap)) return [x, y];
    }
    return null;
  }

  // 點在不在某些區塊裡
  function inBlocks(blocks, x, y) {
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
    return blocks.some((b) => b.cx === cx && b.cy === cy);
  }

  return { ITEMS, NODE_TYPES, DEFAULT_SPAWN, LIMITS, GATHER_RANGE, GATHER_COOLDOWN, PICKUP_RANGE, STACK_MAX, BAG_KINDS,
           normalizeConfig, totalCount, currentAmount, landTiles, territoryResourceError, findSpot, inBlocks };
});
