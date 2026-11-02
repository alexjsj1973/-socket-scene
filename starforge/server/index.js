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
//   * 背包：可以放棄（直接消失）或丟在地上；地上的物品任何人都能撿，10 分鐘沒人撿就消失（只放記憶體，重啟會清空）
// 狀態只放在記憶體（Render 重啟會清空），需要保留的（旗子、位置）都寫進資料庫，
// 啟動或場次切換時從資料庫重新載入（GDD 34.3）。
// ============================================================
const path = require('path');
const SfTerrain = require('./terrain');
const SfResources = require('./resources');
const createAspApi = require('./asp-api');

const TICK_MS = 100;                 // 伺服器移動模擬間隔
const SPEED = 7;                     // 角色移動速度（格 / 秒）
const SAVE_EVERY_MS = 2 * 60 * 1000; // 定期存位置
const WORLD_REFRESH_MS = 30 * 1000;  // 定期向資料庫確認場次（GM 結束場次、換新場次、改資源分佈、改再生倍率）
const FLUSH_EVERY_MS = 30 * 1000;    // 背包、資源節點批次存檔間隔
const DROP_TTL_MS = 10 * 60 * 1000;  // 地上的物品多久沒人撿就消失
const DROP_MAX = 500;                // 整個世界最多同時有幾堆地上物品
const ITEM_OP_GAP_MS = 200;          // 丟棄 / 丟地上 / 撿起的最短間隔（防連點洗訊息）

