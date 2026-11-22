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
    flower:       { name: '花朵',   icon: '🌸' },     // 2026-11-04 新增
    // 2026-11-22：打倒動物、怪物的掉落物品（掉落表在 creatures.js 的 loot；之後可以拿來做料理、裝備）
    raw_meat:       { name: '生肉',       icon: '🍖' },
    hide:           { name: '獸皮',       icon: '🟫' },
    bone:           { name: '骨頭',       icon: '🦴' },
    feather:        { name: '羽毛',       icon: '🪶' },
    fish_meat:      { name: '魚肉',       icon: '🐟' },
    whale_oil:      { name: '鯨油',       icon: '🛢️' },
    turtle_shell:   { name: '龜殼',       icon: '🐢' },
    slime_gel:      { name: '史萊姆凝膠', icon: '🟢' },
    mushroom_cap:   { name: '蘑菇傘',     icon: '🍄' },
    beetle_shell:   { name: '甲蟲殼',     icon: '🪲' },
    frog_skin:      { name: '蛙皮',       icon: '🐸' },
    saber_fang:     { name: '劍齒',       icon: '🦷' },
    lava_scale:     { name: '熔岩鱗片',   icon: '🔥' },
    mammoth_wool:   { name: '長毛',       icon: '🧶' },
    spirit_essence: { name: '幽魂精華',   icon: '👻' },
    totem_core:     { name: '圖騰核心',   icon: '🗿' }
  };

  // ---- 礦物（2026-11-14 新增）：「礦物礦脈」（NODE_TYPES.mineral）依位置固定是其中一種，採到的就是那種礦物 ----
  //   代碼 = assets/sunnyside/ore 的圖檔名（xxx_l / _m / _s），物品圖示用 _m；w = 預設出現權重（越大越常見）
  //   鐵、銅、鋁、銀、金已經有自己的礦脈（iron_ore …），不重複列。後台品種比例：inc/inc_sf_settings.asp 的 SF_SPECIES("mineral")，
  //   代碼與預設權重要跟這裡一致，改一邊就要改另一邊。代碼發出去後不要刪（背包、資料庫裡會有）。
  const MINERALS = {
    basalt:     { name: '玄武岩', w: 12 }, granite:    { name: '花崗岩', w: 12 }, sandstone:  { name: '砂岩',   w: 12 },
    shale:      { name: '頁岩',   w: 12 }, quartz:     { name: '石英',   w: 10 }, calcite:    { name: '方解石', w: 10 },
    dolomite:   { name: '白雲石', w: 10 }, feldspar:   { name: '長石',   w: 10 }, gypsum:     { name: '石膏',   w: 10 },
    marble:     { name: '大理石', w: 10 }, mica:       { name: '雲母',   w: 9 },  barite:     { name: '重晶石', w: 8 },
    hematite:   { name: '赤鐵礦', w: 8 },  pyrite:     { name: '黃鐵礦', w: 8 },  lead:       { name: '鉛礦',   w: 7 },
    magnetite:  { name: '磁鐵礦', w: 7 },  agate:      { name: '瑪瑙',   w: 6 },  azurite:    { name: '藍銅礦', w: 6 },
    fluorite:   { name: '螢石',   w: 6 },  serpentine: { name: '蛇紋石', w: 6 },  tin:        { name: '錫礦',   w: 6 },
    zinc:       { name: '鋅礦',   w: 6 },  malachite:  { name: '孔雀石', w: 5 },  nickel:     { name: '鎳礦',   w: 5 },
    obsidian:   { name: '黑曜石', w: 5 },  olivine:    { name: '橄欖石', w: 5 },  crystal:    { name: '水晶',   w: 4 },
    corundum:   { name: '剛玉',   w: 3 },  mercury:    { name: '汞礦',   w: 3 },  nephrite:   { name: '軟玉',   w: 3 },
    titanium:   { name: '鈦礦',   w: 3 },  jade:       { name: '翡翠',   w: 2 },  opal:       { name: '蛋白石', w: 2 },
    diamond:    { name: '鑽石',   w: 1 },  platinum:   { name: '鉑礦',   w: 1 }
  };
  Object.keys(MINERALS).forEach((k) => { ITEMS[k] = { name: MINERALS[k].name, icon: '💎', art: 'ore/' + k + '_m' }; });

  // ---- 道具裝備（2026-11-14 新增）：32 種，與 assets/sunnyside/equipment/catalog.json 的 id 一致 ----
  //   可以放進背包、存進資料庫（game_sf_inventory.ItemCode），要有才能拿在手上；用手動合成或組裝機做（配方在 factory.js 的 RECIPES）
  //   cat = catalog.json 的分類（melee / ranged / magic / shield / tool）
  const EQUIP_ICON = { melee: '⚔️', ranged: '🏹', magic: '🪄', shield: '🛡️', tool: '🔧', stone: '🪨' };
  const EQUIPMENT = {
    short_sword: { name: '旅行短劍', cat: 'melee' }, long_sword: { name: '騎士長劍', cat: 'melee' }, spear: { name: '巡林長槍', cat: 'melee' },
    battle_axe: { name: '開拓戰斧', cat: 'melee' }, war_hammer: { name: '鍛鋼戰鎚', cat: 'melee' }, dagger: { name: '月牙匕首', cat: 'melee' },
    bow: { name: '白樺獵弓', cat: 'ranged' }, crossbow: { name: '銅翼弩', cat: 'ranged' }, pistol: { name: '黃銅燧發槍', cat: 'ranged' },
    rifle: { name: '木托巡守步槍', cat: 'ranged' }, boomerang: { name: '迴風飛旋鏢', cat: 'ranged' },
    fire_staff: { name: '赤晶火焰杖', cat: 'magic' }, ice_staff: { name: '霜藍冰晶杖', cat: 'magic' }, lightning_wand: { name: '耀金雷光短杖', cat: 'magic' },
    guardian_staff: { name: '碧光守護杖', cat: 'magic' }, healing_staff: { name: '翠葉治癒杖', cat: 'magic' }, grimoire: { name: '星紋魔導書', cat: 'magic' },
    wood_shield: { name: '橡木圓盾', cat: 'shield' }, steel_shield: { name: '藍鋼塔盾', cat: 'shield' }, energy_shield: { name: '青曜能量盾', cat: 'shield' },
    pickaxe: { name: '精鋼十字鎬', cat: 'tool' }, wood_axe: { name: '伐木斧', cat: 'tool' }, power_drill: { name: '電動採礦鑽', cat: 'tool' },
    chainsaw: { name: '電動伐木鏈鋸', cat: 'tool' }, fishing_rod: { name: '溪畔釣竿', cat: 'tool' }, watering_can: { name: '暖銅澆水壺', cat: 'tool' },
    shovel: { name: '園丁鐵鏟', cat: 'tool' }, hoe: { name: '拓荒鋤頭', cat: 'tool' }, sickle: { name: '彎月收割鐮', cat: 'tool' },
    build_hammer: { name: '木匠建造鎚', cat: 'tool' }, repair_wrench: { name: '工程維修扳手', cat: 'tool' }, lantern: { name: '營地提燈', cat: 'tool' },
    // 2026-11-22：12 種石器（骨架角色自帶的道具模型與動作，對照表在 js/sf-avatar.js 的 STONE_TOOLS；圖示在 assets/sunnyside/equipment/stone/）
    stone_axe: { name: '磨製石斧', cat: 'stone' }, handaxe: { name: '打製手斧', cat: 'stone' }, flint_knife: { name: '燧石刀', cat: 'stone' },
    stone_spear: { name: '石尖長矛', cat: 'stone' }, hammerstone: { name: '敲擊石', cat: 'stone' }, digging_stick: { name: '掘土棒', cat: 'stone' },
    resin_torch: { name: '樹脂火把', cat: 'stone' }, stone_hoe: { name: '石鋤', cat: 'stone' }, stone_sickle: { name: '石鐮', cat: 'stone' },
    wood_bow: { name: '木弓', cat: 'stone' }, bone_fishing_rod: { name: '骨鉤釣竿', cat: 'stone' }, stone_pestle: { name: '石杵', cat: 'stone' }
  };
  Object.keys(EQUIPMENT).forEach((k) => { ITEMS[k] = { name: EQUIPMENT[k].name, icon: EQUIP_ICON[EQUIPMENT[k].cat],
    art: (EQUIPMENT[k].cat === 'stone' ? 'equipment/stone/' : 'equipment/icons/') + k, equip: EQUIPMENT[k].cat }; });
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
    flower:   { item: 'flower',       name: '花朵', terrain: 'plain', regenSec: 90 },   // 51 種花的外觀由前端依位置挑
    // 礦物礦脈：item 是 null，實際產出 = mineralAt(位置)（MINERALS 其中一種），一律用 nodeItem() 取
    mineral:  { item: null,           name: '礦物礦脈', terrain: 'hill', regenSec: 300 }   // 2026-11-14 新增
  };
  // 預設分佈（每隊領地）：count 個數、min～max 每個資源可採集的數量；wild = 野外每個區塊大約幾個（只能看、不能採）
  //   再生秒數的預設值是 NODE_TYPES 的 regenSec。後台可以改這些值（每個場次、每一版設定各自存），沒設定就用這裡的預設。
  // 與 inc/inc_sf_settings.asp 的 SF_RESOURCES 預設值一致，改一邊就要改另一邊
  const DEFAULT_SPAWN = {
    tree:     { count: 30, min: 10, max: 20, wild: 24 },
    rock:     { count: 30, min: 10, max: 20, wild: 1.7 },
    iron:     { count: 15, min: 8,  max: 15, wild: 0.8 },
    copper:   { count: 10, min: 8,  max: 15, wild: 0.65 },
    coal:     { count: 10, min: 8,  max: 15, wild: 0.8 },
    aluminum: { count: 10, min: 6,  max: 12, wild: 0.5 },
    silver:   { count: 3,  min: 3,  max: 6,  wild: 0.35 },
    gold:     { count: 2,  min: 2,  max: 4,  wild: 0.2 },
    flower:   { count: 20, min: 3,  max: 8,  wild: 42 },
    mineral:  { count: 12, min: 3,  max: 8,  wild: 0.6 }
  };
  // 上下限（與 ASP 驗證、SQL CHECK 一致）
  const LIMITS = { countMax: 500, totalMax: 1000, amountMax: 999, regenMin: 5, regenMax: 86400, wildMax: 100, speciesMax: 100 };
  const GATHER_RANGE = 1.8;     // 角色離資源多近才能採（格）
  const GATHER_COOLDOWN = 900;  // 每次採集的間隔（毫秒）
  const PICKUP_RANGE = 1.5;     // 角色離地上物品多近才能撿（格）
  const STACK_MAX = 999;        // 每種物品最多帶多少
  const BAG_KINDS = 100;        // 背包最多幾種物品（2026-11-13 工廠 20 → 40；2026-11-14 加入 35 種礦物、32 種道具 → 100）
  const TILES_PER_NODE = 6;     // 每個資源大約要佔幾格陸地（插旗時檢查領地放不放得下）
  const FLAG_CLEAR = 3;         // 旗子周圍幾格內不放資源（留給基地）

  // 整理設定：沒給設定 → 全部用預設；有給 → 沒列到的種類（之後才新增的，例如花朵）也用預設；數值夾在合法範圍內
  //   （2026-11-04 改：原本沒列到的當 0，新增花朵後進行中的場次也要長出花，所以改成用預設；不想要就在後台把數量設 0）
  //   每種：{ count, min, max, regen（每恢復 1 個幾秒）, wild（野外每區塊幾個）, species（品種權重，只有後台有設定的種類才有） }
  function normalizeConfig(cfg) {
    const out = {};
    const int = (v, lo, hi, def) => { v = Math.floor(Number(v)); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; };
    const dec = (v, lo, hi, def) => { v = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(v) ? def : Math.max(lo, Math.min(hi, v)); };
    for (const type of Object.keys(NODE_TYPES)) {
      const d = DEFAULT_SPAWN[type], regenDef = NODE_TYPES[type].regenSec;
      const c = cfg ? cfg[type] : d;
      if (!c) { out[type] = { count: d.count, min: d.min, max: d.max, regen: regenDef, wild: d.wild }; continue; }
      const min = int(c.min, 1, LIMITS.amountMax, d.min);
      const o = { count: int(c.count, 0, LIMITS.countMax, 0), min, max: Math.max(min, int(c.max, 1, LIMITS.amountMax, d.max)),
                  regen: c.regen == null ? regenDef : int(c.regen, LIMITS.regenMin, LIMITS.regenMax, regenDef),
                  wild: c.wild == null ? d.wild : dec(c.wild, 0, LIMITS.wildMax, d.wild) };
      // 品種權重：{ oak: 10, ... }，代碼只能是小寫英數（防止奇怪的 key），權重夾在 0～speciesMax
      if (c.species && typeof c.species === 'object') {
        o.species = {};
        for (const k of Object.keys(c.species)) if (/^[a-z0-9_]{1,30}$/.test(k)) o.species[k] = int(c.species[k], 0, LIMITS.speciesMax, 0);
      }
      out[type] = o;
    }
    return out;
  }
  const totalCount = (cfg) => Object.keys(cfg).reduce((s, k) => s + cfg[k].count, 0);
  // 野外密度：{ tree: 24, rock: 1.7, ... }（給 wild.js 用）
  const wildDensities = (cfg) => { const o = {}; for (const k of Object.keys(cfg)) o[k] = cfg[k].wild; return o; };

  // 目前剩餘量：node 要有 max（這個資源的可採數量）、amount（最後變動時的剩餘量）、t（最後變動的毫秒時間）
  //   cfg = normalizeConfig 的結果（有給就用後台設定的再生秒數，沒給用 NODE_TYPES 的預設）
  function currentAmount(node, now, regenMult, cfg) {
    const def = NODE_TYPES[node.type];
    if (!def) return 0;
    const sec = (cfg && cfg[node.type] && cfg[node.type].regen) || def.regenSec;
    const interval = sec * 1000 / Math.max(0.1, regenMult || 1);
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
  //   2026-11-22：spots.patches（planPatches 的結果）有這種資源的中心時，改放在礦區裡（離中心最近的空位）；
  //   opts.spread = 從最近的幾個空位裡隨機挑一個（採光搬家用，才不會老是搬回同一格）；spots.blocked = 工廠建築佔的格子
  function findSpot(spots, occupied, type, opts) {
    const centers = spots.patches && spots.patches[type];
    if (centers && centers.length) {
      const gap = patchOf(type).gap, blocked = spots.blocked;
      // 候選空地依「離最近的中心多遠」排好（每種資源排一次，快取在 spots 上）
      const key = '_sorted_' + type;
      if (!spots[key]) {
        spots[key] = spots.plains.concat(spots.hills).map(([x, y]) => [x, y, Math.min(...centers.map((c) => Math.hypot(c[0] - x, c[1] - y)))])
          .sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
      }
      const ok = (x, y) => {
        if (blocked) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (blocked.has((x + dx) + ',' + (y + dy))) return false;
        for (let dy = -gap; dy <= gap; dy++) for (let dx = -gap; dx <= gap; dx++) {
          if (dx * dx + dy * dy < gap * gap - 0.01 && occupied.has((x + dx) + ',' + (y + dy))) return false;
        }
        return true;
      };
      const found = [], want = opts && opts.spread ? opts.spread : 1;
      for (const [x, y, d] of spots[key]) {
        if (!ok(x, y)) continue;
        found.push([x, y]);
        if (found.length >= want || d > 24) break;
      }
      if (found.length) return found[Math.floor(Math.random() * found.length)];
    }
    return findSpotScatter(spots, occupied, type);
  }
  function findSpotScatter(spots, occupied, type) {
    const pref = NODE_TYPES[type] && NODE_TYPES[type].terrain === 'plain' ? [spots.plains, spots.hills] : [spots.hills, spots.plains];
    const free = (x, y, gap) => {
      for (let dy = -(gap - 1); dy <= gap - 1; dy++) for (let dx = -(gap - 1); dx <= gap - 1; dx++) {
        if (Math.abs(dx) + Math.abs(dy) < gap && occupied.has((x + dx) + ',' + (y + dy))) return false;
      }
      return true;
    };
    for (const gap of [3, 2]) for (const list of pref) {
      for (const [x, y] of list) if (free(x, y, gap) && !(spots.blocked && spots.blocked.has(x + ',' + y))) return [x, y];
    }
    return null;
  }

  // ---- 礦區（2026-11-22）：同種資源在領地裡聚成一片（礦石一片礦區、樹木成林、花朵成花田）----
  //   做法：插旗後依「隊伍 + 旗子位置 + 資源 epoch」雜湊，替每種資源挑幾個「中心」（彼此隔開、周圍陸地夠多、避開工廠建築），
  //   新長的資源一律放在離自己種類中心最近、還沒被佔用的空地；採光搬家也搬到同一片礦區裡的另一個空位。
  //   per = 每一片大約放幾個（數量超過就多開一片）；gap = 同一片裡彼此最近的距離（格）：
  //   礦石、樹木佔地半徑約 1 格，間隔 3 格角色才走得進去、每一顆都站得到旁邊採；花朵小，間隔 2 格。
  //   中心與擺放順序都是固定的雜湊，遊戲服務重啟後一樣；管理員按「重置所有資源」（epoch + 1）會換一組新的礦區位置。
  const PATCH = {
    tree: { per: 15, gap: 3 }, flower: { per: 12, gap: 2 }, rock: { per: 12, gap: 3 }, iron: { per: 10, gap: 3 },
    copper: { per: 10, gap: 3 }, coal: { per: 10, gap: 3 }, aluminum: { per: 10, gap: 3 }, silver: { per: 6, gap: 3 },
    gold: { per: 6, gap: 3 }, mineral: { per: 8, gap: 3 }
  };
  const PATCH_SEP = [10, 7, 4];       // 兩片礦區中心至少隔幾格（找不到就逐步放寬）
  const PATCH_ROOM = 4;               // 中心周圍這個半徑內要有夠多可用的陸地
  const patchOf = (type) => PATCH[type] || { per: 10, gap: 3 };
  // 每種資源要開幾片：cfg = normalizeConfig 的結果
  function patchCounts(cfg) {
    const o = {};
    for (const type of Object.keys(NODE_TYPES)) { const c = cfg && cfg[type] ? cfg[type].count : 0; o[type] = c > 0 ? Math.ceil(c / patchOf(type).per) : 0; }
    return o;
  }
  // 規劃礦區中心：spots = landTiles 的結果；blocked = Set('x,y')（工廠建築）；回傳 { 種類: [[x, y], ...] }
  function planPatches(spots, cfg, seed, blocked) {
    const land = new Set(), counts = patchCounts(cfg), out = {}, centers = [];
    for (const [x, y] of spots.plains) land.add(x + ',' + y);
    for (const [x, y] of spots.hills) land.add(x + ',' + y);
    const usable = (x, y) => land.has(x + ',' + y) && !(blocked && blocked.has(x + ',' + y));
    const roomy = (x, y) => {                // 周圍可用陸地的比例
      let n = 0, all = 0;
      for (let dy = -PATCH_ROOM; dy <= PATCH_ROOM; dy++) for (let dx = -PATCH_ROOM; dx <= PATCH_ROOM; dx++) {
        if (dx * dx + dy * dy > PATCH_ROOM * PATCH_ROOM) continue;
        all++; if (usable(x + dx, y + dy)) n++;
      }
      return n / all;
    };
    // 固定順序的洗牌（同一個 seed 結果一樣）
    const order = (list, salt) => list.map((t) => [SfTerrain.hash2(t[0] * 7 + salt, t[1] * 13, seed), t]).sort((a, b) => a[0] - b[0] || a[1][1] - b[1][1] || a[1][0] - b[1][0]).map((e) => e[1]);   // 只看座標（清單本身是洗牌過的）
    // 需要開比較多片的先挑（大片的比較需要空間）
    const types = Object.keys(NODE_TYPES).filter((t) => counts[t] > 0).sort((a, b) => counts[b] - counts[a]);
    types.forEach((type, ti) => {
      out[type] = [];
      const pref = NODE_TYPES[type].terrain === 'plain' ? [spots.plains, spots.hills] : [spots.hills, spots.plains];
      const cands = order(pref[0], ti * 31 + 1).concat(order(pref[1], ti * 31 + 2));
      for (let k = 0; k < counts[type]; k++) {
        let pick = null;
        for (const sep of PATCH_SEP) {
          for (const [x, y] of cands) {
            if (!usable(x, y) || roomy(x, y) < 0.7) continue;
            if (centers.some((c) => Math.hypot(c[0] - x, c[1] - y) < sep)) continue;
            pick = [x, y]; break;
          }
          if (pick) break;
        }
        if (!pick) break;                     // 領地太擠：剩下的資源用一般的散布方式放
        centers.push(pick); out[type].push(pick);
      }
    });
    return out;
  }

  // 點在不在某些區塊裡
  function inBlocks(blocks, x, y) {
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
    return blocks.some((b) => b.cx === cx && b.cy === cy);
  }

  // 礦物礦脈在這個位置是哪一種礦物：依整數座標雜湊、照品種權重挑（伺服器採集、採礦機、前端外觀共用，結果一定一樣）
  //   cfg = normalizeConfig 的結果；後台有設品種比例（cfg.mineral.species）就用，沒有就用 MINERALS 的預設權重
  const MINERAL_KEYS = Object.keys(MINERALS);
  function mineralAt(x, y, cfg) {
    const sp = cfg && cfg.mineral && cfg.mineral.species;
    let total = 0;
    const ws = MINERAL_KEYS.map((k) => { const w = sp && sp[k] != null ? Math.max(0, Number(sp[k]) || 0) : MINERALS[k].w; total += w; return w; });
    if (total <= 0) return MINERAL_KEYS[0];
    let r = SfTerrain.hash2(Math.floor(x), Math.floor(y), 7919) * total;
    for (let i = 0; i < ws.length; i++) { r -= ws[i]; if (r < 0) return MINERAL_KEYS[i]; }
    return MINERAL_KEYS[MINERAL_KEYS.length - 1];
  }
  // 採這個資源節點會得到什麼物品（礦物礦脈依位置，其他照 NODE_TYPES.item）
  function nodeItem(node, cfg) {
    const def = node && NODE_TYPES[node.type];
    if (!def) return null;
    return node.type === 'mineral' ? mineralAt(node.x, node.y, cfg) : def.item;
  }

  return { ITEMS, MINERALS, EQUIPMENT, NODE_TYPES, DEFAULT_SPAWN, PATCH, patchCounts, planPatches, mineralAt, nodeItem, LIMITS, GATHER_RANGE, GATHER_COOLDOWN, PICKUP_RANGE, STACK_MAX, BAG_KINDS,
           normalizeConfig, totalCount, wildDensities, currentAmount, landTiles, territoryResourceError, findSpot, inBlocks };
});
