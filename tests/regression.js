'use strict';
/**
 * 回归探针：空态与删除下载器的边界行为
 * 验证：默认空态不造假数据、删除后不回注、历史残留演示数据被清理
 */
const os = require('os');
const path = require('path');
const { Store } = require('../core/store');
const { Collector } = require('../core/collector');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}
function mkStore(tag) {
  const p = path.join(os.tmpdir(), `ttm-regress-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return new Store(p);
}

console.log('\n[1] 默认空态，绝不自动生成假数据');
{
  const store = mkStore('empty');
  const col = new Collector(store, () => {});
  ok('默认不是演示态', col.isDemo() === false);
  ok('默认没有下载器', store.listDownloaders().length === 0);
  ok('默认没有速率样本', store.data.samples.length === 0);
  ok('默认没有小时桶', Object.keys(store.data.hourly).length === 0);
  ok('displayDownloaders 返回空', store.displayDownloaders().length === 0);
  // 模拟采集器跑几轮：空列表不应凭空造出数据
  col.pollRate(); col.pollTraffic();
  setTimeout(() => {
    ok('轮询后依然没有下载器', store.listDownloaders().length === 0);
    ok('轮询后依然没有假样本', store.data.samples.length === 0);
  }, 50);
}

console.log('\n[2] 删除下载器后干净，不回注');
{
  const store = mkStore('del');
  const col = new Collector(store, () => {});
  const real = store.addDownloader({ name: '真实器', type: 'qb', url: 'http://127.0.0.1:8080' });
  ok('加真实器成功', store.listDownloaders().length === 1);
  ok('加真实器不是演示态', col.isDemo() === false);
  store.deleteDownloader(real.id);
  ok('删光后列表为空', store.listDownloaders().length === 0);
  ok('删光后仍非演示态', col.isDemo() === false);
  col.purgeDemoIfReal();
  ok('清理后依然为空（不回注）', store.listDownloaders().length === 0);
  ok('接管标记保持', store.data.demoOptedOut === true);
}

console.log('\n[3] 历史残留演示数据升级后自动清理');
{
  const store = mkStore('legacy');
  // 模拟老版本落盘的演示占位器与数据
  for (let id = 101; id <= 106; id++) {
    store.data.downloaders.push({ id, name: '老演示' + id, type: 'qb', demo: true, enabled: 1 });
    store.data.state[id] = { dl_rate: 999 };
    store.data.hourly[id] = { '123': { dl_bytes: 999 } };
  }
  const col = new Collector(store, () => {});
  col.purgeDemoIfReal();
  ok('演示占位器被清空', store.listDownloaders().length === 0, '实际 ' + store.listDownloaders().length);
  ok('演示状态被清空', Object.keys(store.data.state).length === 0);
  ok('演示小时桶被清空', Object.keys(store.data.hourly).length === 0);
}

console.log('\n[4] 定时器句柄可取消');
{
  const store = mkStore('timer');
  const col = new Collector(store, () => {});
  col.start();
  ok('start 后有 kickTimer 句柄', !!col.kickTimer);
  col.stop();
  ok('stop 后 kickTimer 清空', col.kickTimer === null);
  ok('stop 后 rateTimer 清空', col.rateTimer === null);
}

console.log('\n[5] 旧数据迁移（无 demoOptedOut 字段）');
{
  const store = mkStore('migrate');
  store.addDownloader({ name: '旧真实器', type: 'qb', url: 'http://127.0.0.1:8080' });
  delete store.data.demoOptedOut;
  store.save();
  store.load();
  ok('缺字段时默认 false', store.data.demoOptedOut === false);
  const col = new Collector(store, () => {});
  ok('仍有真实器且非演示态', store.listDownloaders().length === 1 && col.isDemo() === false);
}

// 等 [1] 的异步轮询落定
setTimeout(() => {
  console.log(`\n=== ${pass} PASS / ${fail} FAIL ===\n`);
  process.exit(fail ? 1 : 0);
}, 300);
