// ============================================================
// combat.js - Starforge 戰鬥（2026-11-22）：角色、動物、怪物的血量、攻擊、經驗值與掉落
//
// 做什麼：
//   * 角色：血量（最大血量依等級 creatures.maxHpOf）、經驗值與等級（creatures.expNeed）。
//     被打到 0 → 倒下，COMBAT.playerRespawnMs 後在自己隊伍旗子旁滿血復活（背包不掉東西）；一段時間沒被打會慢慢回血。
//     血量只放記憶體（重新進場是滿血）；經驗值、等級寫回資料庫（game_api.asp act=saveexp）。
//   * 攻擊：前端點生物 → 走到武器的攻擊距離內 → 每隔武器的攻擊間隔送一次 attack { id }；
//     伺服器檢查距離、間隔、生物還活著，傷害 = 武器傷害 + (等級 - 1) + 0～2 的亂數。
//   * 生物反應（creatures.js 的 act）：怪物（aggro）在 aggroRange 格內發現玩家就追上來打；
//     猛獸（fight）被打才還手；草食動物（flee）被打會逃跑。追太遠（leash）或玩家躲進隊伍領地 / 倒下 → 走回原本的漫遊位置。
//   * 打倒：所有打過牠的人都拿到經驗值（乘場次的經驗倍率），掉落物品掉在地上（任何人都能撿）；
//     生物在原處消失，respawn 秒後重新出現（滿血）。
//   * 同步：平常生物的位置由 creatures.js 依時間算（前後端一致，不用傳資料）；
//     「戰鬥中」的生物由這裡模擬位置，每 TICK_MS 廣播 mobs（只送戰鬥中 / 剛倒下的），前端用它蓋過漫遊位置。
//
// Socket 事件（kebab-case）：
//   client → server：attack { id }
//   server → client：mobs { t, rows: [[id, x, y, hp, maxHp, dir, moving, st]] }（st：chase / flee / return）
//                    mob-gone { ids }（回到漫遊）、mob-hit { id, dmg, hp, maxHp, by }、mob-died { id, x, y, until }
//                    char-attack [charId, mobId, dir]、char-hp { id, hp, maxHp, dmg, from }、char-died { id }、
//                    char-respawn { id, x, y, hp, maxHp }、char-exp { exp, level, need, gained }（只給自己）、
//                    char-level { id, level, hp, maxHp }、mob-attack { id, target }（生物出手）、attack-error { error, far, stop }
// ============================================================
const SfTerrain = require('./terrain');
const SfCreatures = require('./creatures');
const SfResources = require('./resources');

const TICK_MS = 200;                // 戰鬥模擬間隔
const AGGRO_SCAN_MS = 500;          // 多久檢查一次怪物有沒有發現玩家
const C = SfCreatures.COMBAT;

