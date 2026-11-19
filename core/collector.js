'use strict';
/**
 * 采集调度器 — 移植自原项目 collector.py
 * rate 轮（高频）：fetch 每个下载器 → 更新在线状态/速率/累计快照 → 写实时 samples
 * traffic 轮（低频）：读累计快照与基线差分 → 写小时桶（唯一流量来源）
 * 无下载器时进入演示模式，注入可复现的 Mock 数据，保证界面打开即有内容。
 */
const clients = require('./clients');
const sites = require('./sites');

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

class Collector {
  constructor(store, onEvent) {
    this.store = store;
    this.onEvent = onEvent || (() => { });
    this.rateTimer = null;
    this.trafficTimer = null;
    this.sitesTimer = null;
    this.rateInFlight = false;
    this.trafficInFlight = false;
    this.sitesInFlight = false;
    this.ticks = 0;
    this.trafficTicks = 0;
    this.sitesTicks = 0;
    this.sitesError = '';
    this.activeTorrents = [];
    this.activeTs = 0;
    this._trackerCache = new Map(); // hash → tracker 列表（空 tracker 种子的反查缓存）
    this._backfillBusy = false;
    this.lastTick = 0;
    this.lastError = '';
    this.kickTimer = null;
  }
  start() {
    this.stop();
    const s = this.store.getSettings();
    const ri = clamp(Number(s.poll_interval) || 5, 0.2, 300) * 1000;
    const ti = clamp(Number(s.traffic_interval) || 60, 5, 1800) * 1000;
    // 种子轮开销大（一次拉全量种子 + 反查空 tracker），单独用较低频率：
    // 默认 30 秒，且不跟随后者的 traffic_interval，避免把 NAS 打得太频繁。
    const si = clamp(Number(s.torrent_interval) || 30, 10, 1800) * 1000;
    this.rateTimer = setInterval(() => this.pollRate(), ri);
    this.trafficTimer = setInterval(() => this.pollTraffic(), ti);
    this.sitesTimer = setInterval(() => this.pollSites(), si);
    // 保存句柄：连续增删下载器会频繁 restart，未取消的一次性轮询会叠加、互相踩踏
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      this.pollRate(); this.pollTraffic(); this.pollSites();
    }, 400);
    this._pushInfo();
  }
  stop() {
    if (this.rateTimer) clearInterval(this.rateTimer);
    if (this.trafficTimer) clearInterval(this.trafficTimer);
    if (this.sitesTimer) clearInterval(this.sitesTimer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.rateTimer = this.trafficTimer = this.sitesTimer = this.kickTimer = null;
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

  /* ---------------- 种子轮：正在下载列表 + PT 站点流量 ----------------
     一轮做三件事：
       1) 拉每个下载器的全部种子（已归一化）；
       2) 汇总「未完成且正在跑」的种子 → 正在下载模块；
       3) 按 tracker 归站、把每站种子累计上传/下载合计喂给 store 做差分记账。
     tracker 为空是常态（实测约 17%），这类种子再花一次 trackers 接口反查站点；
     反查结果按 hash 缓存，且只在「该站从未见过」时补查，避免每轮几百次请求。
     PT 站识别不出来时归入「未知」，绝不丢弃流量。 */
  async pollSites() {
    if (this.sitesInFlight) return;
    this.sitesInFlight = true;
    try {
      const dls = this.store.listDownloaders().filter(d => d.enabled && !d.demo);
      const ts = Math.floor(Date.now() / 1000);
      const perSite = {};
      const active = [];
      const cfg = Number(this.store.getSettings().request_timeout) || 5;

      for (const d of dls) {
        let list = [];
        try {
          const c = clients.makeClient(d, cfg * 1000);
          const r = await c.torrents();
          list = (r && r.list) || [];
        } catch (e) {
          this.sitesError = friendlyError(e);
          continue;
        }
        this.sitesError = '';

        // 反查 tracker：qB 的 torrents/info 只给「当前一个」tracker，实测约 17% 为空，
      // 而一个种子往往同时挂同站的多个域名。整组拿到才能既补空、又让未知域名
      // 通过 learnFromTorrent 自动归属到已知站（换域名的站也能认出来）。
        //
        // 关键：首次运行可能有两百多个种子要查，串行 60 个 × 每个几百毫秒会把
        // 「正在下载」模块拖到一分多钟后才出数。所以这里拆成两步：
        //   本轮只用「已有缓存」；缺失的丢给后台慢速补查，查到后下一轮自然生效。
        // 站点流量记账不依赖 tracker 是否补齐（缺的归到未知站，量不丢），
        // 因此晚一轮补全完全可接受，换来的是首屏秒出。
        const missing = list.filter(t => t.hash && !this._trackerCache.has(t.hash));
        if (missing.length && !this._backfillBusy) this._backfill(d, missing);
        // 回填并识别：优先用整组 tracker 投票，其次退回单字段
        for (const t of list) {
          let trs = this._trackerCache.get(t.hash);
          if (!Array.isArray(trs)) trs = [];
          // 原字段也算一条（有的客户端 trackers 接口权限受限，但 info 里有值）
          const group = t.tracker ? [t.tracker].concat(trs) : trs.slice();
          let info;
          if (group.length) {
            // 学习：同组里有已收录站 → 未知域名自动归过去
            sites.learnFromTorrent(group);
            // 逐个识别，取第一个「已收录」的结果；全是未知则取第一个
            info = null; let fallback = null;
            for (const u of group) {
              const id = sites.identify(u);
              if (!fallback) fallback = id;
              if (id.known) { info = id; break; }
            }
            info = info || fallback;
          } else {
            info = sites.identify('');
          }
          if (!t.tracker && group.length) t.tracker = group[0];
          const key = info.key;
          const s = perSite[key] || (perSite[key] = {
            up: 0, dl: 0, name: info.name, full: info.full, host: info.host, known: info.known, count: 0
          });
          s.up += t.uploaded || 0;
          s.dl += t.downloaded || 0;
          s.count++;
          if (t.state === 'downloading' && t.progress < 1) {
            active.push({
              id: d.id, dl_name: d.name, hash: t.hash, name: t.name,
              progress: t.progress, size: t.size, amount_left: t.amount_left,
              dl_rate: t.dl_rate, up_rate: t.up_rate, eta: t.eta,
              state: t.state, site: info.name, site_key: key
            });
          }
        }
      }

      if (dls.length) this.store.recordSiteTraffic(ts, perSite);

      // 正在下载：速率高的排前面，同速率按进度降序（快下完的优先看到）
      active.sort((a, b) => (b.dl_rate - a.dl_rate) || (b.progress - a.progress));
      this.activeTorrents = active.slice(0, 30);
      this.activeTs = ts;
      this.sitesTicks++;
      this._pushInfo();
      this.onEvent('sites');
    } catch (e) {
      this.lastError = e.message || String(e);
    } finally { this.sitesInFlight = false; }
  }

  /** 后台慢速补查 tracker（不阻塞任何一轮采集）
   *  - 串行、每批 25 个、批间让出 400ms，避免把 NAS 的 HTTP 服务打满
   *  - 单轮总量封顶，防止首次运行一口气查几百个
   *  - 同一个 hash 只查一次，结果（含"查不到"）都进缓存 */
  async _backfill(d, missing) {
    if (this._backfillBusy) return;
    this._backfillBusy = true;
    try {
      const cfg = Number(this.store.getSettings().request_timeout) || 5;
      const c = clients.makeClient(d, cfg * 1000);
      const batch = missing.slice(0, 150);
      for (let i = 0; i < batch.length; i++) {
        const t = batch[i];
        if (!t.hash || this._trackerCache.has(t.hash)) continue;
        try {
          const trs = await c.trackers(t.hash);
          this._trackerCache.set(t.hash, trs);
        } catch (e) {
          this._trackerCache.set(t.hash, []); // 失败也缓存，避免反复重试同一个坏 hash
        }
        if ((i + 1) % 25 === 0) await new Promise(r => setTimeout(r, 400));
      }
      // 补到什么程度就立刻用上，不必等下一轮整点
      this.onEvent('sites');
    } finally {
      this._backfillBusy = false;
    }
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
