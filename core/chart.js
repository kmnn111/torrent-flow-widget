'use strict';
/**
 * 图表数据构建 — 移植自原项目 chart.py 的核心
 * 输出喂给 charts.js 的结构：{range,metric,labels,times,series[],summary,offset,max_offset,...}
 * 支持实时速率（rate）与流量统计（traffic）两类。
 */
const tu = require('./timeutil');

// 12 档范围 → 跨度定义（秒 / 自然周期）
const RANGES = {
  live:     { label: '实时', metric: 'rate', span: null },
  '1h':     { label: '近 1 小时', metric: 'rate', span: 3600 },
  '6h':     { label: '近 6 小时', metric: 'rate', span: 21600 },
  '12h':    { label: '近 12 小时', metric: 'rate', span: 43200 },
  rate24:   { label: '近 24 小时', metric: 'rate', span: 86400 },
  '24h':    { label: '今日', metric: 'traffic', gran: 'day' },
  yesterday:{ label: '昨日', metric: 'traffic', gran: 'day', shift: -1 },
  week:     { label: '本周', metric: 'traffic', gran: 'week' },
  lastweek: { label: '上周', metric: 'traffic', gran: 'week', shift: -1 },
  month:    { label: '本月', metric: 'traffic', gran: 'month' },
  lastmonth:{ label: '上月', metric: 'traffic', gran: 'month', shift: -1 },
  year:     { label: '本年', metric: 'traffic', gran: 'year' },
  all:      { label: '全部', metric: 'traffic', gran: 'all' }
};
const RATE_RANGES = ['live', '1h', '6h', '12h', 'rate24'];
const TRAFFIC_RANGES = ['24h', 'yesterday', 'week', 'lastweek', 'month', 'lastmonth', 'year', 'all'];

