'use strict';
/** 测试辅助：构造带真实下载器与样本数据的 store（不依赖任何演示数据） */
const { Store } = require('../core/store');
const tu = require('../core/timeutil');

function makeFixture(filePath, opts = {}) {
  const store = new Store(filePath);
  const count = opts.count || 3;
  const ids = [];
  for (let i = 0; i < count; i++) {
    const d = store.addDownloader({
      name: '测试器' + (i + 1), type: i % 2 ? 'tr' : 'qb',
      url: 'http://127.0.0.1:' + (8080 + i),
      username: 'admin', password: 'test'
    });
    ids.push(d.id);
  }
  const now = Math.floor(Date.now() / 1000);
  // 速率样本：近 2 小时每 5s 一点 + 更早每 60s 一点
  for (let back = 7200; back > 0; back -= 5) {
    const ts = now - back;
    const per = {};
    ids.forEach((id, i) => {
      per[id] = {
        dl_rate: Math.round(2e6 + Math.sin(ts / 90 + i) * 1.5e6 + i * 3e5),
        up_rate: Math.round(3e5 + Math.cos(ts / 120 + i) * 2e5)
      };
    });
    store.addSample(ts, per);
  }
  for (let back = 86400; back > 7200; back -= 60) {
    const ts = now - back;
    const per = {};
    ids.forEach((id, i) => { per[id] = { dl_rate: 1.5e6 + i * 2e5, up_rate: 2e5 }; });
    store.addSample(ts, per);
  }
  // 小时流量桶：今天各小时 + 过去 40 天各一个点
  const dayStart = tu.dayStartTs(tu.dayKey(now));
  const curHour = tu.hourFloor(now);
  for (let h = dayStart; h <= curHour; h += 3600) {
    ids.forEach((id, i) => store.recordTraffic(id, h, 2e8 + i * 5e7, 3e7 + i * 1e7));
  }
  for (let back = 1; back <= 40; back++) {
    const dKey = tu.shiftDayKey(tu.dayKey(now), -back);
    const ts = tu.dayStartTs(dKey) + 12 * 3600;
    ids.forEach((id, i) => store.recordTraffic(id, ts, 4e9 + i * 1e9, 6e8));
  }
  store.flush();
  return { store, ids };
}

module.exports = { makeFixture };