module.exports = function attachStarforge(opts) {
  const { io, app, verifyLoginToken } = opts;
  const apiUrl = process.env.STARFORGE_API_URL ||
    String(opts.verifyTokenUrl || '').replace(/verify_token\.asp.*$/i, 'starforge/game_api.asp');
  const api = createAspApi(apiUrl, process.env.STARFORGE_API_KEY || opts.apiKey || '');
  const nsp = io.of('/starforge');

  // 瀏覽器用的地形程式（與伺服器同一份）
  ['terrain.js', 'resources.js'].forEach((f) => {
    app.get('/starforge/' + f, (req, res) => {
      res.set('Cache-Control', 'public, max-age=300');
      res.sendFile(path.join(__dirname, f));
    });
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

  async function loadWorld() {
    const r = await api.world();
    if (!r.ok) throw new Error(r.error || '讀取場次失敗');
    const teams = new Map();
    (r.teams || []).forEach((t) => teams.set(t.id, t));
    const nr = await api.nodes();
    if (!nr.ok) throw new Error(nr.error || '讀取資源節點失敗');
    const w = { session: r.session, terrain: SfTerrain.create(r.session.seed, r.session.mapChunks), teams,
                nodes: new Map(), dirtyNodes: new Set(), teamSpots: new Map(), drops: new Map(), dropSeq: 0 };
    (nr.nodes || []).forEach((row) => { const n = nodeFromDb(row); if (n) w.nodes.set(n.id, n); });
    // 已插旗的隊伍：數量跟設定不一樣就補上 / 隱藏（例如伺服器停機時管理員改過設定）
    for (const t of teams.values()) syncTeamNodes(w, t);
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
  function teamSpots(w, team) {
    const key = team.flagX + ',' + team.flagY;
    let sp = w.teamSpots.get(team.id);
    if (sp && sp.key === key) return sp;
    const blocks = SfTerrain.initialTerritory(team.flagX, team.flagY, w.session.initialBlocks, w.session.mapChunks);
    sp = Object.assign({ key }, SfResources.landTiles(w.terrain, blocks, team.flagX, team.flagY));
    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } };
    shuffle(sp.plains); shuffle(sp.hills);
    w.teamSpots.set(team.id, sp);
    return sp;
  }
  // 讓某隊領地裡的資源數量符合目前設定；回傳有變動的資源（呼叫端負責廣播）
  //   數量不夠：先把隱藏的（編號小的先）放回原位，還不夠再找空位長新的（可採數量用「現在」的範圍抽）
  //   數量太多：編號大的先隱藏（不刪除，剩餘量保留）
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
                    x: spot[0] + 0.5, y: spot[1] + 0.5, max, amount: max, t: now, active: true };
        nextIdx++; active++;
        w.nodes.set(n.id, n);
        changed.push(n);
      }
      for (let i = list.length - 1; i >= 0 && active > want; i--) {
        if (list[i].active) { list[i].active = false; active--; changed.push(list[i]); }
      }
    }
    changed.forEach((n) => w.dirtyNodes.add(n.id));
    return changed;
  }
  async function ensureWorld(expectSessionId) {
    if (world && (!expectSessionId || world.session.id === expectSessionId)) return world;
    if (!loading) loading = loadWorld().finally(() => { loading = null; });
    const w = await loading;
    if (!world || world.session.id !== w.session.id) {
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
    if ((s.resourceEpoch || 0) !== (old.resourceEpoch || 0)) {
      // 後台已經刪掉舊的資源資料；這裡清掉記憶體（還沒存的也不要了）重新生成
      w.nodes.clear(); w.dirtyNodes.clear(); w.teamSpots.clear();
      for (const t of w.teams.values()) syncTeamNodes(w, t);
      nsp.emit('nodes-reset', { rows: activeNodeRows(w), resources: s.resources || null, regenMultiplier: s.regenMultiplier });
      flushNodes();
      console.log('[starforge] 資源已重置（epoch ' + s.resourceEpoch + '）');
      return;
    }
    const cfgChanged = JSON.stringify(s.resources || null) !== JSON.stringify(old.resources || null);
    const changed = [];
    if (cfgChanged) for (const t of w.teams.values()) changed.push(...syncTeamNodes(w, t));
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

  const publicPlayer = (p) => ({ id: p.charId, name: p.name, look: p.look, teamId: p.teamId, x: p.x, y: p.y, dir: p.dir });
  const publicTeam = (t) => ({ id: t.id, name: t.name, level: t.level, flagX: t.flagX, flagY: t.flagY });
  const regenMult = () => (world && world.session.regenMultiplier) || 1;
  // 給前端的資源：[id, type, x, y, max, amount, changedMs]（只送顯示中的）
  const nodeRow = (n) => [n.id, n.type, n.x, n.y, n.max, n.amount, n.t];
  const activeNodeRows = (w) => { const out = []; for (const n of w.nodes.values()) if (n.active) out.push(nodeRow(n)); return out; };
  const dropRow = (d) => [d.id, d.item, d.qty, d.x, d.y];
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
  setInterval(() => { flushNodes(); for (const p of players.values()) saveInv(p); }, FLUSH_EVERY_MS);

  nsp.on('connection', (socket) => {
    // ---- 進場 ----
    socket.on('join', async (data) => {
      try {
        if (players.has(socket.id)) return;
        const v = await verifyLoginToken(data && data.token);
        if (!v || !v.ok) return socket.emit('join-error', { error: '登入憑證無效或已過期，請回大廳重新進入', needLobby: true });
        const pr = await api.player(v.memberId);
        if (!pr.ok) return socket.emit('join-error', { error: pr.error || '讀取角色失敗', needLobby: true });
        if (!pr.character || !pr.team) return socket.emit('join-error', { error: '請先在大廳建立角色並加入隊伍', needLobby: true });
        const w = await ensureWorld(pr.sessionId);

        // 同一個角色只能有一個連線：踢掉舊的
        for (const [sid, other] of players) {
          if (other.charId === pr.character.id) {
            const s = nsp.sockets.get(sid);
            if (s) { s.emit('join-error', { error: '你的角色已在其他視窗進入世界' }); s.disconnect(true); }
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
          socketId: socket.id, memberId: v.memberId, charId: c.id, name: c.name, look: c.look, level: c.level,
          teamId: team.id, x: pos.x, y: pos.y, tx: null, ty: null, dir: 0, lastSave: Date.now(),
          inventory: {}, invDirty: false, lastGather: 0, lastItemOp: 0
        };
        (pr.inventory || []).forEach((it) => { if (SfResources.ITEMS[it.code]) p.inventory[it.code] = it.qty; });
        players.set(socket.id, p);
        socket.data.charId = c.id;

        const s = w.session;
        socket.emit('init', {
          me: { id: c.id, name: c.name, level: c.level, teamId: team.id, isLeader: team.leaderId === c.id },
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
          inventory: p.inventory
        });
        socket.broadcast.emit('char-joined', publicPlayer(p));
      } catch (e) {
        console.error('[starforge] join 失敗', e);
        socket.emit('join-error', { error: '進入世界失敗：' + e.message });
      }
    });

    // ---- 移動：只收目的地，伺服器檢查並模擬 ----
    socket.on('move', (data) => {
      const p = players.get(socket.id);
      if (!p || !world || !data) return;
      let x = Number(data.x), y = Number(data.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const size = world.terrain.size;
      x = Math.max(0.5, Math.min(size - 0.5, x));
      y = Math.max(0.5, Math.min(size - 0.5, y));
      if (!world.terrain.walkable(x, y)) return socket.emit('move-error', { error: '那裡過不去（水面或高山）' });
      p.tx = x; p.ty = y;
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
      }).catch((e) => console.error('[starforge] 插旗失敗', e));
    });

    // ---- 採集：一次採 1 單位；前端走到節點旁後每隔一段時間送一次 ----
    socket.on('gather', (data) => {
      const p = players.get(socket.id);
      if (!p || !world || !data) return;
      const R = SfResources, now = Date.now();
      const node = world.nodes.get(String(data.nodeId || ''));
      if (!node || !node.active) return socket.emit('gather-error', { error: '這個資源已經不在了', stop: true });
      if (Math.hypot(node.x - p.x, node.y - p.y) > R.GATHER_RANGE + 0.4) return socket.emit('gather-error', { error: '離太遠了，走近一點再採', far: true });
      const team = world.teams.get(p.teamId);
      if (!team || team.flagX == null) return socket.emit('gather-error', { error: '隊伍插旗建立基地後才能採集', stop: true });
      if (!R.inBlocks(teamBlocks(team), node.x, node.y)) return socket.emit('gather-error', { error: '只能採集自己隊伍領地內的資源', stop: true });
      if (now - p.lastGather < R.GATHER_COOLDOWN - 80) return;   // 太快就忽略（不回錯誤，避免洗訊息）
      const def = R.NODE_TYPES[node.type];
      const amount = R.currentAmount(node, now, regenMult());
      if (amount <= 0) return socket.emit('gather-error', { error: def.name + '已經採光了，過一陣子會再長回來', stop: true });
      const item = def.item;
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
      let x = p.x + Math.sin(ang) * 0.8 + (Math.random() - 0.5) * 0.4, y = p.y + Math.cos(ang) * 0.8 + (Math.random() - 0.5) * 0.4;
      if (!w.terrain.walkable(x, y)) { x = p.x; y = p.y; }
      const d = { id: 'd' + (++w.dropSeq), item: got.item, qty: got.qty, x: +x.toFixed(2), y: +y.toFixed(2), t: Date.now() };
      w.drops.set(d.id, d);
      nsp.emit('drop-added', dropRow(d));
    });
    socket.on('pickup', (data) => {
      const p = players.get(socket.id);
      if (!p || !world || !data || !itemOpOk(p)) return;
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

    socket.on('disconnect', () => {
      const p = players.get(socket.id);
      if (!p) return;
      players.delete(socket.id);
      savePos(p);
      saveInv(p);
      nsp.emit('char-left', { id: p.charId });
    });
  });

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
    const step = SPEED * TICK_MS / 1000;
    const moved = [];
    const now = Date.now();
    for (const p of players.values()) {
      if (p.tx != null) {
        const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy);
        let nx, ny;
        if (d <= step) { nx = p.tx; ny = p.ty; } else { nx = p.x + dx / d * step; ny = p.y + dy / d * step; }
        if (world.terrain.walkable(nx, ny)) {
          p.dir = dirOf(dx, dy);
          p.x = nx; p.y = ny;
          if (d <= step) { p.tx = null; p.ty = null; }
        } else { p.tx = null; p.ty = null; }
        moved.push([p.charId, +p.x.toFixed(2), +p.y.toFixed(2), p.dir, p.tx != null ? 1 : 0]);
      }
      if (now - p.lastSave > SAVE_EVERY_MS) { p.lastSave = now; savePos(p); }
    }
    if (moved.length) nsp.emit('positions', moved);
  }, TICK_MS);

  console.log('[starforge] 遊戲服務已掛上 namespace /starforge，ASP API：' + apiUrl.replace(/key=[^&]*/i, 'key=***'));
};