const fmtClock = ts => {
  const d = tu.wallDate(ts);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
/** 带秒的时分秒：bucket 步长 < 60s 时必须用它，否则同一分钟内十来个桶全叫 "15:36"，横轴会重复 */
const fmtClockSec = ts => {
  const d = tu.wallDate(ts);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
};
const fmtDayClock = ts => {
  const d = tu.wallDate(ts);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
};
const fmtDay = ts => {
  const d = tu.wallDate(ts);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

/** 实时速率：从 samples 按桶取 AVG */
function buildRate(store, rangeKey, offset, downloaders) {
  const cfg = RANGES[rangeKey] || RANGES.live;
  const now = Math.floor(Date.now() / 1000);
  const liveSpan = store.data.settings.live_span || 300;
  let span = cfg.span || liveSpan;
  const targetPoints = 60;
  const step = Math.max(1, Math.round(span / targetPoints));
  span = step * targetPoints;
  const maxOffset = 30 * targetPoints;
  offset = Math.max(0, Math.min(maxOffset, Number(offset) || 0));
  const end = now - offset * step;
  const start = end - span;
  // 窗口右端含当前时刻：最新采样点的 ts 通常等于 now，若用 [start,end) 会把它永远排除，导致最新数据画不出来
  const endInclusive = end + 1;

  // 跨度跨天（≥24h）时横轴带日期；步长 < 60s 时带秒，避免同一分钟标签重复
  const fLabel = span >= 86400 ? fmtDayClock : (step < 60 ? fmtClockSec : fmtClock);
  const buckets = [];
  for (let t = start; t < end; t += step) buckets.push({ ts: t, label: fLabel(t) });
  const series = [{ id: 0, name: '汇总', color_up: '#e8912c', color_down: '#6bb5dd', up: new Array(buckets.length).fill(null), down: new Array(buckets.length).fill(null) }];
  const index = new Map(buckets.map((b, i) => [b.ts, i]));
  const acc = new Map(); // did → {up:[sum,count], down:[sum,count]}

  for (const s of store.data.samples) {
    if (s.ts < start || s.ts >= endInclusive) continue;
    let b = Math.floor((s.ts - start) / step) * step + start;
    if (b >= end) b = end - step;   // 落在最右端的点归入最后一桶
    let i = index.get(b);
    if (i == null) continue;
    for (const did in s.downloaders) {
      const v = s.downloaders[did];
      if (!acc.has(did)) acc.set(did, { up: Array.from({ length: buckets.length }, () => [0, 0]), down: Array.from({ length: buckets.length }, () => [0, 0]) });
      const a = acc.get(did);
      a.down[i][0] += v.dl_rate || 0; a.down[i][1]++;
      a.up[i][0] += v.up_rate || 0; a.up[i][1]++;
    }
  }
  for (const d of downloaders) {
    const s = { id: d.id, name: d.name, color_up: d.color_up, color_down: d.color_down, up: new Array(buckets.length).fill(null), down: new Array(buckets.length).fill(null) };
    // 注意：acc 的键来自对象遍历，是字符串；下载器 id 是数字，必须统一成字符串再查
    const a = acc.get(String(d.id));
    if (a) {
      for (let i = 0; i < buckets.length; i++) {
        if (a.down[i][1]) s.down[i] = +(a.down[i][0] / a.down[i][1]).toFixed(2);
        if (a.up[i][1]) s.up[i] = +(a.up[i][0] / a.up[i][1]).toFixed(2);
      }
    }
    series.push(s);
  }
  // 汇总 = 各下载器逐点求和（缺口跳过）
  for (let i = 0; i < buckets.length; i++) {
    let up = 0, down = 0, any = false;
    for (let k = 1; k < series.length; k++) {
      if (series[k].up[i] != null) { up += series[k].up[i]; any = true; }
      if (series[k].down[i] != null) { down += series[k].down[i]; any = true; }
    }
    if (any) { series[0].up[i] = +up.toFixed(2); series[0].down[i] = +down.toFixed(2); }
  }
  const peak = { up: 0, down: 0 };
  series[0].up.forEach(v => { if (v > peak.up) peak.up = v; });
  series[0].down.forEach(v => { if (v > peak.down) peak.down = v; });
  return {
    ok: true, range: rangeKey, metric: 'rate',
    labels: buckets.map(b => b.label), times: buckets.map(b => b.ts),
    spans: buckets.map((b, i) => [b.ts, i < buckets.length - 1 ? buckets[i + 1].ts : end]),
    series, summary: peak, offset, max_offset: maxOffset, bucket_count: buckets.length,
    at_latest: offset === 0,
    window: { start, end, label: `${span >= 86400 ? fmtDayClock(start) : fmtClock(start)} ~ ${fmtClock(end)}`,
      // 折线图首尾刻度用窗口真实起止（与左上角范围标签逐字一致），而不是首末桶的入桶时刻
      edges: { start: span >= 86400 ? fmtDayClock(start) : fmtClock(start), end: fmtClock(end) } },
    downloaders: downloaders.map(d => ({ id: d.id, name: d.name, color_up: d.color_up, color_down: d.color_down }))
  };
}

/** 决定 "全部" 视图的聚合粒度：跨度越长大，粒度越粗（目标 ~24-60 个柱） */
function pickAllGran(store, downloaders) {
  let minTs = Infinity, maxTs = 0;
  for (const d of downloaders) {
    const hs = store.data.hourly[d.id] || {};
    for (const k in hs) {
      const t = Number(k);
      if (t < minTs) minTs = t;
      if (t > maxTs) maxTs = t;
    }
  }
  if (!Number.isFinite(minTs)) return 'day';
  const days = Math.max(1, (maxTs - minTs) / 86400);
  if (days > 24 * 20) return 'year';   // 跨度超 20 个月 → 按年
  if (days > 30) return 'month';        // 超 30 天 → 按月
  return 'day';
}

/** "全部"：从最早数据到当前，按自适应粒度铺满整条时间轴（含空桶补零） */
function buildAllTraffic(store, rangeKey, downloaders) {
  const gran = pickAllGran(store, downloaders);
  const g = tu.GRAN[gran];
  const now = Math.floor(Date.now() / 1000);
  let minTs = Infinity, maxTs = 0;
  for (const d of downloaders) {
    const hs = store.data.hourly[d.id] || {};
    for (const k in hs) { const t = Number(k); if (t < minTs) minTs = t; if (t > maxTs) maxTs = t; }
  }
  if (!Number.isFinite(minTs)) minTs = now;
  if (!maxTs) maxTs = now;
  let startKey = g.key(minTs);
  const endKey = g.key(maxTs);
  // 收集键序列（上限 400，防极端数据把界面撑爆）
  const keys = [];
  let k = startKey, guard = 0;
  while (guard++ < 400) {
    keys.push(k);
    if (k === endKey) break;
    const next = g.shift(k, 1);
    if (next === k) break;
    k = next;
  }
  const keyIndex = new Map(keys.map((kk, i) => [kk, i]));
  const series = [{ id: 0, name: '汇总', color_up: '#e8912c', color_down: '#6bb5dd', up: new Array(keys.length).fill(0), down: new Array(keys.length).fill(0) }];
  const perDid = new Map();
  for (const d of downloaders) perDid.set(d.id, { up: new Array(keys.length).fill(0), down: new Array(keys.length).fill(0) });
  for (const d of downloaders) {
    const hs = store.data.hourly[d.id] || {};
    for (const h in hs) {
      const b = hs[h];
      const i = keyIndex.get(b[gran]);
      if (i == null) continue;
      const p = perDid.get(d.id);
      p.down[i] += b.dl_bytes; p.up[i] += b.up_bytes;
    }
  }
  for (const d of downloaders) {
    const p = perDid.get(d.id);
    series.push({ id: d.id, name: d.name, color_up: d.color_up, color_down: d.color_down, up: p.up.slice(), down: p.down.slice() });
  }
  for (let i = 0; i < keys.length; i++) {
    let up = 0, down = 0;
    for (let s = 1; s < series.length; s++) { up += series[s].up[i]; down += series[s].down[i]; }
    series[0].up[i] = up; series[0].down[i] = down;
  }
  const labels = keys.map(kk => tu.labelFor(gran, kk));
  const spans = keys.map(kk => [g.start(kk), g.start(g.shift(kk, 1))]);
  const sum = { up: series[0].up.reduce((a, b) => a + b, 0), down: series[0].down.reduce((a, b) => a + b, 0) };
  return {
    ok: true, range: rangeKey, metric: 'traffic', gran,
    labels, times: spans.map(s => s[0]), spans,
    series, summary: sum, offset: 0, max_offset: 0, bucket_count: keys.length, at_latest: true,
    window: { start: spans[0][0], end: spans[spans.length - 1][1], label: `${labels[0]} ~ ${labels[labels.length - 1]}` },
    downloaders: downloaders.map(d => ({ id: d.id, name: d.name, color_up: d.color_up, color_down: d.color_down }))
  };
}

/** 自然周期流量：按 day/week/month/year 聚合 hourly，按下载器分段 */
function buildTrafficNatural(store, rangeKey, offset, downloaders) {
  const cfg = RANGES[rangeKey] || RANGES['24h'];
  const gran = cfg.gran || 'day';
  const g = tu.GRAN[gran] || tu.GRAN.day;
  const now = Math.floor(Date.now() / 1000);
  let curKey = g.key(now);
  if (cfg.shift) curKey = g.shift(curKey, cfg.shift);
  const count = Math.min(g.count, 60);
  const maxOffset = 30 * count;
  offset = Math.max(0, Math.min(maxOffset, Number(offset) || 0));
  if (offset) curKey = g.shift(curKey, -offset);

  // 生成 bucket keys（从旧到新）
  const keys = [];
  for (let i = count - 1; i >= 0; i--) keys.push(g.shift(curKey, -i));
  const keyIndex = new Map(keys.map((k, i) => [k, i]));

  const series = [{ id: 0, name: '汇总', color_up: '#e8912c', color_down: '#6bb5dd', up: new Array(keys.length).fill(0), down: new Array(keys.length).fill(0) }];
  const perDid = new Map();
  for (const d of downloaders) {
    perDid.set(d.id, { up: new Array(keys.length).fill(0), down: new Array(keys.length).fill(0) });
  }

  for (const d of downloaders) {
    const buckets = store.data.hourly[d.id] || {};
    for (const h in buckets) {
      const b = buckets[h];
      const k = b[gran];
      const i = keyIndex.get(k);
      if (i == null) continue;
      const p = perDid.get(d.id);
      p.down[i] += b.dl_bytes; p.up[i] += b.up_bytes;
    }
  }
  for (const d of downloaders) {
    const p = perDid.get(d.id);
    series.push({ id: d.id, name: d.name, color_up: d.color_up, color_down: d.color_down, up: p.up.slice(), down: p.down.slice() });
  }
  for (let i = 0; i < keys.length; i++) {
    let up = 0, down = 0;
    for (let s = 1; s < series.length; s++) { up += series[s].up[i]; down += series[s].down[i]; }
    series[0].up[i] = up; series[0].down[i] = down;
  }
  const labels = keys.map(k => tu.labelFor(gran, k));
  const spans = keys.map(k => [g.start(k), g.start(g.shift(k, 1))]);
  const sum = { up: series[0].up.reduce((a, b) => a + b, 0), down: series[0].down.reduce((a, b) => a + b, 0) };
  return {
    ok: true, range: rangeKey, metric: 'traffic', gran,
    labels, times: spans.map(s => s[0]), spans,
    series, summary: sum, offset, max_offset: maxOffset, bucket_count: keys.length,
    at_latest: offset === 0,
    window: { start: spans[0][0], end: spans[spans.length - 1][1], label: `${labels[0]} ~ ${labels[labels.length - 1]}` },
    downloaders: downloaders.map(d => ({ id: d.id, name: d.name, color_up: d.color_up, color_down: d.color_down }))
  };
}

/** "今日/昨日"按小时桶出图（粒度更细） */
function buildTrafficHourly(store, rangeKey, offset, downloaders) {
  const cfg = RANGES[rangeKey];
  const now = Math.floor(Date.now() / 1000);
  const dayShift = cfg.shift || 0;
  // 支持回看：offset 每 +1 往前推一天。此前完全忽略 offset，导致今日/昨日视图按 Alt+←/→ 毫无反应
  const maxOffset = 30;
  offset = Math.max(0, Math.min(maxOffset, Number(offset) || 0));
  const dayKey = tu.shiftDayKey(tu.dayKey(now), dayShift - offset);
  const dayStart = tu.dayStartTs(dayKey);
  const step = 3600; // 1 小时一桶
  const buckets = [];
  for (let t = dayStart; t < dayStart + 24 * step; t += step) {
    buckets.push({ ts: t, label: String(tu.wallDate(t).getUTCHours()).padStart(2, '0') + ':00' });
  }
  const index = new Map(buckets.map((b, i) => [b.ts, i]));
  const series = [{ id: 0, name: '汇总', color_up: '#e8912c', color_down: '#6bb5dd', up: new Array(24).fill(0), down: new Array(24).fill(0) }];
  for (const d of downloaders) {
    const p = { up: new Array(24).fill(0), down: new Array(24).fill(0) };
    const hs = store.data.hourly[d.id] || {};
    for (const h in hs) {
      const i = index.get(Number(h));
      if (i == null) continue;
      p.down[i] += hs[h].dl_bytes; p.up[i] += hs[h].up_bytes;
    }
    series.push({ id: d.id, name: d.name, color_up: d.color_up, color_down: d.color_down, up: p.up, down: p.down });
  }
  for (let i = 0; i < 24; i++) {
    let up = 0, down = 0;
    for (let s = 1; s < series.length; s++) { up += series[s].up[i]; down += series[s].down[i]; }
    series[0].up[i] = up; series[0].down[i] = down;
  }
  const sum = { up: series[0].up.reduce((a, b) => a + b, 0), down: series[0].down.reduce((a, b) => a + b, 0) };
  return {
    ok: true, range: rangeKey, metric: 'traffic', gran: 'hour',
    labels: buckets.map(b => b.label), times: buckets.map(b => b.ts),
    spans: buckets.map((b, i) => [b.ts, i < 23 ? buckets[i + 1].ts : b.ts + step]),
    series, summary: sum, offset, max_offset: maxOffset, bucket_count: 24, at_latest: offset === 0,
    window: { start: dayStart, end: dayStart + 24 * step, label: dayKey },
    downloaders: downloaders.map(d => ({ id: d.id, name: d.name, color_up: d.color_up, color_down: d.color_down }))
  };
}

function build(store, range, metric, offset) {
  const cfg = RANGES[range] || RANGES[metric === 'rate' ? 'live' : '24h'];
  const downloaders = store.displayDownloaders().filter(d => d.enabled);
  if (cfg.metric === 'rate') return buildRate(store, range, offset, downloaders);
  if (range === 'all') return buildAllTraffic(store, range, downloaders);
  if (range === '24h' || range === 'yesterday') return buildTrafficHourly(store, range, offset, downloaders);
  return buildTrafficNatural(store, range, offset, downloaders);
}

module.exports = { build, RANGES, RATE_RANGES, TRAFFIC_RANGES };
