'use strict';
/**
 * 数据存储 — 原子写入 JSON 文件，零原生依赖（原项目为 SQLite，桌面单机 JSON 足够）。
 * 数据结构：
 * {
 *   downloaders: [{id,name,type,url,username,password,enabled,color_up,color_down,sort_order,created_at}],
 *   settings: {poll_interval,traffic_interval,live_span,tz_offset,request_timeout},
 *   state: { [id]: {status,error,last_seen,dl_rate,up_rate,last_dl_total,last_up_total,last_ts,extra} },
 *   hourly: { [id]: { [hourTs]: {day,week,month,year,dl_bytes,up_bytes,samples} } },
 *   samples: [{ts,downloaders:{[id]:{dl_rate,up_rate}}}],  // 实时速率，滚动保留
 *   traffic_samples: [{ts,downloaders:{[id]:{dl_inc,up_inc}}}],
 *   nextId: int
 * }
 */
const fs = require('fs');
const path = require('path');
const tu = require('./timeutil');

const SUMMARY_UP = '#e8912c';
const SUMMARY_DOWN = '#6bb5dd';
const PALETTE = [
  ['#e8912c', '#6bb5dd'], ['#d9695f', '#7fb069'], ['#9b7bc4', '#e0a34a'],
  ['#5b8fd4', '#d97b9c'], ['#4fa89b', '#c96f4a'], ['#c96f4a', '#4fa89b'],
  ['#8bab3f', '#b06ca8'], ['#d97b9c', '#5b8fd4']
];
/** 站点单轮增量上限：整站一小时涨 1TB 以上必是异常（换库/重新校验/统计口径跳变）。
    超限按 0 记，但基线照常写回，下一轮即恢复正常。 */
const MAX_SITE_STEP = Math.pow(1024, 4);
/** 站点账本最多保留多少站（远超真实用户的站点数，纯属防爆保护） */
const MAX_SITE_KEYS = 500;
/** 种子级基线表上限。320 个种子 ≈ 40KB，两万条足够长期运行且不会撑大 JSON */
const MAX_TORRENT_BASE = 20000;
/** 无 tracker 种子的专用站点键（与「未知站点」严格区分，见 collector.js） */
const NO_SITE_KEY = 'no-site';

