'use strict';
/* 站点识别 + PT 站点流量记账 的回归测试
   覆盖本次新增的两个模块最容易出错的地方：
     · 同一站点多个 tracker 域名必须归一（彩虹岛的三个域名 → 一行）
     · 未收录域名通过「同组 tracker 学习」自动归属
     · 交叉辅种（同组出现两个不同站）绝不能学习，否则把 A 站流量算到 B 站
     · 站点差分记账：首轮建基线、次轮才出增量、负增量不记账
     · 站点周期汇总按本地时区切日/周
   运行：node tests/sites.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sites = require('../core/sites');
const { Store } = require('../core/store');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

console.log('\n[1] tracker 域名 → 站点归一');
{
  const cases = [
    ['chdbits.xyz', '彩虹岛'],
    ['tracker.ptchdbits.co', '彩虹岛'],
    ['tracker.rainbowisland.co', '彩虹岛'],   // 用户实测：rainbowisland 就是彩虹岛
    ['tracker.m-team.cc', '馒头'],
    ['ourbits.club', '我堡'],
    ['tracker.hhanclub.net', '憨憨'],
    ['t.audiences.me', '观众'],
    ['tracker.totheglory.im', '套套哥'],
    ['on.springsunday.net', '春天'],
    ['tracker.pandapt.net', '熊猫'],
    ['tracker.piggo.me', '猪猪'],
    ['crabpt.vip', '蟹']
  ];
  for (const [url, want] of cases) {
    const got = sites.identify(url);
    ok(`${url} → ${want}`, got.name === want && got.known === true, got.name);
  }
  // 三个彩虹岛域名必须落到同一个 key，否则会被拆成三行
  const k1 = sites.identify('chdbits.xyz').key;
  const k2 = sites.identify('tracker.ptchdbits.co').key;
  const k3 = sites.identify('tracker.rainbowisland.co').key;
  ok('彩虹岛三域名同 key', k1 === k2 && k2 === k3, [k1, k2, k3]);
}

console.log('\n[2] 空/异常输入不炸');
{
  ok('空串 → 未知站点', sites.identify('').known === false);
  ok('null → 未知站点', sites.identify(null).known === false);
  ok('裸主机名可解析', sites.identify('tracker.m-team.cc').name === '馒头');
  ok('udp 协议可解析', sites.identify('udp://tracker.example.com:1337/announce').host === 'tracker.example.com');
  ok('带 passkey 的 URL 可解析', sites.identify('https://user:pass@tracker.m-team.cc/announce/x').name === '馒头');
}

console.log('\n[3] 同一站点多子域归并（未收录站也不能拆行）');
{
  const a = sites.identify('tracker2.foo.com');
  const b = sites.identify('tracker3.foo.com');
  ok('tracker2/3.foo.com 同 key', a.key === b.key, [a.key, b.key]);
  ok('展示名用主域', a.name === 'foo.com', a.name);
}

console.log('\n[4] 别名自学习');
{
  // 一个种子挂「已收录站 + 未知域名」→ 未知域名归到该站
  const learnedKey = sites.learnFromTorrent([
    'https://chdbits.xyz/announce/a',
    'https://tracker.brandnew-chd-mirror.net/announce/a'
  ]);
  ok('学习返回站点 key', learnedKey === 'chdbits', learnedKey);
  const got = sites.identify('tracker.brandnew-chd-mirror.net');
  ok('未知域名已归属彩虹岛', got.name === '彩虹岛' && got.known === true, got);
  ok('学习标记为 learned', got.learned === true);
}

console.log('\n[5] 交叉辅种不得学习（防串站）');
{
  // 同一个种子里同时有彩虹岛和馒头 → 语义不明确，必须放弃学习
  const k = sites.learnFromTorrent([
    'https://chdbits.xyz/announce/a',
    'https://tracker.m-team.cc/announce/a',
    'https://tracker.crosssite-unknown.net/announce/a'
  ]);
  ok('交叉辅种返回空（不学习）', k === '', k);
  const got = sites.identify('tracker.crosssite-unknown.net');
  ok('交叉域名仍为未收录', got.known === false, got.name);
}

console.log('\n[6] 站点差分记账：首轮建基线、次轮出增量');
{
  const p = path.join(os.tmpdir(), 'ttm-sites-1-' + Date.now() + '.json');
  const s = new Store(p);
  const t0 = Math.floor(Date.now() / 1000) - 120;

  // 首轮：只有基线，不应产生任何流量
  s.recordSiteTraffic(t0, {
    chdbits: { up: 1000, dl: 5000, name: '彩虹岛', full: 'CHDBits', host: 'chdbits.xyz', known: true }
  });
  ok('首轮今日上传为 0', s.siteTotals()[0].day.up === 0);
  ok('首轮 today 下载为 0', s.siteTotals()[0].day.dl === 0);
  ok('首轮已记录站点元信息', s.data.site_meta.chdbits && s.data.site_meta.chdbits.name === '彩虹岛');

  // 次轮：涨 100 上传 / 200 下载
  s.recordSiteTraffic(t0 + 60, {
    chdbits: { up: 1100, dl: 5200, name: '彩虹岛', full: 'CHDBits', host: 'chdbits.xyz', known: true }
  });
  const r = s.siteTotals()[0];
  ok('次轮上传增量 = 100', r.day.up === 100, r.day.up);
  ok('次轮下载增量 = 200', r.day.dl === 200, r.day.dl);
  ok('总计累加正确', r.all.up === 100 && r.all.dl === 200, r.all);

  // 三轮：计数器回退（换库/重新校验）→ 不记负值，但基线要跟进
  s.recordSiteTraffic(t0 + 120, {
    chdbits: { up: 50, dl: 5200, name: '彩虹岛', full: 'CHDBits', host: 'chdbits.xyz', known: true }
  });
  const r2 = s.siteTotals()[0];
  ok('回退不记负数', r2.day.up === 100, r2.day.up);
  ok('回退后基线已更新', s.data.site_base.chdbits.up === 50, s.data.site_base.chdbits);

  // 四轮：从新基线继续正常记账
  s.recordSiteTraffic(t0 + 180, {
    chdbits: { up: 150, dl: 5200, name: '彩虹岛', full: 'CHDBits', host: 'chdbits.xyz', known: true }
  });
  ok('回退后恢复记账', s.siteTotals()[0].day.up === 200, s.siteTotals()[0].day.up);
  try { fs.unlinkSync(p); } catch (e) { }
}

console.log('\n[7] 站点增量异常值拦截');
{
  const p = path.join(os.tmpdir(), 'ttm-sites-2-' + Date.now() + '.json');
  const s = new Store(p);
  const t = Math.floor(Date.now() / 1000) - 60;
  s.recordSiteTraffic(t, { x: { up: 0, dl: 0, name: 'X', known: true } });
  // 单轮跳 2PB：视作异常，不记账
  s.recordSiteTraffic(t + 60, { x: { up: Math.pow(2, 51), dl: 0, name: 'X', known: true } });
  ok('超大跳变被拦截', s.siteTotals()[0].all.up === 0, s.siteTotals()[0].all.up);
  try { fs.unlinkSync(p); } catch (e) { }
}

console.log('\n[8] 站点汇总不串站、按流量排序');
{
  const p = path.join(os.tmpdir(), 'ttm-sites-3-' + Date.now() + '.json');
  const s = new Store(p);
  const t = Math.floor(Date.now() / 1000) - 60;
  s.recordSiteTraffic(t, {
    a: { up: 0, dl: 0, name: 'A站', known: true },
    b: { up: 0, dl: 0, name: 'B站', known: true }
  });
  s.recordSiteTraffic(t + 60, {
    a: { up: 100, dl: 0, name: 'A站', known: true },   // 小站
    b: { up: 9000, dl: 5000, name: 'B站', known: true } // 大站
  });
  const rows = s.siteTotals();
  ok('两个站各自独立', rows.length === 2, rows.length);
  ok('按总流量降序', rows[0].name === 'B站' && rows[1].name === 'A站', rows.map(r => r.name));
  ok('B 站上传独立正确', rows[0].day.up === 9000, rows[0].day.up);
  ok('A 站上传独立正确', rows[1].day.up === 100, rows[1].day.up);
  try { fs.unlinkSync(p); } catch (e) { }
}

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===\n`);
process.exit(fail ? 1 : 0);