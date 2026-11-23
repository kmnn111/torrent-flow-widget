'use strict';
/**
 * HTTP 请求体回归：登录必须是定长请求，绝不能用 chunked。
 *
 * 事故：request() 把字符串直接交给 req.write()，Node 自动加
 * transfer-encoding: chunked。qBittorrent 的 /api/v2/auth/login 不解析 chunked，
 * 把块长度（如 "20"）当成 HTTP 头解析，收到空用户名 → 记一次失败登录。
 * 应用每 5 秒登录一次，连续 5 次后 qB 把 IP 封进内存黑名单，
 * 之后即使密码正确也只显示「用户名或密码错误」。
 */
const http = require('http');
const { QBClient } = require('../core/clients');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

(async () => {
  console.log('\n=== qB 登录请求体 ===');
  let seen = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen = {
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      };
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Set-Cookie': 'SID=fake-sid; Path=/' });
      res.end('Ok.');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const c = new QBClient({ url: `http://127.0.0.1:${port}`, username: 'admin', password: 'p@ss word&' }, 3000);
    await c.login();

    t('收到登录请求', !!seen && seen.method === 'POST');
    t('带 Content-Length', !!seen && !!seen.headers['content-length'],
      seen && JSON.stringify(seen.headers));
    t('不带 transfer-encoding: chunked',
      !!seen && !String(seen.headers['transfer-encoding'] || '').toLowerCase().includes('chunked'),
      seen && String(seen.headers['transfer-encoding']));
    const expected = new URLSearchParams({ username: 'admin', password: 'p@ss word&' }).toString();
    t('body 完整送达（含特殊字符转义）', !!seen && seen.body === expected,
      seen && seen.body);
    t('Content-Length 与 body 字节数一致',
      !!seen && Number(seen.headers['content-length']) === Buffer.byteLength(seen.body),
      seen && `${seen.headers['content-length']} vs ${Buffer.byteLength(seen.body)}`);
    t('登录成功拿到 SID', c.cookie.indexOf('SID=fake-sid') >= 0, c.cookie);
  } finally {
    await new Promise(r => server.close(r));
  }

  console.log(`\n=== ${pass} 通过, ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
