'use strict';
/**
 * 站点「累计」跨电脑一致性回归。
 *
 * 需求：用户在多台电脑上连同一个 qB（装在绿联 NAS 上），换电脑后站点累计
 * 不能归零。做法：累计取 qB 种子历史快照（存在服务端），日/周/月仍走本机差分。
 *
 * ⚠️ 绝对不能把这份快照拿去算今日增量 —— v1.0.4 就是这么把 695GB
 * 种子历史记成今日流量，虚高 69 倍。下面有专门断言守住这条线。
 */
const os = require('os');
const path = require('path');
const { Store } = require('../core/store');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}
function mkStore(tag) {
  const p = path.join(os.tmpdir(), `ttm-snap-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return new Store(p);
}
// 主进程 IPC 返回 {sites:[...]}，store 直接返回数组，两种都兼容
const byKey = (d, key) => (Array.isArray(d) ? d : (d.sites || [])).find(s => s.key === key);

console.log('\n=== [1] 无快照时退回本机账本（老用户不倒退） ===');
{
  const s = mkStore('legacy');
  s.addDownloader({ name: 'QB', type: 'qb', url: 'http://127.0.0.1:8080' });
  // 手动灌一笔本机观测增量
  s.recordSiteTrafficByTorrent(Math.floor(Date.now() / 1000), [
    { hash: 'h1', site: 'm-team', up: 1000, dl: 2000 }
  ], { 'm-team': { name: '馒头', known: true } });
  // 第二轮有真实增量
  s.recordSiteTrafficByTorrent(Math.floor(Date.now() / 1000) + 60, [
    { hash: 'h1', site: 'm-team', up: 1500, dl: 3000 }
  ], { 'm-team': { name: '馒头', known: true } });
  const row = byKey(s.siteTotals(), 'm-team');
  t('站点存在', !!row);
  // 首见种子只建基线不记账（v1.0.5 起），所以只有第二轮的 500/1000 入账
  t('累计回退到本机增量 500/1000', row && row.all.up === 500 && row.all.dl === 1000,
    row && JSON.stringify(row.all));
  t('标记为 local', row && row.all_from === 'local');
}

console.log('\n=== [2] 快照接入后累计取 qB 种子历史 ===');
let shared = null;
{
  const s = mkStore('machineA');
  s.addDownloader({ name: 'QB', type: 'qb', url: 'http://127.0.0.1:8080' });
  // qB 里该站种子已累计 700GB，其中绝大部分是本应用没观测过的辅种历史
  const history = 700 * 1024 * 1024 * 1024;
  const wrote = s.setSiteSnapshot(Math.floor(Date.now() / 1000), {
    'm-team': { up: history / 2, dl: history / 2 }
  });
  t('快照落盘', wrote === true);
  const row = byKey(s.siteTotals(), 'm-team');
  t('累计 = 种子历史总量', row && row.all.up + row.all.dl === history,
    row && String(row.all.up + row.all.dl));
  t('标记为 qb', row && row.all_from === 'qb');
  t('今日仍为 0（存量绝不进今日）', row && row.day.up === 0 && row.day.dl === 0,
    row && JSON.stringify(row.day));
  shared = s.snapshotFile;
}

console.log('\n=== [3] 换电脑：新账本 + 同一 qB 快照 → 累计恢复 ===');
{
  // 模拟另一台电脑：全新的主账本（无 hourly / 无 torrent_base），
  // 但连同一个 qB，因此能拿到同样的种子累计快照。
  const fresh = mkStore('machineB');
  t('新电脑主账本确实是空的', Object.keys(fresh.data.site_hourly).length === 0);

  const origin = JSON.parse(require('fs').readFileSync(shared, 'utf8'));
  fresh.setSiteSnapshot(origin.ts, origin.sites);
  const row = byKey(fresh.siteTotals(), 'm-team');
  t('换电脑后累计恢复', row && row.all.up + row.all.dl === 700 * 1024 * 1024 * 1024,
    row && String(row.all.up + row.all.dl));
  t('新电脑今日仍为 0', row && row.day.up === 0 && row.day.dl === 0);
}

console.log('\n=== [4] 重启：快照从独立文件读回，不依赖主账本 ===');
{
  const s = mkStore('reopen');
  const p = s.file;
  s.setSiteSnapshot(12345, { 'hdbits': { up: 999, dl: 888 } });
  const again = new Store(p);
  const row = byKey(again.siteTotals(), 'hdbits');
  t('重启后累计仍在', row && row.all.up === 999 && row.all.dl === 888,
    row && JSON.stringify(row.all));
  t('快照时间读回', again.siteSnapshot.ts === 12345);
}

console.log('\n=== [5] 快照值未变不写盘 ===');
{
  const s = mkStore('same');
  const p = { 'a': { up: 10, dl: 20 } };
  t('首次写入返回 true', s.setSiteSnapshot(1, p) === true);
  t('相同值返回 false', s.setSiteSnapshot(2, p) === false);
  t('时间戳仍被推进', s.siteSnapshot.ts === 2);
}

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===\n`);
process.exitCode = fail ? 1 : 0;
