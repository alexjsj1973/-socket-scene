// ============================================================
// resources.js - Starforge 資源節點與物品（伺服器與瀏覽器共用同一份）
//
// 做什麼：
//   * 依場次 seed，在每個區塊固定生成資源節點：平原上的樹木、丘陵上的石頭 / 鐵礦 / 銅礦
//     （位置由 seed 決定，相同 seed 一定一樣；資料庫只存「被採過、數量變了」的節點，GDD 28.1）
//   * 物品清單（名稱、圖示）、每種節點的蘊藏量與再生速度
//   * 再生：被採過的節點每隔一段時間恢復 1 單位，速度再乘上場次的「資源再生倍率」
// 為什麼共用：伺服器用來驗證採集，瀏覽器用來畫資源、顯示剩餘量，兩邊結果一定一致。
// 瀏覽器從遊戲服務的 /starforge/resources.js 載入（要先載入 terrain.js）。
// 注意：改生成規則等於換掉所有場次的資源位置，進行中的場次不要改；
//       物品代碼發出去後不要刪（玩家背包裡會有）。
// ============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./terrain'));
  else root.SfResources = factory(root.SfTerrain);
})(typeof self !== 'undefined' ? self : this, function (SfTerrain) {
  'use strict';
  const CHUNK = SfTerrain.CHUNK, T = SfTerrain.T;

  // 物品：代碼 → 名稱、圖示
  const ITEMS = {
    wood:       { name: '木材', icon: '🪵' },
    stone:      { name: '石材', icon: '🪨' },
    iron_ore:   { name: '鐵礦石', icon: '⛓️' },
    copper_ore: { name: '銅礦石', icon: '🟠' }
  };
  // 節點種類：產出物品、蘊藏量、每恢復 1 單位需要的秒數（再除以再生倍率）、名稱
  const NODE_TYPES = {
    tree:   { item: 'wood',       max: 6,  regenSec: 60,  name: '樹木' },
    rock:   { item: 'stone',      max: 8,  regenSec: 120, name: '石頭' },
    iron:   { item: 'iron_ore',   max: 10, regenSec: 180, name: '鐵礦脈' },
    copper: { item: 'copper_ore', max: 10, regenSec: 180, name: '銅礦脈' }
  };
  const GATHER_RANGE = 1.8;     // 角色離節點多近才能採（格）
  const GATHER_COOLDOWN = 900;  // 每次採集的間隔（毫秒）
  const STACK_MAX = 999;        // 每種物品最多帶多少
  const BAG_KINDS = 20;         // 背包最多幾種物品

  // 每個區塊的節點（同一個 terrain 物件內快取）
  function nodesInChunk(terrain, cx, cy) {
    if (!terrain._nodeCache) terrain._nodeCache = new Map();
    const key = cx + ',' + cy;
    let list = terrain._nodeCache.get(key);
    if (list) return list;
    list = [];
    if (cx >= 0 && cy >= 0 && cx < terrain.mapChunks && cy < terrain.mapChunks) {
      const seed = terrain.seed + 7919;
      const rnd = (k) => SfTerrain.hash2(cx * 131 + k, cy * 137 + k * 7, seed);
      // 森林密度：大範圍雜訊，決定這一帶樹多不多
      const forest = SfTerrain.fbm((cx + 0.5) * CHUNK / 140, (cy + 0.5) * CHUNK / 140, seed + 55, 3);
      const tries = 16 + Math.floor(forest * 26);
      for (let k = 0; k < tries; k++) {
        const x = cx * CHUNK + Math.floor(rnd(k * 3) * CHUNK) + 0.5;
        const y = cy * CHUNK + Math.floor(rnd(k * 3 + 1) * CHUNK) + 0.5;
        const t = terrain.at(x, y);
        if (t !== T.PLAIN && t !== T.HILL) continue;
        if (list.some((n) => Math.abs(n.x - x) + Math.abs(n.y - y) < 3)) continue;
        const r = rnd(k * 3 + 2);
        let type = null;
        if (t === T.PLAIN) {
          if (r < 0.25 + forest * 0.6) type = 'tree';
          else if (r > 0.93) type = 'rock';
        } else {
          const h = terrain.heightAt(x, y);   // 越接近高山，礦越多
          if (r < 0.45) type = 'rock';
          else if (r < 0.45 + 0.18 + (h - SfTerrain.LEVEL.hill) * 2) type = r < 0.56 ? 'iron' : 'copper';
          else if (r > 0.9) type = 'tree';
        }
        if (type) list.push({ id: cx + '_' + cy + '_' + k, type, x, y });
      }
    }
    terrain._nodeCache.set(key, list);
    return list;
  }

  // 用節點代碼找節點（代碼 = 區塊x_區塊y_序號）
  function nodeById(terrain, id) {
    const m = /^(\d+)_(\d+)_(\d+)$/.exec(String(id || ''));
    if (!m) return null;
    return nodesInChunk(terrain, +m[1], +m[2]).find((n) => n.id === id) || null;
  }

  // 目前剩餘量：state = { amount, t(上次變動的毫秒時間) }；沒有 state = 滿的
  function currentAmount(node, state, now, regenMult) {
    const def = NODE_TYPES[node.type];
    if (!state) return def.max;
    const interval = def.regenSec * 1000 / Math.max(0.1, regenMult || 1);
    const regen = Math.floor(Math.max(0, now - state.t) / interval);
    return Math.min(def.max, state.amount + regen);
  }

  // 插旗用：初始領地內至少要有樹和石頭類資源（GDD 30.3「初始範圍內須保證有基礎資源」）
  function territoryResourceError(terrain, blocks) {
    let trees = 0, stones = 0;
    for (const b of blocks) for (const n of nodesInChunk(terrain, b.cx, b.cy)) {
      if (n.type === 'tree') trees++; else stones++;
    }
    if (trees < 2) return '初始領地裡樹木太少，換個靠近森林的位置';
    if (stones < 1) return '初始領地裡沒有石頭或礦脈，換個靠近丘陵的位置';
    return null;
  }

  // 點在不在某些區塊裡
  function inBlocks(blocks, x, y) {
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
    return blocks.some((b) => b.cx === cx && b.cy === cy);
  }

  return { ITEMS, NODE_TYPES, GATHER_RANGE, GATHER_COOLDOWN, STACK_MAX, BAG_KINDS,
           nodesInChunk, nodeById, currentAmount, territoryResourceError, inBlocks };
});
