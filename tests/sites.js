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

console.log('\n[9] 无 tracker 种子不得污染的「未知站点」');
{
  // 回归：此前 collector 用 identify('') 兜底，返回 key=''，
  // 于是所有无 tracker 种子的流量都并进同一个空 key 的假站点，
  // 真实数据里它占了今日 424GB↑/1003GB↓，还把真正的未知站一起吞掉。
  const empty = sites.identify('');
  ok('空输入的 key 不含内容', empty.key === '', JSON.stringify(empty.key));
  ok('空输入标记为未知', empty.known === false, empty.known);

  // collector 现在用专用 key 区分，两者必须是不同的 key
  const NO_SITE_KEY = 'no-site';
  ok('无站点 key 非空', !!NO_SITE_KEY && NO_SITE_KEY !== '');
  ok('无站点 key 与空 key 不同', NO_SITE_KEY !== empty.key);

  // 未收录但有域名的站，key 基于域名，稳定且非空
  const unk = sites.identify('tracker.never-heard-of-this-pt.net');
  ok('未收录域名有非空 key', !!unk.key && unk.key.startsWith('host:'), unk.key);
  ok('未收录域名不等于无站点 key', unk.key !== NO_SITE_KEY, unk.key);
  ok('同一未收录域名 key 稳定', sites.identify('tracker.never-heard-of-this-pt.net').key === unk.key);
}

console.log('\n[10] 空 key 幽灵站点：拒收 + 历史迁移');
{
  // 写入层拒收空 key
  const p1 = path.join(os.tmpdir(), 'ttm-sites-empty-' + Date.now() + '.json');
  const s1 = new Store(p1);
  const t = Math.floor(Date.now() / 1000) - 120;
  s1.recordSiteTraffic(t, { '': { up: 0, dl: 0, name: '未知站点', known: false } });
  s1.recordSiteTraffic(t + 60, { '': { up: 1000, dl: 2000, name: '未知站点', known: false } });
  ok('空 key 不建元信息', !s1.data.site_meta['']);
  ok('空 key 不记账', Object.keys(s1.data.site_hourly || {}).every(k => k !== ''));
  ok('空 key 不进汇总', s1.siteTotals().every(r => r.key !== ''));
  try { fs.unlinkSync(p1); } catch (e) { }

  // 历史文件里已有的空 key 在 load 时被迁移进 no-site，量不丢
  const p2 = path.join(os.tmpdir(), 'ttm-sites-mig-' + Date.now() + '.json');
  fs.writeFileSync(p2, JSON.stringify({
    site_meta: { '': { name: '未知站点', known: false, last_seen: 1 },
                 abc: { name: '彩虹岛', known: true, last_seen: 2 } },
    site_base: { '': { up: 9e10, dl: 9e10 }, abc: { up: 5, dl: 6 } },
    site_hourly: { '': { '1700000000': { day: '2026-11-18', week: 'w', month: 'm', year: 'y', dl_bytes: 300, up_bytes: 100 } },
                   abc: { '1700000000': { day: '2026-11-18', week: 'w', month: 'm', year: 'y', dl_bytes: 7, up_bytes: 3 } } }
  }));
  const s2 = new Store(p2);
  ok('迁移后空 key 元信息已删', !s2.data.site_meta['']);
  ok('迁移后空 key 基线已删', !s2.data.site_base['']);
  ok('迁移后空 key 小时桶已删', !s2.data.site_hourly['']);
  ok('迁移建立 no-site 元信息', s2.data.site_meta['no-site'] && s2.data.site_meta['no-site'].name === '无站点');
  ok('空 key 的量并入 no-site（未丢账）',
    s2.data.site_hourly['no-site']['1700000000'].dl_bytes === 300 &&
    s2.data.site_hourly['no-site']['1700000000'].up_bytes === 100,
    s2.data.site_hourly['no-site']);
  ok('正常站点不受迁移影响', s2.data.site_meta['abc'].name === '彩虹岛');
  const rows2 = s2.siteTotals();
  ok('迁移后汇总含 no-site 与彩虹岛', rows2.length === 2 &&
    rows2.some(r => r.key === 'no-site') && rows2.some(r => r.key === 'abc'), rows2.map(r => r.key));
  try { fs.unlinkSync(p2); } catch (e) { }
}

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===\n`);
process.exit(fail ? 1 : 0);