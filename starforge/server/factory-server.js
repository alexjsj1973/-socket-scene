// ============================================================
// factory-server.js - Starforge 工廠流水線的伺服器端（掛在 index.js 上）
//
// 做什麼：
//   * 每支已插旗的隊伍一份工廠狀態（factory.js），全世界共用一個 Tick 時鐘（每 100ms 一次）一起推進
//   * 玩家的操作（建造、拆除、旋轉、選配方、放入 / 取出、研究、繳交里程碑、手動合成）都在這裡檢查：
//     領地、地形、重疊、材料（先扣背包、不夠再扣基地核心）、距離、頻率；通過後產生「事件」套用並廣播
//   * 同步方式（GDD 7.5 伺服器權威）：
//       - 進場送一次完整狀態（fac-init），之後隊伍裡的人收到每個事件（fac-ev）並用同一份 factory.js 自己往下算
//       - 每 FAC_SNAPSHOT_MS 再送一次完整狀態（fac-state）校正；畫面只是「預測」，數量、生產結果以伺服器為準
//       - 其他隊伍只收到建築外觀（fac-layout），看不到內容（GDD 30.6）
//   * 存檔：狀態壓縮（deflate）後轉 base64 交給 game_api.asp（act=savefactory），每 FAC_SAVE_MS 一次、
//     有重要事件（研究完成、里程碑）時馬上存；Render 重啟後從資料庫載入，並補算離線期間的生產（最多 FAC_OFFLINE_MAX_MIN 分鐘）
//   * 採礦機蓋在資源節點上：被佔用的資源採光不會搬家；資源被管理員隱藏 / 重置時，採礦機改挖範圍內的其他資源或停機
// ============================================================
const zlib = require('zlib');
const SfFactory = require('./factory');
const SfResources = require('./resources');
const SfTerrain = require('./terrain');

const F = SfFactory;
const FAC_SNAPSHOT_MS = Number(process.env.SF_FAC_SNAPSHOT_MS) || 5000;     // 校正用完整狀態多久送一次
const FAC_SAVE_MS = Number(process.env.SF_FAC_SAVE_MS) || 60 * 1000;        // 存檔間隔
const FAC_OFFLINE_MAX_MIN = Number(process.env.SF_FAC_OFFLINE_MAX_MIN) || 30; // 重啟後最多補算幾分鐘（保護伺服器）
const FAC_MAX_TICKS_PER_LOOP = 20;          // 落後太多時一次最多補幾個 Tick，超過就直接跳過（避免卡住事件迴圈）
const REACH = 10;                           // 放入 / 取出要站在建築幾格內
const BUILD_GAP_MS = 35;                    // 建造的最短間隔（拖曳一排輸送帶時大約每秒 25 格）
const OP_GAP_MS = 120;                      // 其他工廠操作的最短間隔
const CRAFT_QUEUE_MAX = 10;                 // 手動合成佇列最多幾筆
const CRAFT_COUNT_MAX = 50;                 // 一次最多合成幾個

