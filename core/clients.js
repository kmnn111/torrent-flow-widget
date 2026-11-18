'use strict';
/**
 * 下载器客户端 — 移植自原项目 clients.py
 * qBittorrent：Cookie(SID) 认证，读 server_state.alltime_dl / alltime_ul
 * Transmission：Basic Auth + X-Transmission-Session-Id，读 cumulative-stats.downloadedBytes / uploadedBytes
 * 核心原则：流量只来自累计计数器差值，绝不用「速率 × 时间」估算。
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

const MAX_ONE_TICK = Math.pow(2, 40); // 单周期 1 TiB 视为异常跳变（注意：JS 位运算是 32 位，不能用 1<<40）

function positiveInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
function positiveFloat(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 通用 HTTP 请求，返回 {status, headers, body(String)}；支持 cookie 注入/收集 */
function request(url, { method = 'GET', headers = {}, body = null, timeout = 5000, cookie = '' } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('无效的地址')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('仅支持 http/https 地址'));
    const mod = u.protocol === 'https:' ? https : http;
    const h = Object.assign({}, headers);
    if (cookie) h['Cookie'] = cookie;
    if (body && !h['Content-Type']) h['Content-Type'] = 'application/x-www-form-urlencoded';
    const req = mod.request(u, { method, headers: h, timeout }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        setCookie: res.headers['set-cookie'] || []
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ==================== qBittorrent ==================== */
class QBClient {
  constructor(cfg, timeout = 5000) {
    this.base = String(cfg.url || '').replace(/\/+$/, '');
    this.username = cfg.username || '';
    this.password = cfg.password || '';
    this.timeout = timeout;
    this.cookie = '';
    this.rid = 0;
    this._totals = { dl: null, ul: null };
  }
  _originHeaders() {
    let origin = '';
    try { const u = new URL(this.base); origin = `${u.protocol}//${u.host}`; } catch (e) { }
    return origin ? { Origin: origin, Referer: this.base + '/' } : {};
  }
  _collectCookie(setCookies) {
    const parts = [];
    for (const sc of setCookies || []) {
      const kv = String(sc).split(';')[0].trim();
      if (kv) parts.push(kv);
    }
    if (parts.length) this.cookie = parts.join('; ');
  }
  async login() {
    const body = new URLSearchParams({ username: this.username, password: this.password }).toString();
    const res = await request(this.base + '/api/v2/auth/login', {
      method: 'POST', body, timeout: this.timeout,
      headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, this._originHeaders())
    });
    this._collectCookie(res.setCookie);
    if (res.status === 200 && /Ok/i.test(res.body)) return true;
    if (/Ip is banned|banned/i.test(res.body)) throw new Error('IP 被下载器临时封禁');
    throw new Error('用户名或密码错误');
  }
  _totalsFrom(st) {
    const hasDl = Object.prototype.hasOwnProperty.call(st, 'alltime_dl');
    const hasUl = Object.prototype.hasOwnProperty.call(st, 'alltime_ul');
    if (hasDl) this._totals.dl = positiveInt(st.alltime_dl);
    if (hasUl) this._totals.ul = positiveInt(st.alltime_ul);
    const src = hasDl && hasUl ? 'live' : (hasDl || hasUl ? 'partial' : 'cached');
    return { dl: this._totals.dl, up: this._totals.ul, src };
  }
  async _fetchMain() {
    const res = await request(`${this.base}/api/v2/sync/maindata?rid=${this.rid}`, {
      timeout: this.timeout, cookie: this.cookie, headers: this._originHeaders()
    });
    if (res.status === 401 || res.status === 403) {
      this.cookie = ''; this.rid = 0;
      await this.login();
      return this._fetchMain();
    }
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const data = JSON.parse(res.body);
    if (Number.isFinite(data.rid)) this.rid = data.rid;
    this._collectCookie(res.setCookie);
    return data.server_state || {};
  }
  async fetch() {
    if (!this.cookie) await this.login();
    let st;
    try {
      st = await this._fetchMain();
    } catch (e) {
      // 降级 transfer/info（无 alltime_*，沿用缓存，差值记 0）
      try {
        const res = await request(this.base + '/api/v2/transfer/info', { timeout: this.timeout, cookie: this.cookie, headers: this._originHeaders() });
        if (res.status === 200) st = JSON.parse(res.body);
        else st = {};
      } catch (e2) { st = {}; }
    }
    const totals = this._totalsFrom(st);
    const extra = {
      source: totals.src,
      connection_status: st.connection_status || '',
      free_space: positiveInt(st.free_space_on_disk),
      session_dl: positiveInt(st.dl_info_data),
      session_ul: positiveInt(st.up_info_data),
      queued_io: positiveInt(st.queued_io_jobs)
    };
    return {
      dl_rate: positiveFloat(st.dl_info_speed),
      up_rate: positiveFloat(st.up_info_speed),
      dl_total: totals.dl, up_total: totals.up, extra
    };
  }
  async version() {
    const res = await request(this.base + '/api/v2/app/version', { timeout: this.timeout, cookie: this.cookie, headers: this._originHeaders() });
    return res.status === 200 ? res.body.trim() : '';
  }
  async torrents() {
    const res = await request(this.base + '/api/v2/torrents/info', { timeout: this.timeout, cookie: this.cookie, headers: this._originHeaders() });
    if (res.status !== 200) return [];
    const arr = JSON.parse(res.body);
    const counts = { total: arr.length, seeding: 0, uploading: 0, downloading: 0, paused: 0, error: 0, checking: 0 };
    let size = 0;
    for (const t of arr) {
      size += positiveInt(t.size);
      const s = t.state || '';
      if (s === 'seeding') counts.seeding++;
      else if (s === 'uploading') counts.uploading++;
      else if (s === 'downloading') counts.downloading++;
      else if (s.indexOf('paused') === 0) counts.paused++;
      else if (s.indexOf('error') === 0) counts.error++;
      else if (s.indexOf('check') >= 0) counts.checking++;
    }
    return { counts, total_size: size };
  }
}

