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
//   * 採集：隊伍插旗後，依後台的「資源分佈」在該隊領地裡生成資源（resources.js，位置由 seed + 隊伍 + 旗子決定），
//     只能採自己隊伍領地內的；每個資源可採數量依設定的範圍抽；
//     伺服器檢查距離、冷卻、剩餘量、背包容量。背包與被採過的節點每 30 秒批次寫回資料庫
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
const WORLD_REFRESH_MS = 60 * 1000;  // 定期向資料庫確認場次（GM 結束場次、換新場次）
const FLUSH_EVERY_MS = 30 * 1000;    // 背包、資源節點批次存檔間隔

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
  let world = null;      // { session, terrain, teams: Map(teamId → team), nodes: Map(nodeId → {amount, t}), dirtyNodes: Set }
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
    const nodes = new Map();
    (nr.nodes || []).forEach(([id, amount, t]) => nodes.set(id, { amount, t: Number(t) }));
    const w = { session: r.session, terrain: SfTerrain.create(r.session.seed, r.session.mapChunks), teams, nodes, dirtyNodes: new Set() };
    // 已插旗的隊伍：生成領地裡的資源（session.resources = 後台設定的資源分佈；舊版 game_api.asp 沒有就用預設）
    for (const t of teams.values()) registerTeamNodes(w, t);
    return w;
  }
  function registerTeamNodes(w, team) {
    if (!w || !team || team.flagX == null) return;
    const blocks = SfTerrain.initialTerritory(team.flagX, team.flagY, w.session.initialBlocks, w.session.mapChunks);
    SfResources.registerTeam(w.terrain, team, blocks, w.session.resources);
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
  // 定期確認場次還在（GM 結束場次時讓玩家離開）
  setInterval(async () => {
    if (!world || players.size === 0) return;
    const r = await api.world();
    // 連線失敗之類的暫時錯誤不處理，只有「確定沒有場次」或「換了場次」才請玩家離開
    if (!r.ok && !/沒有進行中/.test(r.error || '')) return;
    if (!r.ok || r.session.id !== world.session.id) {
      for (const [sid] of players) {
        const s = nsp.sockets.get(sid);
        if (s) { s.emit('join-error', { error: r.ok ? '世界場次已更換' : '目前沒有進行中的世界', needLobby: true }); s.disconnect(true); }
      }
      players.clear();
      world = null;
    } else {
      (r.teams || []).forEach((t) => { if (!world.teams.has(t.id)) world.teams.set(t.id, t); });
    }
  }, WORLD_REFRESH_MS);

  const publicPlayer = (p) => ({ id: p.charId, name: p.name, look: p.look, teamId: p.teamId, x: p.x, y: p.y, dir: p.dir });
  const publicTeam = (t) => ({ id: t.id, name: t.name, level: t.level, flagX: t.flagX, flagY: t.flagY });
  const regenMult = () => (world && world.session.regenMultiplier) || 1;
  const nodeRow = (id, st) => [id, st.amount, st.t];
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
    const w = world, ids = Array.from(w.dirtyNodes);
    w.dirtyNodes.clear();
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200).map((id) => nodeRow(id, w.nodes.get(id)));
      api.saveNodes(batch).then((r) => {
        if (!r.ok) { batch.forEach(([id]) => w.dirtyNodes.add(id)); console.warn('[starforge] 存資源節點失敗', r.error); }
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
          if (fresh.ok) (fresh.teams || []).forEach((t) => { w.teams.set(t.id, t); registerTeamNodes(w, t); });
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
          inventory: {}, invDirty: false, lastGather: 0
        };
        (pr.inventory || []).forEach((it) => { if (SfResources.ITEMS[it.code]) p.inventory[it.code] = it.qty; });
        players.set(socket.id, p);
        socket.data.charId = c.id;

        const s = w.session;
        socket.emit('init', {
          me: { id: c.id, name: c.name, level: c.level, teamId: team.id, isLeader: team.leaderId === c.id },
          world: { id: s.id, name: s.name, seed: s.seed, mapChunks: s.mapChunks, chunk: SfTerrain.CHUNK,
                   initialBlocks: s.initialBlocks, minFlagDistance: s.minFlagDistance, teamSizeMax: s.teamSizeMax,
                   resources: s.resources || null },   // 資源分佈：前端用同一份 resources.js 算出一樣的資源位置
          players: Array.from(players.values()).map(publicPlayer),
          teams: Array.from(w.teams.values()).map(publicTeam),
          // 資源：被採過的節點、伺服器時間（前端算再生用）、再生倍率、自己的背包
          nodes: Array.from(w.nodes.entries()).map(([id, st]) => nodeRow(id, st)),
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
        registerTeamNodes(world, team);   // 領地裡長出資源
        nsp.emit('flag-planted', publicTeam(team));
      }).catch((e) => console.error('[starforge] 插旗失敗', e));
    });

    // ---- 採集：一次採 1 單位；前端走到節點旁後每隔一段時間送一次 ----
    socket.on('gather', (data) => {
      const p = players.get(socket.id);
      if (!p || !world || !data) return;
      const R = SfResources, now = Date.now();
      const node = R.nodeById(world.terrain, data.nodeId);
      if (!node) return socket.emit('gather-error', { error: '找不到這個資源' });
      if (Math.hypot(node.x - p.x, node.y - p.y) > R.GATHER_RANGE + 0.4) return socket.emit('gather-error', { error: '離太遠了，走近一點再採', far: true });
      const team = world.teams.get(p.teamId);
      if (!team || team.flagX == null) return socket.emit('gather-error', { error: '隊伍插旗建立基地後才能採集', stop: true });
      if (!R.inBlocks(teamBlocks(team), node.x, node.y)) return socket.emit('gather-error', { error: '只能採集自己隊伍領地內的資源', stop: true });
      if (now - p.lastGather < R.GATHER_COOLDOWN - 80) return;   // 太快就忽略（不回錯誤，避免洗訊息）
      const def = R.NODE_TYPES[node.type];
      const st = world.nodes.get(node.id);
      const amount = R.currentAmount(node, st, now, regenMult());
      if (amount <= 0) return socket.emit('gather-error', { error: def.name + '已經採光了，過一陣子會再長回來', stop: true });
      const item = def.item;
      if (!p.inventory[item] && Object.keys(p.inventory).filter((k) => p.inventory[k] > 0).length >= R.BAG_KINDS) return socket.emit('gather-error', { error: '背包滿了', stop: true });
      if ((p.inventory[item] || 0) >= R.STACK_MAX) return socket.emit('gather-error', { error: R.ITEMS[item].name + '已經帶滿 ' + R.STACK_MAX + ' 個了', stop: true });
      p.lastGather = now;
      const next = { amount: amount - 1, t: now };
      world.nodes.set(node.id, next);
      world.dirtyNodes.add(node.id);
      p.inventory[item] = (p.inventory[item] || 0) + 1;
      p.invDirty = true;
      // 面向節點
      p.dir = dirOf(node.x - p.x, node.y - p.y);
      socket.emit('gathered', { nodeId: node.id, item, qty: p.inventory[item], left: next.amount });
      nsp.emit('node-changed', nodeRow(node.id, next));
      // 給其他人播採集動畫（揮工具、資源晃動）：[角色, 節點, 面向]；轉向也一起帶過去（站著不動時 positions 不會廣播）
      socket.broadcast.emit('char-gathering', [p.charId, node.id, p.dir]);
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
