// ============================================================
// wild.js - Starforge 野外資源（裝飾）與「資源擋路」判斷（伺服器與瀏覽器共用同一份）
//
// 做什麼：
//   1. 野外的樹木、礦石、花朵：每個區塊依「場次 seed + 區塊座標」雜湊出位置、種類、大小（數量依後台的野外密度），
//      所以同一場次每個人看到的都一樣，伺服器與資料庫都不用存。只放在平原 / 丘陵上。
//      野外的只能看、不能採；任何隊伍的領地內不放（領地裡是伺服器生成、可以採的真正資源）。
//   2. 資源擋路：所有可採的東西（野外的 + 領地裡的資源節點）都有一個圓形的「佔地」，
//      角色與陸上動物不能走進去（obstacleAt）。伺服器移動模擬用它擋玩家，瀏覽器用它讓動物繞開、
//      讓「走到資源旁邊」停在佔地外。
// 為什麼共用：伺服器是唯一真相（擋不擋得住由伺服器決定），但野外資源只在瀏覽器畫；
//   兩邊跑同一份程式，算出來的位置一定一樣。瀏覽器從遊戲服務的 /starforge/wild.js 載入（要先載入 terrain.js）。
// 注意：改這裡的數量、間距、雜湊，等於換掉所有場次的野外配置（只是外觀與擋路，資料庫沒有存）。
// ============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./terrain'));
  else root.SfWild = factory(root.SfTerrain);
})(typeof self !== 'undefined' ? self : this, function (SfTerrain) {
  'use strict';
  const CHUNK = SfTerrain.CHUNK, T = SfTerrain.T;

  // 野外密度（每個區塊大約嘗試放幾個；落在水面、高山或太擠的會被跳過）：後台「資源分佈」的「野外密度」可改，
  // 沒給設定就用這裡的預設（與 resources.js 的 DEFAULT_SPAWN.wild、inc_sf_settings.asp 的 SF_RESOURCES 一致）
  const DEFAULT_WILD = { tree: 24, flower: 42, rock: 1.7, coal: 0.8, iron: 0.8, copper: 0.65, aluminum: 0.5, silver: 0.35, gold: 0.2 };
  const ORE_TYPES = ['rock', 'coal', 'iron', 'copper', 'aluminum', 'silver', 'gold'];   // 順序固定（影響雜湊挑選的結果）

  // 佔地半徑（格）：角色、動物的中心點不能進到「佔地 + BODY_R」以內。
  // 要比採集距離（resources.js 的 GATHER_RANGE 1.8）小，站在旁邊才採得到。
  const BLOCK_R = { tree: 0.9, flower: 0.45 };    // 沒列到的（各種礦）用 ORE_R
  const ORE_R = 1.0;
  const BODY_R = 0.3;                             // 角色 / 動物身體半徑
  const blockR = (type) => (BLOCK_R[type] != null ? BLOCK_R[type] : ORE_R);

  // density = { tree: 24, rock: 1.7, ... }（後台設定；缺的用 DEFAULT_WILD）。設定改了就重新 create 一份
  function create(terrain, density) {
    const cache = new Map();
    const D = {};
    for (const k of Object.keys(DEFAULT_WILD)) {
      const v = density && density[k] != null ? Number(density[k]) : DEFAULT_WILD[k];
      D[k] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_WILD[k];
    }
    const oreSum = ORE_TYPES.reduce((a, k) => a + D[k], 0);
    // 某個區塊裡的野外資源（不管領地；呼叫端自己決定領地內的要不要用）
    function chunk(cx, cy) {
      const key = cx + ',' + cy;
      let list = cache.get(key);
      if (list) return list;
      list = [];
      const S = CHUNK, seed = (terrain.seed | 0) + 90613, H = (i, j) => SfTerrain.hash2(cx * 64 + i, cy * 64 + j, seed);
      // 野外礦石：每區塊嘗試次數 = 各種礦密度的總和（上下浮動 40%），種類依各自密度的比例挑；丘陵比較容易出現
      const tries = Math.floor(oreSum * 0.6 + H(0, 0) * (oreSum * 0.8 + 1));
      for (let i = 1; i <= tries; i++) {
        const x = cx * S + 1.5 + H(i, 1) * (S - 3), y = cy * S + 1.5 + H(i, 2) * (S - 3);
        const t = terrain.at(x, y);
        if (t !== T.PLAIN && t !== T.HILL) continue;
        if (t === T.PLAIN && H(i, 3) < 0.45) continue;      // 平原少一點
        if (oreSum <= 0) break;
        let r = H(i, 4) * oreSum, type = null;
        for (const k of ORE_TYPES) { if ((r -= D[k]) < 0 && D[k] > 0) { type = k; break; } }
        if (!type) continue;
        if (list.some((o) => Math.hypot(o.x - x, o.y - y) < 4.5)) continue;
        list.push({ wild: true, id: 'w' + key + ':' + i, type, x: Math.floor(x) + 0.5, y: Math.floor(y) + 0.5, size: H(i, 5) < 0.4 ? 'l' : H(i, 5) < 0.85 ? 'm' : 's' });
      }
      // 野外樹木：區塊的「樹林密度」也用雜湊決定，有的區塊樹多、有的稀疏
      const dens = 0.35 + H(0, 9) * 0.65;
      const treeTries = Math.round((D.tree * 2 / 3 + H(0, 8) * (D.tree * 2 / 3)) * dens);   // 密度 ×（2/3～4/3）× 樹林密度
      for (let i = 1; i <= treeTries; i++) {
        const x = cx * S + 1.5 + H(i + 40, 1) * (S - 3), y = cy * S + 1.5 + H(i + 40, 2) * (S - 3);
        const t = terrain.at(x, y);
        if (t !== T.PLAIN && t !== T.HILL) continue;
        if (t === T.HILL && H(i + 40, 3) < 0.6) continue;
        if (list.some((o) => Math.hypot(o.x - x, o.y - y) < (o.type === 'tree' ? 7.5 : 4.5))) continue;   // 大樹約 8 格寬
        list.push({ wild: true, id: 'w' + key + ':t' + i, type: 'tree', x: Math.floor(x) + 0.5, y: Math.floor(y) + 0.5, size: H(i + 40, 5) < 0.45 ? 'l' : H(i + 40, 5) < 0.85 ? 'm' : 's' });
      }
      // 野外花朵：花田密度也用雜湊決定；離樹、礦遠一點，花跟花可以近一點
      const fdens = Math.pow(H(0, 11), 1.5);
      const flowerTries = Math.round((D.flower * 2 / 3 + H(0, 12) * (D.flower * 2 / 3)) * (0.4 + fdens * 0.6));
      for (let i = 1; i <= flowerTries; i++) {
        const x = cx * S + 1.5 + H(i + 90, 1) * (S - 3), y = cy * S + 1.5 + H(i + 90, 2) * (S - 3);
        const t = terrain.at(x, y);
        if (t !== T.PLAIN && t !== T.HILL) continue;
        if (t === T.HILL && H(i + 90, 3) < 0.7) continue;
        if (list.some((o) => Math.hypot(o.x - x, o.y - y) < (o.type === 'flower' ? 2.2 : o.type === 'tree' ? 4 : 3.5))) continue;
        list.push({ wild: true, id: 'w' + key + ':f' + i, type: 'flower', x: Math.floor(x) + 0.5, y: Math.floor(y) + 0.5, size: H(i + 90, 5) < 0.35 ? 'l' : H(i + 90, 5) < 0.75 ? 'm' : 's' });
      }
      cache.set(key, list);
      if (cache.size > 600) cache.delete(cache.keys().next().value);
      return list;
    }

    // (x, y) 有沒有被資源擋住：回傳擋住的那個資源（{ x, y, type, r }），沒有就回 null
    //   territory = Set('cx,cy')（領地區塊，裡面的野外資源不算）；nodesNear(x, y) = 附近的真正資源節點（呼叫端提供）
    function obstacleAt(x, y, territory, nodesNear) {
      const cx0 = Math.floor(x / CHUNK), cy0 = Math.floor(y / CHUNK);
      for (let cy = cy0 - 1; cy <= cy0 + 1; cy++) for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) {
        if (cx < 0 || cy < 0 || territory && territory.has(cx + ',' + cy)) continue;
        for (const o of chunk(cx, cy)) {
          const r = blockR(o.type) + BODY_R;
          if (Math.abs(o.x - x) < r && Math.abs(o.y - y) < r && Math.hypot(o.x - x, o.y - y) < r) return { x: o.x, y: o.y, type: o.type, r };
        }
      }
      if (nodesNear) for (const n of nodesNear(x, y)) {
        const r = blockR(n.type) + BODY_R;
        if (Math.abs(n.x - x) < r && Math.abs(n.y - y) < r && Math.hypot(n.x - x, n.y - y) < r) return { x: n.x, y: n.y, type: n.type, r };
      }
      return null;
    }
    return { chunk, obstacleAt };
  }

  // 往目標走一步，撞到資源就沿著它的邊緣繞（左右各試幾個角度，選離目標最近的）；都過不去回 null
  //   ok(x, y) = 地形可走；hit(x, y) = obstacleAt 的結果
  //   已經站在佔地裡（例如資源剛好長在腳下）時，只要不是往更裡面走就放行，才走得出來
  function stepAround(x, y, tx, ty, step, ok, hit) {
    const dx = tx - x, dy = ty - y, d = Math.hypot(dx, dy);
    if (d < 1e-6) return null;
    const s = Math.min(step, d), base = Math.atan2(dy, dx);
    const here = hit(x, y);
    const allowed = (nx, ny) => {
      if (!ok(nx, ny)) return false;
      const o = hit(nx, ny);
      if (!o) return true;
      return here && o.x === here.x && o.y === here.y && Math.hypot(nx - o.x, ny - o.y) >= Math.hypot(x - o.x, y - o.y) - 1e-6;
    };
    const nx0 = x + Math.cos(base) * s, ny0 = y + Math.sin(base) * s;
    if (allowed(nx0, ny0)) return [nx0, ny0, false];
    let best = null;
    for (const a of [0.5, 0.9, 1.3, 1.65]) for (const sg of [1, -1]) {
      const ang = base + a * sg, nx = x + Math.cos(ang) * s, ny = y + Math.sin(ang) * s;
      if (!allowed(nx, ny)) continue;
      const dd = Math.hypot(tx - nx, ty - ny);
      if (!best || dd < best[2]) best = [nx, ny, dd];
    }
    return best ? [best[0], best[1], true] : null;
  }

  return { create, stepAround, blockR, BODY_R, DEFAULT_WILD };
});
