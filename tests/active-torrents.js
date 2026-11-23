'use strict';
/**
 * 「正在下载」列表口径回归：必须与 qB 的下载中数量一致。
 *
 * 事故：qB 的 stalledDL 被 qbState() 归一成 'stalled'，而采集器只收
 * 'downloading'，导致「有队列但暂时没速度」的种子全部漏掉。
 * 实测用户 qB 有 5 个下载中（2 个有速度 + 3 个 stalledDL），界面只显示 2 个。
 */
const os = require('os');
const path = require('path');
const assert = require('assert');
const { Store } = require('../core/store');
const { Collector } = require('../core/collector');
const clients = require('../core/clients');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

function mkStore(tag) {
  const p = path.join(os.tmpdir(), `ttm-active-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return new Store(p);
}
/** qB 原始 torrents/info 条目；只填与筛选/排序有关的字段 */
function qbTorrent(hash, state, progress, dlspeed) {
  return {
    hash, name: 'torrent-' + hash, state, progress, dlspeed, upspeed: 100,
    size: 1000, completed: Math.round(1000 * progress), downloaded: 1, uploaded: 1,
    tracker: '', eta: 0
  };
}

(async () => {
  console.log('\n=== 正在下载列表：状态筛选 ===');

  const store = mkStore('list');
  const dl = store.addDownloader({ name: 'QB', type: 'qb', url: 'http://127.0.0.1:8080' });
  const col = new Collector(store, () => {});

  // 用假客户端替换网络请求，走真实的 qbTorrent 归一化链路
  const realMakeClient = clients.makeClient;
  clients.makeClient = () => ({
    async torrents() {
      // 客户端的 torrents() 返回的是归一化后的结构，走真实 qbTorrent 转换
      const norm = (hash, state, progress, dlspeed) =>
        clients.qbTorrent(qbTorrent(hash, state, progress, dlspeed));
      return { list: [
        norm('a', 'downloading', 0.5, 1024),      // 有速度
        norm('b', 'downloading', 0.8, 512),
        norm('c', 'stalledDL', 0.3, 0),           // 无速度，必须保留
        norm('d', 'stalledDL', 0.9, 0),
        norm('e', 'stalledDL', 0.6, 0),
        norm('f', 'stalledUP', 1, 0),             // 做种，不应出现
        norm('g', 'pausedDL', 0.2, 0),            // 暂停，不应出现
        norm('h', 'stalledDL', 1, 0)              // 已完成，不应出现
      ] };
    }
  });

  try {
    await col.pollSites();
  } finally {
    clients.makeClient = realMakeClient;
  }

  const list = col.activeTorrents || [];
  const hashes = list.map(x => x.hash).sort();
  t('下载中 5 个全部保留（含 3 个 stalledDL）', hashes.join(',') === 'a,b,c,d,e', hashes.join(','));
  t('停滞种子标记为 stalled 而非 downloading',
    list.filter(x => x.state === 'stalled').length === 3);
  t('做种种子未混入', !hashes.includes('f'));
  t('暂停种子未混入', !hashes.includes('g'));
  t('已完成的 stalledDL 未混入', !hashes.includes('h'));
  t('按速率降序、同速率按进度降序',
    list.map(x => x.hash).join(',') === 'a,b,d,e,c',
    list.map(x => x.hash).join(','));

  console.log('\n=== 状态归一化 ===');
  t('qB stalledDL → stalled', clients.qbState('stalledDL') === 'stalled');
  t('qB stalledUP → seeding（不会误收为下载中）',
    clients.qbState('stalledUP') === 'seeding');

  console.log(`\n=== ${pass} 通过, ${fail} 失败 ===\n`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
