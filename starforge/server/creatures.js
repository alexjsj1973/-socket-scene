// ============================================================
// creatures.js - Starforge 野生動物與怪物（伺服器與瀏覽器共用同一份，2026-11-22）
//
// 做什麼：
//   * 種類資料：動物（ANIMALS）、怪物（MONSTERS）的外觀行為（地形、速度、一群幾隻）與戰鬥數值（血量、攻擊、反應、經驗、掉落）
//   * 武器（WEAPONS / weaponOf）：手上拿的道具決定傷害、攻擊距離、攻擊間隔
//   * 生成與漫遊：每個區塊依「場次 seed + 區塊座標」雜湊出幾群動物 / 怪物，住處附近一段一段走；
//     位置只由「編號 + 伺服器時間」決定，所以伺服器與每個玩家同一時間算出同一個位置，平常不用傳任何資料。
//   * 戰鬥時（被打、怪物追人）改由伺服器模擬位置並廣播（server/combat.js），前端用伺服器給的位置蓋過漫遊位置。
//
// 用法：
//   const crea = SfCreatures.create(terrain, { obstacleAt(x, y), territory() → Set('cx,cy'), monsterCfg() → parseMonsterCfg 的結果 });
//   crea.animalsIn(cx, cy) / crea.monstersIn(cx, cy) → 區塊裡的生物（快取）；crea.update(a, now) 依時間算 a.x / a.y / a.dir / a.moving
//   crea.byId(id) → 依編號找生物；crea.clearAnimals() / crea.clearMonsters() → 設定或地形變了要清快取
// 伺服器用 require('./creatures')；瀏覽器從遊戲服務的 /starforge/creatures.js 載入（要先載入 terrain.js），全域名稱 SfCreatures。
// 改這裡要重新部署 Render（瀏覽器也是從那裡載入），前端 main.js 只負責畫。
// 編號：動物 'cx,cy:群:隻'、怪物 'mcx,cy:群:隻'（只由 seed 與區塊決定，伺服器和前端一致）
// ============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./terrain'));
  else root.SfCreatures = factory(root.SfTerrain);
})(typeof self !== 'undefined' ? self : this, function (SfTerrain) {
  'use strict';

  // 掉落物品（生肉、獸皮、怪物素材…）定義在 resources.js 的 ITEMS（LOOT 區）；loot 裡的代碼要在那裡有

  // ---- 動物 ----
  // 外觀行為：hab land 陸地 / sea 開闊水面 / air 天空；pref plain 平原、hill 丘陵、coast 海邊；move 動作；speed 格 / 秒；w 權重；herd 一群幾隻；
  //   depth = 水裡的大動物四周要有幾格水（身體才不會跑到岸上）
  // 戰鬥：hp 血量、atk 攻擊力、act 被打時的反應（flee 逃跑 / fight 還手）、exp 經驗值、respawn 被打倒後幾秒在原處重新出現、
  //   loot = [[物品, 最少, 最多, 機率]]（機率省略 = 1）
  const ANIMALS = {
    lion:      { name: '獅子',   hab: 'land', pref: 'plain', move: 'walk',   speed: 1.6, w: 5, hp: 90, atk: 12, act: 'fight', exp: 30, loot: [['raw_meat', 2, 3], ['hide', 1, 2]] },
    tiger:     { name: '老虎',   hab: 'land', pref: 'hill',  move: 'walk',   speed: 1.7, w: 4, hp: 95, atk: 13, act: 'fight', exp: 32, loot: [['raw_meat', 2, 3], ['hide', 1, 2]] },
    elephant:  { name: '大象',   hab: 'land', pref: 'plain', move: 'walk',   speed: 1.0, w: 4, herd: [2, 3], hp: 160, atk: 15, act: 'fight', exp: 40, loot: [['raw_meat', 3, 5], ['hide', 2, 3], ['bone', 1, 2]] },
    giraffe:   { name: '長頸鹿', hab: 'land', pref: 'plain', move: 'walk',   speed: 1.2, w: 4, herd: [2, 3], hp: 90, atk: 0, act: 'flee', exp: 20, loot: [['raw_meat', 2, 4], ['hide', 1, 2]] },
    zebra:     { name: '斑馬',   hab: 'land', pref: 'plain', move: 'walk',   speed: 1.8, w: 5, herd: [2, 4], hp: 55, atk: 0, act: 'flee', exp: 12, loot: [['raw_meat', 1, 3], ['hide', 1, 1]] },
    cheetah:   { name: '獵豹',   hab: 'land', pref: 'plain', move: 'walk',   speed: 3.2, w: 3, hp: 65, atk: 10, act: 'fight', exp: 22, loot: [['raw_meat', 1, 2], ['hide', 1, 1]] },
    wolf:      { name: '灰狼',   hab: 'land', pref: 'hill',  move: 'walk',   speed: 2.2, w: 4, herd: [2, 3], hp: 50, atk: 9, act: 'fight', exp: 18, loot: [['raw_meat', 1, 2], ['hide', 1, 1], ['bone', 0, 1]] },
    bear:      { name: '黑熊',   hab: 'land', pref: 'hill',  move: 'walk',   speed: 1.1, w: 3, hp: 120, atk: 14, act: 'fight', exp: 35, loot: [['raw_meat', 2, 4], ['hide', 1, 2]] },
    panda:     { name: '熊貓',   hab: 'land', pref: 'hill',  move: 'waddle', speed: 0.8, w: 3, hp: 80, atk: 0, act: 'flee', exp: 16, loot: [['hide', 1, 1]] },
    kangaroo:  { name: '袋鼠',   hab: 'land', pref: 'plain', move: 'hop',    speed: 2.4, w: 3, hp: 50, atk: 0, act: 'flee', exp: 12, loot: [['raw_meat', 1, 2], ['hide', 1, 1]] },
    penguin:   { name: '企鵝',   hab: 'land', pref: 'coast', move: 'waddle', speed: 0.9, w: 4, herd: [2, 4], hp: 20, atk: 0, act: 'flee', exp: 6, loot: [['raw_meat', 1, 1], ['feather', 1, 2]] },
    turtle:    { name: '烏龜',   hab: 'land', pref: 'coast', move: 'walk',   speed: 0.4, w: 3, hp: 30, atk: 0, act: 'flee', exp: 8, loot: [['turtle_shell', 1, 1, 0.6]] },
    whale:     { name: '鯨魚',   hab: 'sea',  move: 'swim',  speed: 1.2, w: 2, depth: 4, hp: 200, atk: 0, act: 'flee', exp: 50, loot: [['raw_meat', 4, 6], ['whale_oil', 1, 2]] },
    dolphin:   { name: '海豚',   hab: 'sea',  move: 'swim',  speed: 2.6, w: 4, herd: [2, 3], depth: 3, hp: 60, atk: 0, act: 'flee', exp: 18, loot: [['fish_meat', 1, 2]] },
    shark:     { name: '鯊魚',   hab: 'sea',  move: 'swim',  speed: 2.0, w: 3, depth: 3, hp: 100, atk: 12, act: 'fight', exp: 32, loot: [['fish_meat', 2, 3], ['bone', 0, 1]] },
    octopus:   { name: '章魚',   hab: 'sea',  move: 'float', speed: 0.7, w: 3, hp: 30, atk: 0, act: 'flee', exp: 8, loot: [['fish_meat', 1, 1]] },
    jellyfish: { name: '水母',   hab: 'sea',  move: 'float', speed: 0.5, w: 3, hp: 18, atk: 4, act: 'fight', exp: 6, loot: [['slime_gel', 0, 1]] },
    eagle:     { name: '老鷹',   hab: 'air',  move: 'fly',   speed: 4.0, w: 3, hp: 35, atk: 0, act: 'flee', exp: 10, loot: [['feather', 1, 3]] },
    owl:       { name: '貓頭鷹', hab: 'air',  move: 'fly',   speed: 2.6, w: 2, hp: 25, atk: 0, act: 'flee', exp: 8, loot: [['feather', 1, 2]] },
    pigeon:    { name: '鴿子',   hab: 'air',  move: 'fly',   speed: 3.2, w: 4, hp: 12, atk: 0, act: 'flee', exp: 4, loot: [['feather', 1, 1]] }
  };
  // ---- 怪物：一律主動攻擊（靠近 aggro 格內就追上來打）----
  //   外觀：size = 整格圖（64×64）畫出來的高度 ÷ 角色身高；alt = 飛多高（格）；desc = 滑鼠提示
  //   w = 預設出現權重（後台「怪物」可以改；與 inc/inc_sf_settings.asp 的 SF_MONSTERS 一致，改一邊就要改另一邊）
  const MONSTERS = {
    moss_slime:  { name: '苔石史萊姆', hab: 'land', pref: 'plain', speed: 0.9, size: 1.3,  w: 14, herd: [1, 3], hp: 30,  atk: 4,  exp: 10, loot: [['slime_gel', 1, 2]], desc: '長滿青苔的果凍，一伸一縮往前彈' },
    mushroom:    { name: '蘑菇走走',   hab: 'land', pref: 'plain', speed: 0.7, size: 1.2,  w: 12, herd: [2, 3], hp: 28,  atk: 4,  exp: 9,  loot: [['mushroom_cap', 1, 2]], desc: '頂著紅傘的小蘑菇，成群慢慢散步' },
    rock_beetle: { name: '岩殼甲蟲',   hab: 'land', pref: 'hill',  speed: 0.8, size: 1.35, w: 12, herd: [1, 2], hp: 55,  atk: 6,  exp: 15, loot: [['beetle_shell', 1, 1], ['stone', 1, 2, 0.5]], desc: '背著嵌礦石的硬殼，常在山坡出沒' },
    swamp_frog:  { name: '沼澤大嘴蛙', hab: 'land', pref: 'coast', speed: 1.3, size: 1.35, w: 10, herd: [1, 2], hp: 40,  atk: 5,  exp: 12, loot: [['frog_skin', 1, 1], ['raw_meat', 0, 1]], desc: '住在水邊，嘴巴大得嚇人' },
    sabertooth:  { name: '劍齒幼獸',   hab: 'land', pref: 'plain', speed: 2.0, size: 1.4,  w: 8,  hp: 85, atk: 11, exp: 28, loot: [['saber_fang', 1, 2], ['hide', 1, 1], ['raw_meat', 1, 2]], desc: '兩根長牙的小劍齒虎，跑得很快' },
    lava_lizard: { name: '熔岩蜥蜴',   hab: 'land', pref: 'hill',  speed: 1.6, size: 1.4,  w: 8,  hp: 60,  atk: 9,  exp: 20, loot: [['lava_scale', 1, 2]], desc: '背上冒著熱氣的蜥蜴' },
    ptero:       { name: '翼龍雛鳥',   hab: 'air',  speed: 3.0, size: 1.6, w: 8, alt: 1.8, hp: 50, atk: 8, exp: 18, loot: [['feather', 1, 3], ['bone', 0, 1]], desc: '在天空盤旋的小翼龍' },
    mammoth:     { name: '長毛象寶寶', hab: 'land', pref: 'plain', speed: 0.8, size: 1.8,  w: 6,  herd: [2, 3], hp: 150, atk: 14, exp: 45, loot: [['mammoth_wool', 1, 3], ['raw_meat', 2, 3], ['bone', 1, 1]], desc: '毛茸茸的小長毛象，跟著家人走' },
    bone_spirit: { name: '骨面幽魂',   hab: 'air',  speed: 1.0, size: 1.3, w: 5, alt: 0.3, hp: 70, atk: 10, exp: 25, loot: [['spirit_essence', 1, 1], ['bone', 1, 2]], desc: '戴著骨面具的幽魂，低低地飄' },
    stone_totem: { name: '圖騰石像',   hab: 'land', pref: 'hill',  speed: 0.3, size: 1.45, w: 3,  hp: 200, atk: 16, exp: 60, loot: [['totem_core', 1, 1], ['stone', 2, 4]], desc: '會慢慢挪動的古老石像' }
  };
  Object.keys(MONSTERS).forEach((k) => { const m = MONSTERS[k]; m.act = 'aggro'; m.move = m.hab === 'air' ? 'fly' : 'walk'; });

  // ---- 戰鬥規則（伺服器用，前端用來決定走多近、多久送一次攻擊）----
  const COMBAT = {
    aggroRange: 5,          // 怪物發現玩家的距離（格）
    leash: 18,              // 追離住處多遠就放棄、走回去（格）
    mobReach: 1.5,          // 生物打得到玩家的距離（格；水裡的打得到岸邊的人）
    mobAttackMs: 1500,      // 生物攻擊間隔
    fleeMs: 4500,           // 被打的草食動物逃跑多久
    respawnAnimal: 90,      // 預設：動物被打倒後幾秒重新出現
    respawnMonster: 60,     // 預設：怪物被打倒後幾秒重新出現
    playerRespawnMs: 5000,  // 玩家倒下後幾毫秒在旗子旁復活
    regenDelayMs: 8000,     // 玩家多久沒被打就開始回血
    regenPerSec: 0.03,      // 每秒回最大血量的幾成
    maxLevel: 99
  };
  const maxHpOf = (level) => 100 + 12 * (Math.max(1, level) - 1);           // 角色最大血量
  const expNeed = (level) => 40 + 30 * Math.max(1, level);                  // 升到下一級要多少經驗（Lv1 → 2 要 70）

  // ---- 武器：手上拿的道具 → 傷害、攻擊距離（格）、攻擊間隔（毫秒）；沒拿 = 徒手 ----
  const WEAPON_CAT = {
    melee: { dmg: 16, range: 1.7, cd: 900 }, ranged: { dmg: 12, range: 6.5, cd: 1100 }, magic: { dmg: 14, range: 5.5, cd: 1200 },
    shield: { dmg: 6, range: 1.5, cd: 900 }, tool: { dmg: 8, range: 1.6, cd: 900 }, stone: { dmg: 8, range: 1.6, cd: 900 }
  };
  const WEAPONS = {
    long_sword: { dmg: 20 }, battle_axe: { dmg: 22, cd: 1100 }, war_hammer: { dmg: 24, cd: 1200 }, dagger: { dmg: 12, cd: 650 },
    spear: { dmg: 17, range: 2.3 }, crossbow: { dmg: 18, range: 7, cd: 1300 }, pistol: { dmg: 16, range: 6, cd: 1000 },
    rifle: { dmg: 22, range: 8, cd: 1500 }, boomerang: { dmg: 11, range: 5 }, healing_staff: { dmg: 8 }, guardian_staff: { dmg: 9 },
    stone_axe: { dmg: 11, cd: 950 }, handaxe: { dmg: 10 }, flint_knife: { dmg: 9, range: 1.5, cd: 750 }, stone_spear: { dmg: 13, range: 2.3, cd: 950 },
    resin_torch: { dmg: 10, range: 1.7 }, wood_bow: { dmg: 10, range: 6, cd: 1100 }
  };
  const UNARMED = { dmg: 7, range: 1.5, cd: 900 };
  // 武器數值：held = 手上的道具代碼；cat = resources.js 的 EQUIPMENT[held].cat
  function weaponOf(held, cat) {
    if (!held || !cat || !WEAPON_CAT[cat]) return Object.assign({ name: '徒手' }, UNARMED);
    return Object.assign({}, WEAPON_CAT[cat], WEAPONS[held] || {});
  }

  // ---- 漫遊 ----
  const ROAM = { land: 7, sea: 10, air: 16 };      // 離住處最遠幾格
  const SEG_MS = 7000;                             // 每一段（走 + 停）多久
  const ANIMAL_PER_CHUNK = { land: [1, 3], sea: [1, 3], air: [0, 2] };   // 每個區塊幾群
  const MONSTER_DENSITY_DEFAULT = 1.5, MONSTER_DENSITY_MAX = 10, MONSTER_PER_CHUNK_MAX = 12;
  const animalsByHab = { land: [], sea: [], air: [] };
  Object.keys(ANIMALS).forEach((k) => animalsByHab[ANIMALS[k].hab].push(k));

  // 後台怪物設定（game_api.asp 的 resources.monster = { density, species:{代碼:權重} }）→ { density, kinds, cum, total }
  function parseMonsterCfg(raw) {
    const m = raw && typeof raw === 'object' ? raw : {};
    let density = Number(m.density);
    if (m.density == null || !Number.isFinite(density)) density = MONSTER_DENSITY_DEFAULT;
    density = Math.max(0, Math.min(MONSTER_DENSITY_MAX, density));
    const sp = m.species && typeof m.species === 'object' ? m.species : null;
    const kinds = [], cum = [];
    let total = 0;
    for (const k of Object.keys(MONSTERS)) {
      let w = sp && sp[k] != null ? Number(sp[k]) : MONSTERS[k].w;     // 後台之後才新增的怪物：用預設權重
      w = Number.isFinite(w) ? Math.max(0, Math.min(100, Math.floor(w))) : 0;
      if (w <= 0) continue;
      total += w; kinds.push(k); cum.push(total);
    }
    return { density: total > 0 ? density : 0, kinds, cum, total };
  }

  function create(terrain, env) {
    const S = SfTerrain.CHUNK, T = SfTerrain.T;
    const obstacleAt = (x, y) => (env && env.obstacleAt ? env.obstacleAt(x, y) : null);
    const territory = () => (env && env.territory ? env.territory() : new Set());
    const monsterCfg = () => (env && env.monsterCfg ? env.monsterCfg() : null) || parseMonsterCfg(null);

    // 地形判斷
    const isWater = (x, y) => terrain.at(x, y) === T.WATER;
    // 水夠不夠深：周圍 dep 格（上下左右與斜角）都是水；大隻的（鯨魚、鯊魚、海豚）要更寬的水面
    const deepWater = (x, y, dep) => {
      const r = dep || 2, k = r * 0.7;
      return isWater(x, y) && isWater(x + r, y) && isWater(x - r, y) && isWater(x, y + r) && isWater(x, y - r) &&
        isWater(x + k, y + k) && isWater(x - k, y + k) && isWater(x + k, y - k) && isWater(x - k, y - k);
    };
    const nearWater = (x, y) => isWater(x + 3, y) || isWater(x - 3, y) || isWater(x, y + 3) || isWater(x, y - 3);
    function habOk(hab, x, y, dep) {
      if (x < 1 || y < 1 || x > terrain.size - 1 || y > terrain.size - 1) return false;
      return hab === 'air' ? true : hab === 'sea' ? deepWater(x, y, dep) : (terrain.walkable(x, y) && !obstacleAt(x, y));   // 陸上動物也不能走到資源上
    }
    function lineOk(hab, x0, y0, x1, y1, dep) {
      if (hab === 'air') return true;
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.6);
      for (let i = 1; i <= n; i++) if (!habOk(hab, x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, dep)) return false;
      return true;
    }
    function prefOk(pref, x, y) {
      const t = terrain.at(x, y);
      if (pref === 'plain') return t === T.PLAIN;
      if (pref === 'hill') return t === T.HILL;
      if (pref === 'coast') return nearWater(x, y);
      return true;
    }
    // 怪物不進隊伍領地
    const freeOf = (x, y) => !territory().has(Math.floor(x / S) + ',' + Math.floor(y / S));
    function lineFree(x0, y0, x1, y1) {
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2));
      for (let i = 0; i <= n; i++) if (!freeOf(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n)) return false;
      return true;
    }

    // 區塊裡的動物（快取）
    const animalCache = new Map();
    function animalsIn(cx, cy) {
      const key = cx + ',' + cy;
      let list = animalCache.get(key);
      if (list) return list;
      list = [];
      const seed = (terrain.seed | 0) + 271828, H = (i, j) => SfTerrain.hash2(cx * 97 + i, cy * 97 + j, seed);
      let gi = 0;
      for (const hab of ['land', 'sea', 'air']) {
        const [lo, hi] = ANIMAL_PER_CHUNK[hab], base = hab === 'land' ? 10 : hab === 'sea' ? 40 : 70;
        const groups = lo + Math.floor(H(base, 0) * (hi - lo + 1));
        for (let g = 0; g < groups; g++) {
          gi++;
          // 種類：依權重；位置：找一個適合的住處（最多試 10 次）
          const kinds = animalsByHab[hab], sum = kinds.reduce((a, k) => a + ANIMALS[k].w, 0);
          let r = H(base + g, 1) * sum, kind = kinds[0];
          for (const k of kinds) { if ((r -= ANIMALS[k].w) < 0) { kind = k; break; } }
          const def = ANIMALS[kind];
          let home = null;
          for (let t = 0; t < 10 && !home; t++) {
            const x = cx * S + 2 + H(base + g, 10 + t) * (S - 4), y = cy * S + 2 + H(base + g, 30 + t) * (S - 4);
            if (habOk(hab, x, y, def.depth) && (hab !== 'land' || prefOk(def.pref, x, y) || t >= 7)) home = { x, y };
          }
          if (!home) continue;
          const herd = def.herd ? def.herd[0] + Math.floor(H(base + g, 50) * (def.herd[1] - def.herd[0] + 1)) : 1;
          for (let m = 0; m < herd; m++) {
            let hx = home.x + (m ? (H(base + g, 60 + m) - 0.5) * 4 : 0), hy = home.y + (m ? (H(base + g, 70 + m) - 0.5) * 4 : 0);
            if (!habOk(hab, hx, hy, def.depth)) { hx = home.x; hy = home.y; }
            list.push({ id: key + ':' + gi + ':' + m, kind, def, hab, depth: def.depth, chunk: key, hx, hy, seed: Math.floor(H(base + g, 80 + m) * 1e6),
                        phase: H(base + g, 90 + m) * SEG_MS, wp: new Map(), x: hx, y: hy, dir: 1, moving: false });
          }
        }
      }
      animalCache.set(key, list);
      if (animalCache.size > 400) animalCache.delete(animalCache.keys().next().value);
      return list;
    }
    // 區塊裡的怪物（快取；後台設定變了要 clearMonsters）
    const monsterCache = new Map();
    function monstersIn(cx, cy) {
      const key = cx + ',' + cy;
      let list = monsterCache.get(key);
      if (list) return list;
      list = [];
      const cfg = monsterCfg();
      const seed = (terrain.seed | 0) + 314159, H = (i, j) => SfTerrain.hash2(cx * 89 + i, cy * 89 + j, seed);
      const groups = cfg.total > 0 ? Math.min(MONSTER_PER_CHUNK_MAX, Math.floor(cfg.density) + (H(3, 0) < cfg.density % 1 ? 1 : 0)) : 0;
      for (let g = 0; g < groups; g++) {
        const base = 100 + g * 13;
        let r = H(base, 1) * cfg.total, kind = cfg.kinds[cfg.kinds.length - 1];
        for (let i = 0; i < cfg.kinds.length; i++) if (r < cfg.cum[i]) { kind = cfg.kinds[i]; break; }
        const def = MONSTERS[kind], hab = def.hab;
        let home = null;
        for (let t = 0; t < 10 && !home; t++) {
          const x = cx * S + 2 + H(base, 10 + t) * (S - 4), y = cy * S + 2 + H(base, 30 + t) * (S - 4);
          if (habOk(hab, x, y) && (hab !== 'land' || prefOk(def.pref, x, y) || t >= 7)) home = { x, y };
        }
        if (!home) continue;
        const herd = def.herd ? def.herd[0] + Math.floor(H(base, 50) * (def.herd[1] - def.herd[0] + 1)) : 1;
        for (let m = 0; m < herd; m++) {
          let hx = home.x + (m ? (H(base, 60 + m) - 0.5) * 3 : 0), hy = home.y + (m ? (H(base, 70 + m) - 0.5) * 3 : 0);
          if (!habOk(hab, hx, hy)) { hx = home.x; hy = home.y; }
          list.push({ id: 'm' + key + ':' + g + ':' + m, monster: true, kind, def, hab, chunk: key, hx, hy,
                      seed: Math.floor(H(base, 80 + m) * 1e6), phase: H(base, 90 + m) * SEG_MS, wp: new Map(), x: hx, y: hy, dir: 1, moving: false });
        }
      }
      monsterCache.set(key, list);
      if (monsterCache.size > 400) monsterCache.delete(monsterCache.keys().next().value);
      return list;
    }
    // 第 k 段的目的地（快取，只算一次）
    function wpOf(a, k) {
      let p = a.wp.get(k);
      if (p) return p;
      const R0 = ROAM[a.hab];
      p = { x: a.hx, y: a.hy };
      for (let j = 0; j < 6; j++) {
        const ang = SfTerrain.hash2(a.seed, k * 7 + j, 31) * Math.PI * 2, rr = (0.25 + 0.75 * SfTerrain.hash2(a.seed, k * 7 + j, 47)) * R0;
        const x = a.hx + Math.cos(ang) * rr, y = a.hy + Math.sin(ang) * rr;
        if (habOk(a.hab, x, y, a.depth) && lineOk(a.hab, a.hx, a.hy, x, y, a.depth) && (!a.monster || lineFree(a.hx, a.hy, x, y))) { p = { x, y }; break; }
      }
      a.wp.set(k, p);
      if (a.wp.size > 6) a.wp.delete(a.wp.keys().next().value);
      return p;
    }
    // 依伺服器時間更新位置（同一時間每個人算出來都一樣）：寫進 a.x、a.y、a.dir（1 右 / -1 左）、a.moving
    function update(a, now) {
      const t = now + a.phase, k = Math.floor(t / SEG_MS), f = (t - k * SEG_MS) / SEG_MS;
      const A = wpOf(a, k - 1), B = wpOf(a, k);
      // 直線會穿過走不過去的地形 → 經過住處（住處到每個 wp 的直線都檢查過）
      let legs = [[A, B]];
      const segKey = 'L' + k;
      let direct = a.wp.get(segKey);
      if (direct == null) { direct = lineOk(a.hab, A.x, A.y, B.x, B.y, a.depth) && (!a.monster || lineFree(A.x, A.y, B.x, B.y)) ? 1 : 0; a.wp.set(segKey, direct); }
      if (!direct) legs = [[A, { x: a.hx, y: a.hy }], [{ x: a.hx, y: a.hy }, B]];
      const lens = legs.map(([p, q]) => Math.hypot(q.x - p.x, q.y - p.y)), total = lens[0] + (lens[1] || 0);
      const moveFrac = Math.min(0.8, total / a.def.speed * 1000 / SEG_MS);   // 走路佔這一段的比例，剩下的時間停著
      if (total < 0.05 || f >= moveFrac) { a.x = B.x; a.y = B.y; a.moving = false; if (Math.abs(B.x - A.x) > 0.05) a.dir = B.x >= A.x ? 1 : -1; return a; }
      let d = (f / moveFrac) * total, leg = 0;
      if (legs.length > 1 && d > lens[0]) { d -= lens[0]; leg = 1; }
      const [p, q] = legs[leg], u = lens[leg] ? d / lens[leg] : 1;
      a.x = p.x + (q.x - p.x) * u; a.y = p.y + (q.y - p.y) * u;
      a.moving = true;
      if (Math.abs(q.x - p.x) > 0.05) a.dir = q.x >= p.x ? 1 : -1;
      return a;
    }
    // 依編號找生物（沒有回 null）
    function byId(id) {
      const m = /^(m?)(\d{1,4}),(\d{1,4}):(\d{1,3}):(\d{1,2})$/.exec(String(id || ''));
      if (!m) return null;
      const cx = Number(m[2]), cy = Number(m[3]), n = terrain.size / S;
      if (cx >= n || cy >= n) return null;
      const list = m[1] ? monstersIn(cx, cy) : animalsIn(cx, cy);
      for (const a of list) if (a.id === id) return a;
      return null;
    }
    // 生物能不能站在這裡（戰鬥時由伺服器移動用）
    const canStand = (a, x, y) => a.hab === 'air' ? (x > 1 && y > 1 && x < terrain.size - 1 && y < terrain.size - 1)
      : a.hab === 'sea' ? deepWater(x, y, 1)                       // 水裡的：四周 1 格都是水就能游（追 / 逃時可以靠近岸邊）
      : (terrain.walkable(x, y) && !obstacleAt(x, y));
    return {
      animalsIn, monstersIn, update, byId, habOk, canStand, isWater, freeOf,
      clearAnimals: () => animalCache.clear(), clearMonsters: () => monsterCache.clear()
    };
  }

  return { ANIMALS, MONSTERS, COMBAT, WEAPONS, UNARMED, ROAM, SEG_MS, MONSTER_DENSITY_DEFAULT,
           weaponOf, maxHpOf, expNeed, parseMonsterCfg, create };
});
