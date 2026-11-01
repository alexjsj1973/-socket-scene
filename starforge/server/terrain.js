// ============================================================
// terrain.js - Starforge 地形程序生成（伺服器與瀏覽器共用同一份）
//
// 做什麼：給定場次的 seed 與地圖大小，算出每一格的地形：
//   0 水域（海、湖、河）/ 1 平原 / 2 丘陵 / 3 高山（GDD 第 28 章的四層）
//   另外提供：可走、可建造判斷、初始領地區塊、插旗位置檢查、出生點搜尋。
// 為什麼共用：相同 seed 一定得到相同地形（GDD 28.1）。伺服器用它驗證移動與插旗，
//   瀏覽器用它畫地圖與預覽插旗位置，兩邊跑同一份程式，結果一定一致；
//   資料庫不用存整張地圖。瀏覽器從遊戲服務的 /starforge/terrain.js 載入這個檔案。
// 注意：改這裡的演算法或閾值，等於換掉所有場次的地形；進行中的場次不要改。
// ============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SfTerrain = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHUNK = 32;                 // 每個區塊 32×32 格（GDD 3.5 技術建議）
  const T = { WATER: 0, PLAIN: 1, HILL: 2, MOUNTAIN: 3 };
  const LEVEL = { water: 0.34, hill: 0.555, mountain: 0.645 };   // 高度分級閾值

  // ---- 以 seed 決定的雜湊與 value noise ----
  function hash2(ix, iy, seed) {
    let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967295;
  }
  const smooth = (t) => t * t * (3 - 2 * t);
  function noise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
    const u = smooth(fx), v = smooth(fy);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, seed, oct) {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += noise(x * freq, y * freq, seed + i * 101) * amp;
      norm += amp; amp *= 0.5; freq *= 2.03;
    }
    return sum / norm;
  }

  // 建立一個場次的地形
  function create(seed, mapChunks) {
    seed = (seed | 0) || 1;
    const size = mapChunks * CHUNK;            // 地圖邊長（格）

    // 高度 0～1：大範圍起伏 + 細節，四周往外降成海，讓地圖邊界自然是海岸
    function heightAt(x, y) {
      let h = fbm(x / 220, y / 220, seed, 5) * 0.82 + fbm(x / 48, y / 48, seed + 999, 3) * 0.18;
      const ex = Math.min(x, size - 1 - x) / size, ey = Math.min(y, size - 1 - y) / size;
      const edge = Math.min(ex, ey);           // 0（邊界）～ 0.5（中心）
      if (edge < 0.12) h -= (0.12 - edge) * 3.2;
      return h;
    }
    // 河流：另一組雜訊的等高線（數值接近 0.5 的細長帶狀），只出現在低地
    function riverAt(x, y, h) {
      if (h >= LEVEL.hill) return false;
      const r = fbm(x / 170, y / 170, seed + 4242, 3);
      const width = 0.012 + (LEVEL.hill - h) * 0.02;
      return Math.abs(r - 0.5) < width;
    }
    function at(x, y) {
      x = Math.floor(x); y = Math.floor(y);
      if (x < 0 || y < 0 || x >= size || y >= size) return T.WATER;
      const h = heightAt(x, y);
      if (h < LEVEL.water) return T.WATER;
      if (h >= LEVEL.mountain) return T.MOUNTAIN;
      if (riverAt(x, y, h)) return T.WATER;
      return h >= LEVEL.hill ? T.HILL : T.PLAIN;
    }
    const walkable = (x, y) => { const t = at(x, y); return t === T.PLAIN || t === T.HILL; };
    const buildable = walkable;               // 水面與高山不可建造（GDD 28.3）；丘陵坡度限制之後再加

    // 從 (cx, cy) 往外螺旋找最近的可走格子
    function findWalkable(cx, cy, maxR) {
      cx = Math.floor(cx); cy = Math.floor(cy); maxR = maxR || 400;
      if (walkable(cx, cy)) return { x: cx + 0.5, y: cy + 0.5 };
      for (let r = 1; r <= maxR; r++) {
        for (let k = -r; k <= r; k++) {
          const pts = [[cx + k, cy - r], [cx + k, cy + r], [cx - r, cy + k], [cx + r, cy + k]];
          for (const [x, y] of pts) if (walkable(x, y)) return { x: x + 0.5, y: y + 0.5 };
        }
      }
      return { x: size / 2, y: size / 2 };
    }
    return { seed, size, mapChunks, heightAt, at, walkable, buildable, findWalkable };
  }

  // 初始領地：離旗子最近的 n 個區塊（先比「棋盤距離」再比直線距離，4 塊會是 2×2 方形；結果固定、彼此相連）
  function initialTerritory(fx, fy, n, mapChunks) {
    const fcx = Math.floor(fx / CHUNK), fcy = Math.floor(fy / CHUNK), list = [];
    const r = Math.ceil(Math.sqrt(n)) + 1;
    for (let cy = fcy - r; cy <= fcy + r; cy++) for (let cx = fcx - r; cx <= fcx + r; cx++) {
      if (cx < 0 || cy < 0 || cx >= mapChunks || cy >= mapChunks) continue;
      const dx = (cx + 0.5) * CHUNK - fx, dy = (cy + 0.5) * CHUNK - fy;
      list.push({ cx, cy, c: Math.max(Math.abs(dx), Math.abs(dy)), d: dx * dx + dy * dy + (cy * 1e-6 + cx * 1e-9) });
    }
    list.sort((a, b) => (a.c - b.c) || (a.d - b.d));
    return list.slice(0, n).map(({ cx, cy }) => ({ cx, cy }));
  }

  // 插旗位置檢查（GDD 30.3）：伺服器用來驗證，瀏覽器用來預覽。回傳 { ok, error, blocks }
  //   opts = { initialBlocks, minFlagDistance（區塊）, flags: [{ x, y, teamId }], teamId }
  function checkFlagSite(terrain, x, y, opts) {
    const size = terrain.size;
    if (!(x >= 0 && y >= 0 && x < size && y < size)) return { ok: false, error: '超出地圖範圍' };
    if (!terrain.buildable(x, y)) return { ok: false, error: '旗子要插在平原或丘陵上（水面與高山不行）' };
    const minD = (opts.minFlagDistance || 0) * CHUNK;
    for (const f of opts.flags || []) {
      if (f.teamId === opts.teamId) continue;
      if (Math.hypot(f.x - x, f.y - y) < minD) return { ok: false, error: '離其他隊伍的旗子太近（至少要 ' + opts.minFlagDistance + ' 個區塊）' };
    }
    const blocks = initialTerritory(x, y, opts.initialBlocks || 1, terrain.mapChunks);
    if (blocks.length < (opts.initialBlocks || 1)) return { ok: false, error: '太靠近地圖邊緣', blocks };
    // 領地內抽樣：可建造面積至少一半、而且要有水源
    let total = 0, build = 0, water = 0;
    for (const b of blocks) {
      for (let yy = b.cy * CHUNK; yy < (b.cy + 1) * CHUNK; yy += 2) for (let xx = b.cx * CHUNK; xx < (b.cx + 1) * CHUNK; xx += 2) {
        total++;
        const t = terrain.at(xx, yy);
        if (t === T.PLAIN || t === T.HILL) build++;
        else if (t === T.WATER) water++;
      }
    }
    if (build < total * 0.5) return { ok: false, error: '這裡可以蓋東西的地太少（至少要一半是平原或丘陵）', blocks };
    if (water < 6) return { ok: false, error: '初始領地裡沒有水源，請選靠近河流或湖泊的位置', blocks };
    return { ok: true, blocks };
  }

  return { CHUNK, T, LEVEL, create, initialTerritory, checkFlagSite };
});