class Store {
  constructor(filePath) {
    this.file = filePath;
    this.data = this._blank();
    this.load();
    this._dirty = false;
    this._saveTimer = null;
  }
  _blank() {
    return {
      downloaders: [],
      settings: { poll_interval: 5, traffic_interval: 60, live_span: 300, tz_offset: 8, request_timeout: 5 },
      state: {}, hourly: {}, samples: [], traffic_samples: [], nextId: 1,
      // PT 站流量账本：
      //   torrent_base: { [hash]: {up, dl, site, ts} }  ← 种子级基线（v1.0.5 起的记账依据）
      //   site_base: { [siteKey]: {up, dl} }             ← 站点聚合基线（旧口径，仅兼容保留）
      //   site_hourly: { [siteKey]: { [hourTs]: {day,week,month,year,dl_bytes,up_bytes} } }
      //   site_meta: { [siteKey]: {name, full, host, known, last_seen} }   ← 昵称与最近活跃
      torrent_base: {}, site_base: {}, site_hourly: {}, site_meta: {},
      // tracker 反查缓存（hash → {trs, ts}），跨启动复用，减少归属抖动
      tracker_cache: {},
      // 演示数据功能已彻底移除。保留 demoOptedOut 仅为兼容旧数据读取，不再参与任何逻辑。
      demoOptedOut: false
    };
  }
  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // 先铺默认值再合并解析结果。不能先 Object.assign(b, parsed) 再合 settings：
      // 那会用 parsed.settings 覆盖 b.settings，后续就变成"自己合并自己"，
      // 旧数据缺字段时 tz_offset / request_timeout 等默认值永远补不上。
      const b = this._blank();
      this.data = Object.assign(b, parsed);
      this.data.settings = Object.assign(this._blank().settings, parsed.settings || {});
      // 类型校验：JSON 合法但字段类型错（如 downloaders:null）会让首屏直接崩
      this.data.downloaders = Array.isArray(parsed.downloaders) ? parsed.downloaders : [];
      this.data.state = (parsed.state && typeof parsed.state === 'object' && !Array.isArray(parsed.state)) ? parsed.state : {};
      this.data.hourly = (parsed.hourly && typeof parsed.hourly === 'object' && !Array.isArray(parsed.hourly)) ? parsed.hourly : {};
      this.data.samples = Array.isArray(parsed.samples) ? parsed.samples : [];
      this.data.traffic_samples = Array.isArray(parsed.traffic_samples) ? parsed.traffic_samples : [];
      this.data.site_base = (parsed.site_base && typeof parsed.site_base === 'object' && !Array.isArray(parsed.site_base)) ? parsed.site_base : {};
      this.data.torrent_base = (parsed.torrent_base && typeof parsed.torrent_base === 'object' && !Array.isArray(parsed.torrent_base)) ? parsed.torrent_base : {};
      this.data.tracker_cache = (parsed.tracker_cache && typeof parsed.tracker_cache === 'object' && !Array.isArray(parsed.tracker_cache)) ? parsed.tracker_cache : {};
      this.data.site_hourly = (parsed.site_hourly && typeof parsed.site_hourly === 'object' && !Array.isArray(parsed.site_hourly)) ? parsed.site_hourly : {};
      this.data.site_meta = (parsed.site_meta && typeof parsed.site_meta === 'object' && !Array.isArray(parsed.site_meta)) ? parsed.site_meta : {};
      this.data.nextId = Number(parsed.nextId) || 1;
      this._migrateEmptySiteKey();
      tu.setTzOffset(this.data.settings.tz_offset);
    } catch (e) {
      // 损坏留现场，回退空数据
      try { fs.copyFileSync(this.file, this.file + '.broken'); } catch (_) { }
      this.data = this._blank();
    }
  }
  /**
   * 一次性迁移：清掉旧版本写入的空 key「幽灵站点」。
   * 旧 collector 在没有 tracker 时调用 identify('')，返回 key 为空串，
   * 于是所有无 tracker 种子（本机做种/私有种子）的流量都汇总到一个空名字的站，
   * 真实数据里它一度占了今日 0.41TB↑/0.98TB↓ 并排在榜首。
   * 现在这类种子改用 'no-site' 专用键；历史空 key 的量并入 'no-site' 以免丢账。
   */
  _migrateEmptySiteKey() {
    const hasEmpty = (o) => o && Object.prototype.hasOwnProperty.call(o, '');
    if (!hasEmpty(this.data.site_meta) && !hasEmpty(this.data.site_base) && !hasEmpty(this.data.site_hourly)) return false;

    // 历史小时桶合入 no-site（同一小时同一字段累加），保证总量不失真
    const oldHourly = this.data.site_hourly[''];
    if (oldHourly) {
      const dst = this.data.site_hourly['no-site'] || (this.data.site_hourly['no-site'] = {});
      for (const h in oldHourly) {
        const src = oldHourly[h], cur = dst[h];
        if (!cur) { dst[h] = src; continue; }
        cur.dl_bytes = (cur.dl_bytes || 0) + (src.dl_bytes || 0);
        cur.up_bytes = (cur.up_bytes || 0) + (src.up_bytes || 0);
      }
    }
    // 基线直接丢弃：no-site 的基线由下一轮采集重建，沿用旧值反而会算错增量
    delete this.data.site_meta[''];
    delete this.data.site_base[''];
    delete this.data.site_hourly[''];
    const m = this.data.site_meta['no-site'];
    if (!m) {
      this.data.site_meta['no-site'] = {
        name: '无站点', full: '本机/私有种子（无 tracker）', host: '', known: true, last_seen: 0
      };
    }
    this.touch();
    return true;
  }
  save() {
    try {
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (e) { console.error('[store] save failed', e.message); }
  }
  // 合并写盘（高频采集调用，防抖 1.2s）
  touch() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._dirty) this.save();
    }, 1200);
  }
  flush() { if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; } if (this._dirty) this.save(); }

  /* ---------- 下载器 CRUD ---------- */
  listDownloaders() {
    return this.data.downloaders.slice().sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
  }
  getDownloader(id) { return this.data.downloaders.find(d => d.id === Number(id)) || null; }
  addDownloader(d) {
    const row = {
      id: this.data.nextId++,
      name: String(d.name || `下载器${this.data.nextId - 1}`).slice(0, 60),
      type: d.type === 'tr' ? 'tr' : 'qb',
      url: String(d.url || '').trim().replace(/\/+$/, ''),
      username: String(d.username || ''),
      password: String(d.password || ''),
      enabled: d.enabled === false ? 0 : 1,
      color_up: d.color_up || '', color_down: d.color_down || '',
      sort_order: Number.isFinite(d.sort_order) ? d.sort_order : this.data.downloaders.length,
      created_at: Math.floor(Date.now() / 1000)
    };
    if (!row.color_up || !row.color_down) {
      const p = PALETTE[(row.id - 1) % PALETTE.length];
      row.color_up = row.color_up || p[0];
      row.color_down = row.color_down || p[1];
    }
    this.data.downloaders.push(row);
    this.data.demoOptedOut = true;
    this.save();
    return row;
  }
  updateDownloader(id, patch) {
    const row = this.getDownloader(id);
    if (!row) return null;
    for (const k of ['name', 'type', 'url', 'username', 'enabled', 'color_up', 'color_down', 'sort_order']) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) row[k] = patch[k];
    }
    if (patch.password) row.password = String(patch.password); // 留空不改
    if (row.url) row.url = row.url.replace(/\/+$/, '');
    this.save();
    return row;
  }
  deleteDownloader(id) {
    const i = this.data.downloaders.findIndex(d => d.id === Number(id));
    if (i < 0) return false;
    this.data.downloaders.splice(i, 1);
    delete this.data.state[id]; delete this.data.hourly[id];
    // 删除后保持"未配置"空态
    this.data.demoOptedOut = true;
    this.save();
    return true;
  }
  reorderDownloaders(ids) {
    const map = new Map(ids.map((id, i) => [Number(id), i]));
    this.data.downloaders.forEach(d => { if (map.has(d.id)) d.sort_order = map.get(d.id); });
    this.save();
  }
  recolor() {
    const shuffled = PALETTE.slice();
    // 简单轮转，点一次换一套
    shuffled.push(shuffled.shift());
    this.listDownloaders().forEach((d, i) => {
      const p = shuffled[i % shuffled.length];
      d.color_up = p[0]; d.color_down = p[1];
    });
    this.save();
  }
  updateSettings(patch) {
    Object.assign(this.data.settings, patch);
    if (patch.tz_offset != null) tu.setTzOffset(patch.tz_offset);
    this.save();
  }
  getSettings() { return Object.assign({}, this.data.settings); }

  /* ---------- 采集状态 ---------- */
  getState(id) {
    return this.data.state[id] || (this.data.state[id] = { status: 'unknown', error: '', last_seen: 0, dl_rate: 0, up_rate: 0, last_dl_total: null, last_up_total: null, last_ts: null, extra: {} });
  }

  /**
   * 写一条速率采样（内存数组 + 定期落盘）
   */
  addSample(ts, perDownloader) {
    this.data.samples.push({ ts, downloaders: perDownloader });
    this._trimSamples();
    this.touch();
  }
  _trimSamples() {
    const retention = (this.data.settings.sample_retention_days || 7) * 86400;
    const cutoff = Math.floor(Date.now() / 1000) - retention;
    if (this.data.samples.length && this.data.samples[0].ts < cutoff) {
      this.data.samples = this.data.samples.filter(s => s.ts >= cutoff);
    }
    // 容量上限：按 5s 采样 7 天 ≈ 12 万点，上限 20 万
    if (this.data.samples.length > 200000) this.data.samples.splice(0, this.data.samples.length - 200000);
  }

  /**
   * 累计计数器差分 → 分摊写入小时桶（核心）
   */
  recordTraffic(id, ts, dlInc, upInc) {
    // traffic_samples 留痕
    this.data.traffic_samples.push({ ts, downloaders: { [id]: { dl_inc: dlInc, up_inc: upInc } } });
    if (this.data.traffic_samples.length > 50000) this.data.traffic_samples.splice(0, this.data.traffic_samples.length - 50000);

    const prevTs = this.getState(id).last_ts;
    const span = prevTs ? Math.min(3600, Math.max(1, ts - prevTs)) : 0;
    const segments = [];
    if (span > 0) {
      let cur = ts - span;
      while (cur < ts) {
        const h = tu.hourFloor(cur);
        const segEnd = Math.min(ts, h + 3600);
        segments.push([h, segEnd - cur]);
        cur = segEnd;
      }
    } else {
      segments.push([tu.hourFloor(ts), 1]);
    }
    if (!this.data.hourly[id]) this.data.hourly[id] = {};
    const buckets = this.data.hourly[id];
    // 首轮无时间基线时 span=0，此时整笔增量全落在当前桶（share=1）。
    // 绝不能写 (w/span || 1)：span=0 时 w/span=Infinity 是 truthy，|| 兜底失效，
    // 会把小时桶写成 Infinity/NaN，污染全部周期汇总与图表。
    const safeDl = Number.isFinite(dlInc) && dlInc > 0 ? dlInc : 0;
    const safeUp = Number.isFinite(upInc) && upInc > 0 ? upInc : 0;
    for (const [h, w] of segments) {
      const meta = tu.hourMeta(h);
      const key = String(h);
      const b = buckets[key] || (buckets[key] = { day: meta.day, week: meta.week, month: meta.month, year: meta.year, dl_bytes: 0, up_bytes: 0, samples: 0 });
      const s = span > 0 ? (w / span) : 1;
      b.dl_bytes += Math.round(safeDl * s);
      b.up_bytes += Math.round(safeUp * s);
      b.samples += 1;
    }
    // 写回时间基线：下一次差分才知道这次增量跨越了多长时间，才能正确分摊到小时桶
    this.getState(id).last_ts = ts;
    this.touch();
  }

  /* ---------- PT 站点流量账本 ----------
     为什么不能直接用种子的 uploaded/downloaded 分周期：
     这两个是「种子自加入以来的累计值」，老种子今天仍在做种、上传量一直在涨，
     用 added_on 去切「今日/本周」会把十年的累计全算进今天（实测：今天新增种子
     只占上传 53GB，而真实日上传靠的是几百个老种子）。所以周期只能靠差分记账：
     每轮抓取每站所有种子的累计值，与上一轮基线的差值就是这段时间的新增流量，
     再按 recordTraffic 同样的方式摊到小时桶。 */

  /* ---------- tracker 反查缓存（跨启动复用） ----------
     只存「查到过」的 hash。目的：减少重启后种子归属从「无站点」跳回真实站的抖动，
     让第一轮采集就能把站点认对。条目带 ts，超过 14 天自动淘汰（换 tracker 的种子
     会自然更新；长期不活跃的种子没必要一直占着）。 */
  getTrackerCache() {
    const c = this.data.tracker_cache;
    if (!c || typeof c !== 'object') return null;
    const cutoff = Math.floor(Date.now() / 1000) - 14 * 86400;
    const out = {};
    let any = false;
    for (const h in c) {
      const e = c[h];
      if (!e || !Array.isArray(e.trs) || !e.trs.length) continue;
      if ((e.ts || 0) < cutoff) continue;
      out[h] = e.trs;
      any = true;
    }
    return any ? out : null;
  }
  setTrackerCache(map) {
    const now = Math.floor(Date.now() / 1000);
    const prev = this.data.tracker_cache || {};
    const next = {};
    for (const h in map) {
      const trs = map[h];
      if (!Array.isArray(trs) || !trs.length) continue;
      next[h] = { trs, ts: (prev[h] && prev[h].ts) || now };
    }
    this.data.tracker_cache = next;
    this.touch();
  }

  /** 站点元信息（昵称等）落盘，供 UI 直接读，不必重新解析 tracker */
  _siteMeta(key, info) {
    const m = this.data.site_meta[key];
    // 防御：调用方某一轮可能只带 up/dl 而不带 name（例如补录/自检脚本），
    // 那时不能把已识别好的站名冲成 undefined —— 站点名丢了就退化成 key。
    const name = info.name || (m && m.name) || key;
    const full = info.full !== undefined ? (info.full || '') : ((m && m.full) || '');
    const host = info.host !== undefined ? (info.host || '') : ((m && m.host) || '');
    const known = info.known !== undefined ? !!info.known : !!(m && m.known);
    if (!m || m.name !== name || m.full !== full || m.host !== host || m.known !== known) {
      this.data.site_meta[key] = { name, full, host, known, last_seen: (m && m.last_seen) || 0 };
    }
  }

  /**
   * 用「每站种子的累计上传/下载合计」做差分，写入站点小时桶。
   *
   * ⚠️ 已知缺陷（v1.0.5 起由 recordSiteTrafficByTorrent 取代）：
   * 站点聚合值不是单调递增的 —— 种子的 tracker 字段会抖动（彩虹岛在
   * chdbits.xyz / tracker.ptchdbits.co / tracker.rainbowisland.co 间来回切换），
   * 冷启动时 _trackerCache 为空，无 tracker 的种子先归「无站点」，
   * 后台反查补齐后又跳回真实站。聚合值随之涨落，差分就把「跳回来的旧流量」
   * 当成新增量重复记账。实测：冷→热一次切换凭空产生 1006GB 假增量，
   * 表现就是「天空今日下载 1.2TB」而该站累计才 695GB。
   * 保留此方法仅供测试与向后兼容；生产路径改用按种子记账。
   *
   * @param {number} ts 本轮时间戳（秒）
   * @param {Object} perSite { [siteKey]: { up, dl, name, full, host, known } }
   * @returns {{changed:boolean, events:Object}}
   */
  recordSiteTraffic(ts, perSite) {
    const prevTs = this.data.site_last_ts || 0;
    const span = prevTs ? Math.min(3600, Math.max(1, ts - prevTs)) : 0;
    const segments = [];
    if (span > 0) {
      let cur = ts - span;
      while (cur < ts) {
        const h = tu.hourFloor(cur);
        const segEnd = Math.min(ts, h + 3600);
        segments.push([h, segEnd - cur]);
        cur = segEnd;
      }
    } else {
      segments.push([tu.hourFloor(ts), 1]);
    }

    const events = {};
    let changed = false;
    for (const key in perSite) {
      const cur = perSite[key];
      if (!cur) continue;
      // 空 key 会变成一个"幽灵站点"，把不同来源的流量并到一起（历史上真实发生过）。
      // 站点标识必须非空，空键一律拒收，宁可少记也不能记错账。
      if (!key || !String(key).trim()) continue;
      this._siteMeta(key, cur);
      const base = this.data.site_base[key] || {};
      const upNow = Number(cur.up) || 0, dlNow = Number(cur.dl) || 0;
      const prevUp = Number(base.up), prevDl = Number(base.dl);
      const firstRound = !Number.isFinite(prevUp) || !Number.isFinite(prevDl);

      // 与 downloaders 同口径：负值=站点重置/换种，按 0 计但必须重建基线
      let upInc = 0, dlInc = 0;
      if (!firstRound) {
        const du = upNow - prevUp, dd = dlNow - prevDl;
        // 单轮增量上限：整站一小时涨幅超 1TB 视为异常（换库/重新校验），不记
        if (du > 0 && du < MAX_SITE_STEP) upInc = du;
        if (dd > 0 && dd < MAX_SITE_STEP) dlInc = dd;
        events[key] = { up: upInc, dl: dlInc, reset: du < 0 || dd < 0 };
      } else {
        events[key] = { up: 0, dl: 0, first: true };
      }

      if (upInc || dlInc) {
        if (!this.data.site_hourly[key]) this.data.site_hourly[key] = {};
        const buckets = this.data.site_hourly[key];
        for (const [h, w] of segments) {
          const meta = tu.hourMeta(h);
          const k = String(h);
          const b = buckets[k] || (buckets[k] = { day: meta.day, week: meta.week, month: meta.month, year: meta.year, dl_bytes: 0, up_bytes: 0 });
          const s = span > 0 ? (w / span) : 1;
          b.dl_bytes += Math.round(dlInc * s);
          b.up_bytes += Math.round(upInc * s);
        }
        changed = true;
      }

      // 基线无条件写回（含首轮），否则永远错过基线，每次都是 no_base
      this.data.site_base[key] = { up: upNow, dl: dlNow };
      const mm = this.data.site_meta[key];
      if (mm) mm.last_seen = ts;
    }
    this.data.site_last_ts = ts;
    // 站点桶只增不减（年度报表要读历史），但站点数可能因换域名/临时站持续膨胀。
    // 这里只做上限保护：超过 MAX_SITE_KEYS 个站时，淘汰「最近 90 天无流量」的站，
    // 仍超则按最后活跃时间砍最旧的 —— 正常用户几十年也碰不到这条线。
    this._trimSiteKeys();
    if (changed) this.touch();
    return { changed, events };
  }

  _trimSiteKeys() {
    const keys = Object.keys(this.data.site_meta);
    if (keys.length <= MAX_SITE_KEYS) return;
    const now = Math.floor(Date.now() / 1000);
    const stale = keys.filter(k => !(this.data.site_meta[k].last_seen > now - 90 * 86400));
    const victims = (stale.length ? stale : keys.sort((a, b) =>
      (this.data.site_meta[a].last_seen || 0) - (this.data.site_meta[b].last_seen || 0)));
    const dropCount = keys.length - MAX_SITE_KEYS;
    for (const k of victims.slice(0, dropCount)) {
      delete this.data.site_meta[k];
      delete this.data.site_base[k];
      delete this.data.site_hourly[k];
    }
  }

  /**
   * 按「单个种子」记账（v1.0.5 起的正确做法）。
   *
   * 为什么不能用站点聚合值差分：聚合值 = 该站所有种子累计值之和，它随
   * 「本轮哪些种子被认成这个站」而变，不是单调函数。
   *   · 冷启动时 _trackerCache 为空 → 无 tracker 的种子先归「无站点」
   *   · 后台反查补齐后 → 同一批种子跳回真实站
   * 聚合值于是「先跌后涨」，差分把涨的那段当成新流量再记一遍。
   * 实测一次冷→热切换就凭空多记 1006GB，正是「天空今日 1.2TB」的来源。
   *
   * 单个种子的 uploaded/downloaded 只增不减（除非重新校验），差分天然安全：
   * 归属变了也无所谓，我们记的是「这个 hash 涨了多少」，归属只决定记到哪个站。
   *
   * @param {number} ts 本轮时间戳（秒）
   * @param {Array<{hash,site,up,dl}>} rows 本轮全部种子及其真实归属
   * @param {Object} siteInfo { [siteKey]: {name,full,host,known} } 仅用于写元信息
   * @returns {{changed:boolean, recorded:number}}
   */
  recordSiteTrafficByTorrent(ts, rows, siteInfo) {
    if (!Array.isArray(rows) || !rows.length) return { changed: false, recorded: 0 };
    // 时间分摊：与旧方法同口径，跨整点时按秒数比例拆到各小时桶
    const prevTs = this.data.site_last_ts || 0;
    const span = prevTs ? Math.min(3600, Math.max(1, ts - prevTs)) : 0;
    const segments = [];
    if (span > 0) {
      let cur = ts - span;
      while (cur < ts) {
        const h = tu.hourFloor(cur);
        const segEnd = Math.min(ts, h + 3600);
        segments.push([h, segEnd - cur]);
        cur = segEnd;
      }
    } else {
      segments.push([tu.hourFloor(ts), 1]);
    }

    const baselines = this.data.torrent_base || (this.data.torrent_base = {});
    // 本轮每个站的增量累加，最后一次性写桶，避免逐种子反复改对象
    const siteInc = {};
    let recorded = 0;

    for (const r of rows) {
      const hash = String(r.hash || '');
      if (!hash) continue;
      const key = r.site || NO_SITE_KEY;
      const upNow = Number(r.up) || 0, dlNow = Number(r.dl) || 0;
      const b = baselines[hash];
      if (!b) {
        // 首次见到这个种子：只建基线不记账。
        // 它的 downloaded 可能已经是几十 GB 的历史累计，记进来就是一次假流量。
        baselines[hash] = { up: upNow, dl: dlNow, site: key, ts };
        continue;
      }
      let du = upNow - (Number(b.up) || 0);
      let dd = dlNow - (Number(b.dl) || 0);
      // 负值 = 重新校验 / 换文件 / 计数器归零：按 0 计并重建基线
      if (!(du > 0)) du = 0;
      if (!(dd > 0)) dd = 0;
      // 单种子单轮上限：一个种子一小时涨超 1TB 必是异常
      if (du >= MAX_SITE_STEP) du = 0;
      if (dd >= MAX_SITE_STEP) dd = 0;
      if (du || dd) {
        const s = siteInc[key] || (siteInc[key] = { up: 0, dl: 0 });
        s.up += du; s.dl += dd;
        recorded++;
      }
      // 归属变化时更新记录里的站（不影响已记的账，只影响下一轮记到哪）
      b.up = upNow; b.dl = dlNow; b.site = key; b.ts = ts;
    }

    let changed = false;
    for (const key in siteInc) {
      const inc = siteInc[key];
      if (!inc.up && !inc.dl) continue;
      if (!this.data.site_hourly[key]) this.data.site_hourly[key] = {};
      const buckets = this.data.site_hourly[key];
      for (const [h, w] of segments) {
        const meta = tu.hourMeta(h);
        const k = String(h);
        const bk = buckets[k] || (buckets[k] = { day: meta.day, week: meta.week, month: meta.month, year: meta.year, dl_bytes: 0, up_bytes: 0 });
        const s = span > 0 ? (w / span) : 1;
        bk.dl_bytes += Math.round(inc.dl * s);
        bk.up_bytes += Math.round(inc.up * s);
      }
      changed = true;
    }

    // 站点元信息与活跃时间
    if (siteInfo) {
      for (const key in siteInfo) {
        if (!key || !String(key).trim()) continue;
        this._siteMeta(key, siteInfo[key]);
        const mm = this.data.site_meta[key];
        if (mm) mm.last_seen = ts;
      }
    }
    this.data.site_last_ts = ts;
    this._trimTorrentBase(ts);
    if (changed) this.touch();
    return { changed, recorded };
  }

  /** 种子基线表清理：默认保留 30 天没出现过的 hash（防止换种频繁的用户表无限膨胀） */
  _trimTorrentBase(now) {
    const base = this.data.torrent_base;
    if (!base) return;
    const keys = Object.keys(base);
    if (keys.length <= MAX_TORRENT_BASE) return;
    const cutoff = (now || Math.floor(Date.now() / 1000)) - 30 * 86400;
    for (const h of keys) {
      if ((base[h].ts || 0) < cutoff) delete base[h];
    }
    // 仍然超限就按最久未见淘汰
    const rest = Object.keys(base);
    if (rest.length > MAX_TORRENT_BASE) {
      rest.sort((a, b) => (base[a].ts || 0) - (base[b].ts || 0));
      for (const h of rest.slice(0, rest.length - MAX_TORRENT_BASE)) delete base[h];
    }
  }

  /** 站点周期汇总：[{key,name,full,host,known,day,week,month,year,all,...}] */
  siteTotals() {
    const now = Math.floor(Date.now() / 1000);
    const cur = { day: tu.dayKey(now), week: tu.weekKey(now), month: tu.monthKey(now), year: tu.yearKey(now) };
    const out = [];
    const keys = new Set([...Object.keys(this.data.site_hourly), ...Object.keys(this.data.site_meta)]);
    for (const key of keys) {
      // 历史版本可能写入过空 key 的"幽灵站点"（旧版 collector 用 identify('') 兜底）。
      // 汇总时跳过，避免它继续占据排行首位。
      if (!key || !String(key).trim()) continue;
      const buckets = this.data.site_hourly[key] || {};
      const acc = {
        day: { dl: 0, up: 0 }, week: { dl: 0, up: 0 }, month: { dl: 0, up: 0 },
        year: { dl: 0, up: 0 }, all: { dl: 0, up: 0 }
      };
      for (const k in buckets) {
        const b = buckets[k];
        const dl = b.dl_bytes || 0, up = b.up_bytes || 0;
        if (!dl && !up) continue;
        acc.all.dl += dl; acc.all.up += up;
        if (b.day === cur.day) { acc.day.dl += dl; acc.day.up += up; }
        if (b.week === cur.week) { acc.week.dl += dl; acc.week.up += up; }
        if (b.month === cur.month) { acc.month.dl += dl; acc.month.up += up; }
        if (b.year === cur.year) { acc.year.dl += dl; acc.year.up += up; }
      }
      const m = this.data.site_meta[key] || { name: key, full: '', known: false };
      out.push({
        key, name: m.name || key, full: m.full || '', host: m.host || '',
        known: !!m.known, last_seen: m.last_seen || 0,
        day: acc.day, week: acc.week, month: acc.month, year: acc.year, all: acc.all,
        total: acc.all.up + acc.all.dl
      });
    }
    // 有流量的排前面；同流量按站点名稳定排序，避免界面每次刷新跳位
    return out.sort((a, b) => (b.total - a.total) || String(a.name).localeCompare(String(b.name)));
  }

  /* ---------- 查询 ---------- */
  enabledIds() { return this.listDownloaders().filter(d => d.enabled).map(d => d.id); }
  /** 显示用下载器列表：只返回用户自己配置的真实下载器，演示数据已彻底移除 */
  displayDownloaders() {
    return this.listDownloaders().filter(d => !d.demo);
  }

  // 四周期汇总（按启用下载器）
  periodTotals() {
    const ids = this.displayDownloaders().filter(d => d.enabled).map(d => d.id);
    const now = Math.floor(Date.now() / 1000);
    const cur = { day: tu.dayKey(now), week: tu.weekKey(now), month: tu.monthKey(now), year: tu.yearKey(now) };
    const out = { day: { dl: 0, up: 0 }, week: { dl: 0, up: 0 }, month: { dl: 0, up: 0 }, year: { dl: 0, up: 0 }, all: { dl: 0, up: 0 } };
    for (const id of ids) {
      const buckets = this.data.hourly[id] || {};
      for (const k in buckets) {
        const b = buckets[k];
        out.all.dl += b.dl_bytes; out.all.up += b.up_bytes;
        if (b.day === cur.day) { out.day.dl += b.dl_bytes; out.day.up += b.up_bytes; }
        if (b.week === cur.week) { out.week.dl += b.dl_bytes; out.week.up += b.up_bytes; }
        if (b.month === cur.month) { out.month.dl += b.dl_bytes; out.month.up += b.up_bytes; }
        if (b.year === cur.year) { out.year.dl += b.dl_bytes; out.year.up += b.up_bytes; }
      }
    }
    return out;
  }

  // 单下载器四周期（详情用）
  periodTotalsFor(id) {
    const now = Math.floor(Date.now() / 1000);
    const cur = { day: tu.dayKey(now), week: tu.weekKey(now), month: tu.monthKey(now), year: tu.yearKey(now) };
    const out = { day: { dl: 0, up: 0 }, week: { dl: 0, up: 0 }, month: { dl: 0, up: 0 }, year: { dl: 0, up: 0 }, all: { dl: 0, up: 0 } };
    const buckets = this.data.hourly[id] || {};
    for (const k in buckets) {
      const b = buckets[k];
      out.all.dl += b.dl_bytes; out.all.up += b.up_bytes;
      if (b.day === cur.day) { out.day.dl += b.dl_bytes; out.day.up += b.up_bytes; }
      if (b.week === cur.week) { out.week.dl += b.dl_bytes; out.week.up += b.up_bytes; }
      if (b.month === cur.month) { out.month.dl += b.dl_bytes; out.month.up += b.up_bytes; }
      if (b.year === cur.year) { out.year.dl += b.dl_bytes; out.year.up += b.up_bytes; }
    }
    return out;
  }

  // 历史周期下拉：按 gran 返回最近 count 期的合计
  periodSeries(gran) {
    const g = tu.GRAN[gran] || tu.GRAN.day;
    const now = Math.floor(Date.now() / 1000);
    const curKey = g.key(now);
    const ids = this.displayDownloaders().filter(d => d.enabled).map(d => d.id);
    const sums = {};
    for (const id of ids) {
      const buckets = this.data.hourly[id] || {};
      for (const k in buckets) {
        const b = buckets[k];
        const key = b[gran];
        if (!key) continue;
        if (!sums[key]) sums[key] = { dl: 0, up: 0 };
        sums[key].dl += b.dl_bytes; sums[key].up += b.up_bytes;
      }
    }
    const items = [];
    let key = curKey;
    for (let i = 0; i < g.count; i++) {
      const s = sums[key] || { dl: 0, up: 0 };
      items.push({ offset: i, key, label: tu.labelFor(gran, key), up: s.up, dl: s.dl });
      key = g.shift(key, -1);
    }
    return { gran, items };
  }

  // 总览
  overview() {
    const dls = this.displayDownloaders();
    const total = { dl_rate: 0, up_rate: 0, online: 0, count: dls.length, ...this.periodTotals() };
    const list = dls.map(d => {
      const st = this.getState(d.id);
      const per = this.periodTotalsFor(d.id);
      if (d.enabled && st.status === 'online') { total.dl_rate += st.dl_rate || 0; total.up_rate += st.up_rate || 0; total.online++; }
      return {
        id: d.id, name: d.name, type: d.type, url: d.url, enabled: d.enabled,
        color_up: d.color_up, color_down: d.color_down, has_password: !!d.password,
        status: st.status, error: st.error || '', last_seen: st.last_seen,
        dl_rate: st.dl_rate || 0, up_rate: st.up_rate || 0, extra: st.extra || {},
        ...per
      };
    });
    return {
      server_time: Math.floor(Date.now() / 1000),
      tz_offset: tu.getTzOffset(),
      collector: this.collectorInfo(),
      total, downloaders: list
    };
  }
  setCollectorInfo(info) { this._collectorInfo = info; }
  collectorInfo() { return this._collectorInfo || { rate_interval: this.data.settings.poll_interval, traffic_interval: this.data.settings.traffic_interval, ticks: 0, last_tick: 0, last_error: '' }; }
}

module.exports = { Store, SUMMARY_UP, SUMMARY_DOWN, PALETTE };
