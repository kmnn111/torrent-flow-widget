'use strict';
/* 验证修复：种子归属抖动不得产生假流量。
   场景完全复刻真实事故：
     T1 冷启动，8 个天空种子还没有 tracker 缓存 → 归「无站点」
     T2 后台回填完成 → 同样 8 个种子改归「天空」
     T3/T4 tracker 字段抖动，来回切换归属
   旧口径（站点聚合差分）→ 每次都把种子历史累计当新流量记一遍
   新口径（种子 hash 差分）→ 只在种子真的涨了才记 */
const { Store } = require('../core/store');
const os = require('os'), path = require('path'), fs = require('fs');
const GB = v => (v / 1073741824).toFixed(2) + 'GB';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } };

const mk = () => {
  const f = path.join(os.tmpdir(), '.sitefix-' + Math.random().toString(36).slice(2) + '.json');
  return { s: new Store(f), f };
};
const T0 = Math.floor(new Date('2026-11-19T01:00:00Z').getTime() / 1000);

// 8 个天空种子，每个下载 86.9GB，累计 695.3GB
const HDSKY = [];
for (let i = 0; i < 8; i++) HDSKY.push({ hash: 'hs' + i, up: 326.7 * 1073741824 / 8, dl: 695.3 * 1073741824 / 8 });

console.log('=== [1] 归属抖动不得产生假流量 ===');
{
  const { s, f } = mk();
  // T1：冷启动，归 no-site（还没反查到 tracker）
  s.recordSiteTrafficByTorrent(T0, HDSKY.map(t => ({ hash: t.hash, site: 'no-site', up: t.up, dl: t.dl })), { 'no-site': { name: '无站点', known: true } });
  // T2：回填完成，改归 hdsky（种子累计值没变！）
  s.recordSiteTrafficByTorrent(T0 + 3600, HDSKY.map(t => ({ hash: t.hash, site: 'hdsky', up: t.up, dl: t.dl })), { hdsky: { name: '天空', known: true } });
  const h = s.data.site_hourly.hdsky || {};
  const tot = Object.values(h).reduce((a, x) => a + (x.dl_bytes || 0), 0);
  ok(tot === 0, '归属从 no-site 切到 hdsky 不应记账，实际记了 ' + GB(tot));
  ok(s.data.site_meta.hdsky && s.data.site_meta.hdsky.name === '天空', '站点元信息应正常写入');

  // T3：抖回 no-site
  s.recordSiteTrafficByTorrent(T0 + 7200, HDSKY.map(t => ({ hash: t.hash, site: 'no-site', up: t.up, dl: t.dl })), null);
  // T4：再抖回 hdsky
  s.recordSiteTrafficByTorrent(T0 + 10800, HDSKY.map(t => ({ hash: t.hash, site: 'hdsky', up: t.up, dl: t.dl })), null);
  const h2 = s.data.site_hourly.hdsky || {};
  const tot2 = Object.values(h2).reduce((a, x) => a + (x.dl_bytes || 0), 0);
  ok(tot2 === 0, '反复抖动 4 轮仍不得记账，实际 ' + GB(tot2));
  try { fs.unlinkSync(f); } catch (e) { }
}

console.log('\n=== [2] 真实增长必须照常记到正确站点 ===');
{
  const { s, f } = mk();
  s.recordSiteTrafficByTorrent(T0, HDSKY.map(t => ({ hash: t.hash, site: 'hdsky', up: t.up, dl: t.dl })), { hdsky: { name: '天空', known: true } });
  // 其中 2 个种子各多下了 10GB
  const G = 10 * 1073741824;
  const grown = HDSKY.map((t, i) => ({ hash: t.hash, site: 'hdsky', up: t.up, dl: t.dl + (i < 2 ? G : 0) }));
  s.recordSiteTrafficByTorrent(T0 + 1800, grown, null);
  const h = s.data.site_hourly.hdsky || {};
  const tot = Object.values(h).reduce((a, x) => a + (x.dl_bytes || 0), 0);
  ok(Math.abs(tot - 2 * G) < 1024, '应记 20GB，实际 ' + GB(tot));

  // 归属变化 + 真实增长：增长要记到「新归属」的站
  const moved = grown.map(t => Object.assign({}, t, { site: 'ourbits', dl: t.dl + G }));
  s.recordSiteTrafficByTorrent(T0 + 3600, moved, { ourbits: { name: '我堡', known: true } });
  const ob = s.data.site_hourly.ourbits || {};
  const obTot = Object.values(ob).reduce((a, x) => a + (x.dl_bytes || 0), 0);
  ok(Math.abs(obTot - 8 * G) < 1024, '切换归属后的新增应记到新站（8×10GB），实际 ' + GB(obTot));
  try { fs.unlinkSync(f); } catch (e) { }
}

