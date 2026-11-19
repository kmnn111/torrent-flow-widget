'use strict';
/**
 * 采集调度器 — 移植自原项目 collector.py
 * rate 轮（高频）：fetch 每个下载器 → 更新在线状态/速率/累计快照 → 写实时 samples
 * traffic 轮（低频）：读累计快照与基线差分 → 写小时桶（唯一流量来源）
 * 无下载器时进入演示模式，注入可复现的 Mock 数据，保证界面打开即有内容。
 */
const clients = require('./clients');

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

class Collector {
  constructor(store, onEvent) {
    this.store = store;
    this.onEvent = onEvent || (() => { });
    this.rateTimer = null;
    this.trafficTimer = null;
    this.rateInFlight = false;
    this.trafficInFlight = false;
    this.ticks = 0;
    this.trafficTicks = 0;
    this.lastTick = 0;
    this.lastError = '';
    this.kickTimer = null;
  }
  start() {
    this.stop();
    const s = this.store.getSettings();
    const ri = clamp(Number(s.poll_interval) || 5, 0.2, 300) * 1000;
    const ti = clamp(Number(s.traffic_interval) || 60, 5, 1800) * 1000;
    this.rateTimer = setInterval(() => this.pollRate(), ri);
    this.trafficTimer = setInterval(() => this.pollTraffic(), ti);
    // 保存句柄：连续增删下载器会频繁 restart，未取消的一次性轮询会叠加、互相踩踏
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      this.pollRate(); this.pollTraffic();
    }, 400);
    this._pushInfo();
  }
  stop() {
    if (this.rateTimer) clearInterval(this.rateTimer);
    if (this.trafficTimer) clearInterval(this.trafficTimer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.rateTimer = this.trafficTimer = this.kickTimer = null;
  }
  restart() { this.start(); }
  _pushInfo() {
    this.store.setCollectorInfo({
      rate_interval: this.store.getSettings().poll_interval,
      traffic_interval: this.store.getSettings().traffic_interval,
      ticks: this.ticks, traffic_ticks: this.trafficTicks,
      last_tick: this.lastTick, last_error: this.lastError,
      demo: this.isDemo()
    });
  }
  /** 演示数据功能已移除，恒为 false（保留接口兼容调用方） */
  isDemo() { return false; }
  /** 清理历史版本可能残留的演示占位数据（升级后首次启动自动执行一次） */
  purgeDemoIfReal() {
    const store = this.store;
    const before = store.data.downloaders.length;
    store.data.downloaders = store.data.downloaders.filter(d => !d.demo);
    let changed = store.data.downloaders.length !== before;
    // 历史演示器固定用 101~106，连状态与小时桶一起清干净
    for (let id = 101; id <= 106; id++) {
      if (store.data.state[id]) { delete store.data.state[id]; changed = true; }
      if (store.data.hourly[id]) { delete store.data.hourly[id]; changed = true; }
    }
    if (changed) store.save();
    return changed;
  }

  /* ---------------- rate 轮 ---------------- */
  async pollRate() {
    if (this.rateInFlight) return;
    this.rateInFlight = true;
    try {
      this.purgeDemoIfReal();
      // 采集器只处理真实下载器，永不生成演示/假数据
      const dls = this.store.listDownloaders().filter(d => d.enabled && !d.demo);
      const ts = Math.floor(Date.now() / 1000);
      const per = {};
      await Promise.all(dls.map(async d => {
        try {
          // request_timeout 单位是秒（与 main.js 的 dl:test 口径一致），下面再乘 1000
          const cfg = Number(this.store.getSettings().request_timeout) || 5;
          const c = clients.makeClient(d, cfg * 1000);
          const r = await c.fetch();
          const st = this.store.getState(d.id);
          st.status = 'online'; st.error = ''; st.last_seen = ts;
          st.dl_rate = r.dl_rate; st.up_rate = r.up_rate;
          st.extra = Object.assign({}, r.extra);
          st.live_dl_total = r.dl_total; st.live_up_total = r.up_total;
          st.live_ts = ts;
          per[d.id] = { dl_rate: r.dl_rate, up_rate: r.up_rate };
        } catch (e) {
          const st = this.store.getState(d.id);
          st.status = 'offline'; st.error = friendlyError(e); st.dl_rate = 0; st.up_rate = 0;
          per[d.id] = { dl_rate: 0, up_rate: 0 };
          this.lastError = `${d.name}: ${st.error}`;
        }
      }));
      // 没有下载器时不写空采样，避免空态下数据文件仍持续增长
      if (dls.length) this.store.addSample(ts, per);
      this.ticks++; this.lastTick = ts;
      this._pushInfo();
      this.onEvent('rate');
    } catch (e) {
      this.lastError = e.message || String(e);
    } finally { this.rateInFlight = false; }
  }

  /* ---------------- traffic 轮 ---------------- */
  async pollTraffic() {
    if (this.trafficInFlight) return;
    this.trafficInFlight = true;
    try {
      this.purgeDemoIfReal();
      const dls = this.store.listDownloaders().filter(d => d.enabled && !d.demo);
      const ts = Math.floor(Date.now() / 1000);
      for (const d of dls) {
        const st = this.store.getState(d.id);
        const dl = st.live_dl_total, up = st.live_up_total;
        const r1 = clients.increment(dl, st.last_dl_total);
        const r2 = clients.increment(up, st.last_up_total);
        // 首轮必须先建立基线：no_base 时不写回，下一轮仍是 no_base，inc 永远为 0
        if (r1.event === 'no_base' || r1.event === 'ok' || r1.event === 'reset' || r1.event === 'spike') st.last_dl_total = dl;
        if (r2.event === 'no_base' || r2.event === 'ok' || r2.event === 'reset' || r2.event === 'spike') st.last_up_total = up;
        this.store.recordTraffic(d.id, ts, r1.inc, r2.inc);
      }
      this.trafficTicks++;
      this._pushInfo();
      this.onEvent('traffic');
    } catch (e) {
      this.lastError = e.message || String(e);
    } finally { this.trafficInFlight = false; }
  }

  // 演示数据已彻底移除：本应用只显示用户自己配置的下载器的真实数据。
}

function friendlyError(e) {
  const m = String((e && e.message) || e || '');
  if (/timeout|超时/i.test(m)) return '连接超时';
  if (/ECONNREFUSED|connect/i.test(m)) return '连接被拒绝';
  if (/密码|password|auth|401|403/i.test(m)) return '认证失败';
  if (/ENOTFOUND|getaddrinfo/i.test(m)) return '地址无法解析';
  return m.slice(0, 40) || '未知错误';
}

module.exports = { Collector };
