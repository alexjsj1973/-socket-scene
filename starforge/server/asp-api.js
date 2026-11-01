// ============================================================
// asp-api.js - 呼叫 ASP 主機上的 starforge/game_api.asp（server-to-server）
// 讀取用 GET、寫入用 POST（application/x-www-form-urlencoded），一律帶 key。
// 回傳 Promise<{ ok, ... }>；連線失敗或格式錯誤也回 { ok:false, error }，不會丟例外。
// ============================================================
const https = require('https');
const http = require('http');
const { URL } = require('url');

module.exports = function createAspApi(baseUrl, apiKey) {
  function request(method, params) {
    return new Promise((resolve) => {
      const q = new URLSearchParams(Object.assign({ key: apiKey }, params)).toString();
      const u = new URL(method === 'GET' ? baseUrl + (baseUrl.includes('?') ? '&' : '?') + q : baseUrl);
      const lib = u.protocol === 'http:' ? http : https;
      const opts = { method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, timeout: 15000, headers: {} };
      if (method === 'POST') {
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.headers['Content-Length'] = Buffer.byteLength(q);
      }
      const req = lib.request(opts, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { resolve({ ok: false, error: 'game_api.asp 回傳格式錯誤（HTTP ' + res.statusCode + '）' }); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('逾時')));
      req.on('error', (err) => resolve({ ok: false, error: '無法連線到 game_api.asp：' + err.message }));
      if (method === 'POST') req.write(q);
      req.end();
    });
  }
  return {
    world: () => request('GET', { act: 'world' }),
    player: (memberId) => request('GET', { act: 'player', memberId }),
    nodes: () => request('GET', { act: 'nodes' }),
    plant: (teamId, charId, x, y) => request('POST', { act: 'plant', teamId, charId, x: x.toFixed(2), y: y.toFixed(2) }),
    savePos: (charId, x, y) => request('POST', { act: 'savepos', charId, x: x.toFixed(2), y: y.toFixed(2) }),
    // inventory = { wood: 12, stone: 3 }
    saveInv: (charId, inventory) => request('POST', { act: 'saveinv', charId,
      items: Object.keys(inventory).filter((k) => inventory[k] > 0).map((k) => k + ':' + inventory[k]).join(',') }),
    // list = [[id, amount, changedMs], ...]
    saveNodes: (list) => request('POST', { act: 'savenodes', nodes: list.map((n) => n.join(':')).join(';') })
  };
};