console.log('\n=== [3] 种子被删后重新添加：不得重复记账 ===');
{
  const { s, f } = mk();
  s.recordSiteTrafficByTorrent(T0, [{ hash: 'x1', site: 'hdsky', up: 0, dl: 600 * 1073741824 }], { hdsky: { name: '天空', known: true } });
  // 种子被删（本轮不出现）
  s.recordSiteTrafficByTorrent(T0 + 3600, [{ hash: 'other', site: 'mteam', up: 0, dl: 0 }], { mteam: { name: '馒头', known: true } });
  // 重新添加同一个 hash，累计从 0 变回 600GB 附近
  s.recordSiteTrafficByTorrent(T0 + 7200, [{ hash: 'x1', site: 'hdsky', up: 0, dl: 600 * 1073741824 }], null);
  const h = s.data.site_hourly.hdsky || {};
  const tot = Object.values(h).reduce((a, x) => a + (x.dl_bytes || 0), 0);
  ok(tot === 0, '重新添加种子不得重复记账，实际 ' + GB(tot));
  try { fs.unlinkSync(f); } catch (e) { }
}

console.log('\n=== [4] 重新校验（计数归零）不得产生负流量 ===');
{
  const { s, f } = mk();
  s.recordSiteTrafficByTorrent(T0, [{ hash: 'r1', site: 'hdsky', up: 100 * 1073741824, dl: 500 * 1073741824 }], { hdsky: { name: '天空', known: true } });
  // 重新校验后计数变小
  s.recordSiteTrafficByTorrent(T0 + 1800, [{ hash: 'r1', site: 'hdsky', up: 0, dl: 0 }], null);
  const h = s.data.site_hourly.hdsky || {};
  const totDl = Object.values(h).reduce((a, x) => a + (x.dl_bytes || 0), 0);
  ok(totDl === 0, '归零不得产生流量，实际 ' + GB(totDl));
  ok(s.data.torrent_base.r1.dl === 0, '基线应重建为 0');
  // 之后正常增长要能记
  s.recordSiteTrafficByTorrent(T0 + 3600, [{ hash: 'r1', site: 'hdsky', up: 0, dl: 5 * 1073741824 }], null);
  const tot2 = Object.values(s.data.site_hourly.hdsky || {}).reduce((a, x) => a + (x.dl_bytes || 0), 0);
  ok(Math.abs(tot2 - 5 * 1073741824) < 1024, '归零后应恢复正常记账（5GB），实际 ' + GB(tot2));
  try { fs.unlinkSync(f); } catch (e) { }
}

console.log('\n=== [5] 跨整点分摊 ===');
{
  const { s, f } = mk();
  s.recordSiteTrafficByTorrent(T0, [{ hash: 'c1', site: 'hdsky', up: 0, dl: 0 }], { hdsky: { name: '天空', known: true } });
  // 从 01:00 跨到 03:05（75 分钟），记 100GB
  s.recordSiteTrafficByTorrent(T0 + 75 * 60, [{ hash: 'c1', site: 'hdsky', up: 0, dl: 100 * 1073741824 }], null);
  const h = s.data.site_hourly.hdsky || {};
  const tot = Object.values(h).reduce((a, x) => a + (x.dl_bytes || 0), 0);
  ok(Math.abs(tot - 100 * 1073741824) < 4096, '跨整点总量应守恒 100GB，实际 ' + GB(tot));
  ok(Object.keys(h).length >= 2, '应拆到多个小时桶，实际桶数 ' + Object.keys(h).length);
  try { fs.unlinkSync(f); } catch (e) { }
}

console.log('\n=== [6] 单轮超限保护 ===');
{
  const { s, f } = mk();
  s.recordSiteTrafficByTorrent(T0, [{ hash: 'b1', site: 'hdsky', up: 0, dl: 0 }], { hdsky: { name: '天空', known: true } });
  s.recordSiteTrafficByTorrent(T0 + 60, [{ hash: 'b1', site: 'hdsky', up: 0, dl: 2 * Math.pow(1024, 4) }], null);
  const tot = Object.values(s.data.site_hourly.hdsky || {}).reduce((a, x) => a + (x.dl_bytes || 0), 0);
  ok(tot === 0, '单种子单轮涨 2TB 应被拦截，实际 ' + GB(tot));
  try { fs.unlinkSync(f); } catch (e) { }
}

console.log('\n=== [7] tracker 缓存持久化 ===');
{
  const { s, f } = mk();
  s.setTrackerCache({ abc123: ['https://tracker.hdsky.me/announce'] });
  const back = s.getTrackerCache();
  ok(back && back.abc123 && back.abc123.length === 1, '缓存应能读回');
  // 空数组不应被缓存（下次要重试）
  s.setTrackerCache({ xyz: [], abc123: ['https://a.b/c'] });
  const back2 = s.getTrackerCache();
  ok(!back2.xyz, '空 tracker 列表不应写入缓存');
  ok(back2.abc123, '有效条目应保留');
  try { fs.unlinkSync(f); } catch (e) { }
}

console.log('\n' + '─'.repeat(50));
console.log(pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);