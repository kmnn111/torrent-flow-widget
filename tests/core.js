'use strict';
/* 核心自检：脱离 Electron 验证统计口径 / 分桶 / 汇总 / 图表数据 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../core/store.js');
const { Collector } = require('../core/collector.js');
const chart = require('../core/chart.js');
const tu = require('../core/timeutil.js');
const clients = require('../core/clients.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS', name); }
  catch (e) { fail++; console.log('  FAIL', name, '-', e.message); }
}

console.log('\n[1] 差分算法 _increment');
t('正常增量', () => assert.deepStrictEqual(clients.increment(1100, 1000), { inc: 100, event: 'ok' }));
t('缺失计数器记 0', () => assert.strictEqual(clients.increment(null, 1000).inc, 0));
t('首次无基线记 0', () => assert.strictEqual(clients.increment(1000, null).event, 'no_base'));
t('回退(reset)记 0', () => assert.strictEqual(clients.increment(500, 1000).event, 'reset'));
t('异常跳变(spike)记 0', () => assert.strictEqual(clients.increment(Math.pow(2, 41), 1000).event, 'spike'));

console.log('\n[2] 时间分桶');
t('东八区日键', () => assert.strictEqual(tu.dayKey(1700000000), tu.dayKey(1700000000)));
t('周一为周起点', () => {
  // 2024-01-03 周三 → 周一 2024-01-01
  const ts = Math.floor(Date.UTC(2024, 0, 3, 12) / 1000) - 8 * 3600;
  assert.strictEqual(tu.weekKey(ts), '2024-01-01');
});
t('小时对齐', () => {
  const h = tu.hourFloor(1700000000);
  assert.strictEqual(h % 3600, 0);
});

console.log('\n[3] Store + 演示采集');
const tmp = path.join(os.tmpdir(), 'ttm-probe-' + Date.now() + '.json');
const store = new Store(tmp);
const collector = new Collector(store, () => {});
t('演示模式识别', () => assert.strictEqual(collector.isDemo(), true));
collector._demoRate(Math.floor(Date.now() / 1000));
collector._demoTraffic(Math.floor(Date.now() / 1000));
t('演示注入速率样本', () => assert.ok(store.data.samples.length > 0, 'samples empty'));
t('演示注入小时桶', () => {
  const total = Object.values(store.data.hourly).reduce((a, m) => a + Object.keys(m).length, 0);
  assert.ok(total > 0, 'hourly empty');
});

console.log('\n[4] 四周期汇总 / 历史 / 图表');
const ov = store.overview();
t('总览含四周期', () => {
  assert.ok(ov.total.day && ov.total.week && ov.total.month && ov.total.year && ov.total.all);
  assert.ok(ov.total.day.up > 0 || ov.total.day.dl > 0, 'today should have traffic');
});
t('今日 ≤ 本周 ≤ 本月 ≤ 本年 ≤ 全部(下载)', () => {
  const x = ov.total;
  assert.ok(x.day.dl <= x.week.dl && x.week.dl <= x.month.dl && x.month.dl <= x.year.dl && x.year.dl <= x.all.dl,
    JSON.stringify({ day: x.day.dl, week: x.week.dl, month: x.month.dl, year: x.year.dl, all: x.all.dl }));
});
for (const g of ['day', 'week', 'month', 'year']) {
  t('历史周期 ' + g, () => { const r = store.periodSeries(g); assert.ok(r.items.length >= 6 && r.items[0].key); });
}
t('速率图 live', () => {
  const d = chart.build(store, 'live', 'rate', 0);
  assert.strictEqual(d.series[0].id, 0);
  assert.ok(d.labels.length > 0 && d.series.length >= 1);
});
t('流量图 今日(按小时)', () => {
  const d = chart.build(store, '24h', 'traffic', 0);
  assert.strictEqual(d.bucket_count, 24);
  assert.ok(d.summary.down > 0);
});
t('流量图 本月(自然周期)', () => {
  const d = chart.build(store, 'month', 'traffic', 0);
  assert.ok(d.labels.length > 0 && d.series.length >= 1);
});
t('流量图 全部(自适应)', () => {
  const d = chart.build(store, 'all', 'traffic', 0);
  assert.ok(d.labels.length > 0 && d.summary.down > 0);
});
t('图表汇总 = 各下载器之和', () => {
  const d = chart.build(store, 'month', 'traffic', 0);
  const sum = d.series.slice(1).reduce((a, s) => a + s.down.reduce((x, y) => x + y, 0), 0);
  const head = d.series[0].down.reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - head) < 2, `head=${head} sum=${sum}`);
});

console.log('\n[5] 真实下载器差分记账');
const tmp2 = path.join(os.tmpdir(), 'ttm-probe2-' + Date.now() + '.json');
const s2 = new Store(tmp2);
const d1 = s2.addDownloader({ name: 'QB', type: 'qb', url: 'http://127.0.0.1:8080', username: 'a', password: 'b' });
s2.getState(d1.id).last_dl_total = 1000;
s2.getState(d1.id).last_up_total = 500;
s2.getState(d1.id).last_ts = Math.floor(Date.now() / 1000) - 60;
s2.recordTraffic(d1.id, Math.floor(Date.now() / 1000), 2048, 1024);
t('真实差分写入小时桶', () => {
  const ov2 = s2.overview();
  assert.ok(ov2.total.all.dl >= 2048 && ov2.total.all.up >= 1024, JSON.stringify(ov2.total.all));
});

try { fs.unlinkSync(tmp); } catch (e) { }
try { fs.unlinkSync(tmp2); } catch (e) { }
console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
