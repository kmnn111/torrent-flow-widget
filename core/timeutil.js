'use strict';
/**
 * 时间分桶工具 — 移植自原项目 timeutil.py
 * 固定偏移时区（默认东八区），不依赖 tzdata；用 UTC 对象承载"本地墙上时间"，只取字段。
 */

let _tzOffset = 8; // 小时
function setTzOffset(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n >= -12 && n <= 14) _tzOffset = n;
}
function getTzOffset() { return _tzOffset; }
function offsetSec() { return _tzOffset * 3600; }

// ts 为 Unix 秒 → 承载本地墙上时间的 Date（取其 UTC 字段即为本地字段）
function wallDate(ts) {
  return new Date((Number(ts) || 0) * 1000 + offsetSec() * 1000);
}
// 本地墙上时间 → 真实 Unix 秒
function wallTs(d) {
  return Math.floor(d.getTime() / 1000) - offsetSec();
}
const pad2 = n => String(n).padStart(2, '0');

function dayKey(ts) {
  const d = wallDate(ts);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function monthKey(ts) {
  const d = wallDate(ts);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}
function yearKey(ts) {
  return String(wallDate(ts).getUTCFullYear());
}
function weekKey(ts) {
  // 以周一为起点
  const d = wallDate(ts);
  const wd = d.getUTCDay(); // 0=周日
  const diff = (wd === 0 ? -6 : 1 - wd);
  const mon = new Date(d.getTime() + diff * 86400000);
  return `${mon.getUTCFullYear()}-${pad2(mon.getUTCMonth() + 1)}-${pad2(mon.getUTCDate())}`;
}
function hourFloor(ts) {
  // 所在本地小时的起点（真实 Unix 秒）
  return Math.floor((Number(ts) + offsetSec()) / 3600) * 3600 - offsetSec();
}
function hourMeta(hourTs) {
  return { day: dayKey(hourTs), week: weekKey(hourTs), month: monthKey(hourTs), year: yearKey(hourTs) };
}

function shiftDayKey(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}
function shiftMonthKey(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}`;
}
function shiftYearKey(key, delta) { return String(Number(key) + delta); }
function shiftWeekKey(key, delta) { return shiftDayKey(key, delta * 7); }

function dayStartTs(key) {
  const [y, m, d] = key.split('-').map(Number);
  return wallTs(new Date(Date.UTC(y, m - 1, d, 0, 0, 0)));
}
function monthStartTs(key) {
  const [y, m] = key.split('-').map(Number);
  return wallTs(new Date(Date.UTC(y, m - 1, 1, 0, 0, 0)));
}
function weekStartTs(key) { return dayStartTs(key); }
function yearStartTs(key) { return wallTs(new Date(Date.UTC(Number(key), 0, 1, 0, 0, 0))); }

function labelFor(gran, key) {
  if (gran === 'day') { const [, m, d] = key.split('-'); return `${Number(m)}月${Number(d)}日`; }
  if (gran === 'week') { return key.slice(5).replace('-', '/') + ' 周'; }
  if (gran === 'month') { const [y, m] = key.split('-'); return `${y}/${Number(m)}`; }
  if (gran === 'year') { return key + ' 年'; }
  return key;
}

module.exports = {
  setTzOffset, getTzOffset, offsetSec, wallDate, wallTs,
  dayKey, weekKey, monthKey, yearKey, hourFloor, hourMeta,
  shiftDayKey, shiftWeekKey, shiftMonthKey, shiftYearKey,
  dayStartTs, weekStartTs, monthStartTs, yearStartTs, labelFor,
  GRAN: { day: { key: dayKey, shift: shiftDayKey, start: dayStartTs, count: 31 },
          week: { key: weekKey, shift: shiftWeekKey, start: weekStartTs, count: 27 },
          month: { key: monthKey, shift: shiftMonthKey, start: monthStartTs, count: 13 },
          year: { key: yearKey, shift: shiftYearKey, start: yearStartTs, count: 6 } }
};
