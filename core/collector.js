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
    this._demoBase = null;
    this._demoSeed = 7;
    this.kickTimer = null;
    this._demoRateSeeded = false;
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
  /**
   * 是否处于演示态：真实（非 demo 标记）下载器一台都没有。
   * 注意不能用「enabled 数量」判断——演示态会注册虚拟下载器占位。
   */
  isDemo() {
    // 用户一旦增删过下载器就锁定为真实态；否则删光会被演示逻辑立刻回填，表现为"删了又跳出来"
    if (this.store.data.demoOptedOut) return false;
    return this.store.listDownloaders().filter(d => !d.demo).length === 0;
  }
  /** 有真实下载器（或用户已接管配置）后，清掉演示占位数据 */
  purgeDemoIfReal() {
    if (this.isDemo()) return false;
    const store = this.store;
    const before = store.data.downloaders.length;
    store.data.downloaders = store.data.downloaders.filter(d => !d.demo);
    let changed = store.data.downloaders.length !== before;
    // demo id 从定义派生，避免三处硬编码不同步
    for (const d of this._demoDefs()) {
      if (store.data.state[d.id]) { delete store.data.state[d.id]; changed = true; }
      if (store.data.hourly[d.id]) { delete store.data.hourly[d.id]; changed = true; }
    }
    if (changed) {
      // 演示数据被清掉后，下次若主动恢复演示，速率历史应重新预填
      this._demoRateSeeded = false;
      store.save();
    }
    return changed;
  }

  /* ---------------- rate 轮 ---------------- */
  async pollRate() {
    if (this.rateInFlight) return;
    this.rateInFlight = true;
    try {
      this.purgeDemoIfReal();
      const demo = this.isDemo();
      const dls = demo ? [] : this.store.listDownloaders().filter(d => d.enabled && !d.demo);
      const ts = Math.floor(Date.now() / 1000);
      if (demo) {
        this._demoRate(ts);
      } else {
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
        this.store.addSample(ts, per);
      }
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
      const demo = this.isDemo();
      const dls = demo ? [] : this.store.listDownloaders().filter(d => d.enabled && !d.demo);
      const ts = Math.floor(Date.now() / 1000);
      if (demo) {
        this._demoTraffic(ts);
      } else {
        for (const d of dls) {
          const st = this.store.getState(d.id);
          const dl = st.live_dl_total, up = st.live_up_total;
          const r1 = clients.increment(dl, st.last_dl_total);
          const r2 = clients.increment(up, st.last_up_total);
          // 首轮必须先建立基线：no_base 时不写回，下一轮仍是 no_base，inc 永远为 0，
          // 真实下载器的流量统计会彻底失效（演示态直接写数值，掩盖了这个缺陷）
          if (r1.event === 'no_base' || r1.event === 'ok' || r1.event === 'reset' || r1.event === 'spike') st.last_dl_total = dl;
          if (r2.event === 'no_base' || r2.event === 'ok' || r2.event === 'reset' || r2.event === 'spike') st.last_up_total = up;
          this.store.recordTraffic(d.id, ts, r1.inc, r2.inc);
        }
      }
      this.trafficTicks++;
      this._pushInfo();
      this.onEvent('traffic');
    } catch (e) {
      this.lastError = e.message || String(e);
    } finally { this.trafficInFlight = false; }
  }

  /* ---------------- 演示数据 ---------------- */
  _rand() {
    // 可复现伪随机
    this._demoSeed = (this._demoSeed * 1103515245 + 12345) & 0x7fffffff;
    return this._demoSeed / 0x7fffffff;
  }
  /** 演示数据用的虚拟下载器定义（不落盘为真实配置，仅内存占位） */
  _demoDefs() {
    return [
      { id: 101, name: 'tr1(主神)', type: 'tr', color_up: '#e8912c', color_down: '#6bb5dd' },
      { id: 102, name: 'qb1(下载)', type: 'qb', color_up: '#d9695f', color_down: '#7fb069' },
      { id: 103, name: 'qb1(御用)', type: 'qb', color_up: '#9b7bc4', color_down: '#e0a34a' },
      { id: 104, name: 'tr1(大包)', type: 'tr', color_up: '#5b8fd4', color_down: '#d97b9c' },
      { id: 105, name: 'tr2(缓存)', type: 'tr', color_up: '#4fa89b', color_down: '#c96f4a' },
      { id: 106, name: 'qb1(宝组)', type: 'qb', color_up: '#8bab3f', color_down: '#b06ca8' }
    ];
  }
  /**
   * 确保演示下载器已注册进 store：图表/汇总只遍历 store.listDownloaders()，
   * 不注册虚拟器会让演示态界面有速率却图表全空。
   */
  _ensureDemoDownloaders() {
    const defs = this._demoDefs();
    for (const d of defs) {
      if (!this.store.getDownloader(d.id)) {
        this.store.data.downloaders.push({
          id: d.id, name: d.name, type: d.type, url: 'demo://' + d.name,
          username: '', password: '', enabled: 1,
          color_up: d.color_up, color_down: d.color_down,
          sort_order: d.id, created_at: Math.floor(Date.now() / 1000), demo: true
        });
      }
    }
    // 保证 nextId 不撞车
    const maxId = Math.max(0, ...this.store.data.downloaders.map(x => x.id));
    if (this.store.data.nextId <= maxId) this.store.data.nextId = maxId + 1;
  }
  _demoRate(ts) {
    this._ensureDemoDownloaders();
    const demo = this._demoDefs();
    // 首次进入演示态：预填历史采样，让速率曲线一打开就有形状（单点画不出线）
    // 两级密度：近 2 小时按 5s（喂实时/1h 视图），往前到 24 小时按 60s（喂 6h/12h/24h 视图）
    if (!this._demoRateSeeded) {
      this._demoRateSeeded = true;
      for (let back = 86400; back > 7200; back -= 60) this._demoRatePush(ts - back, demo);
      for (let back = 7200; back > 0; back -= 5) this._demoRatePush(ts - back, demo);
    }
    this._demoRatePush(ts, demo);
  }
  /** 写入单个演示采样点（含速率/状态），供历史预填与实时 tick 复用 */
  _demoRatePush(ts, demo) {
    const per = {};
    const h = new Date((ts + 8 * 3600) * 1000).getUTCHours();
    const wave = 0.5 + 0.5 * Math.sin((h + (ts % 3600) / 3600) / 24 * Math.PI * 2);
    demo.forEach((d, i) => {
      // 每台下载器独立的低频起伏 + 高频抖动，曲线更自然
      const phase = i * 1.7;
      const slow = 0.55 + 0.45 * Math.sin(ts / 260 + phase);
      const fast = 0.85 + 0.3 * Math.sin(ts / 37 + phase * 2);
      const up = Math.round((180 + this._rand() * 900) * (0.4 + wave) * slow);
      const down = i === 1
        ? Math.round(9 * 1024 * 1024 * (0.25 + this._rand() * 0.9) * fast)
        : Math.round(this._rand() * 3 * 1024 * 1024 * fast);
      per[d.id] = { dl_rate: down, up_rate: up };
      const st = this.store.getState(d.id);
      st.status = 'online'; st.error = ''; st.last_seen = ts;
      st.dl_rate = down; st.up_rate = up;
      st.extra = { source: 'demo', connection_status: 'Connected' };
    });
    this.store.addSample(ts, per);
  }
  _demoTraffic(ts) {
    this._ensureDemoDownloaders();
    // 为今天每个已过去的小时补一份稳定的演示流量
    const demoIds = this._demoDefs().map(d => d.id);
    const dayStart = require('./timeutil').dayStartTs(require('./timeutil').dayKey(ts));
    const curHour = require('./timeutil').hourFloor(ts);
    const base = [1.6e9, 38e9, 6e9, 2e9, 0.8e9, 1.2e9]; // 各下载器今日下载量级
    for (let h = dayStart; h <= curHour; h += 3600) {
      const hourOfDay = new Date((h + 8 * 3600) * 1000).getUTCHours();
      demoIds.forEach((id, i) => {
        if (!this.store.data.hourly[id]) this.store.data.hourly[id] = {};
        const key = String(h);
        if (this.store.data.hourly[id][key]) return; // 已有真实/已补数据不覆盖
        const tu = require('./timeutil');
        const meta = tu.hourMeta(h);
        const active = hourOfDay >= 7 && hourOfDay <= 23 ? 1 : 0.3;
        const dl = Math.round(base[i] / 16 * active * (0.6 + this._rand() * 0.8));
        const up = Math.round(dl * (0.12 + this._rand() * 0.2));
        this.store.data.hourly[id][key] = { day: meta.day, week: meta.week, month: meta.month, year: meta.year, dl_bytes: dl, up_bytes: up, samples: 1 };
      });
    }
    // 历史若干天（周/月/年视图不空）
    const tu = require('./timeutil');
    for (let back = 1; back <= 40; back++) {
      const d = tu.shiftDayKey(tu.dayKey(ts), -back);
      const dStart = tu.dayStartTs(d);
      demoIds.forEach((id, i) => {
        if (!this.store.data.hourly[id]) this.store.data.hourly[id] = {};
        const key = String(dStart + 12 * 3600);
        if (this.store.data.hourly[id][key]) return;
        const meta = tu.hourMeta(dStart + 12 * 3600);
        const dl = Math.round(base[i] * (0.5 + this._rand()));
        const up = Math.round(dl * 0.18);
        this.store.data.hourly[id][key] = { day: meta.day, week: meta.week, month: meta.month, year: meta.year, dl_bytes: dl, up_bytes: up, samples: 1 };
      });
    }
    this.store.touch();
  }
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