/* ==================== Transmission ==================== */
class TRClient {
  constructor(cfg, timeout = 5000) {
    let u = String(cfg.url || '').replace(/\/+$/, '');
    if (!u.endsWith('/transmission/rpc')) u += '/transmission/rpc';
    this.url = u;
    this.username = cfg.username || '';
    this.password = cfg.password || '';
    this.timeout = timeout;
    this.sessionId = '';
    this._totals = { dl: null, ul: null };
  }
  async rpc(method, args = {}) {
    const body = JSON.stringify({ method, arguments: args });
    const headers = { 'Content-Type': 'application/json' };
    if (this.sessionId) headers['X-Transmission-Session-Id'] = this.sessionId;
    if (this.username || this.password) {
      const token = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      headers['Authorization'] = 'Basic ' + token;
    }
    let res = await request(this.url, { method: 'POST', body, headers, timeout: this.timeout });
    if (res.status === 409) {
      this.sessionId = String(res.headers['x-transmission-session-id'] || res.headers['X-Transmission-Session-Id'] || '');
      if (!this.sessionId) throw new Error('无法获取 Transmission Session ID');
      headers['X-Transmission-Session-Id'] = this.sessionId;
      res = await request(this.url, { method: 'POST', body, headers, timeout: this.timeout });
    }
    if (res.status === 401 || res.status === 403) throw new Error('用户名或密码错误');
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const data = JSON.parse(res.body);
    if (data.result !== 'success') throw new Error(data.result || 'RPC 调用失败');
    return data.arguments || {};
  }
  _totalsFrom(a) {
    const cs = a['cumulative-stats'] || a.cumulative_stats || {};
    const hasDl = Object.prototype.hasOwnProperty.call(cs, 'downloadedBytes');
    const hasUl = Object.prototype.hasOwnProperty.call(cs, 'uploadedBytes');
    if (hasDl) this._totals.dl = positiveInt(cs.downloadedBytes);
    if (hasUl) this._totals.ul = positiveInt(cs.uploadedBytes);
    const src = hasDl && hasUl ? 'live' : (hasDl || hasUl ? 'partial' : 'cached');
    return { dl: this._totals.dl, up: this._totals.ul, src };
  }
  async fetch() {
    const a = await this.rpc('session-stats');
    const totals = this._totalsFrom(a);
    return {
      dl_rate: positiveFloat(a.downloadSpeed),
      up_rate: positiveFloat(a.uploadSpeed),
      dl_total: totals.dl, up_total: totals.up,
      extra: {
        source: totals.src,
        active: positiveInt(a.activeTorrentCount),
        total_torrents: positiveInt(a.torrentCount)
      }
    };
  }
  async version() {
    const a = await this.rpc('session-get');
    return String(a.version || '');
  }
  async torrents() {
    const a = await this.rpc('torrent-get', { fields: ['status', 'sizeWhenDone', 'error', 'rateDownload', 'rateUpload'] });
    const arr = a.torrents || [];
    const counts = { total: arr.length, seeding: 0, uploading: 0, downloading: 0, paused: 0, error: 0, checking: 0 };
    let size = 0;
    for (const t of arr) {
      size += positiveInt(t.sizeWhenDone);
      const st = Number(t.status);
      if (st === 4 || st === 5 || st === 6) counts.seeding++;
      else if (st === 3) counts.downloading++;
      else if (st === 0) counts.paused++;
      else if (t.error) counts.error++;
      else if (st === 2) counts.checking++;
    }
    return { counts, total_size: size };
  }
}

function makeClient(cfg, timeout) {
  const t = Number(timeout) || 5000;
  return cfg.type === 'tr' ? new TRClient(cfg, t) : new QBClient(cfg, t);
}

/** 累计计数器差分 — 唯一流量来源 */
function increment(total, previous) {
  if (total == null) return { inc: 0, event: 'missing' };
  if (previous == null) return { inc: 0, event: 'no_base' };
  const delta = Math.floor(Number(total)) - Math.floor(Number(previous));
  if (delta < 0) return { inc: 0, event: 'reset' };
  if (delta > MAX_ONE_TICK) return { inc: 0, event: 'spike' };
  return { inc: delta, event: 'ok' };
}

function shortVersion(v) {
  const m = String(v || '').match(/\d+(\.\d+)+/);
  return m ? m[0] : String(v || '');
}

module.exports = { QBClient, TRClient, makeClient, increment, shortVersion, positiveInt, positiveFloat };
