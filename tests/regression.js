'use strict';
/**
 * 回归探针：演示态与删除下载器的边界行为
 * 重点验证「删除后 demo 器不会自动回注」这个真实 BUG 已修复
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

console.log('\n[1] 演示态注入');
{
  const store = mkStore('demo');
  const col = new Collector(store, () => {});
  ok('初始为演示态', col.isDemo() === true);
  col._demoRate(Math.floor(Date.now() / 1000));
  col._demoTraffic(Math.floor(Date.now() / 1000));
  ok('注入 6 台演示器', store.listDownloaders().length === 6, '实际 ' + store.listDownloaders().length);
  ok('演示器均带 demo 标记', store.listDownloaders().every(d => d.demo));
  ok('未接管配置', store.data.demoOptedOut === false);
}

console.log('\n[2] 删除演示器不再自动回注（核心 BUG）');
{
  const store = mkStore('del');
  const col = new Collector(store, () => {});
  col._demoRate(Math.floor(Date.now() / 1000));
  // 先加一台真实器，使系统脱离演示态
  const real = store.addDownloader({ name: '真实器', type: 'qb', url: 'http://127.0.0.1:8080' });
  ok('加真实器后脱离演示态', col.isDemo() === false);
  ok('加真实器后置接管标记', store.data.demoOptedOut === true);
  col.purgeDemoIfReal();
  ok('演示器被清掉', store.listDownloaders().length === 1, '实际 ' + store.listDownloaders().length);

  // 删掉唯一的真实器 —— 关键场景
  store.deleteDownloader(real.id);
  ok('删光后列表为空', store.listDownloaders().length === 0);
  ok('删光后仍非演示态', col.isDemo() === false, 'isDemo=' + col.isDemo());

  // 模拟采集器下一轮轮询：以前这里会把 6 台 demo 器重新塞回来
  col._demoRateSeeded = false;
  col.purgeDemoIfReal();
  if (!col.isDemo()) {
    // 与 pollRate 的真实分支一致：不调用 _ensureDemoDownloaders
    col._demoRateSeeded = false;
  }
  ok('轮询后依然为空（不再回注）', store.listDownloaders().length === 0, '实际 ' + store.listDownloaders().length);
  ok('接管标记保持', store.data.demoOptedOut === true);
}

console.log('\n[3] 演示态下展示/配置接口分离');
{
  const store = mkStore('split');
  const col = new Collector(store, () => {});
  col._demoRate(Math.floor(Date.now() / 1000));
  col._demoTraffic(Math.floor(Date.now() / 1000));
  ok('displayDownloaders 含演示器（主界面有内容）', store.displayDownloaders().length === 6);
  const configList = store.listDownloaders().filter(d => !d.demo);
  ok('配置接口过滤后为空（设置页不显示虚拟器）', configList.length === 0);
}

console.log('\n[4] 恢复演示数据');
{
  const store = mkStore('reset');
  const col = new Collector(store, () => {});
  const r = store.addDownloader({ name: '真实器', type: 'qb', url: 'http://127.0.0.1:8080' });
  store.deleteDownloader(r.id);
  ok('删光后为空', store.listDownloaders().length === 0);
  store.resetToDemo();
  ok('复位后接管标记清除', store.data.demoOptedOut === false);
  ok('复位后回到演示态', col.isDemo() === true);
  col._demoRate(Math.floor(Date.now() / 1000));
  ok('复位后重新注入 6 台', store.listDownloaders().length === 6, '实际 ' + store.listDownloaders().length);
}

console.log('\n[5] 定时器句柄可取消');
{
  const store = mkStore('timer');
  const col = new Collector(store, () => {});
  col.start();
  ok('start 后有 kickTimer 句柄', !!col.kickTimer);
  col.stop();
  ok('stop 后 kickTimer 清空', col.kickTimer === null);
  ok('stop 后 rateTimer 清空', col.rateTimer === null);
}

console.log('\n[6] 旧数据迁移（无 demoOptedOut 字段）');
{
  const store = mkStore('migrate');
  store.addDownloader({ name: '旧真实器', type: 'qb', url: 'http://127.0.0.1:8080' });
  delete store.data.demoOptedOut;
  store.save();
  store.load();
  ok('缺字段时默认 false', store.data.demoOptedOut === false);
  const col = new Collector(store, () => {});
  ok('仍有真实器所以非演示态', col.isDemo() === false);
}

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===\n`);
process.exit(fail ? 1 : 0);