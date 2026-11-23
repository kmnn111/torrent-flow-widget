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
    // ⚠️ 必须显式给 Content-Length。若把字符串直接交给 req.write()，Node 会用
    // transfer-encoding: chunked；qBittorrent 的 /api/v2/auth/login 不解析 chunked body，
    // 它会把「0x20」这种块长度当成 HTTP 头（日志里 invalid http header: "20"），
    // 导致收到的用户名是空的 → 记为一次失败登录。每 5 秒重试，连续 5 次后 qB
    // 把本机 IP 封进内存黑名单，之后即使密码正确也一律「用户名或密码错误」。
    // 转成 Buffer + 显式长度后走普通定长请求，不再触发 chunked。
    let bodyBuf = null;
    if (body != null && body !== '') {
      bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      if (!h['Content-Type']) h['Content-Type'] = 'application/x-www-form-urlencoded';
      if (!h['Content-Length'] && !h['content-length']) h['Content-Length'] = String(bodyBuf.length);
    }
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
    if (bodyBuf) req.write(bodyBuf);
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
    if (!this.cookie) await this.login();
    let res = await request(this.base + '/api/v2/torrents/info', { timeout: this.timeout, cookie: this.cookie, headers: this._originHeaders() });
    if (res.status === 401 || res.status === 403) { // cookie 过期：重登一次再取
      this.cookie = ''; this.rid = 0;
      await this.login();
      res = await request(this.base + '/api/v2/torrents/info', { timeout: this.timeout, cookie: this.cookie, headers: this._originHeaders() });
    }
    if (res.status !== 200) return { counts: null, list: [] };
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
    return { counts, total_size: size, list: arr.map(qbTorrent) };
  }

  /**
   * 单个种子的 tracker 列表（用于 tracker 字段为空的种子反查站点）
   * qBittorrent 的 torrents/info 里 tracker 只有「当前生效的一个」，
   * 实测有 17% 的种子该字段为空，但其 trackers 接口仍能列出全部 tracker。
   */
  async trackers(hash) {
    if (!hash) return [];
    if (!this.cookie) await this.login();
    const res = await request(`${this.base}/api/v2/torrents/trackers?hash=${encodeURIComponent(hash)}`,
      { timeout: this.timeout, cookie: this.cookie, headers: this._originHeaders() });
    if (res.status !== 200) return [];
    let arr = [];
    try { arr = JSON.parse(res.body); } catch (e) { return []; }
    // tier < 0 的是 DHT / PeX / LSD 等非站点来源，不是 PT 站，必须排除
    return (Array.isArray(arr) ? arr : [])
      .filter(x => Number(x.tier) >= 0 && x.url)
      .map(x => String(x.url));
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
    const fields = [
      'status', 'sizeWhenDone', 'totalSize', 'error', 'rateDownload', 'rateUpload',
      'name', 'hashString', 'percentDone', 'uploadedEver', 'downloadedEver',
      'leftUntilDone', 'eta', 'addedDate', 'tracker', 'labels', 'uploadRatio'
    ];
    const a = await this.rpc('torrent-get', { fields });
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
    return { counts, total_size: size, list: arr.map(trTorrent) };
  }
  /** 单种子 tracker 列表；Transmission 的 torrent-get 已含 tracker 字段，
      这里保留同名接口以对齐 qB，返回 [{announce}] 形式由上层统一处理 */
  async trackers(hash) {
    if (!hash) return [];
    const a = await this.rpc('torrent-get', { ids: [hash], fields: ['trackerStats'] });
    const t = (a.torrents || [])[0] || {};
    return (t.trackerStats || []).map(x => String(x.announce || '')).filter(Boolean);
  }
}

/* ==================== 种子明细归一化 ====================
   两个客户端字段命名完全不同（qb: dlspeed/upspeed/uploaded/downloaded，
   tr: rateDownload/rateUpload/uploadedEver/downloadedEver，状态还是数字枚举），
   统一成一套结构，上层（种子列表 / 站点流量）就不必到处判类型。 */

/** qBittorrent 的 state 归一为语义状态 */
function qbState(s) {
  const v = String(s || '');
  if (v === 'downloading' || v === 'metaDL' || v === 'forcedDL' || v === 'allocating') return 'downloading';
  if (v === 'uploading' || v === 'forcedUP') return 'uploading';
  if (v === 'seeding') return 'seeding';
  if (v === 'stalledDL') return 'stalled';
  if (v === 'stalledUP') return 'seeding';
  if (v.indexOf('paused') === 0 || v === 'stoppedDL' || v === 'stoppedUP') return 'paused';
  if (v.indexOf('error') === 0 || v === 'missingFiles') return 'error';
  if (v.indexOf('check') >= 0 || v.indexOf('moving') >= 0) return 'checking';
  return 'other';
}

function qbTorrent(t) {
  const size = positiveInt(t.size);
  const done = positiveInt(t.completed);
  return {
    hash: String(t.hash || ''),
    name: String(t.name || '(未命名)'),
    size,
    // qB 的 progress 已是 0~1 比例
    progress: Math.max(0, Math.min(1, Number(t.progress) || 0)),
    state: qbState(t.state),
    raw_state: String(t.state || ''),
    dl_rate: positiveFloat(t.dlspeed),
    up_rate: positiveFloat(t.upspeed),
    downloaded: positiveInt(t.downloaded),
    uploaded: positiveInt(t.uploaded),
    eta: Number.isFinite(Number(t.eta)) && Number(t.eta) > 0 && Number(t.eta) < 8640000 ? Number(t.eta) : 0,
    added_on: positiveInt(t.added_on),
    tracker: String(t.tracker || ''),
    category: String(t.category || ''),
    ratio: Number(t.ratio) || 0,
    amount_left: Math.max(0, size - done)
  };
}

/** Transmission 的 status 数字 → 语义状态（0停 1待检 2检查 3下载 4待种 5种子 6停止中） */
function trState(st, err) {
  const n = Number(st);
  if (err) return 'error';
  if (n === 3 || n === 1 || n === 2) return n === 3 ? 'downloading' : 'checking';
  if (n === 4 || n === 5) return 'seeding';
  if (n === 6) return 'paused';
  if (n === 0) return 'paused';
  return 'other';
}

function trTorrent(t) {
  const size = positiveInt(t.totalSize || t.sizeWhenDone);
  const downloaded = positiveInt(t.downloadedEver);
  const left = positiveInt(t.leftUntilDone);
  // Transmission 不直接给 progress，用「已下载 / (已下载 + 待下载)」推算；
  // 播种完成时 left=0，此时恒为 1。
  const progress = size > 0 ? Math.max(0, Math.min(1, (size - left) / size)) : (left === 0 ? 1 : 0);
  return {
    hash: String(t.hashString || ''),
    name: String(t.name || '(未命名)'),
    size,
    progress,
    state: trState(t.status, t.error),
    raw_state: String(t.status),
    dl_rate: positiveFloat(t.rateDownload),
    up_rate: positiveFloat(t.rateUpload),
    downloaded,
    uploaded: positiveInt(t.uploadedEver),
    eta: Number.isFinite(Number(t.eta)) && Number(t.eta) > 0 ? Number(t.eta) : 0,
    added_on: positiveInt(t.addedDate),
    tracker: String(t.tracker || ''),
    category: String(t.labels && t.labels.length ? t.labels.join(',') : ''),
    ratio: Number(t.uploadRatio) || 0,
    amount_left: left
  };
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

module.exports = {
  QBClient, TRClient, makeClient, increment, shortVersion, positiveInt, positiveFloat,
  qbTorrent, trTorrent, qbState, trState
};
