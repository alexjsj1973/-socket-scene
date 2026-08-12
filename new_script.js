(function(){
  const HAIR_COLORS = ["#3b2a20","#8a5a34","#c99a4a","#d94f4f","#5c7a5e","#4a5b8a"];
  const BODY_COLORS = ["#b5623f","#e8b559","#5c7a5e","#4a5b8a","#8a5a8a","#3b2a20"];

  const scene = document.getElementById('scene');
  const charList = document.getElementById('charList');
  const chatLogEl = document.getElementById('chatLog');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const hint = document.getElementById('hint');
  const hairSwatches = document.getElementById('hairSwatches');
  const bodySwatches = document.getElementById('bodySwatches');
  const statusText = document.getElementById('statusText');
  const onlineCountEl = document.getElementById('onlineCount');

  const joinOverlay = document.getElementById('joinOverlay');
  const joinName = document.getElementById('joinName');
  const joinHairSwatches = document.getElementById('joinHairSwatches');
  const joinBodySwatches = document.getElementById('joinBodySwatches');
  const joinPreview = document.getElementById('joinPreview');
  const joinBtn = document.getElementById('joinBtn');
  const joinError = document.getElementById('joinError');

  // ---- Local mirror of server state ----
  let characters = {};   // id -> character object (server is source of truth)
  let myId = null;
  let charEls = {};      // id -> root <div class="char"> element, kept alive across moves

  let pendingHair = HAIR_COLORS[Math.floor(Math.random()*HAIR_COLORS.length)];
  let pendingBody = BODY_COLORS[Math.floor(Math.random()*BODY_COLORS.length)];

  function svgFor(hair, body){
    return `
    <svg class="body-svg" width="56" height="72" viewBox="0 0 56 72" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="28" cy="66" rx="15" ry="5" fill="rgba(43,36,32,0.15)"/>
      <path d="M14 40 Q14 26 28 26 Q42 26 42 40 L42 62 Q42 68 28 68 Q14 68 14 62 Z" fill="${body}" stroke="#2b2420" stroke-width="2"/>
      <circle cx="28" cy="16" r="13" fill="#f2d3ae" stroke="#2b2420" stroke-width="2"/>
      <path d="M15 14 Q15 2 28 2 Q41 2 41 14 Q41 8 34 8 Q30 3 24 8 Q18 6 15 14 Z" fill="${hair}" stroke="#2b2420" stroke-width="2"/>
      <circle cx="23" cy="17" r="1.6" fill="#2b2420"/>
      <circle cx="33" cy="17" r="1.6" fill="#2b2420"/>
      <path d="M24 22 Q28 25 32 22" stroke="#2b2420" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    </svg>`;
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  // ---------------------------------------------------------------
  // Join screen (選角色)
  // ---------------------------------------------------------------
  function buildJoinSwatches(){
    joinHairSwatches.innerHTML = '';
    HAIR_COLORS.forEach(col => {
      const sw = document.createElement('div');
      sw.className = 'swatch' + (col === pendingHair ? ' active' : '');
      sw.style.background = col;
      sw.addEventListener('click', () => { pendingHair = col; buildJoinSwatches(); renderJoinPreview(); });
      joinHairSwatches.appendChild(sw);
    });
    joinBodySwatches.innerHTML = '';
    BODY_COLORS.forEach(col => {
      const sw = document.createElement('div');
      sw.className = 'swatch' + (col === pendingBody ? ' active' : '');
      sw.style.background = col;
      sw.addEventListener('click', () => { pendingBody = col; buildJoinSwatches(); renderJoinPreview(); });
      joinBodySwatches.appendChild(sw);
    });
  }
  function renderJoinPreview(){
    joinPreview.innerHTML = svgFor(pendingHair, pendingBody);
  }
  buildJoinSwatches();
  renderJoinPreview();

  function doJoin(){
    const name = joinName.value.trim();
    if(!name){
      joinError.textContent = '請先輸入名字';
      joinName.focus();
      return;
    }
    joinBtn.disabled = true;
    joinError.textContent = '';
    socket.emit('join', { name, hair: pendingHair, body: pendingBody });
  }
  joinBtn.addEventListener('click', doJoin);
  joinName.addEventListener('keydown', e => { if(e.key === 'Enter') doJoin(); });

  // ---------------------------------------------------------------
  // Character rendering
  // ---------------------------------------------------------------
  function createCharElement(c){
    const el = document.createElement('div');
    el.className = 'char' + (c.id === myId ? ' self' : '');
    el.style.left = c.x + '%';
    el.style.top = c.y + '%';
    el.dataset.id = c.id;
    el.innerHTML = `
      <div class="name-tag">${escapeHtml(c.name)}${c.id === myId ? ' (你)' : ''}</div>
      <div class="bubble" id="bubble-${c.id}"></div>
      <div class="sprite" id="sprite-${c.id}">
        <div class="bob" id="bob-${c.id}">${svgFor(c.hair, c.body)}</div>
      </div>
    `;
    scene.appendChild(el);
    charEls[c.id] = el;
    return el;
  }

  function removeCharElement(id){
    const el = charEls[id];
    if(el){
      el.style.transition = 'opacity .35s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 360);
      delete charEls[id];
    }
  }

  function updateAppearance(c){
    const bob = document.getElementById('bob-' + c.id);
    if(bob) bob.innerHTML = svgFor(c.hair, c.body);
  }

  // Moves an existing character node to a new spot, timing the CSS
  // transition to the distance travelled so far walks feel fast and
  // near walks feel short, plus a little bob + turn-to-face polish.
  function moveCharacterTo(c, xPct, yPct){
    const el = charEls[c.id];
    if(!el) return;
    const rect = scene.getBoundingClientRect();
    const dxPx = ((xPct - c.x) / 100) * rect.width;
    const dyPx = ((yPct - c.y) / 100) * rect.height;
    const dist = Math.sqrt(dxPx * dxPx + dyPx * dyPx);
    const speed = 160; // px per second
    const duration = Math.min(2.5, Math.max(0.35, dist / speed));
    el.style.transitionDuration = duration.toFixed(2) + 's';

    const sprite = document.getElementById('sprite-' + c.id);
    if(sprite && Math.abs(dxPx) > 2){
      sprite.classList.toggle('face-left', dxPx < 0);
    }
    const bob = document.getElementById('bob-' + c.id);
    if(bob) bob.classList.add('walking');

    c.x = xPct;
    c.y = yPct;
    el.style.left = c.x + '%';
    el.style.top = c.y + '%';

    clearTimeout(el._walkTimer);
    el._walkTimer = setTimeout(() => {
      if(bob) bob.classList.remove('walking');
    }, duration * 1000);
  }

  function renderCharList(){
    charList.innerHTML = '';
    Object.values(characters)
      .sort((a,b) => (a.id === myId ? -1 : b.id === myId ? 1 : 0))
      .forEach(c => {
        const isSelf = c.id === myId;
        const row = document.createElement('div');
        row.className = 'char-row' + (isSelf ? ' self' : '');
        if(isSelf){
          row.innerHTML = `
            <div class="dot" style="background:${c.body}"></div>
            <input type="text" value="${escapeHtml(c.name)}" data-id="${c.id}">
            <span class="you-tag">你</span>
          `;
          const input = row.querySelector('input');
          input.addEventListener('change', () => {
            const name = input.value.trim() || '無名旅人';
            socket.emit('rename', { name });
          });
        } else {
          row.innerHTML = `
            <div class="dot" style="background:${c.body}"></div>
            <span>${escapeHtml(c.name)}</span>
          `;
        }
        charList.appendChild(row);
      });
  }

  function renderCustomizer(){
    const c = characters[myId];
    hairSwatches.innerHTML = '<div class="label">髮色</div>';
    bodySwatches.innerHTML = '<div class="label">衣服顏色</div>';
    if(!c) return;
    HAIR_COLORS.forEach(col => {
      const sw = document.createElement('div');
      sw.className = 'swatch' + (c.hair === col ? ' active' : '');
      sw.style.background = col;
      sw.addEventListener('click', () => {
        socket.emit('customize', { hair: col, body: c.body });
      });
      hairSwatches.appendChild(sw);
    });
    BODY_COLORS.forEach(col => {
      const sw = document.createElement('div');
      sw.className = 'swatch' + (c.body === col ? ' active' : '');
      sw.style.background = col;
      sw.addEventListener('click', () => {
        socket.emit('customize', { hair: c.hair, body: col });
      });
      bodySwatches.appendChild(sw);
    });
  }

  function addChatLine(who, text, isSystem){
    const row = document.createElement('div');
    row.className = 'row' + (isSystem ? ' sys' : '');
    const time = new Date().toLocaleTimeString('zh-TW', {hour:'2-digit', minute:'2-digit'});
    if(isSystem){
      row.textContent = text;
    } else {
      row.innerHTML = `<span class="who">${escapeHtml(who)}</span><span class="time">${time}</span>：${escapeHtml(text)}`;
    }
    chatLogEl.appendChild(row);
    chatLogEl.scrollTop = chatLogEl.scrollHeight;
  }

  function showBubble(id, text){
    const bubble = document.getElementById('bubble-' + id);
    if(!bubble) return;
    bubble.textContent = text;
    bubble.classList.add('show');
    clearTimeout(bubble._t);
    bubble._t = setTimeout(() => bubble.classList.remove('show'), 3200);
  }

  // ---------------------------------------------------------------
  // Scene click => move MY character only
  // ---------------------------------------------------------------
  scene.addEventListener('click', (e) => {
    if(!myId || !characters[myId]) return;
    const rect = scene.getBoundingClientRect();
    const xPct = ((e.clientX - rect.left) / rect.width) * 100;
    const yPct = ((e.clientY - rect.top) / rect.height) * 100;
    const targetX = Math.min(95, Math.max(5, xPct));
    const targetY = Math.min(92, Math.max(20, yPct));
    socket.emit('move', { x: targetX, y: targetY });
    hint.style.opacity = '0';
  });

  // ---------------------------------------------------------------
  // Chat send
  // ---------------------------------------------------------------
  function sendMessage(){
    const text = chatInput.value.trim();
    if(!myId || !text) return;
    socket.emit('chat', { text });
    chatInput.value = '';
  }
  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', e => { if(e.key === 'Enter') sendMessage(); });

  // ---------------------------------------------------------------
  // Wander (random move — my character only)
  // ---------------------------------------------------------------
  document.getElementById('wanderBtn').addEventListener('click', () => {
    if(!myId) return;
    const tx = Math.min(95, Math.max(5, 15 + Math.random()*70));
    const ty = Math.min(92, Math.max(20, 25 + Math.random()*55));
    socket.emit('move', { x: tx, y: ty });
  });

  // ---------------------------------------------------------------
  // Socket.io wiring
  // ---------------------------------------------------------------
  const socket = io();

  socket.on('connect', () => {
    statusText.textContent = '已連線到伺服器';
  });

  socket.on('disconnect', () => {
    statusText.textContent = '與伺服器斷線，正在嘗試重新連線…';
    onlineCountEl.textContent = '離線';
  });

  socket.on('init', (data) => {
    myId = data.selfId;
    characters = {};
    charEls = {};
    scene.querySelectorAll('.char').forEach(el => el.remove());

    data.characters.forEach(c => {
      characters[c.id] = c;
      createCharElement(c);
    });

    chatLogEl.innerHTML = '';
    data.chatLog.forEach(m => addChatLine(m.who, m.text, m.isSystem));

    joinOverlay.classList.add('hidden');
    renderCharList();
    renderCustomizer();
    chatInput.focus();
    statusText.textContent = '已加入場景';
  });

  socket.on('char-joined', (c) => {
    characters[c.id] = c;
    createCharElement(c);
    renderCharList();
  });

  socket.on('char-left', ({ id }) => {
    removeCharElement(id);
    delete characters[id];
    renderCharList();
  });

  socket.on('char-moved', ({ id, x, y }) => {
    const c = characters[id];
    if(!c) return;
    moveCharacterTo(c, x, y);
  });

  socket.on('char-customized', ({ id, hair, body }) => {
    const c = characters[id];
    if(!c) return;
    c.hair = hair; c.body = body;
    updateAppearance(c);
    renderCharList();
    if(id === myId) renderCustomizer();
  });

  socket.on('char-renamed', ({ id, name }) => {
    const c = characters[id];
    if(!c) return;
    c.name = name;
    const el = charEls[id];
    const tag = el && el.querySelector('.name-tag');
    if(tag) tag.textContent = name + (id === myId ? ' (你)' : '');
    renderCharList();
  });

  socket.on('char-bubble', ({ id, text }) => {
    showBubble(id, text);
  });

  socket.on('chat-message', (msg) => {
    addChatLine(msg.who, msg.text, msg.isSystem);
  });

  socket.on('online-count', (n) => {
    onlineCountEl.textContent = n + ' 人在線';
  });

  socket.on('connect_error', () => {
    statusText.textContent = '連線失敗，請確認伺服器已啟動 (node server.js)';
  });

  // Focus name field on load
  joinName.focus();
})();