module.exports = function createFactoryServer(ctx) {
  // ctx = { nsp, api, players, getWorld, teamBlocks(team), sendChat(msg), dropAt(item, qty, x, y), log }
  const { nsp, api, players } = ctx;

  // ---- 每個世界的工廠資料（掛在 world.fac 上）----
  //   w.fac = { epoch（Tick 0 的時間）, gt（目前 Tick）, teams: Map(teamId → { S, seq, ver, dirty, lastSave, events }) }
  function facOf(w, teamId, create) {
    if (!w.fac || !w.fac.ready) return null;
    let f = w.fac.teams.get(teamId);
    if (!f && create && !w.fac.broken.has(teamId)) {
      const team = w.teams.get(teamId);
      f = { S: F.createState(team ? team.level || 1 : 1), seq: 0, ver: 0, dirty: true, lastSave: 0 };
      f.S.tick = w.fac.gt;
      w.fac.teams.set(teamId, f);
    }
    return f;
  }

  // ---- 載入：所有隊伍的存檔 → 還原 → 補算離線期間 ----
  //   讀取失敗時（ASP 連不上、資料表還沒建）：工廠功能先停用（ready = false），每 30 秒重試；
  //   絕對不能用空的工廠繼續跑，否則下次存檔會把資料庫裡真正的工廠蓋掉
  async function loadAll(w) {
    w.fac = { epoch: Date.now(), gt: 0, teams: new Map(), ready: false, broken: new Set() };
    const r = await api.factories();
    if (!r.ok) { console.warn('[starforge] 讀取工廠存檔失敗，工廠功能暫停，30 秒後重試：', r.error); return; }
    const now = Date.now();
    for (const row of r.factories || []) {
      try {
        const json = zlib.inflateRawSync(Buffer.from(String(row.data || ''), 'base64')).toString('utf8');
        const S = F.unpack(JSON.parse(json));
        const team = w.teams.get(Number(row.teamId));
        if (team) S.level = Math.max(S.level, team.level || 1);
        // 補算離線期間（研究完成之類的通知也照樣處理）
        const ticks = Math.max(0, Math.min(Math.floor((now - Number(row.savedMs || now)) / F.TICK_MS), FAC_OFFLINE_MAX_MIN * 600));
        for (let i = 0; i < ticks; i++) {
          F.step(S);
          if (i % 2000 === 1999) await new Promise((res) => setImmediate(res));   // 讓事件迴圈喘口氣
        }
        S.tick = 0;
        w.fac.teams.set(Number(row.teamId), { S, seq: 0, ver: Number(row.ver) || 0, dirty: ticks > 0, lastSave: Date.now() });
        if (ticks) console.log('[starforge] 隊伍 ' + row.teamId + ' 的工廠補算了離線期間 ' + Math.round(ticks / 10) + ' 秒');
      } catch (e) {
        // 存檔壞掉：這隊的工廠停用（不建立新的，以免把資料庫裡的蓋掉），請管理員檢查 game_sf_factory
        w.fac.broken.add(Number(row.teamId));
        console.error('[starforge] 隊伍 ' + row.teamId + ' 的工廠存檔讀不出來，這隊的工廠先停用', e.message);
      }
    }
    w.fac.epoch = Date.now();
    w.fac.gt = 0;
    w.fac.ready = true;
    for (const t of w.teams.values()) revalidateMiners(w, t.id, true);
  }

  // ---- 事件：套用、記號、廣播 ----
  //   ev.t = 套用時的 Tick（前端在同一個 Tick 之後套用），ev.s = 流水號（前端用來判斷完整狀態是否已經包含這個事件）
  const LAYOUT_EVENTS = { build: 1, remove: 1, rotate: 1 };
  function emitEv(w, teamId, ev) {
    const f = facOf(w, teamId, true);
    if (!f) return null;
    ev.t = f.S.tick;
    ev.s = ++f.seq;
    F.apply(f.S, ev);
    f.dirty = true;
    nsp.to('team:' + teamId).emit('fac-ev', ev);
    if (LAYOUT_EVENTS[ev.k]) {
      const b = f.S.b.get(ev.id);
      // 其他隊伍只需要外觀（前端收到自己隊伍的 fac-layout 會略過）
      nsp.emit('fac-layout', { team: teamId, k: ev.k, row: b ? [b.id, b.type, b.x, b.y, b.d] : [ev.id] });
    }
    return f;
  }
  const stateJson = (f) => JSON.stringify(F.pack(f.S));

  // 讀取失敗時每 30 秒重試；成功後通知線上的玩家重新同步
  setInterval(async () => {
    const w = ctx.getWorld();
    if (!w || !w.fac || w.fac.ready || w.fac.retrying) return;
    w.fac.retrying = true;
    try { await loadAll(w); } finally { if (w.fac) w.fac.retrying = false; }
    if (w.fac.ready && w === ctx.getWorld()) {
      for (const p of players.values()) { const s = nsp.sockets.get(p.socketId); if (s) onJoin(s, p); }
      console.log('[starforge] 工廠存檔重新讀取成功');
    }
  }, 30 * 1000);

  // ---- 主迴圈：全世界同一個 Tick ----
  setInterval(() => {
    const w = ctx.getWorld();
    if (!w || !w.fac || !w.fac.ready) return;
    const fac = w.fac;
    const target = Math.floor((Date.now() - fac.epoch) / F.TICK_MS);
    let n = 0;
    const t0 = Date.now();
    while (fac.gt < target && n < FAC_MAX_TICKS_PER_LOOP) {
      fac.gt++; n++;
      for (const [teamId, f] of fac.teams) {
        const notes = F.step(f.S);
        if (notes.length) handleNotes(w, teamId, f, notes);
      }
    }
    if (fac.gt < target) {
      // 伺服器忙不過來：直接跳到現在（工廠少算幾個 Tick；前端收到下一次完整狀態就會對齊）
      console.warn('[starforge] 工廠模擬落後 ' + (target - fac.gt) + ' Tick，跳過');
      fac.gt = target;
      for (const f of fac.teams.values()) f.S.tick = target;
    }
    const cost = Date.now() - t0;
    if (cost > 60) console.warn('[starforge] 工廠模擬一次花了 ' + cost + 'ms（' + n + ' Tick）');
  }, 50);

  // 研究完成：通知隊伍、存檔；終極科技全世界廣播
  function handleNotes(w, teamId, f, notes) {
    const team = w.teams.get(teamId);
    for (const nt of notes) {
      if (nt.k !== 'tech') continue;
      const t = F.TECHS[nt.id];
      nsp.to('team:' + teamId).emit('fac-notice', { kind: 'tech', id: nt.id, text: '🔬 研究完成：「' + t.name + '」' });
      ctx.sendChat({ channel: 'team', who: '系統', charId: null, teamId, text: '🔬 研究完成：「' + t.name + '」', isSystem: true, ts: Date.now() });
      if (nt.id === 'planet_industry' && team) {
        ctx.sendChat({ channel: 'world', who: '系統', charId: null, teamId: null, text: '🌟 隊伍「' + team.name + '」完成了「星球工業化」，成為星球工業文明！', isSystem: true, ts: Date.now() });
      }
      f.dirty = true; f.lastSave = 0;     // 下一輪就存
    }
  }

  // ---- 定期送完整狀態校正、定期存檔 ----
  setInterval(() => {
    const w = ctx.getWorld();
    if (!w || !w.fac) return;
    for (const [teamId, f] of w.fac.teams) {
      const room = nsp.adapter.rooms.get('team:' + teamId);
      if (room && room.size) nsp.to('team:' + teamId).emit('fac-state', { team: teamId, seq: f.seq, serverNow: Date.now(), state: stateJson(f) });
    }
  }, FAC_SNAPSHOT_MS);
  setInterval(() => { const w = ctx.getWorld(); if (w) saveAll(w, false); }, 5000);
  function saveAll(w, force) {
    if (!w || !w.fac || !w.fac.ready) return;
    const now = Date.now();
    for (const [teamId, f] of w.fac.teams) {
      if (!f.dirty || f.saving) continue;
      if (!force && now - f.lastSave < FAC_SAVE_MS) continue;
      saveOne(teamId, f);
    }
  }
  function saveOne(teamId, f) {
    let data;
    try { data = zlib.deflateRawSync(Buffer.from(stateJson(f), 'utf8'), { level: 6 }).toString('base64'); }
    catch (e) { console.error('[starforge] 工廠存檔壓縮失敗', e); return; }
    f.dirty = false; f.saving = true; f.lastSave = Date.now();
    const ver = f.ver + 1;
    api.saveFactory(teamId, ver, Date.now(), data).then((r) => {
      f.saving = false;
      if (r.ok) { f.ver = ver; return; }
      f.dirty = true;
      if (r.staleVersion && r.ver) f.ver = Number(r.ver);   // 資料庫裡的版本比較新（例如舊的伺服器還在跑）：跟上版本號，下次再存
      console.warn('[starforge] 隊伍 ' + teamId + ' 工廠存檔失敗', r.error);
    });
  }

  // ---- 採礦機與資源節點 ----
  // 某資源有沒有被採礦機佔用（被佔用的資源採光後不會搬家，留在原地慢慢長回來）
  function isNodeClaimed(w, node) {
    if (w && w.fac && !w.fac.ready) return true;   // 工廠還沒讀進來：當成被佔用（不搬家），以免採礦機底下的資源跑掉
    const f = w && w.fac && w.fac.teams.get(node.teamId);
    if (!f) return false;
    for (const b of f.S.b.values()) if (b.node === node.id) return true;
    return false;
  }
  // 隊伍的資源變了（管理員調整、重置、搬家）：採礦機底下的資源不見了 → 改挖範圍內其他的，或停機
  function revalidateMiners(w, teamId, silent) {
    const f = w && w.fac && w.fac.teams.get(teamId);
    if (!f) return;
    const claimed = new Set();
    for (const b of f.S.b.values()) if (b.node) claimed.add(b.node);
    for (const b of Array.from(f.S.b.values())) {
      const d = F.BUILDINGS[b.type];
      if (d.kind !== 'miner') continue;
      const inside = (n) => n && n.active && n.teamId === teamId && Math.floor(n.x) >= b.x && Math.floor(n.x) < b.x + d.w && Math.floor(n.y) >= b.y && Math.floor(n.y) < b.y + d.h;
      const cur = b.node && w.nodes.get(b.node);
      if (inside(cur)) continue;
      let next = null;
      for (const n of w.nodes.values()) if (inside(n) && !claimed.has(n.id)) { next = n; break; }
      if (b.node) claimed.delete(b.node);
      if (next) claimed.add(next.id);
      const res = next ? SfResources.NODE_TYPES[next.type].item : null;
      if ((next ? next.id : null) === b.node && res === b.res) continue;
      const ev = { k: 'miner', id: b.id, node: next ? next.id : null, res };
      if (silent) F.apply(f.S, ev); else emitEv(w, teamId, ev);
    }
  }

  // ---- 背包工具 ----
  const R = SfResources;
  function kindsOf(inv) { let n = 0; for (const k in inv) if (inv[k] > 0) n++; return n; }
  // 放進背包，放不下的回傳
  function giveItems(p, items) {
    const left = {};
    for (const it in items) {
      let n = items[it];
      if (n <= 0) continue;
      const have = p.inventory[it] || 0;
      if (!have && kindsOf(p.inventory) >= R.BAG_KINDS) { left[it] = n; continue; }
      const take = Math.min(n, R.STACK_MAX - have);
      if (take > 0) { p.inventory[it] = have + take; n -= take; p.invDirty = true; }
      if (n > 0) left[it] = n;
    }
    return left;
  }
  // 背包放不下的：先放基地核心，再不行就丟在玩家腳邊
  function giveOrStore(w, p, items, f) {
    const left = giveItems(p, items);
    const hub = f && Array.from(f.S.b.values()).find((b) => b.type === 'hub');
    for (const it in left) {
      let n = left[it];
      if (hub) {
        const k = F.acceptCount(f.S, hub, it, n);
        if (k > 0) { emitEv(w, p.teamId, { k: 'put', id: hub.id, item: it, n: k }); n -= k; }
      }
      if (n > 0) ctx.dropAt(it, n, p.x, p.y);
    }
  }
  const syncInv = (socket, p) => socket.emit('inventory-sync', { inventory: p.inventory });

  // 材料：背包 + 基地核心夠不夠
  function canPay(p, f, cost) {
    for (const it in cost) if ((p.inventory[it] || 0) + (f.S.hub[it] || 0) < cost[it]) return F.ITEMS[it] ? F.ITEMS[it].name : it;
    return null;
  }
  function pay(w, p, f, cost) {
    for (const it in cost) {
      const fromBag = Math.min(cost[it], p.inventory[it] || 0);
      if (fromBag > 0) { p.inventory[it] -= fromBag; if (p.inventory[it] <= 0) delete p.inventory[it]; p.invDirty = true; }
      const rest = cost[it] - fromBag;
      if (rest > 0) emitEv(w, p.teamId, { k: 'hubtake', item: it, n: rest });
    }
  }

  // ---- 手動合成（GDD 32.1）：材料一開始就扣掉，時間到給產品；取消或離線退回還沒做的 ----
  function craftState(p) {
    return { queue: (p.craft || []).map((c) => ({ r: c.r, left: c.left, ends: c.ends, total: c.total })), serverNow: Date.now() };
  }
  setInterval(() => {
    const w = ctx.getWorld();
    if (!w) return;
    const now = Date.now();
    for (const p of players.values()) {
      if (!p.craft || !p.craft.length) continue;
      const c = p.craft[0];
      if (now < c.ends) continue;
      const r = F.RECIPES[c.r];
      const f = facOf(w, p.teamId, false);
      giveOrStore(w, p, r.out, f);
      c.left--;
      if (c.left > 0) c.ends = now + r.time * F.TICK_MS;
      else { p.craft.shift(); if (p.craft[0]) p.craft[0].ends = now + F.RECIPES[p.craft[0].r].time * F.TICK_MS; }
      const s = nsp.sockets.get(p.socketId);
      if (s) { syncInv(s, p); s.emit('craft-state', craftState(p)); }
    }
  }, 100);
  function refundCraft(p) {
    if (!p.craft || !p.craft.length) return;
    const back = {};
    for (const c of p.craft) for (const it in F.RECIPES[c.r].in) back[it] = (back[it] || 0) + F.RECIPES[c.r].in[it] * c.left;
    p.craft = [];
    const left = giveItems(p, back);
    for (const it in left) ctx.dropAt(it, left[it], p.x, p.y);
  }

  // ---- 進場 / 離線 ----
  function onJoin(socket, p) {
    const w = ctx.getWorld();
    if (!w || !w.fac || !w.fac.ready) return;
    const team = w.teams.get(p.teamId);
    const own = team && team.flagX != null ? facOf(w, p.teamId, true) : facOf(w, p.teamId, false);
    const layouts = [];
    for (const [teamId, f] of w.fac.teams) if (teamId !== p.teamId) layouts.push([teamId, F.layoutOf(f.S)]);
    socket.emit('fac-init', {
      epoch: w.fac.epoch, serverNow: Date.now(), tickMs: F.TICK_MS,
      team: p.teamId, seq: own ? own.seq : 0, state: own ? stateJson(own) : null, layouts
    });
    socket.emit('craft-state', craftState(p));
  }
  function onLeave(p) { refundCraft(p); }

  // ---- 玩家操作 ----
  function bind(socket) {
    const ctxOf = (data, gap) => {
      const p = players.get(socket.id), w = ctx.getWorld();
      if (!p || !w || !w.fac || !data || typeof data !== 'object') return null;
      const now = Date.now();
      if (now - (p.lastFac || 0) < (gap || OP_GAP_MS)) return null;
      p.lastFac = now;
      const team = w.teams.get(p.teamId);
      if (!team || team.flagX == null) { socket.emit('fac-error', { error: '隊伍插旗建立基地後才能蓋工廠' }); return null; }
      const f = facOf(w, p.teamId, true);
      if (!f) { socket.emit('fac-error', { error: w.fac.ready ? '你們隊伍的工廠存檔讀取失敗，請聯絡管理員' : '工廠資料讀取中，請稍後再試' }); return null; }
      return { p, w, team, f };
    };
    const fail = (error) => socket.emit('fac-error', { error });
    const near = (p, b) => {
      const d = F.BUILDINGS[b.type];
      const cx = b.x + d.w / 2, cy = b.y + d.h / 2;
      return Math.max(Math.abs(p.x - cx) - d.w / 2, Math.abs(p.y - cy) - d.h / 2) <= REACH;
    };
    const getB = (c, id) => c.f.S.b.get(Math.floor(Number(id)));
    const cleanItem = (v) => { const s = String(v || ''); return /^[a-z0-9_]{1,30}$/.test(s) && F.ITEMS[s] ? s : null; };

    // 建造：{ type, x, y, d, r? }
    socket.on('fac-build', (data) => {
      const c = ctxOf(data, BUILD_GAP_MS); if (!c) return;
      const type = String(data.type || ''), x = Math.floor(Number(data.x)), y = Math.floor(Number(data.y)), d = Math.floor(Number(data.d)) & 3;
      if (!F.BUILDINGS[type]) return fail('沒有這種建築');
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const w = c.w, team = c.team;
      const nodes = [];
      for (const n of w.nodes.values()) if (n.active && n.teamId === team.id) nodes.push({ id: n.id, type: n.type, x: n.x, y: n.y });
      const chk = F.checkPlace(c.f.S, { terrain: w.terrain, blocks: ctx.teamBlocks(team), nodes, flag: { x: team.flagX, y: team.flagY } }, type, x, y);
      if (!chk.ok) return fail(chk.error);
      const cost = F.BUILDINGS[type].cost, lack = canPay(c.p, c.f, cost);
      if (lack) return fail('材料不夠：' + lack + '（背包和基地核心都沒有了）');
      pay(w, c.p, c.f, cost);
      const ev = { k: 'build', id: c.f.S.nid, type, x, y, d };
      if (chk.node) { ev.node = chk.node; ev.res = chk.res; }
      const r = data.r && F.RECIPES[data.r];
      if (r && F.BUILDINGS[type].kind === 'assembler' && r.machine === 'assembler' && F.recipeUnlocked(c.f.S, data.r)) ev.r = data.r;
      emitEv(w, team.id, ev);
      syncInv(socket, c.p);
    });
    // 拆除：建造材料 + 裡面的東西全部退回
    socket.on('fac-remove', (data) => {
      const c = ctxOf(data, BUILD_GAP_MS); if (!c) return;
      const b = getB(c, data.id); if (!b) return;
      const items = F.contentsOf(b), cost = F.BUILDINGS[b.type].cost;
      for (const it in cost) items[it] = (items[it] || 0) + cost[it];
      emitEv(c.w, c.team.id, { k: 'remove', id: b.id });
      giveOrStore(c.w, c.p, items, c.f);
      syncInv(socket, c.p);
    });
    socket.on('fac-rotate', (data) => {
      const c = ctxOf(data); if (!c) return;
      const b = getB(c, data.id); if (!b) return;
      const d = data.d == null ? (b.d + 1) & 3 : Math.floor(Number(data.d)) & 3;
      emitEv(c.w, c.team.id, { k: 'rotate', id: b.id, d });
    });
    // 組裝機選配方：原本放進去的材料退回
    socket.on('fac-recipe', (data) => {
      const c = ctxOf(data); if (!c) return;
      const b = getB(c, data.id); if (!b || F.BUILDINGS[b.type].kind !== 'assembler') return;
      const rid = data.r ? String(data.r) : null;
      if (rid) {
        const r = F.RECIPES[rid];
        if (!r || r.machine !== 'assembler') return fail('組裝機不能做這個');
        if (!F.recipeUnlocked(c.f.S, rid)) return fail('要先研究「' + F.TECHS[r.tech].name + '」');
      }
      if (rid === b.r) return;
      const back = Object.assign({}, b.inv);
      emitEv(c.w, c.team.id, { k: 'recipe', id: b.id, r: rid });
      if (Object.keys(back).length) { giveOrStore(c.w, c.p, back, c.f); syncInv(socket, c.p); }
    });
    socket.on('fac-filter', (data) => {
      const c = ctxOf(data); if (!c) return;
      const b = getB(c, data.id); if (!b || b.type !== 'sorter') return;
      const item = data.item ? cleanItem(data.item) : null;
      if (data.item && !item) return;
      emitEv(c.w, c.team.id, { k: 'filter', id: b.id, item });
    });
    // 從背包放進建築：{ id, item, qty }（基地核心也是用這個）
    socket.on('fac-put', (data) => {
      const c = ctxOf(data); if (!c) return;
      const b = getB(c, data.id); if (!b) return;
      if (!near(c.p, b)) return fail('離太遠了，走近一點（' + REACH + ' 格內）');
      const item = cleanItem(data.item), have = item ? c.p.inventory[item] || 0 : 0;
      if (!item || have <= 0) return fail('背包裡沒有這個物品');
      const want = Math.max(1, Math.min(have, Math.floor(Number(data.qty)) || 1));
      const n = F.acceptCount(c.f.S, b, item, want);
      if (n <= 0) return fail(F.ITEMS[item].name + '放不進' + F.BUILDINGS[b.type].name);
      c.p.inventory[item] = have - n; if (c.p.inventory[item] <= 0) delete c.p.inventory[item];
      c.p.invDirty = true;
      emitEv(c.w, c.team.id, { k: 'put', id: b.id, item, n });
      syncInv(socket, c.p);
    });
    // 取出：一般建築 = 產品（箱子 = 全部）全拿；基地核心 = { item, qty }
    socket.on('fac-take', (data) => {
      const c = ctxOf(data); if (!c) return;
      const b = getB(c, data.id); if (!b) return;
      if (!near(c.p, b)) return fail('離太遠了，走近一點（' + REACH + ' 格內）');
      if (b.type === 'hub') {
        const item = cleanItem(data.item), have = item ? c.f.S.hub[item] || 0 : 0;
        if (!item || have <= 0) return fail('核心倉庫裡沒有這個物品');
        const want = Math.max(1, Math.min(have, Math.floor(Number(data.qty)) || 1));
        const left = giveItems(c.p, { [item]: want });
        const got = want - (left[item] || 0);
        if (got <= 0) return fail('背包放不下了');
        emitEv(c.w, c.team.id, { k: 'hubtake', item, n: got });
        return syncInv(socket, c.p);
      }
      const can = F.takeableOf(b);
      if (!Object.keys(can).length) return fail('裡面沒有可以拿的東西');
      const left = giveItems(c.p, can), got = {};
      let any = false;
      for (const it in can) { const g = can[it] - (left[it] || 0); if (g > 0) { got[it] = g; any = true; } }
      if (!any) return fail('背包放不下了');
      emitEv(c.w, c.team.id, { k: 'take', id: b.id, items: got });
      syncInv(socket, c.p);
    });
    socket.on('fac-research', (data) => {
      const c = ctxOf(data); if (!c) return;
      const id = data.tech ? String(data.tech) : null;
      if (id) { const err = F.techError(c.f.S, id); if (err) return fail(err); }
      if (id === c.f.S.tech.cur) return;
      emitEv(c.w, c.team.id, { k: 'research', tech: id });
    });
    // 繳交里程碑：基地核心裡的東西夠了才行；隊伍等級 +1 並寫進資料庫
    socket.on('fac-milestone', (data) => {
      const c = ctxOf(data || {}); if (!c) return;
      const S = c.f.S, m = F.MILESTONES.find((mm) => mm.level === S.level + 1);
      if (!m) return fail('已經完成所有里程碑了');
      if (!Array.from(S.b.values()).some((b) => b.type === 'hub')) return fail('要先蓋基地核心');
      for (const it in m.need) if ((S.hub[it] || 0) < m.need[it]) return fail('核心倉庫的' + F.ITEMS[it].name + '還不夠（' + (S.hub[it] || 0) + ' / ' + m.need[it] + '）');
      emitEv(c.w, c.team.id, { k: 'milestone' });
      c.team.level = S.level;
      c.f.lastSave = 0;
      api.teamLevel(c.team.id, S.level).then((r) => { if (!r.ok) console.warn('[starforge] 存隊伍等級失敗', r.error); });
      nsp.emit('team-level', { id: c.team.id, level: S.level });
      ctx.sendChat({ channel: 'world', who: '系統', charId: null, teamId: null, text: '🏆 隊伍「' + c.team.name + '」完成里程碑「' + m.name + '」，升到 Lv.' + S.level + '！', isSystem: true, ts: Date.now() });
    });
    // 手動合成：{ r, count }
    socket.on('craft', (data) => {
      const p = players.get(socket.id), w = ctx.getWorld();
      if (!p || !w || !data) return;
      const now = Date.now();
      if (now - (p.lastFac || 0) < OP_GAP_MS) return;
      p.lastFac = now;
      const rid = String(data.r || ''), r = F.RECIPES[rid];
      if (!r || !r.hand) return fail('這個不能手動合成');
      const f = facOf(w, p.teamId, false);
      const S = f ? f.S : F.createState(1);
      if (!F.recipeUnlocked(S, rid)) return fail('要先研究「' + F.TECHS[r.tech].name + '」');
      p.craft = p.craft || [];
      if (p.craft.length >= CRAFT_QUEUE_MAX) return fail('合成佇列滿了（最多 ' + CRAFT_QUEUE_MAX + ' 筆）');
      let count = Math.max(1, Math.min(CRAFT_COUNT_MAX, Math.floor(Number(data.count)) || 1));
      for (const it in r.in) count = Math.min(count, Math.floor((p.inventory[it] || 0) / r.in[it]));
      if (count <= 0) return fail('材料不夠');
      for (const it in r.in) { p.inventory[it] -= r.in[it] * count; if (p.inventory[it] <= 0) delete p.inventory[it]; }
      p.invDirty = true;
      p.craft.push({ r: rid, left: count, total: count, ends: p.craft.length ? 0 : now + r.time * F.TICK_MS });
      syncInv(socket, p);
      socket.emit('craft-state', craftState(p));
    });
    socket.on('craft-cancel', (data) => {
      const p = players.get(socket.id);
      if (!p || !p.craft || !data) return;
      const i = Math.floor(Number(data.index));
      if (!(i >= 0 && i < p.craft.length)) return;
      const c = p.craft.splice(i, 1)[0], back = {};
      for (const it in F.RECIPES[c.r].in) back[it] = F.RECIPES[c.r].in[it] * c.left;
      const left = giveItems(p, back);
      for (const it in left) ctx.dropAt(it, left[it], p.x, p.y);
      if (i === 0 && p.craft[0]) p.craft[0].ends = Date.now() + F.RECIPES[p.craft[0].r].time * F.TICK_MS;
      syncInv(socket, p);
      socket.emit('craft-state', craftState(p));
    });
  }

  return { loadAll, onJoin, onLeave, bind, isNodeClaimed, revalidateMiners, saveAll, facOf,
           // 插旗後建立工廠狀態，讓隊員馬上可以開始蓋
           onFlag(w, team) {
             const f = facOf(w, team.id, true);
             if (!f) return;
             nsp.to('team:' + team.id).emit('fac-state', { team: team.id, seq: f.seq, serverNow: Date.now(), state: stateJson(f) });
           } };
};
