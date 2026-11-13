// ============================================================
// factory.js - Starforge 工廠流水線（伺服器與瀏覽器共用同一份）
//
// 做什麼：
//   * 建築、物品、配方、科技樹、里程碑的資料表（設計說明見 docs/FACTORY_DESIGN.md）
//   * 每支隊伍一份「工廠狀態」，以固定 Tick（每秒 10 次）推進：
//     採礦機 → 輸送帶 → 機械手臂 / 分流器 → 熔爐 / 組裝機 → 研究站 / 基地核心，電力與燃料
//   * 擺放檢查（領地、地形、重疊、採礦機要蓋在資源上）
//   * 狀態打包 / 還原（存資料庫、送給前端）與「事件」（建造、拆除、放入、取出、選配方、研究、里程碑）
// 為什麼共用：伺服器是唯一真相，但輸送帶上的物品每秒在動，不可能每一格都即時傳送。
//   做法跟 Factorio 一樣：模擬是「確定性」的（不用亂數、依建築編號固定順序），
//   伺服器送一次完整狀態 + 之後的事件，瀏覽器用同一份程式自己往下算，畫面就跟伺服器一致；
//   每隔幾秒伺服器再送一次完整狀態校正（萬一有誤差也會被拉回來）。
// 瀏覽器從遊戲服務的 /starforge/factory.js 載入（要先載入 terrain.js、resources.js）。
// 注意：
//   * 物品、建築、配方、科技代碼發出去後不要刪（資料庫存檔裡會有）；不想用就從 UI 拿掉
//   * 模擬裡不能用 Math.random()、Date.now()，也不能依賴物件以外的順序，否則前後端會算出不同結果
//   * 改數值會影響所有進行中的工廠（存檔只存狀態，不存數值）
// ============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./terrain'), require('./resources'));
  else root.SfFactory = factory(root.SfTerrain, root.SfResources);
})(typeof self !== 'undefined' ? self : this, function (SfTerrain, SfResources) {
  'use strict';
  const T = SfTerrain.T;

  // ---- 基本常數 ----
  const TICK_MS = 100;            // 每個 Tick 100 毫秒（每秒 10 次），前後端一致
  const BELT_L = 120;             // 輸送帶一格的長度（內部單位）
  const BELT_GAP = 30;            // 物品之間至少間隔（一格最多 4 個）
  const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // 0 東（右）、1 南（下）、2 西（左）、3 北（上），順時針
  const DIR_NAMES = ['→', '↓', '←', '↑'];
  const MAX_BUILDINGS = 1500;     // 每隊最多幾個建築（存檔大小與伺服器負載的上限）
  const OUT_CAP = 20;             // 機器輸出暫存上限
  const CHEST_CAP = 400, CHEST_KINDS = 16;
  const HUB_CAP = 9999;           // 基地核心每種物品上限
  const LAB_PACK_CAP = 20;        // 研究站每種研究包最多放幾個
  const FUEL_ITEMS_CAP = 10;      // 燃料最多放幾個

  // ---- 新物品（加進 resources.js 的物品清單，背包、地上物品都能用）----
  const NEW_ITEMS = {
    iron_plate:       { name: '鐵板',       icon: '🔳' },
    copper_plate:     { name: '銅板',       icon: '🟧' },
    stone_brick:      { name: '石磚',       icon: '🧱' },
    aluminum_plate:   { name: '鋁板',       icon: '⬜' },
    silver_bar:       { name: '銀錠',       icon: '🥈' },
    gold_bar:         { name: '金錠',       icon: '🥇' },
    steel_plate:      { name: '鋼板',       icon: '⬛' },
    iron_gear:        { name: '鐵齒輪',     icon: '⚙️' },
    copper_wire:      { name: '銅線',       icon: '🧶' },
    circuit:          { name: '電路板',     icon: '💾' },
    advanced_circuit: { name: '先進電路',   icon: '📀' },
    motor:            { name: '電動機',     icon: '🌀' },
    alloy_frame:      { name: '合金框架',   icon: '🏗️' },
    red_pack:         { name: '自動化研究包', icon: '🧪' },
    green_pack:       { name: '物流研究包',   icon: '🧴' },
    blue_pack:        { name: '高科技研究包', icon: '💠' }
  };
  Object.keys(NEW_ITEMS).forEach((k) => { if (!SfResources.ITEMS[k]) SfResources.ITEMS[k] = NEW_ITEMS[k]; });
  const ITEMS = SfResources.ITEMS;
  // 燃料：每個可提供多少能量（燃燒型建築每 Tick 消耗 burn，發電機每 Tick 最多輸出 output）
  const FUEL = { coal: 4000, wood: 1500 };
  const PACKS = ['red_pack', 'green_pack', 'blue_pack'];

  // ---- 建築 ----
  //   w×h 佔地（全部是正方形，旋轉不影響佔地）；cost 建造材料（從背包扣，不夠再從基地核心扣；拆除全部退回）
  //   tech = 需要先研究的科技；kind = 模擬時的類別
  //   power = 運作時耗電；output = 發電量；burn = 燃燒型每 Tick 用掉的能量
  const BUILDINGS = {
    belt:             { name: '輸送帶',     cat: 'logistics', kind: 'belt',     w: 1, h: 1, cost: { iron_plate: 1 }, speed: 12, icon: '➡️',
                        desc: '把物品往箭頭方向送。指向機器 = 送進去；從機器往外指 = 把產品接出來。從旁邊接上另一條就會合流。' },
    fast_belt:        { name: '快速輸送帶', cat: 'logistics', kind: 'belt',     w: 1, h: 1, cost: { iron_plate: 1, iron_gear: 1 }, speed: 24, tech: 'logistics2', icon: '⏩',
                        desc: '速度是一般輸送帶的兩倍（每秒 2 格、每秒 8 個物品）。' },
    splitter:         { name: '分流器',     cat: 'logistics', kind: 'splitter', w: 1, h: 1, cost: { iron_plate: 5, circuit: 3 }, tech: 'logistics', icon: '🔱',
                        desc: '從後面進來的物品，輪流送往前、左、右三個方向（哪邊塞住就跳過）。' },
    sorter:           { name: '分類器',     cat: 'logistics', kind: 'sorter',   w: 1, h: 1, cost: { iron_plate: 5, circuit: 5 }, tech: 'smart_sort', icon: '🔀',
                        desc: '設定一種物品：符合的往前送，其他的輪流往左右送。' },
    inserter:         { name: '機械手臂',   cat: 'logistics', kind: 'inserter', w: 1, h: 1, cost: { iron_plate: 1, iron_gear: 1, circuit: 1 }, cycle: 12, icon: '🦾',
                        desc: '從背後那一格抓東西，放到前面那一格（機器、箱子或輸送帶）。只抓前面用得到的東西。' },
    fast_inserter:    { name: '快速機械手臂', cat: 'logistics', kind: 'inserter', w: 1, h: 1, cost: { iron_plate: 2, iron_gear: 2, circuit: 2 }, cycle: 6, tech: 'logistics2', icon: '🤖',
                        desc: '動作快一倍的機械手臂。' },
    chest:            { name: '儲物箱',     cat: 'logistics', kind: 'chest',    w: 1, h: 1, cost: { wood: 4 }, icon: '📦',
                        desc: '最多放 ' + CHEST_CAP + ' 個、' + CHEST_KINDS + ' 種物品。輸送帶指向它就會放進去，機械手臂可以從裡面拿。' },
    burner_miner:     { name: '燃燒採礦機', cat: 'production', kind: 'miner',   w: 2, h: 2, cost: { iron_plate: 3, iron_gear: 3, stone: 5 }, rate: 40, burn: 10, icon: '⛏️',
                        desc: '蓋在領地裡的資源上（樹木、石頭、礦脈、花都可以），燒煤炭或木材，每 4 秒挖 1 個。' },
    electric_miner:   { name: '電動採礦機', cat: 'production', kind: 'miner',   w: 2, h: 2, cost: { iron_plate: 10, iron_gear: 5, circuit: 3 }, rate: 20, power: 30, tech: 'electric_mining', icon: '🛠️',
                        desc: '用電的採礦機，每 2 秒挖 1 個。' },
    stone_furnace:    { name: '石爐',       cat: 'production', kind: 'furnace', w: 2, h: 2, cost: { stone: 5 }, speed: 1, burn: 9, icon: '🔥',
                        desc: '燒煤炭或木材，把礦石煉成金屬板（放進什麼就煉什麼）。' },
    electric_furnace: { name: '電爐',       cat: 'production', kind: 'furnace', w: 2, h: 2, cost: { steel_plate: 5, circuit: 5, stone_brick: 10 }, speed: 2, power: 40, tech: 'electric_smelting', icon: '♨️',
                        desc: '用電的熔爐，速度是石爐的兩倍，不用燃料。' },
    assembler:        { name: '組裝機',     cat: 'production', kind: 'assembler', w: 3, h: 3, cost: { iron_plate: 9, iron_gear: 5, circuit: 3 }, speed: 0.75, power: 25, tech: 'automation', icon: '🏭',
                        desc: '選一個配方，自動把材料組成產品。' },
    assembler2:       { name: '組裝機 II',  cat: 'production', kind: 'assembler', w: 3, h: 3, cost: { steel_plate: 4, iron_gear: 5, advanced_circuit: 2 }, speed: 1.25, power: 40, tech: 'automation2', icon: '🏗️',
                        desc: '更快的組裝機。' },
    generator:        { name: '燃燒發電機', cat: 'power', kind: 'generator', w: 2, h: 2, cost: { iron_plate: 10, iron_gear: 5, stone_brick: 10 }, output: 90, icon: '⚡',
                        desc: '燒煤炭或木材發電，整個領地共用一個電網（最多 90 電力）。' },
    solar:            { name: '太陽能板',   cat: 'power', kind: 'solar',     w: 2, h: 2, cost: { steel_plate: 5, copper_plate: 10, circuit: 10 }, output: 25, tech: 'solar', icon: '🔆',
                        desc: '不用燃料、穩定提供 25 電力。' },
    lab:              { name: '研究站',     cat: 'science', kind: 'lab',       w: 3, h: 3, cost: { iron_gear: 10, circuit: 10, copper_plate: 10 }, power: 20, icon: '🔬',
                        desc: '放進研究包，推進目前的科技研究（研究進度整隊共用）。' },
    hub:              { name: '基地核心',   cat: 'science', kind: 'hub',       w: 3, h: 3, cost: {}, limit: 1, icon: '🏛️',
                        desc: '隊伍共用倉庫。輸送帶送進來的東西都存在這裡；建造材料不夠時從這裡扣；繳交里程碑提升隊伍等級。每隊一座。' }
  };
  const CATS = [
    { id: 'logistics', name: '物流' }, { id: 'production', name: '生產' }, { id: 'power', name: '電力' }, { id: 'science', name: '研究' }
  ];

  // ---- 配方 ----
  //   machine：furnace（熔爐，依放進去的原料自動決定）/ assembler（組裝機，要選）；hand = 也可以在背包手動合成
  //   time = 基本所需 Tick（速度 1 的機器、手動合成）
  const RECIPES = {
    iron_plate:       { machine: 'furnace',   in: { iron_ore: 1 },  out: { iron_plate: 1 },      time: 32 },
    copper_plate:     { machine: 'furnace',   in: { copper_ore: 1 }, out: { copper_plate: 1 },   time: 32 },
    stone_brick:      { machine: 'furnace',   in: { stone: 2 },     out: { stone_brick: 1 },     time: 32 },
    aluminum_plate:   { machine: 'furnace',   in: { aluminum_ore: 1 }, out: { aluminum_plate: 1 }, time: 48 },
    silver_bar:       { machine: 'furnace',   in: { silver_ore: 1 }, out: { silver_bar: 1 },     time: 64 },
    gold_bar:         { machine: 'furnace',   in: { gold_ore: 1 },  out: { gold_bar: 1 },        time: 80 },
    steel_plate:      { machine: 'furnace',   in: { iron_plate: 5 }, out: { steel_plate: 1 },    time: 160, tech: 'steel' },
    iron_gear:        { machine: 'assembler', in: { iron_plate: 2 }, out: { iron_gear: 1 },      time: 10, hand: true },
    copper_wire:      { machine: 'assembler', in: { copper_plate: 1 }, out: { copper_wire: 2 },  time: 5,  hand: true },
    circuit:          { machine: 'assembler', in: { iron_plate: 1, copper_wire: 3 }, out: { circuit: 1 }, time: 10, hand: true },
    red_pack:         { machine: 'assembler', in: { copper_plate: 1, iron_gear: 1 }, out: { red_pack: 1 }, time: 50, hand: true },
    green_pack:       { machine: 'assembler', in: { circuit: 1, iron_gear: 1, stone_brick: 1 }, out: { green_pack: 1 }, time: 60, hand: true, tech: 'green_science' },
    advanced_circuit: { machine: 'assembler', in: { circuit: 2, copper_wire: 4, aluminum_plate: 1 }, out: { advanced_circuit: 1 }, time: 60, tech: 'advanced_circuit' },
    motor:            { machine: 'assembler', in: { steel_plate: 1, iron_gear: 2, copper_wire: 3 }, out: { motor: 1 }, time: 80, tech: 'automation2' },
    alloy_frame:      { machine: 'assembler', in: { aluminum_plate: 2, steel_plate: 1 }, out: { alloy_frame: 1 }, time: 60, tech: 'advanced_circuit' },
    blue_pack:        { machine: 'assembler', in: { advanced_circuit: 1, motor: 1, gold_bar: 1 }, out: { blue_pack: 2 }, time: 120, tech: 'blue_science' }
  };
  // 熔爐：原料 → 配方（放進去的是什麼就煉什麼）
  const FURNACE_BY_INPUT = {};
  Object.keys(RECIPES).forEach((id) => { const r = RECIPES[id]; if (r.machine === 'furnace') FURNACE_BY_INPUT[Object.keys(r.in)[0]] = id; });

  // ---- 科技樹（3 層，研究進度整隊共用）----
  //   count = 要研究幾個單位；每單位每種研究包各用 1 個、研究站要 time Tick（速度 1）
  //   level = 需要的隊伍等級（里程碑）；unlock 只是說明用，真正的解鎖寫在建築 / 配方的 tech 欄位
  const TECHS = {
    automation:        { name: '自動化',     tier: 1, packs: ['red_pack'], count: 10, time: 100, pre: [], level: 1, desc: '解鎖組裝機：自動生產齒輪、電路板、研究包。' },
    logistics:         { name: '物流學',     tier: 1, packs: ['red_pack'], count: 15, time: 100, pre: [], level: 1, desc: '解鎖分流器。' },
    electric_mining:   { name: '電動採礦',   tier: 1, packs: ['red_pack'], count: 20, time: 100, pre: ['automation'], level: 1, desc: '解鎖電動採礦機（速度兩倍、不用燃料）。' },
    steel:             { name: '鋼鐵冶煉',   tier: 1, packs: ['red_pack'], count: 25, time: 100, pre: [], level: 1, desc: '熔爐可以把 5 片鐵板煉成 1 片鋼板。' },
    green_science:     { name: '物流研究包', tier: 1, packs: ['red_pack'], count: 30, time: 100, pre: ['automation'], level: 1, desc: '解鎖物流研究包配方（第二層科技要用）。' },
    logistics2:        { name: '物流學 II',  tier: 2, packs: ['red_pack', 'green_pack'], count: 40, time: 150, pre: ['logistics', 'green_science'], level: 2, desc: '解鎖快速輸送帶與快速機械手臂。' },
    smart_sort:        { name: '智慧分類',   tier: 2, packs: ['red_pack', 'green_pack'], count: 30, time: 150, pre: ['logistics', 'green_science'], level: 2, desc: '解鎖分類器：指定物品往前送，其他往旁邊送。' },
    electric_smelting: { name: '電力冶煉',   tier: 2, packs: ['red_pack', 'green_pack'], count: 50, time: 150, pre: ['steel', 'green_science'], level: 2, desc: '解鎖電爐（速度兩倍、不用燃料）。' },
    solar:             { name: '太陽能',     tier: 2, packs: ['red_pack', 'green_pack'], count: 60, time: 150, pre: ['steel', 'green_science'], level: 2, desc: '解鎖太陽能板。' },
    advanced_circuit:  { name: '先進電路',   tier: 2, packs: ['red_pack', 'green_pack'], count: 60, time: 150, pre: ['green_science'], level: 2, desc: '解鎖先進電路與合金框架配方。' },
    automation2:       { name: '自動化 II',  tier: 2, packs: ['red_pack', 'green_pack'], count: 60, time: 150, pre: ['automation', 'advanced_circuit', 'steel'], level: 2, desc: '解鎖組裝機 II 與電動機配方。' },
    blue_science:      { name: '高科技研究包', tier: 3, packs: ['red_pack', 'green_pack'], count: 80, time: 150, pre: ['automation2'], level: 3, desc: '解鎖高科技研究包配方（第三層科技要用）。' },
    mining_productivity: { name: '採礦產能',  tier: 3, packs: ['red_pack', 'green_pack', 'blue_pack'], count: 100, time: 200, pre: ['blue_science'], level: 3, desc: '所有採礦機產量 +25%。' },
    lab_speed:         { name: '研究效率',   tier: 3, packs: ['red_pack', 'green_pack', 'blue_pack'], count: 100, time: 200, pre: ['blue_science'], level: 3, desc: '研究站速度 +50%。' },
    planet_industry:   { name: '星球工業化', tier: 3, packs: ['red_pack', 'green_pack', 'blue_pack'], count: 200, time: 200, pre: ['mining_productivity', 'lab_speed'], level: 4, desc: '終極科技：完成後隊伍名列「星球工業文明」。' }
  };
  // ---- 里程碑（繳交到基地核心，隊伍等級 +1；等級決定能研究哪一層科技，之後也用來擴張領地）----
  const MILESTONES = [
    { level: 2, name: '冶金起步',   need: { iron_plate: 100, copper_plate: 100, stone_brick: 50 } },
    { level: 3, name: '量產時代',   need: { iron_gear: 200, circuit: 150, steel_plate: 50 } },
    { level: 4, name: '精密工業',   need: { advanced_circuit: 100, alloy_frame: 50, gold_bar: 30 } },
    { level: 5, name: '星球工業文明', need: { motor: 150, alloy_frame: 100, silver_bar: 50, blue_pack: 100 } }
  ];

  // ============================================================
  // 狀態
  //   S = { tick, nid（下一個建築編號）, level（隊伍等級）, hub（基地核心倉庫）, b: Map(id → 建築),
  //         tech: { done: { id: 1 }, cur: 研究中的科技, prog: { id: 已完成單位 } },
  //         pw: { supply, demand, sat }（上一個 Tick 的電力統計，只給畫面看）, topo（快取，不存檔） }
  //   建築共同欄位：id, type, x, y（左上角格子）, d（方向 0～3）
  //   依種類：items（輸送帶上的物品 [{i 物品, p 位置 0～BELT_L, f 從哪一邊進來, q 上一 Tick 的位置（畫面內插用，不存檔）}]）
  //           inv（輸入暫存）, out（輸出暫存）, fuel（燃料物品）, en（剩餘燃燒能量）, w（工作進度 0～1）,
  //           r（組裝機配方）, flt（分類器的物品）, res / node（採礦機挖的物品 / 資源節點代碼）,
  //           h / ph（機械手臂手上的物品 / 動作進度）, buf（分流器暫存）, rr（輪流計數）, ld（研究站已裝填一個單位）
  // ============================================================
  function createState(level) {
    return { tick: 0, nid: 1, level: level || 1, hub: {}, b: new Map(), tech: { done: {}, cur: null, prog: {} },
             pw: { supply: 0, demand: 0, sat: 0 }, topo: null };
  }
  function newBuilding(id, type, x, y, d) {
    const def = BUILDINGS[type], b = { id, type, x, y, d: d & 3 };
    switch (def.kind) {
      case 'belt': b.items = []; break;
      case 'miner': b.out = {}; b.w = 0; b.res = null; b.node = null; if (def.burn) { b.fuel = {}; b.en = 0; } break;
      case 'furnace': b.inv = {}; b.out = {}; b.w = 0; if (def.burn) { b.fuel = {}; b.en = 0; } break;
      case 'assembler': b.inv = {}; b.out = {}; b.w = 0; b.r = null; break;
      case 'generator': b.fuel = {}; b.en = 0; break;
      case 'lab': b.inv = {}; b.w = 0; b.ld = 0; break;
      case 'chest': b.inv = {}; break;
      case 'splitter': b.buf = null; b.rr = 0; break;
      case 'sorter': b.buf = null; b.rr = 0; b.flt = null; break;
      case 'inserter': b.h = null; b.ph = 0; break;
    }
    if (def.kind !== 'belt' && def.kind !== 'inserter') b.rr = b.rr || 0;
    return b;
  }
  const defOf = (b) => BUILDINGS[b.type];
  const sumMap = (m) => { let s = 0; for (const k in m) s += m[k]; return s; };
  const addTo = (m, k, n) => { m[k] = (m[k] || 0) + n; };
  const takeFrom = (m, k, n) => { m[k] -= n; if (m[k] <= 0) delete m[k]; };
  const isDone = (S, tech) => !tech || !!S.tech.done[tech];
  const buildingUnlocked = (S, type) => !!BUILDINGS[type] && isDone(S, BUILDINGS[type].tech);
  const recipeUnlocked = (S, id) => !!RECIPES[id] && isDone(S, RECIPES[id].tech);
  const techMult = (S, kind) => (kind === 'miner' && S.tech.done.mining_productivity ? 1.25 : kind === 'lab' && S.tech.done.lab_speed ? 1.5 : 1);
  // 某科技現在能不能開始研究：前置都完成、隊伍等級夠、還沒完成；回傳錯誤訊息或 null
  function techError(S, id) {
    const t = TECHS[id];
    if (!t) return '沒有這個科技';
    if (S.tech.done[id]) return '已經研究完成了';
    for (const p of t.pre) if (!S.tech.done[p]) return '要先研究「' + TECHS[p].name + '」';
    if (S.level < t.level) return '隊伍等級要達到 ' + t.level + '（到基地核心繳交里程碑）';
    return null;
  }

  // ---- 地圖索引（建築變動時重建）----
  //   grid：'x,y' → 建築；belts：輸送帶依「下游先算」排序（前面的空出來，後面的才跟得上）；
  //   front：輸送帶 / 分流器各方向的目標；ports：機器周圍「往外指」的輸送帶
  const key = (x, y) => x + ',' + y;
  function topo(S) {
    if (S.topo) return S.topo;
    const grid = new Map();
    for (const b of S.b.values()) {
      const d = defOf(b);
      for (let yy = 0; yy < d.h; yy++) for (let xx = 0; xx < d.w; xx++) grid.set(key(b.x + xx, b.y + yy), b);
    }
    const at = (x, y) => grid.get(key(x, y)) || null;
    const isBeltish = (k) => k === 'belt' || k === 'splitter' || k === 'sorter';
    // 物品從 (x, y) 往 md 方向離開，進入隔壁那一格：回傳 { t 目標建築, mode: 'belt' | 'split' | 'bld', p 進入位置, f 進入邊 } 或 null
    function entry(x, y, md, self) {
      const nx = x + DIRS[md][0], ny = y + DIRS[md][1], t = at(nx, ny);
      if (!t || t === self) return null;
      const k = defOf(t).kind, from = (md + 2) & 3;
      if (k === 'belt') {
        if (t.d === from) return null;                   // 迎面相撞
        if (t.d === md) return { t, mode: 'belt', p: 0, f: from };
        // 從側邊接上：目標後面如果已經有東西直直餵進來，就從中間插入（合流）；沒有的話當成轉彎，從頭開始走
        const bx = t.x - DIRS[t.d][0], by = t.y - DIRS[t.d][1], feeder = at(bx, by);
        let fed = false;
        if (feeder) {
          const fk = defOf(feeder).kind;
          if (fk === 'belt' || fk === 'splitter' || fk === 'sorter') fed = feeder.d === t.d;
          else if (fk !== 'inserter' && fk !== 'chest' && fk !== 'hub' && fk !== 'lab') fed = true;   // 機器從後面輸出
        }
        return fed ? { t, mode: 'belt', p: BELT_L / 2, f: from } : { t, mode: 'belt', p: 0, f: from };
      }
      if (k === 'splitter' || k === 'sorter') return t.d === md ? { t, mode: 'split' } : null;
      if (k === 'inserter') return null;                 // 機械手臂自己會抓
      return { t, mode: 'bld' };
    }
    const front = new Map();
    const belts = [];
    for (const b of S.b.values()) {
      const k = defOf(b).kind;
      if (k === 'belt') { belts.push(b); front.set(b.id, entry(b.x, b.y, b.d, b)); }
      else if (k === 'splitter' || k === 'sorter') front.set(b.id, [b.d, (b.d + 3) & 3, (b.d + 1) & 3].map((md) => entry(b.x, b.y, md, b)));
    }
    // 下游先算：depth = 往前數到盡頭的格數（環狀的就停）
    const depth = new Map();
    for (const b of belts) {
      if (depth.has(b.id)) continue;
      const chain = [], seen = new Set();
      let cur = b, base = 0;
      while (cur) {
        if (depth.has(cur.id)) { base = depth.get(cur.id) + 1; break; }
        if (seen.has(cur.id)) { base = 0; break; }
        seen.add(cur.id); chain.push(cur);
        const e = front.get(cur.id);
        cur = e && e.mode === 'belt' ? e.t : null;
      }
      for (let i = chain.length - 1; i >= 0; i--) { if (!depth.has(chain[i].id)) depth.set(chain[i].id, base); base = depth.get(chain[i].id) + 1; }
    }
    belts.sort((a, b) => (depth.get(a.id) - depth.get(b.id)) || (a.id - b.id));
    // 機器的輸出口：周圍「背後貼著機器、往外指」的輸送帶（依編號排序，輪流送）
    const ports = new Map();
    for (const b of S.b.values()) {
      const d = defOf(b), k = d.kind;
      if (isBeltish(k) || k === 'inserter' || k === 'hub' || k === 'lab' || k === 'generator' || k === 'solar') continue;
      const list = [];
      for (let yy = -1; yy <= d.h; yy++) for (let xx = -1; xx <= d.w; xx++) {
        const edge = xx === -1 || yy === -1 || xx === d.w || yy === d.h;
        if (!edge || ((xx === -1 || xx === d.w) && (yy === -1 || yy === d.h))) continue;   // 只看四邊、不看角落
        const t = at(b.x + xx, b.y + yy);
        if (!t || defOf(t).kind !== 'belt') continue;
        const bx = t.x - DIRS[t.d][0], by = t.y - DIRS[t.d][1];
        if (bx >= b.x && bx < b.x + d.w && by >= b.y && by < b.y + d.h) list.push(t);
      }
      list.sort((a, c) => a.id - c.id);
      if (list.length) ports.set(b.id, list);
    }
    S.topo = { grid, at, front, belts, ports, entry };
    return S.topo;
  }

  // ---- 輸送帶插入：位置 p 前後 BELT_GAP 內沒有其他物品才放得進去 ----
  function beltRoom(b, p) {
    for (const o of b.items) if (Math.abs(o.p - p) < BELT_GAP) return false;
    return true;
  }
  function beltInsert(b, item, p, f) {
    if (!beltRoom(b, p)) return false;
    const o = { i: item, p, f, q: p };
    let k = 0;
    while (k < b.items.length && b.items[k].p > p) k++;
    b.items.splice(k, 0, o);
    return true;
  }

  // ---- 建築收貨：canAccept 只檢查、put 真的放（數量 n）----
  function canAccept(S, b, item) {
    const d = defOf(b);
    switch (d.kind) {
      case 'furnace': {
        if (d.burn && FUEL[item] && !FURNACE_BY_INPUT[item]) return sumMap(b.fuel) < FUEL_ITEMS_CAP;
        const rid = FURNACE_BY_INPUT[item];
        if (!rid || !recipeUnlocked(S, rid)) return false;
        const keys = Object.keys(b.inv);
        if (keys.length && keys[0] !== item) return false;
        return (b.inv[item] || 0) < RECIPES[rid].in[item] * 4 + 2;
      }
      case 'assembler': {
        const r = b.r && RECIPES[b.r];
        if (!r || !r.in[item]) return false;
        return (b.inv[item] || 0) < Math.max(r.in[item] * 3, r.in[item] + 2);
      }
      case 'miner': return !!d.burn && !!FUEL[item] && sumMap(b.fuel) < FUEL_ITEMS_CAP;
      case 'generator': return !!FUEL[item] && sumMap(b.fuel) < FUEL_ITEMS_CAP;
      case 'lab': return PACKS.indexOf(item) >= 0 && (b.inv[item] || 0) < LAB_PACK_CAP;
      case 'chest': return sumMap(b.inv) < CHEST_CAP && (b.inv[item] != null || Object.keys(b.inv).length < CHEST_KINDS);
      case 'hub': return (S.hub[item] || 0) < HUB_CAP;
      case 'splitter': return !b.buf;
      case 'sorter': return !b.buf;
      default: return false;
    }
  }
  // 最多還能收幾個（玩家手動放入用）
  function acceptCount(S, b, item, want) {
    const d = defOf(b);
    switch (d.kind) {
      case 'furnace': {
        if (d.burn && FUEL[item] && !FURNACE_BY_INPUT[item]) return Math.max(0, Math.min(want, FUEL_ITEMS_CAP * 5 - sumMap(b.fuel)));
        const rid = FURNACE_BY_INPUT[item];
        if (!rid || !recipeUnlocked(S, rid)) return 0;
        const keys = Object.keys(b.inv);
        if (keys.length && keys[0] !== item) return 0;
        return Math.max(0, Math.min(want, 100 - (b.inv[item] || 0)));
      }
      case 'assembler': {
        const r = b.r && RECIPES[b.r];
        if (!r || !r.in[item]) return 0;
        return Math.max(0, Math.min(want, r.in[item] * 20 - (b.inv[item] || 0)));
      }
      case 'miner': return d.burn && FUEL[item] ? Math.max(0, Math.min(want, FUEL_ITEMS_CAP * 5 - sumMap(b.fuel))) : 0;
      case 'generator': return FUEL[item] ? Math.max(0, Math.min(want, FUEL_ITEMS_CAP * 5 - sumMap(b.fuel))) : 0;
      case 'lab': return PACKS.indexOf(item) >= 0 ? Math.max(0, Math.min(want, 100 - (b.inv[item] || 0))) : 0;
      case 'chest': {
        if (b.inv[item] == null && Object.keys(b.inv).length >= CHEST_KINDS) return 0;
        return Math.max(0, Math.min(want, CHEST_CAP - sumMap(b.inv)));
      }
      case 'hub': return Math.max(0, Math.min(want, HUB_CAP - (S.hub[item] || 0)));
      default: return 0;
    }
  }
  function put(S, b, item, n) {
    const d = defOf(b);
    switch (d.kind) {
      case 'furnace': if (d.burn && FUEL[item] && !FURNACE_BY_INPUT[item]) addTo(b.fuel, item, n); else addTo(b.inv, item, n); break;
      case 'miner': case 'generator': addTo(b.fuel, item, n); break;
      case 'assembler': case 'lab': case 'chest': addTo(b.inv, item, n); break;
      case 'hub': addTo(S.hub, item, n); break;
      case 'splitter': case 'sorter': b.buf = item; break;
    }
  }
  // 機械手臂可以從這個建築拿什麼（want(item) = 前面收不收）
  function provide(S, b, want) {
    const k = defOf(b).kind;
    if (k === 'chest') { for (const it in b.inv) if (want(it)) { takeFrom(b.inv, it, 1); return it; } return null; }
    if (k === 'splitter' || k === 'sorter') { if (b.buf && want(b.buf)) { const it = b.buf; b.buf = null; return it; } return null; }
    if (b.out) { for (const it in b.out) if (want(it)) { takeFrom(b.out, it, 1); return it; } }
    return null;
  }

  // 機器把產品送到輸出口（周圍往外指的輸送帶），每 Tick 最多一個，輪流
  function pushOut(S, b) {
    const ports = topo(S).ports.get(b.id);
    if (!ports || !b.out) return;
    const items = Object.keys(b.out);
    if (!items.length) return;
    const n = ports.length;
    for (let k = 0; k < n; k++) {
      const t = ports[(b.rr + k) % n];
      const item = items[(b.rr + k) % items.length];
      if (beltInsert(t, item, 0, (t.d + 2) & 3)) { takeFrom(b.out, item, 1); b.rr = (b.rr + k + 1) % 1000000; return; }
    }
  }

  // 燃燒型：需要能量時從燃料裡拿一個來燒；回傳有沒有能量可用
  function burnerReady(b, need) {
    if (b.en >= need) return true;
    for (const it in b.fuel) { takeFrom(b.fuel, it, 1); b.en += FUEL[it] || 0; return b.en >= need; }
    return b.en > 0;
  }

  // ============================================================
  // 一個 Tick
  //   回傳通知清單（例如研究完成），伺服器拿來廣播；瀏覽器不用
  // ============================================================
  function step(S) {
    const tp = topo(S), notes = [];
    S.tick++;
    const list = Array.from(S.b.values());
    // ---- 1. 電力：先算誰想用電（有材料、有空間），再看供給 ----
    let demand = 0, solarS = 0, genS = 0;
    const gens = [];
    for (const b of list) {
      const d = defOf(b);
      if (d.kind === 'solar') solarS += d.output;
      else if (d.kind === 'generator') {
        if (b.en < d.output) burnerReady(b, d.output);
        if (b.en > 0) { gens.push(b); genS += Math.min(d.output, b.en); }
        b.st = b.en > 0 ? 'ok' : 'nofuel';
      } else if (d.power) {
        b.want = wantsWork(S, b, d);
        if (b.want) demand += d.power;
      }
    }
    const supply = solarS + genS;
    const sat = demand > 0 ? Math.min(1, supply / demand) : 0;
    S.pw = { supply, demand, sat };
    // 發電機依負載消耗燃料（太陽能先用）
    const used = Math.min(demand, supply), fromGen = Math.max(0, used - solarS);
    if (fromGen > 0 && genS > 0) for (const g of gens) { const cap = Math.min(defOf(g).output, g.en); g.en = Math.max(0, g.en - fromGen * cap / genS); }

    // ---- 2. 機器工作 ----
    for (const b of list) {
      const d = defOf(b);
      switch (d.kind) {
        case 'miner': {
          if (!b.res) { b.st = 'nores'; break; }
          if (sumMap(b.out) >= 10) { b.st = 'full'; break; }
          let eff;
          if (d.burn) { if (!burnerReady(b, d.burn)) { b.st = 'nofuel'; break; } b.en = Math.max(0, b.en - d.burn); eff = 1; }
          else { if (sat <= 0) { b.st = 'nopower'; break; } eff = sat; }
          b.st = eff < 1 ? 'lowpower' : 'ok';
          b.w += eff * techMult(S, 'miner') / d.rate;
          if (b.w >= 1) { b.w -= 1; addTo(b.out, b.res, 1); }
          break;
        }
        case 'furnace': {
          const item = Object.keys(b.inv)[0], rid = item && FURNACE_BY_INPUT[item], r = rid && RECIPES[rid];
          if (!r || !recipeUnlocked(S, rid)) { b.st = 'noinput'; b.w = 0; break; }
          if ((b.inv[item] || 0) < r.in[item]) { b.st = 'noinput'; break; }
          const oi = Object.keys(r.out)[0];
          if ((b.out[oi] || 0) + r.out[oi] > OUT_CAP) { b.st = 'full'; break; }
          let eff;
          if (d.burn) { if (!burnerReady(b, d.burn)) { b.st = 'nofuel'; break; } b.en = Math.max(0, b.en - d.burn); eff = 1; }
          else { if (sat <= 0) { b.st = 'nopower'; break; } eff = sat; }
          b.st = eff < 1 ? 'lowpower' : 'ok';
          b.w += eff * d.speed / r.time;
          if (b.w >= 1) { b.w = 0; takeFrom(b.inv, item, r.in[item]); addTo(b.out, oi, r.out[oi]); }
          break;
        }
        case 'assembler': {
          if (!b.want) { b.st = b.r ? (b.st2 || 'noinput') : 'norecipe'; break; }
          if (sat <= 0) { b.st = 'nopower'; break; }
          const r = RECIPES[b.r];
          b.st = sat < 1 ? 'lowpower' : 'ok';
          b.w += sat * d.speed / r.time;
          if (b.w >= 1) {
            b.w = 0;
            for (const it in r.in) takeFrom(b.inv, it, r.in[it]);
            for (const it in r.out) addTo(b.out, it, r.out[it]);
          }
          break;
        }
        case 'lab': {
          const cur = S.tech.cur && TECHS[S.tech.cur];
          if (!cur) { b.st = 'idle'; break; }
          if (!b.want) { b.st = 'noinput'; break; }
          if (sat <= 0) { b.st = 'nopower'; break; }
          if (!b.ld) { for (const pk of cur.packs) takeFrom(b.inv, pk, 1); b.ld = 1; }
          b.st = sat < 1 ? 'lowpower' : 'ok';
          b.w += sat * techMult(S, 'lab') / cur.time;
          if (b.w >= 1) {
            b.w = 0; b.ld = 0;
            const id = S.tech.cur;
            S.tech.prog[id] = (S.tech.prog[id] || 0) + 1;
            if (S.tech.prog[id] >= cur.count) {
              S.tech.done[id] = 1; delete S.tech.prog[id]; S.tech.cur = null;
              notes.push({ k: 'tech', id });
            }
          }
          break;
        }
      }
    }
    // ---- 3. 產品送上輸送帶 ----
    for (const b of list) if (b.out) pushOut(S, b);
    // ---- 4. 機械手臂 ----
    for (const b of list) if (defOf(b).kind === 'inserter') stepInserter(S, tp, b);
    // ---- 5. 分流器 / 分類器 ----
    for (const b of list) { const k = defOf(b).kind; if ((k === 'splitter' || k === 'sorter') && b.buf) stepSplitter(S, tp, b, k); }
    // ---- 6. 輸送帶（下游先算）----
    for (const b of tp.belts) stepBelt(S, tp, b);
    return notes;
  }
  // 用電機器這個 Tick 想不想工作（有配方、材料夠、產品放得下）；組裝機另外記下卡住原因
  function wantsWork(S, b, d) {
    if (d.kind === 'miner') return !!b.res && sumMap(b.out) < 10;
    if (d.kind === 'furnace') {
      const item = Object.keys(b.inv)[0], rid = item && FURNACE_BY_INPUT[item], r = rid && RECIPES[rid];
      if (!r || !recipeUnlocked(S, rid) || (b.inv[item] || 0) < r.in[item]) return false;
      const oi = Object.keys(r.out)[0];
      return (b.out[oi] || 0) + r.out[oi] <= OUT_CAP;
    }
    if (d.kind === 'assembler') {
      const r = b.r && RECIPES[b.r];
      if (!r) return false;
      for (const it in r.in) if ((b.inv[it] || 0) < r.in[it]) { b.st2 = 'noinput'; return false; }
      for (const it in r.out) if ((b.out[it] || 0) + r.out[it] > OUT_CAP) { b.st2 = 'full'; return false; }
      return true;
    }
    if (d.kind === 'lab') {
      const cur = S.tech.cur && TECHS[S.tech.cur];
      if (!cur) return false;
      if (b.ld) return true;
      for (const pk of cur.packs) if (!(b.inv[pk] > 0)) return false;
      return true;
    }
    return false;
  }

  // 輸送帶：最前面的物品走到底就交給前面的目標；後面的物品跟在前一個後面（保持間隔）
  function stepBelt(S, tp, b) {
    const it = b.items;
    if (!it.length) return;
    const sp = defOf(b).speed;
    let maxP = BELT_L, moved = false;
    for (let k = 0; k < it.length; k++) {
      const o = it[k];
      o.q = o.p;
      let np = Math.min(o.p + sp, maxP);
      if (np < o.p) np = o.p;
      o.p = np;
      if (k === 0 && !moved && o.p >= BELT_L && deliver(S, tp, b, o.i)) {
        it.shift(); k--; moved = true; maxP = BELT_L - 0.001;   // 同一 Tick 只交出一個
        continue;
      }
      maxP = o.p - BELT_GAP;
    }
  }
  function deliver(S, tp, b, item) {
    const e = tp.front.get(b.id);
    return sendTo(S, e, item);
  }
  // 把一個物品送給 entry() 算出來的目標
  function sendTo(S, e, item) {
    if (!e) return false;
    if (e.mode === 'belt') return beltInsert(e.t, item, e.p, e.f);
    if (e.mode === 'split') { if (e.t.buf) return false; e.t.buf = item; return true; }
    if (canAccept(S, e.t, item)) { put(S, e.t, item, 1); return true; }
    return false;
  }
  function stepSplitter(S, tp, b, k) {
    const outs = tp.front.get(b.id);   // [前, 左, 右]
    let order;
    if (k === 'sorter') order = b.flt && b.buf === b.flt ? [0] : [1, 2];
    else order = [0, 1, 2];
    const n = order.length;
    for (let j = 0; j < n; j++) {
      const idx = order[(b.rr + j) % n];
      if (sendTo(S, outs[idx], b.buf)) { b.buf = null; b.rr = (b.rr + j + 1) % 1000000; return; }
    }
  }
  // 機械手臂：ph 0 = 空手等待；抓到後 ph 往上加到 cycle/2 放下，再回到 0
  function stepInserter(S, tp, b) {
    const d = defOf(b), half = d.cycle / 2;
    const fx = b.x + DIRS[b.d][0], fy = b.y + DIRS[b.d][1], bx = b.x - DIRS[b.d][0], by = b.y - DIRS[b.d][1];
    const ft = tp.at(fx, fy), bt = tp.at(bx, by);
    if (b.h == null) {
      if (b.ph > 0) { b.ph = Math.max(0, b.ph - 1); b.st = 'ok'; return; }   // 空手轉回來
      if (!ft || !bt) { b.st = 'idle'; return; }
      const fk = defOf(ft).kind;
      if (fk === 'inserter') { b.st = 'idle'; return; }
      const want = fk === 'belt' ? () => beltRoom(ft, BELT_L / 2) : (item) => canAccept(S, ft, item);
      const bk = defOf(bt).kind;
      let got = null;
      if (bk === 'belt') {
        for (let k = 0; k < bt.items.length; k++) if (want(bt.items[k].i)) { got = bt.items[k].i; bt.items.splice(k, 1); break; }
      } else if (bk !== 'hub' && bk !== 'inserter') got = provide(S, bt, want);
      if (got) { b.h = got; b.ph = 1; b.st = 'ok'; } else b.st = 'idle';
      return;
    }
    if (b.ph < half) { b.ph++; b.st = 'ok'; return; }
    // 到前面了：放下（放不下就拿著等）
    if (!ft) { b.st = 'blocked'; return; }
    const fk = defOf(ft).kind;
    let ok = false;
    if (fk === 'belt') ok = beltInsert(ft, b.h, BELT_L / 2, -1);
    else if (canAccept(S, ft, b.h)) { put(S, ft, b.h, 1); ok = true; }
    if (ok) { b.h = null; b.ph = half; b.st = 'ok'; } else b.st = 'blocked';
  }

  // ============================================================
  // 事件：伺服器檢查過、算好數量後才產生，前後端都用 apply() 套用，結果一定一樣
  //   build { id, type, x, y, d, r? } / remove { id } / rotate { id, d } / recipe { id, r } / filter { id, item }
  //   put { id, item, n } / take { id, items: { item: n } } / hubtake { item, n } / research { tech }
  //   milestone {} / miner { id, node, res }
  // ============================================================
  function apply(S, ev) {
    const b = ev.id != null ? S.b.get(ev.id) : null;
    switch (ev.k) {
      case 'build': {
        const nb = newBuilding(ev.id, ev.type, ev.x, ev.y, ev.d);
        if (ev.r) nb.r = ev.r;
        if (ev.res) { nb.res = ev.res; nb.node = ev.node || null; }
        S.b.set(ev.id, nb);
        if (ev.id >= S.nid) S.nid = ev.id + 1;
        S.topo = null;
        break;
      }
      case 'remove': if (b) { S.b.delete(ev.id); S.topo = null; } break;
      case 'rotate': if (b) { b.d = ev.d & 3; if (b.items) b.items.forEach((o) => { if (o.f === b.d) o.f = (b.d + 2) & 3; }); S.topo = null; } break;
      case 'recipe': if (b) { b.r = ev.r || null; b.inv = {}; b.w = 0; } break;
      case 'filter': if (b) b.flt = ev.item || null; break;
      case 'put': if (b) put(S, b, ev.item, ev.n); break;
      case 'take':
        if (b) for (const it in ev.items) {
          let n = ev.items[it];
          for (const m of [b.out, b.inv, b.fuel]) {
            if (!m || !m[it] || n <= 0) continue;
            const t = Math.min(n, m[it]); takeFrom(m, it, t); n -= t;
          }
          if (n > 0 && b.buf === it) { b.buf = null; n--; }
        }
        break;
      case 'hubtake': if (S.hub[ev.item]) takeFrom(S.hub, ev.item, Math.min(ev.n, S.hub[ev.item])); break;
      case 'research': S.tech.cur = ev.tech || null; for (const x of S.b.values()) if (defOf(x).kind === 'lab' && x.ld === 0) x.w = 0; break;
      case 'milestone': {
        const m = MILESTONES.find((mm) => mm.level === S.level + 1);
        if (!m) break;
        for (const it in m.need) takeFrom(S.hub, it, m.need[it]);
        S.level = m.level;
        break;
      }
      case 'miner': if (b) { b.res = ev.res || null; b.node = ev.node || null; } break;
    }
  }

  // 拆除時退回的東西：建造材料 + 裡面所有物品（輸送帶上的、手上的、暫存的）
  function contentsOf(b) {
    const out = {};
    for (const m of [b.inv, b.out, b.fuel]) if (m) for (const it in m) addTo(out, it, m[it]);
    if (b.items) for (const o of b.items) addTo(out, o.i, 1);
    if (b.h) addTo(out, b.h, 1);
    if (b.buf) addTo(out, b.buf, 1);
    // 研究站已裝填的那組研究包算用掉了，不退
    return out;
  }
  // 玩家「全部取出」可以拿的：機器的產品、箱子裡全部
  function takeableOf(b) {
    const k = defOf(b).kind, out = {};
    if (k === 'chest') Object.assign(out, b.inv);
    else if (b.out) Object.assign(out, b.out);
    return out;
  }

  // ============================================================
  // 擺放檢查（伺服器驗證、瀏覽器預覽用同一份）
  //   ctx = { terrain, blocks（自己隊伍的領地區塊）, nodes（自己隊伍顯示中的資源 [{ id, type, x, y }]）, flag: { x, y } }
  //   回傳 { ok, error, node }（採礦機會帶要挖的資源）
  // ============================================================
  function checkPlace(S, ctx, type, x, y) {
    const d = BUILDINGS[type];
    if (!d) return { ok: false, error: '沒有這種建築' };
    if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, error: '位置不正確' };
    if (!buildingUnlocked(S, type)) return { ok: false, error: '要先研究「' + TECHS[d.tech].name + '」' };
    if (d.limit) { let n = 0; for (const b of S.b.values()) if (b.type === type) n++; if (n >= d.limit) return { ok: false, error: d.name + '每隊只能蓋 ' + d.limit + ' 座' }; }
    if (S.b.size >= MAX_BUILDINGS) return { ok: false, error: '建築數量已達上限 ' + MAX_BUILDINGS };
    const tp = topo(S), CH = SfTerrain.CHUNK;
    const inTerr = (tx, ty) => ctx.blocks.some((bl) => bl.cx === Math.floor(tx / CH) && bl.cy === Math.floor(ty / CH));
    const fx = ctx.flag ? Math.floor(ctx.flag.x) : null, fy = ctx.flag ? Math.floor(ctx.flag.y) : null;
    for (let yy = 0; yy < d.h; yy++) for (let xx = 0; xx < d.w; xx++) {
      const tx = x + xx, ty = y + yy;
      if (!inTerr(tx, ty)) return { ok: false, error: '只能蓋在自己隊伍的領地裡' };
      const t = ctx.terrain.at(tx + 0.5, ty + 0.5);
      if (t !== T.PLAIN && t !== T.HILL) return { ok: false, error: '水面和高山上不能蓋' };
      if (tx === fx && ty === fy) return { ok: false, error: '不能蓋在旗子上' };
      if (tp.at(tx, ty)) return { ok: false, error: '這裡已經有建築了' };
    }
    // 資源：採礦機一定要蓋在資源上；其他建築不能壓到資源
    const inside = (ctx.nodes || []).filter((n) => Math.floor(n.x) >= x && Math.floor(n.x) < x + d.w && Math.floor(n.y) >= y && Math.floor(n.y) < y + d.h);
    if (d.kind === 'miner') {
      const claimed = new Set();
      for (const b of S.b.values()) if (b.node) claimed.add(b.node);
      const n = inside.find((nn) => !claimed.has(nn.id));
      if (!n) return { ok: false, error: inside.length ? '這個資源已經有採礦機了' : '採礦機要蓋在領地裡的資源上（樹木、石頭、礦脈）' };
      const nt = SfResources.NODE_TYPES[n.type];
      return { ok: true, node: n.id, res: nt ? nt.item : null };
    }
    if (inside.length) return { ok: false, error: '這裡有資源擋著（只有採礦機可以蓋在資源上）' };
    return { ok: true };
  }

  // ============================================================
  // 打包 / 還原：存資料庫、送給前端的完整狀態（JSON 可序列化；數字原樣保留，前後端還原後完全相同）
  // ============================================================
  const PACK_KEYS = ['inv', 'out', 'fuel', 'en', 'w', 'r', 'flt', 'res', 'node', 'h', 'ph', 'buf', 'rr', 'ld'];
  function pack(S) {
    const bl = [];
    for (const b of S.b.values()) {
      const ex = {};
      for (const k of PACK_KEYS) {
        const v = b[k];
        if (v == null || v === 0) continue;
        if (typeof v === 'object' && !Object.keys(v).length) continue;
        ex[k] = v;
      }
      if (b.items && b.items.length) { const a = []; for (const o of b.items) a.push(o.i, o.p, o.f); ex.it = a; }
      bl.push(Object.keys(ex).length ? [b.id, b.type, b.x, b.y, b.d, ex] : [b.id, b.type, b.x, b.y, b.d]);
    }
    return { v: 1, t: S.tick, n: S.nid, lv: S.level, hub: S.hub, tech: { d: Object.keys(S.tech.done), c: S.tech.cur, p: S.tech.prog }, b: bl };
  }
  function unpack(o) {
    const S = createState(o.lv || 1);
    S.tick = o.t || 0; S.nid = o.n || 1;
    S.hub = Object.assign({}, o.hub || {});
    const tech = o.tech || {};
    (tech.d || []).forEach((id) => { if (TECHS[id]) S.tech.done[id] = 1; });
    S.tech.cur = tech.c && TECHS[tech.c] ? tech.c : null;
    S.tech.prog = Object.assign({}, tech.p || {});
    const rows = (o.b || []).slice().sort((a, b) => a[0] - b[0]);
    for (const row of rows) {
      const [id, type, x, y, d, ex] = row;
      if (!BUILDINGS[type]) continue;                       // 之後拿掉的建築種類：略過
      const b = newBuilding(id, type, x, y, d);
      if (ex) {
        for (const k of PACK_KEYS) if (ex[k] != null) b[k] = typeof ex[k] === 'object' ? JSON.parse(JSON.stringify(ex[k])) : ex[k];
        if (ex.it && b.items) for (let i = 0; i + 2 < ex.it.length; i += 3) {
          b.items.push({ i: ex.it[i], p: ex.it[i + 1], f: ex.it[i + 2], q: ex.it[i + 1] });
        }
      }
      S.b.set(id, b);
      if (id >= S.nid) S.nid = id + 1;
    }
    return S;
  }
  // 給其他隊伍看的建築外觀（不含內容，GDD 30.6「工廠細節不公開」）
  function layoutOf(S) {
    const out = [];
    for (const b of S.b.values()) out.push([b.id, b.type, b.x, b.y, b.d]);
    return out;
  }

  // 建造成本合計（拖曳一排輸送帶時用）
  function costOf(type, n) {
    const c = BUILDINGS[type].cost, out = {};
    for (const k in c) out[k] = c[k] * (n || 1);
    return out;
  }

  return {
    TICK_MS, BELT_L, BELT_GAP, DIRS, DIR_NAMES, MAX_BUILDINGS, OUT_CAP, CHEST_CAP, HUB_CAP, FUEL, PACKS,
    ITEMS, NEW_ITEMS, BUILDINGS, CATS, RECIPES, FURNACE_BY_INPUT, TECHS, MILESTONES,
    createState, newBuilding, topo, step, apply, pack, unpack, layoutOf, checkPlace, canAccept, acceptCount, put,
    contentsOf, takeableOf, costOf, techError, buildingUnlocked, recipeUnlocked, isDone, sumMap
  };
});