module.exports = function createCombat(ctx) {
  const { nsp, players, getWorld, obstacleFn, territorySet, dropAt, sendChat, api } = ctx;

  // ---- 每個世界一份：生物產生器、戰鬥中的生物、倒下的生物 ----
  function ensure(w) {
    if (w.creatures) return w;
    w.monCfg = SfCreatures.parseMonsterCfg(w.session.resources && w.session.resources.monster);
    w.monCfgKey = JSON.stringify(w.monCfg);
    w.creatures = SfCreatures.create(w.terrain, {
      obstacleAt: (x, y) => obstacleFn(w)(x, y),
      territory: () => territorySet(w),
      monsterCfg: () => w.monCfg
    });
    w.mobs = new Map();      // id → 戰鬥中的生物 { id, a(漫遊資料), def, hp, maxHp, x, y, dir, moving, st, target, fleeFrom, until, lastAtk, hitters, stuck }
    w.dead = new Map();      // id → 重新出現的時間（毫秒）
    return w;
  }
  // 後台改了怪物設定（密度、比例）：之後生成的區塊用新設定；戰鬥中的不動
  function onSessionUpdate(w) {
    if (!w.creatures) return;
    const cfg = SfCreatures.parseMonsterCfg(w.session.resources && w.session.resources.monster), key = JSON.stringify(cfg);
    if (key !== w.monCfgKey) { w.monCfg = cfg; w.monCfgKey = key; w.creatures.clearMonsters(); }
  }
  // 野外資源密度改了（擋路的東西變了）：動物住處重新算
  function onWildChange(w) { if (w.creatures) { w.creatures.clearAnimals(); w.creatures.clearMonsters(); } }

  // ---- 角色數值 ----
  function initPlayer(p, level, exp) {
    p.level = Math.max(1, Math.min(C.maxLevel, Math.floor(Number(level) || 1)));
    p.exp = Math.max(0, Math.floor(Number(exp) || 0));
    p.maxHp = SfCreatures.maxHpOf(p.level);
    p.hp = p.maxHp;
    p.dead = false; p.lastHurt = 0; p.lastAttack = 0; p.expDirty = false;
  }
  const statsOf = (p) => ({ hp: Math.ceil(p.hp), maxHp: p.maxHp, level: p.level, exp: p.exp, need: SfCreatures.expNeed(p.level), dead: !!p.dead });
  const weaponOfPlayer = (p) => SfCreatures.weaponOf(p.held, p.held && SfResources.EQUIPMENT[p.held] ? SfResources.EQUIPMENT[p.held].cat : null);
  const playerByChar = () => { const m = new Map(); for (const p of players.values()) m.set(p.charId, p); return m; };
  const socketOf = (p) => nsp.sockets.get(p.socketId);
  // 玩家在不在隊伍領地裡（領地是安全區：怪物不會追進去）
  const inTerritory = (w, x, y) => territorySet(w).has(Math.floor(x / SfTerrain.CHUNK) + ',' + Math.floor(y / SfTerrain.CHUNK));

  function saveExp(p) {
    if (!p || !p.expDirty || !api.saveExp) return;
    p.expDirty = false;
    api.saveExp(p.charId, p.level, p.exp).then((r) => { if (!r.ok) { p.expDirty = true; console.warn('[starforge] 存經驗值失敗', r.error); } });
  }
  function addExp(p, amount) {
    const w = getWorld();
    const mult = (w && Number(w.session.expMultiplier)) || 1;
    const gained = Math.max(1, Math.round(amount * mult));
    p.exp += gained; p.expDirty = true;
    let up = false;
    while (p.level < C.maxLevel && p.exp >= SfCreatures.expNeed(p.level)) {
      p.exp -= SfCreatures.expNeed(p.level); p.level++; up = true;
    }
    if (p.level >= C.maxLevel) p.exp = Math.min(p.exp, SfCreatures.expNeed(p.level) - 1);
    const s = socketOf(p);
    if (s) s.emit('char-exp', { exp: p.exp, level: p.level, need: SfCreatures.expNeed(p.level), gained });
    if (up) {
      p.maxHp = SfCreatures.maxHpOf(p.level); p.hp = p.maxHp;      // 升級補滿血
      nsp.emit('char-level', { id: p.charId, level: p.level, hp: p.hp, maxHp: p.maxHp });
      sendChat({ channel: 'team', who: '系統', charId: null, teamId: p.teamId, text: '🎉 ' + p.name + ' 升到 Lv.' + p.level + ' 了！', isSystem: true, ts: Date.now() });
      saveExp(p);                                                     // 升級馬上存
    }
  }

  // ---- 生物進入戰鬥 ----
  function engage(w, a) {
    let m = w.mobs.get(a.id);
    if (m) return m;
    const now = Date.now();
    w.creatures.update(a, now);
    m = { id: a.id, a, def: a.def, hp: a.def.hp, maxHp: a.def.hp, x: a.x, y: a.y, dir: a.dir, moving: false, st: 'return',
          target: null, fleeFrom: null, until: 0, lastAtk: now, lastHit: 0, hitters: new Map(), stuck: 0, since: now };
    w.mobs.set(a.id, m);
    return m;
  }
  // 往 (tx, ty) 走 step 格；被擋住就試著偏 45° / 90° 繞過去
  function stepMob(w, m, tx, ty, step) {
    const dx = tx - m.x, dy = ty - m.y, d = Math.hypot(dx, dy);
    if (d < 1e-3) return false;
    const s = Math.min(step, d), base = Math.atan2(dy, dx);
    for (const off of [0, 0.785, -0.785, 1.571, -1.571]) {
      const nx = m.x + Math.cos(base + off) * s, ny = m.y + Math.sin(base + off) * s;
      if (!w.creatures.canStand(m.a, nx, ny)) continue;
      if (m.a.monster && !w.creatures.freeOf(nx, ny)) continue;        // 怪物不進隊伍領地
      if (Math.abs(nx - m.x) > 0.02) m.dir = nx > m.x ? 1 : -1;
      m.x = nx; m.y = ny;
      return true;
    }
    return false;
  }
  const chaseSpeed = (def) => Math.max(1.8, Math.min(5, def.speed * 1.5));
  const fleeSpeed = (def) => Math.max(2.2, Math.min(6, def.speed * 1.8));

  // 生物打玩家
  function hurtPlayer(w, p, dmg, m) {
    if (p.dead) return;
    p.hp = Math.max(0, p.hp - dmg); p.lastHurt = Date.now();
    nsp.emit('char-hp', { id: p.charId, hp: Math.ceil(p.hp), maxHp: p.maxHp, dmg, from: m ? m.id : null });
    if (p.hp > 0) return;
    // 倒下：停下來、所有追他的生物放棄；幾秒後在旗子旁滿血復活
    p.dead = true; p.tx = null; p.ty = null;
    nsp.emit('char-died', { id: p.charId });
    for (const o of w.mobs.values()) if (o.target === p.charId) { o.target = null; o.st = 'return'; }
    const charId = p.charId;
    setTimeout(() => {
      const q = Array.from(players.values()).find((x) => x.charId === charId);
      const ww = getWorld();
      if (!q || !ww || !q.dead) return;
      const team = ww.teams.get(q.teamId);
      let pos = null;
      if (team && team.flagX != null) pos = ww.terrain.findWalkable(team.flagX + 1.5, team.flagY + 1.5);
      if (!pos) pos = ww.terrain.findWalkable(q.x, q.y);
      q.x = pos.x; q.y = pos.y; q.tx = null; q.ty = null;
      q.hp = q.maxHp; q.dead = false; q.lastHurt = 0;
      nsp.emit('char-respawn', { id: q.charId, x: +q.x.toFixed(2), y: +q.y.toFixed(2), hp: q.hp, maxHp: q.maxHp });
    }, C.playerRespawnMs);
  }

  // 生物被打倒：經驗值給所有打過牠的人（30 秒內），掉落物品，原處消失
  function killMob(w, m, killer) {
    const now = Date.now();
    w.mobs.delete(m.id);
    const respawn = (m.def.respawn || (m.a.monster ? C.respawnMonster : C.respawnAnimal)) * 1000;
    w.dead.set(m.id, now + respawn);
    nsp.emit('mob-died', { id: m.id, x: +m.x.toFixed(2), y: +m.y.toFixed(2), until: now + respawn, by: killer ? killer.charId : null });
    const byChar = playerByChar();
    for (const [charId, t] of m.hitters) {
      if (now - t > 30000) continue;
      const p = byChar.get(charId);
      if (p && !p.dead) addExp(p, m.def.exp || 1);
    }
    for (const [item, lo, hi, chance] of (m.def.loot || [])) {
      if (!SfResources.ITEMS[item]) continue;
      if (chance != null && Math.random() > chance) continue;
      const qty = lo + Math.floor(Math.random() * (hi - lo + 1));
      if (qty > 0) dropAt(item, qty, m.x, m.y, killer ? killer.x : m.x, killer ? killer.y : m.y);
    }
  }

  // ---- 玩家攻擊 ----
  function bind(socket) {
    socket.on('attack', (data) => {
      const p = players.get(socket.id), w = getWorld();
      if (!p || !w || p.dead || !data || typeof data !== 'object') return;
      ensure(w);
      const id = String(data.id || '');
      if (!/^m?\d{1,4},\d{1,4}:\d{1,3}:\d{1,2}$/.test(id)) return;
      const now = Date.now(), wp = weaponOfPlayer(p);
      if (now - p.lastAttack < wp.cd - 80) return;                      // 太快就忽略（不回錯誤，避免洗訊息）
      if ((w.dead.get(id) || 0) > now) return socket.emit('attack-error', { error: '牠已經被打倒了', stop: true });
      let m = w.mobs.get(id), a = m ? m.a : w.creatures.byId(id);
      if (!a) return socket.emit('attack-error', { error: '找不到這隻生物', stop: true });
      let x, y;
      if (m) { x = m.x; y = m.y; } else { w.creatures.update(a, now); x = a.x; y = a.y; }
      // 距離：武器距離 + 0.9 的誤差（前端看到的位置跟伺服器可能差一點）
      if (Math.hypot(x - p.x, y - p.y) > wp.range + 0.9) return socket.emit('attack-error', { error: '離太遠了', far: true });
      p.lastAttack = now;
      if (!m) m = engage(w, a);
      const dmg = Math.max(1, Math.round(wp.dmg + (p.level - 1) + Math.random() * 2));
      m.hp = Math.max(0, m.hp - dmg);
      m.hitters.set(p.charId, now); m.lastHit = now;
      const dirOf = (dx, dy) => ((Math.round(Math.atan2(dx, dy) / (Math.PI / 4)) % 8) + 8) % 8;
      p.dir = dirOf(x - p.x, y - p.y);
      socket.broadcast.emit('char-attack', [p.charId, id, p.dir]);
      nsp.emit('mob-hit', { id, dmg, hp: Math.ceil(m.hp), maxHp: m.maxHp, by: p.charId });
      if (m.hp <= 0) return killMob(w, m, p);
      // 反應：怪物、猛獸追打打牠的人；草食動物逃跑
      if (m.def.act === 'flee' || !(m.def.atk > 0)) { m.st = 'flee'; m.fleeFrom = p.charId; m.until = now + C.fleeMs; }
      else { m.st = 'chase'; m.target = p.charId; }
    });
  }

  // ---- 模擬：戰鬥中的生物移動、攻擊；怪物發現玩家；玩家回血 ----
  let lastScan = 0;
  setInterval(() => {
    const w = getWorld();
    if (!w || players.size === 0) return;
    ensure(w);
    const now = Date.now(), dt = TICK_MS / 1000, byChar = playerByChar();
    // 重新出現時間到了
    for (const [id, until] of w.dead) if (until <= now) w.dead.delete(id);
    // 怪物發現附近的玩家（玩家在自己領地裡、倒下時不會被發現）
    if (now - lastScan >= AGGRO_SCAN_MS) {
      lastScan = now;
      for (const p of players.values()) {
        if (p.dead || inTerritory(w, p.x, p.y)) continue;
        const cx0 = Math.floor(p.x / SfTerrain.CHUNK), cy0 = Math.floor(p.y / SfTerrain.CHUNK), n = w.terrain.size / SfTerrain.CHUNK;
        for (let cy = cy0 - 1; cy <= cy0 + 1; cy++) for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) {
          if (cx < 0 || cy < 0 || cx >= n || cy >= n || territorySet(w).has(cx + ',' + cy)) continue;
          for (const a of w.creatures.monstersIn(cx, cy)) {
            if (w.mobs.has(a.id) || (w.dead.get(a.id) || 0) > now) continue;
            w.creatures.update(a, now);
            if (Math.hypot(a.x - p.x, a.y - p.y) > C.aggroRange) continue;
            const m = engage(w, a);
            m.st = 'chase'; m.target = p.charId;
          }
        }
      }
    }
    // 戰鬥中的生物
    const rows = [], gone = [];
    for (const m of w.mobs.values()) {
      const a = m.a, def = m.def;
      w.creatures.update(a, now);                                        // 漫遊位置（走回去的目標）
      const homeD = Math.hypot(m.x - a.x, m.y - a.y);
      let moved = false;
      if (m.st === 'chase') {
        const p = byChar.get(m.target);
        if (!p || p.dead || homeD > C.leash || inTerritory(w, p.x, p.y)) { m.st = 'return'; m.target = null; }
        else {
          const d = Math.hypot(p.x - m.x, p.y - m.y), reach = C.mobReach + (def.size ? def.size * 0.15 : 0.3);
          if (d > reach * 0.85) moved = stepMob(w, m, p.x, p.y, chaseSpeed(def) * dt);
          else if (Math.abs(p.x - m.x) > 0.05) m.dir = p.x > m.x ? 1 : -1;
          if (d <= reach && now - m.lastAtk >= C.mobAttackMs) {
            m.lastAtk = now;
            const dmg = Math.max(1, Math.round(def.atk * (0.85 + Math.random() * 0.3)));
            nsp.emit('mob-attack', { id: m.id, target: p.charId });
            hurtPlayer(w, p, dmg, m);
          }
        }
      } else if (m.st === 'flee') {
        const p = byChar.get(m.fleeFrom);
        if (!p || now > m.until || homeD > C.leash) m.st = 'return';
        else {
          const dx = m.x - p.x, dy = m.y - p.y, d = Math.hypot(dx, dy) || 1;
          moved = stepMob(w, m, m.x + dx / d * 3, m.y + dy / d * 3, fleeSpeed(def) * dt);
        }
      }
      if (m.st === 'return') {
        // 走回漫遊位置；到了（或卡住太久）就交還給漫遊，血量回滿
        if (homeD < 0.6 || m.stuck > 30) { gone.push(m.id); continue; }
        const before = homeD;
        moved = stepMob(w, m, a.x, a.y, Math.max(def.speed, 1.5) * 1.2 * dt);
        m.stuck = Math.hypot(m.x - a.x, m.y - a.y) < before - 0.01 ? 0 : m.stuck + 1;
        // 回去的路上慢慢回血（5 秒內被打過就不回）
        if (now - (m.lastHit || 0) > 5000) m.hp = Math.min(m.maxHp, m.hp + m.maxHp * 0.05 * dt);
      }
      m.moving = moved;
      rows.push([m.id, +m.x.toFixed(2), +m.y.toFixed(2), Math.ceil(m.hp), m.maxHp, m.dir, m.moving ? 1 : 0, m.st]);
    }
    gone.forEach((id) => w.mobs.delete(id));
    if (rows.length) nsp.emit('mobs', { t: now, rows });
    if (gone.length) nsp.emit('mob-gone', { ids: gone });
    // 玩家回血：一段時間沒被打，每秒回最大血量的 regenPerSec
    for (const p of players.values()) {
      if (p.dead || p.hp >= p.maxHp || now - p.lastHurt < C.regenDelayMs) continue;
      const before = Math.ceil(p.hp);
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp * C.regenPerSec * dt);
      if (Math.ceil(p.hp) !== before) nsp.emit('char-hp', { id: p.charId, hp: Math.ceil(p.hp), maxHp: p.maxHp, dmg: 0 });
    }
  }, TICK_MS);

  // 進場時給的資料：戰鬥中的生物、倒下還沒重新出現的生物
  function snapshot(w) {
    ensure(w);
    const now = Date.now();
    return {
      mobs: Array.from(w.mobs.values()).map((m) => [m.id, +m.x.toFixed(2), +m.y.toFixed(2), Math.ceil(m.hp), m.maxHp, m.dir, m.moving ? 1 : 0, m.st]),
      dead: Array.from(w.dead.entries()).filter(([, u]) => u > now)
    };
  }

  return { ensure, onSessionUpdate, onWildChange, initPlayer, statsOf, saveExp, bind, snapshot };
};
