'use strict';
/**
 * 流量台 · 界面主逻辑
 * 承袭云上晴雨的桌面机制接口（window.flow），内容替换为流量监控。
 */
(() => {
  const $ = id => document.getElementById(id);
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const RATE_RANGES = [['live', '实时'], ['1h', '近 1 小时'], ['6h', '近 6 小时'], ['12h', '近 12 小时'], ['rate24', '近 24 小时']];
  const TRAFFIC_RANGES = [['24h', '今日'], ['yesterday', '昨日'], ['week', '本周'], ['lastweek', '上周'], ['month', '本月'], ['lastmonth', '上月'], ['year', '本年'], ['all', '全部']];
  const DIR_OPTS = [['both', '双向'], ['up', '仅上传'], ['down', '仅下载']];
  const RATE_CHOICES = [0.1, 0.2, 0.5, 1, 3, 5, 10];
  const TRAFFIC_CHOICES = [5, 10, 30, 60, 300, 600, 1800];
  const LIVE_CHOICES = [30, 60, 180, 300, 600, 1800];

  const state = {
    settings: null, collect: null,
    overview: null, downloaders: [], isDemo: false,
    periods: { day: null, week: null, month: null, year: null },
    rate: { range: 'live', dir: 'both', offset: 0, data: null, hover: null },
    traffic: { range: '24h', dir: 'both', offset: 0, data: null, hover: null },
    chartPick: new Set(['all']), // 选中的下载器（'all' 或 id 字符串）
    _chartReq: { rate: 0, traffic: 0 }, // 图表请求序号，防旧回包覆盖新范围
    _periodReq: { day: 0, week: 0, month: 0, year: 0 },
    activeTorrents: { at: 0, list: [], total_up_rate: 0 },
    siteData: { at: 0, sites: [] },
    sitePeriod: 'day', // PT 站点模块当前查看的周期：今日 / 本周 / 总计
    refreshTimer: null, lastUpdate: 0, fetching: false
  };

  /* ================= 格式化 ================= */
  function fmtBytes(n, digits) {
    n = Number(n) || 0;
    if (n < 0) return '-' + fmtBytes(-n, digits);
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    const d = digits != null ? digits : (i === 0 ? 0 : (v < 10 ? 2 : (v < 100 ? 1 : 0)));
    return v.toFixed(d) + ' ' + units[i];
  }
  function fmtRate(n) {
    n = Number(n) || 0;
    if (n <= 0) return '0 B/s';
    return fmtBytes(n, n < 1024 ? 0 : (n < 10240 ? 1 : 0)) + '/s';
  }
  const fmtSpanTitle = (a, b) => {
    const f = t => { const d = new Date((Number(t) + 8 * 3600) * 1000); return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
    return f(a) + ' ~ ' + f(b);
  };
  const fmtSpanMid = sp => {
    const t = (Number(sp[0]) + Number(sp[1])) / 2;
    const d = new Date((t + 8 * 3600) * 1000);
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };

  /* ================= 时钟与天空 ================= */
  function tickClock() {
    const now = new Date();
    $('clockHM').textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
    $('clockSec').textContent = pad(now.getSeconds());
    $('pillTime').textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
    $('pillSec').textContent = pad(now.getSeconds());
    const wd = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    const dateStr = `${now.getMonth() + 1}月${now.getDate()}日 周${wd}`;
    $('dateLine').textContent = dateStr;
    $('pillDate').textContent = dateStr;
    // 昼夜：按当前时间（简化：6:00–18:00 为昼，接入后可改为按地区日出日落）
    // window.__forceNight 供截图/调试强制指定，否则每秒 tick 会把外部手动加的 .night 类冲掉
    const isDay = now.getHours() >= 6 && now.getHours() < 18;
    const forced = window.__forceNight;
    document.documentElement.classList.toggle('night', forced == null ? !isDay : !!forced);
    // 数据超龄补刷（60s 粒度，窗口隐藏时不刷）
    const ms = Date.now();
    if (ms - lastStaleCheck > 60000) {
      lastStaleCheck = ms;
      if (!document.hidden && state.lastUpdate && ms - state.lastUpdate > 15000) refreshAll(false);
    }
  }
  let lastStaleCheck = 0;

  /* ================= 数据加载 ================= */
  async function refreshAll(animate) {
    if (state.fetching) return;
    // 窗口隐藏（收起小窗 / 最小化）时不做无意义的整屏刷新：既省电也避免隐藏期间堆积请求
    if (document.hidden) return;
    state.fetching = true;
    try {
      const [overview, isDemo] = await Promise.all([
        window.flow.overview(), window.flow.isDemo()
      ]);
      state.overview = overview;
      state.isDemo = isDemo;
      state.downloaders = overview.downloaders || [];
      state.lastUpdate = Date.now();
      renderHero();
      renderSummary();
      renderDownloaders();
      await Promise.all([
        loadPeriod('day'), loadPeriod('week'), loadPeriod('month'), loadPeriod('year'),
        loadChart('rate'), loadChart('traffic'),
        loadActiveTorrents(), loadSites()
      ]);
      updateTrayInfo();
    } catch (e) {
      console.error('[app] refresh failed', e);
    } finally { state.fetching = false; }
  }
  async function loadPeriod(gran) {
    const req = (state._periodReq[gran] || 0) + 1;
    state._periodReq[gran] = req;
    try {
      const data = await window.flow.periods(gran);
      if (state._periodReq[gran] !== req) return; // 丢弃过期回包
      state.periods[gran] = data;
      renderSummary();
    } catch (e) { }
  }
  async function loadChart(which) {
    const st = state[which];
    // 请求序号：快速切换范围/回看时，旧回包可能晚于新回包到达，必须丢弃过期结果，
    // 否则图表会显示错的时间范围（与天气台搜索/切城同类竞态）
    const req = (state._chartReq[which] || 0) + 1;
    state._chartReq[which] = req;
    const range = st.range, offset = st.offset;
    try {
      const data = await window.flow.chart({ range, metric: which, offset });
      if (state._chartReq[which] !== req) return; // 已有更新的请求，丢弃本次回包
      st.data = data;
      if (which === 'rate') drawRate(animateFlag); else drawTraffic(animateFlag);
    } catch (e) { if (state._chartReq[which] === req) console.error('[app] chart ' + which, e); }
  }
  let animateFlag = false;

  /* ================= 渲染 Hero ================= */
  function renderHero() {
    const o = state.overview; if (!o) return;
    const t = o.total || {};
    $('heroUp').textContent = '↑ ' + fmtRate(t.up_rate);
    $('heroDown').textContent = '↓ ' + fmtRate(t.dl_rate);
    // 小窗实时速率
    $('pillUp').textContent = '↑ ' + fmtRate(t.up_rate);
    $('pillDown').textContent = '↓ ' + fmtRate(t.dl_rate);
    const today = t.day || {};
    $('pillTodayUp').textContent = '今 ↑' + fmtBytes(today.up);
    $('pillTodayDown').textContent = '今 ↓' + fmtBytes(today.dl);
    const online = t.online || 0, count = t.count || 0;
    const hp = $('healthPill');
    hp.classList.toggle('off', online === 0 && count > 0);
    $('healthTxt').textContent = state.isDemo ? '演示数据' : (count ? `${online}/${count} 在线` : '未配置下载器');
    $('srcLine').textContent = state.isDemo
      ? '演示数据 · 在设置里添加下载器后自动切换为真实数据'
      : (count ? `累计计数器差分统计 · ${count} 台下载器` : '未配置下载器 · 请在设置里添加');
    $('lastUpdate').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  /* ================= 渲染四周期卡片 ================= */
  function renderSummary() {
    const o = state.overview; if (!o) return;
    const defs = [
      ['day', '今日'], ['week', '本周'], ['month', '本月'], ['year', '本年']
    ];
    const box = $('summaryCards');
    box.innerHTML = defs.map(([key, label]) => {
      const v = (o.total && o.total[key]) || { up: 0, dl: 0 };
      const hist = state.periods[key];
      let histHtml = '';
      if (hist && hist.items && hist.items.length > 1) {
        const it = hist.items[0];
        histHtml = `<span class="sum-history" data-period="${key}" title="点击查看历史数据">历史数据 ▾</span>`;
      }
      return `<div class="sum-card" data-summary="${key}">
        <div class="sum-period"><span>${label}</span><span class="sum-range">${esc(key === 'day' ? '' : (v.up ? '' : ''))}</span></div>
        <div class="sum-vals">
          <div class="sum-row up"><span class="lbl">上传</span><span class="num">${fmtBytes(v.up)}</span></div>
          <div class="sum-row down"><span class="lbl">下载</span><span class="num">${fmtBytes(v.dl)}</span></div>
        </div>
        ${histHtml}
      </div>`;
    }).join('');
    box.querySelectorAll('.sum-card').forEach(el => {
      el.addEventListener('click', () => showSummaryDetail(el.getAttribute('data-summary')));
    });
    box.querySelectorAll('.sum-history').forEach(el => {
      el.addEventListener('click', e => { e.stopPropagation(); showPeriodHistory(el.getAttribute('data-period')); });
    });
  }

  /* ================= 渲染下载器列表 ================= */
  function renderDownloaders() {
    const list = state.downloaders;
    const strip = $('dlStrip');
    let html = `<div class="dl-card summary" id="dlSummary">
      <div>
        <div class="dl-top"><span class="dl-name">汇总 · 全部下载器${state.isDemo ? '<span class="demo-badge">演示</span>' : ''}</span></div>
        <div class="dl-sum-rates">
          <span class="u" id="sumUp">↑ ${fmtRate(state.overview.total.up_rate)}</span>
          <span class="d" id="sumDown">↓ ${fmtRate(state.overview.total.dl_rate)}</span>
        </div>
      </div>
      <div class="dl-updated" id="sumToday">今日 ↑${fmtBytes(state.overview.total.day.up)} ↓${fmtBytes(state.overview.total.day.dl)}</div>
    </div>`;
    for (const d of list) {
      const online = d.status === 'online';
      html += `<div class="dl-card" data-dl="${d.id}">
        <div class="dl-top">
          <span class="dl-dot ${online ? '' : 'off'}" title="${online ? '在线' : '离线'}"></span>
          <span class="dl-name" title="${esc(d.name)}">${esc(d.name)}</span>
          <span class="dl-type">${d.type === 'tr' ? 'TR' : 'QB'}</span>
          <span class="dl-switch ${d.enabled ? 'on' : ''}" data-switch="${d.id}" title="加入/移出图表"></span>
        </div>
        <div class="dl-rates">
          <span class="u">↑ ${fmtRate(d.up_rate)}</span>
          <span class="d">↓ ${fmtRate(d.dl_rate)}</span>
        </div>
      </div>`;
    }
    // 真实器删光后显示明确的空态与入口，而不是一张全 0 的汇总卡让人以为程序坏了
    if (!list.length && !state.isDemo) {
      strip.innerHTML = `<div class="dl-card empty" id="dlEmpty">
        <div class="empty-title">尚未配置下载器</div>
        <div class="empty-sub">在设置里填 qBittorrent / Transmission 的地址与账号即可开始统计</div>
        <button class="pill-btn sm primary" id="btnEmptySettings">去设置</button>
      </div>`;
      $('btnEmptySettings').addEventListener('click', () => $('btnSettings').click());
      return;
    }
    strip.innerHTML = html;
    $('dlSummary').addEventListener('click', () => showSummaryDetailAll());
    strip.querySelectorAll('.dl-card[data-dl]').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.classList.contains('dl-switch')) return;
        showDlDetail(Number(el.getAttribute('data-dl')));
      });
    });
    strip.querySelectorAll('.dl-switch').forEach(el => {
      el.addEventListener('click', async e => {
        e.stopPropagation();
        const id = Number(el.getAttribute('data-switch'));
        const d = state.downloaders.find(x => x.id === id);
        if (!d) return;
        const on = !d.enabled;
        el.classList.toggle('on', on);
        d.enabled = on;
        try { await window.flow.dlUpdate(id, { ...d, password: '' }); refreshAll(false); } catch (ex) { console.error(ex); }
      });
    });
  }

  /* ================= 图表绘制 ================= */
  function adapt(hex, theme) {
    // 与 charts.js 的 adapt 口径一致：浅色主题下加深，深色下提亮（由 charts 内部处理，这里直接传原色）
    return hex;
  }
  function dirsOf(dir) { return { up: dir === 'both' || dir === 'up', down: dir === 'both' || dir === 'down' }; }
  function pickSeries(data) {
    if (!data || !data.series) return [];
    const all = state.chartPick.has('all');
    return all ? data.series : data.series.filter(s => s.id === 0 || state.chartPick.has(String(s.id)));
  }
  function drawRate(animate) {
    const st = state.rate, data = st.data; if (!data) return;
    const cv = $('rateChart');
    const dirs = dirsOf(st.dir);
    const series = pickSeries(data);
    const lines = [];
    for (const s of series) {
      const isSum = s.id === 0, width = isSum ? 1.7 : 0.9;
      const name = isSum ? '汇总' : s.name;
      const cu = adapt(s.color_up), cd = adapt(s.color_down);
      if (dirs.up) lines.push({ label: name + ' ↑', name, dir: 'up', color: cu, width, values: s.up });
      if (dirs.down) lines.push({ label: name + ' ↓', name, dir: 'down', color: cd, width, values: s.down });
    }
    TTMCharts.drawLines(cv, {
      labels: data.labels, times: data.times, lines, fmt: fmtRate, smooth: true,
      animate: !!animate, theme: document.documentElement.classList.contains('night') ? 'dark' : 'light',
      hover: st.hover, axis: $('rateAxis'), axisLabels: data.labels, edges: data.window && data.window.edges,
      empty: '该时间范围暂无采样数据，等待采集器写入…'
    });
    renderLegend('rateLegend', series, dirs, lines);
    const r = RATE_RANGES.find(x => x[0] === st.range);
    $('rateRangeTrigger').textContent = (r ? r[1] : '实时') + (st.offset ? ` · 回看${st.offset}` : '');
    $('ratePanRange').textContent = data.window ? data.window.label : '';
    $('rateLatest').hidden = !st.offset;
  }
  function drawTraffic(animate) {
    const st = state.traffic, data = st.data; if (!data) return;
    const cv = $('trafficChart');
    const dirs = dirsOf(st.dir);
    const parts = pickSeries(data).filter(s => s.id !== 0);
    const groups = data.labels.map((label, i) => {
      const upParts = parts.map(p => ({ name: p.name, color: adapt(p.color_up), value: Number(p.up[i]) || 0 }));
      const downParts = parts.map(p => ({ name: p.name, color: adapt(p.color_down), value: Number(p.down[i]) || 0 }));
      return { label, upParts, downParts,
        up: upParts.reduce((a, p) => a + p.value, 0),
        down: downParts.reduce((a, p) => a + p.value, 0) };
    });
    data._groups = groups; // 供悬停提示读取各分组数值
    const spanRange = ['24h', 'yesterday'].indexOf(st.range) >= 0;
    const tipTitles = spanRange ? (data.spans || []).map(sp => sp ? fmtSpanTitle(sp[0], sp[1]) : '') : null;
    let axisLabels = data.labels;
    if (spanRange && data.spans) axisLabels = data.spans.map(sp => sp ? fmtSpanMid(sp) : '');
    TTMCharts.drawBars(cv, {
      labels: data.labels, groups, dirs, fmt: v => fmtBytes(v), hover: st.hover,
      theme: document.documentElement.classList.contains('night') ? 'dark' : 'light',
      axis: $('trafficAxis'), axisLabels, tipTitles, empty: '该时间范围暂无数据'
    });
    renderLegend('trafficLegend', pickSeries(data), dirs, null);
    const su = groups.reduce((a, g) => a + g.up, 0), sd = groups.reduce((a, g) => a + g.down, 0);
    $('trafficSummary').innerHTML =
      `<div>区间上传<b class="u">${fmtBytes(dirs.up ? su : 0)}</b></div>` +
      `<div>区间下载<b class="d">${fmtBytes(dirs.down ? sd : 0)}</b></div>` +
      `<div>合计<b>${fmtBytes((dirs.up ? su : 0) + (dirs.down ? sd : 0))}</b></div>`;
    const rr = TRAFFIC_RANGES.find(x => x[0] === st.range);
    $('trafficRangeTrigger').textContent = (rr ? rr[1] : '今日') + (st.offset ? ` · 回看${st.offset}` : '');
    $('trafficPanRange').textContent = data.window ? data.window.label : '';
    $('trafficLatest').hidden = !st.offset;
  }
  function renderLegend(id, series, dirs, lines) {
    let html = '';
    for (const s of series) {
      const name = s.id === 0 ? '汇总' : s.name;
      if (dirs.up) html += `<span class="pair" style="color:${s.color_up}"><i class="sq" style="background:${s.color_up}"></i><b class="arw">↑</b>${esc(name)}</span>`;
      if (dirs.down) html += `<span class="pair" style="color:${s.color_down}"><i class="sq" style="background:${s.color_down}"></i><b class="arw">↓</b>${esc(name)}</span>`;
    }
    $(id).innerHTML = html;
  }

  // 后续部分见文件末尾（事件绑定与设置）
  window.__flowState = state;
  window.__flowFmt = { fmtBytes, fmtRate, esc };
  window.__flowRefresh = refreshAll;
  window.__flowLoadChart = loadChart;
  window.__flowDrawRate = drawRate;
  window.__flowDrawTraffic = drawTraffic;
  // 自检钩子：--shot 下注入下载中种子后需要手动重渲染（模块内函数无法从外部调用）
  window.__flowRenderActive = renderActiveTorrents;
  window.__flowRenderSites = renderSites;

  /* ================= 下拉交互 ================= */
  function bindDropdown(triggerId, menuId, options, current, onSelect) {
    const trig = $(triggerId), menu = $(menuId);
    function render() {
      menu.innerHTML = options.map(([v, l]) => `<button data-v="${v}" class="${v === current() ? 'active' : ''}">${esc(l)}</button>`).join('');
    }
    trig.addEventListener('click', e => { e.stopPropagation(); closeAllMenus(); render(); menu.hidden = !menu.hidden; });
    menu.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      onSelect(b.getAttribute('data-v')); menu.hidden = true;
    });
  }
  function closeAllMenus() {
    document.querySelectorAll('.dd-menu').forEach(m => m.hidden = true);
  }
  bindDropdown('rateRangeTrigger', 'rateRangeMenu', RATE_RANGES, () => state.rate.range, v => {
    state.rate.range = v; state.rate.offset = 0; state.rate.hover = null; loadChart('rate');
  });
  bindDropdown('rateDirTrigger', 'rateDirMenu', DIR_OPTS, () => state.rate.dir, v => { state.rate.dir = v; drawRate(false); });
  $('rateDirTrigger').textContent = '方向 · 双向';
  const rateDirMenu = $('rateDirMenu');
  rateDirMenu.addEventListener('click', () => {
    const v = state.rate.dir;
    $('rateDirTrigger').textContent = '方向 · ' + (DIR_OPTS.find(x => x[0] === v) || [])[1];
  });
  bindDropdown('trafficRangeTrigger', 'trafficRangeMenu', TRAFFIC_RANGES, () => state.traffic.range, v => {
    state.traffic.range = v; state.traffic.offset = 0; state.traffic.hover = null; loadChart('traffic');
  });
  bindDropdown('trafficDirTrigger', 'trafficDirMenu', DIR_OPTS, () => state.traffic.dir, v => { state.traffic.dir = v; drawTraffic(false); });
  $('trafficDirTrigger').textContent = '方向 · 双向';
  $('trafficDirMenu').addEventListener('click', () => {
    const v = state.traffic.dir;
    $('trafficDirTrigger').textContent = '方向 · ' + (DIR_OPTS.find(x => x[0] === v) || [])[1];
  });
  document.addEventListener('click', closeAllMenus);

  $('rateLatest').addEventListener('click', () => { state.rate.offset = 0; state.rate.hover = null; loadChart('rate'); });
  $('trafficLatest').addEventListener('click', () => { state.traffic.offset = 0; state.traffic.hover = null; loadChart('traffic'); });

  /* ================= 面板 / 窗口按钮 ================= */
  function openSettings() { $('settingsPanel').classList.add('open'); }
  function closeSettings() { $('settingsPanel').classList.remove('open'); }
  $('btnSettings').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', closeSettings);
  $('btnClose').addEventListener('click', () => window.flow.winAction('close'));
  $('btnPin').addEventListener('click', async () => {
    const on = await window.flow.winAction('pin');
    $('btnPin').style.color = on ? 'var(--sun-deep)' : '';
  });
  $('btnRefresh').addEventListener('click', () => refreshAll(false));
  $('btnRefreshData').addEventListener('click', () => refreshAll(false));

  /* ================= 键盘快捷键 ================= */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSettings(); $('detailModal').hidden = true; closeAllMenus(); }
    else if (e.key === 'F5') { e.preventDefault(); refreshAll(false); }
    else if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings(); }
    else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const delta = e.key === 'ArrowLeft' ? 1 : -1;
      const st = state.traffic;
      st.offset = Math.max(0, st.offset + delta);
      loadChart('traffic');
    }
  });

  /* ================= 软件更新（OTA） =================
     主进程侧（main.js）已把整条链路做完：检查 → 发现新版本 → 下载 → 重启安装。
     渲染层只负责把 update:state 翻译成人话，并提供入口按钮 —— 缺了这层，
     后端能力再完整用户也点不到，等于没有。 */
  let manualCheck = false;      // 是否手动点了「检查更新」：决定 up-to-date/error 要不要显示状态
  let lastUpdateState = null;   // 最近一次状态：横幅主按钮和设置页按钮都按它决定动作

  function setUpdateStatus(t) { const el = $('updateStatus'); if (el) el.textContent = t; }
  // 横幅显隐一律走 .show 类：hidden 属性会被 .update-banner 的 display:flex 覆盖，改了也没反应
  function hideUpdateBanner() { const b = $('updateBanner'); if (b) b.classList.remove('show'); }
  // 「稍后」按 版本+状态 记忆到 localStorage：同一版本的同一提醒只弹一次，跨启动、跨后台检查都不复发
  function dismissedKey(type, ver) { return 'updDismiss_' + type + '_' + ver; }
  function dismissUpdateBanner() {
    const s = lastUpdateState || {};
    if ((s.type === 'available' || s.type === 'downloaded') && s.version) {
      try { localStorage.setItem(dismissedKey(s.type, s.version), '1'); } catch (e) { }
    }
    hideUpdateBanner();
  }
  function showUpdateBanner(html, primaryLabel, showPrimary) {
    const b = $('updateBanner'); if (!b) return;
    $('ubText').innerHTML = html;
    const p = $('ubPrimary');
    if (p) {
      p.hidden = !showPrimary;
      if (showPrimary) { p.textContent = primaryLabel; p.disabled = false; }
    }
    b.classList.add('show');
  }
  // 受「稍后」记忆约束的提示：该提醒过就收掉横幅，没记过才弹。
  // 必须显式 hide —— 否则上一个状态（比如「正在下载 42%」）的横幅会一直挂在屏幕上，
  // 主按钮又被本状态藏掉，看起来就是一个永远不会前进的假进度条。
  function maybeBanner(type, ver, html, primaryLabel) {
    if (ver && localStorage.getItem(dismissedKey(type, ver))) hideUpdateBanner();
    else showUpdateBanner(html, primaryLabel, true);
  }
  // 设置页的动作按钮：发现新版本 → 「立即更新」；下载完成 → 「立即重启」；其余隐藏
  function setDoUpdate(label) {
    const b = $('btnDoUpdate'); if (!b) return;
    if (label) { b.hidden = false; b.textContent = label; b.disabled = false; }
    else b.hidden = true;
  }

  function onUpdateState(s) {
    if (!s || !s.type) return;
    lastUpdateState = s;
    const cur = s.current ? 'v' + esc(s.current) : '';
    switch (s.type) {
      case 'available':
        manualCheck = false;
        setUpdateStatus(`发现新版本 v${esc(s.version)}`);
        setDoUpdate('立即更新');
        maybeBanner('available', s.version,
          `发现新版本 <span class="nb"><b>v${esc(s.version)}</b>（当前 ${cur}）</span>`, '立即更新');
        break;
      case 'downloading': {
        const pct = s.percent || 0;
        const b = $('updateBanner');
        if (b) b.classList.add('show');
        const t = $('ubText'); if (t) t.innerHTML = `正在下载更新… <b>${pct}%</b>`;
        const p = $('ubPrimary'); if (p) p.hidden = true;
        setUpdateStatus(`正在下载 ${pct}%`);
        setDoUpdate(null);
        break;
      }
      case 'downloaded':
        setUpdateStatus('更新已就绪，重启后安装');
        setDoUpdate('立即重启');
        maybeBanner('downloaded', s.version,
          `<span class="nb">新版本 <b>v${esc(s.version)}</b></span> 已就绪，<span class="nb">重启后完成安装</span>`, '立即重启');
        break;
      case 'up-to-date':
        if (manualCheck) setUpdateStatus(`已是最新版本（${cur}）`);
        manualCheck = false; setDoUpdate(null); hideUpdateBanner();
        break;
      case 'unconfigured':
        if (manualCheck) setUpdateStatus('未配置更新服务器地址');
        manualCheck = false; setDoUpdate(null);
        break;
      case 'error':
        if (manualCheck) setUpdateStatus('检查失败：' + esc(s.message || '未知错误'));
        manualCheck = false; setDoUpdate(null);
        break;
    }
  }

  function bindUpdate() {
    const btnCheck = $('btnCheckUpdate');
    if (btnCheck) btnCheck.addEventListener('click', () => {
      manualCheck = true;
      setUpdateStatus('正在检查更新…');
      window.flow.updateCheck();
    });
    const btnSave = $('btnSaveUpdateUrl');
    if (btnSave) btnSave.addEventListener('click', async () => {
      const v = $('updateUrlInput').value.trim();
      state.settings = await window.flow.updateSettings({ updateUrl: v });
      // 主进程对地址做了白名单校验（https；http 仅限本机），非法值会被静默丢弃 —— 回填真实生效值
      const saved = (state.settings && state.settings.updateUrl) || '';
      $('updateUrlInput').value = saved;
      setUpdateStatus(!v ? '已清除更新服务器地址' : (saved ? '更新服务器地址已保存' : '地址无效：必须是 https（本机可 http）'));
    });
    const ubPrimary = $('ubPrimary');
    if (ubPrimary) ubPrimary.addEventListener('click', () => {
      const s = lastUpdateState || {};
      if (s.type === 'available') { ubPrimary.disabled = true; window.flow.updateDownload(); }
      else if (s.type === 'downloaded') window.flow.updateInstall();
    });
    // 设置页按钮与横幅主按钮同逻辑；下载类动作点完立即禁用，防连点重复触发
    const btnDo = $('btnDoUpdate');
    if (btnDo) btnDo.addEventListener('click', () => {
      const s = lastUpdateState || {};
      if (s.type === 'available') { btnDo.disabled = true; window.flow.updateDownload(); }
      else if (s.type === 'downloaded') window.flow.updateInstall();
    });
    const ubLater = $('ubLater');
    if (ubLater) ubLater.addEventListener('click', dismissUpdateBanner);
    // 订阅主进程状态推送，并把当前状态补一次（页面可能晚于后台检查加载完成）
    if (window.flow.onUpdateState) window.flow.onUpdateState(onUpdateState);
    if (window.flow.updateState) {
      Promise.resolve(window.flow.updateState()).then(s => { if (s && s.type && s.type !== 'idle') onUpdateState(s); }).catch(() => { });
    }
    // 回填当前更新源地址
    if ($('updateUrlInput')) $('updateUrlInput').value = (state.settings && state.settings.updateUrl) || '';
  }

  /* ================= 设置面板逻辑 ================= */
  function bindSettings() {
    // 下载器配置列表
    renderDlConfig();
    // 表单提交
    $('dlForm').addEventListener('submit', async e => {
      e.preventDefault();
      const id = Number($('fId').value) || 0;
      const d = {
        name: $('fName').value.trim(), type: $('fType').value, url: $('fUrl').value.trim(),
        username: $('fUser').value.trim(), password: $('fPass').value, enabled: $('fEnabled').checked
      };
      if (!d.name || !d.url) { $('formMsg').textContent = '请填写名称和地址'; return; }
      // 地址必须 http(s)://，否则客户端发请求时会抛难懂的底层错误
      if (!/^https?:\/\//i.test(d.url)) { $('formMsg').textContent = '地址要以 http:// 或 https:// 开头'; return; }
      try { new URL(d.url); } catch (_) { $('formMsg').textContent = '地址格式不正确'; return; }
      const res = id ? await window.flow.dlUpdate(id, d) : await window.flow.dlAdd(d);
      if (res && res.error) { $('formMsg').textContent = res.error; return; }
      $('formMsg').textContent = '已保存';
      resetForm(); renderDlConfig(); refreshAll(false);
    });
    $('btnTest').addEventListener('click', async () => {
      const id = Number($('fId').value) || 0;
      const d = { id, name: $('fName').value.trim(), type: $('fType').value, url: $('fUrl').value.trim(), username: $('fUser').value.trim(), password: $('fPass').value };
      if (!/^https?:\/\//i.test(d.url)) { $('formMsg').textContent = '地址要以 http:// 或 https:// 开头'; return; }
      $('formMsg').textContent = '测试中…';
      let r;
      try { r = await window.flow.dlTest(d); } catch (err) { r = { ok: false, error: String((err && err.message) || err) }; }
      $('formMsg').textContent = r && r.ok
        ? `连接成功 · ${r.version || '未知版本'} · ↑${fmtRate(r.up_rate)} ↓${fmtRate(r.dl_rate)}`
        : ('失败：' + ((r && r.error) || '无法连接'));
    });
    $('btnResetForm').addEventListener('click', resetForm);
    $('btnRecolor').addEventListener('click', async () => { await window.flow.dlRecolor(); refreshAll(false); });
    // 采集选项
    renderCollectOptions();
    $('btnSaveCollect').addEventListener('click', async () => {
      const safe = {};
      if (window._pollSel != null) safe.poll_interval = window._pollSel;
      if (window._trafficSel != null) safe.traffic_interval = window._trafficSel;
      if (window._liveSel != null) safe.live_span = window._liveSel;
      state.collect = await window.flow.settingsCollect(safe);
      $('collectMsg').textContent = '已保存，采集已重启';
      renderCollectInfo();
    });
    $('btnQuit').addEventListener('click', () => window.flow.winAction('quit'));
    // 窗口设置
    if (state.settings) {
      $('chkTop').checked = !!state.settings.alwaysOnTop;
      $('chkAuto').checked = !!state.settings.autoLaunch;
      $('chkEdgeDock').checked = state.settings.edgeDock !== false;
      $('chkTrayInfo').checked = state.settings.trayInfo !== false;
      $('motionSelect').value = state.settings.motion || 'on';
    }
    $('chkTop').addEventListener('change', () => { window.flow.updateSettings({ alwaysOnTop: $('chkTop').checked }); });
    $('chkAuto').addEventListener('change', () => { window.flow.updateSettings({ autoLaunch: $('chkAuto').checked }); });
    $('chkEdgeDock').addEventListener('change', () => { window.flow.updateSettings({ edgeDock: $('chkEdgeDock').checked }); });
    // 托盘开关此前只改内存不落盘，重启即丢
    $('chkTrayInfo').addEventListener('change', () => {
      window.flow.updateSettings({ trayInfo: $('chkTrayInfo').checked });
      updateTrayInfo();
    });
    $('motionSelect').addEventListener('change', async () => {
      const off = $('motionSelect').value === 'off';
      document.documentElement.classList.toggle('motion-off', off);
      await window.flow.updateSettings({ motion: $('motionSelect').value });
    });
    // 设置页切换
    document.querySelectorAll('.st-nav').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.st-nav').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.st-page').forEach(p => p.hidden = p.getAttribute('data-page') !== btn.getAttribute('data-page'));
      });
    });
  }
  function resetForm() {
    $('fId').value = ''; $('fName').value = ''; $('fType').value = 'qb'; $('fUrl').value = '';
    $('fUser').value = ''; $('fPass').value = ''; $('fEnabled').checked = true; $('formTitle').textContent = '添加下载器';
  }
  async function renderDlConfig() {
    const list = await window.flow.downloaders();
    state.downloaders = list;
    const box = $('dlConfigList');
    box.innerHTML = list.length ? list.map(d => `<div class="dl-config-row" data-id="${d.id}">
      <span class="cname">${esc(d.name)}</span><span class="ctype">${d.type === 'tr' ? 'TR' : 'QB'}</span>
      <button data-act="edit">编辑</button><button data-act="del" class="del">删除</button>
    </div>`).join('') : '<p class="hint">暂无下载器。下方添加一个即可开始采集真实数据。</p>';
    $('demoHint').textContent = list.length ? '' : '未配置下载器';
    box.querySelectorAll('.dl-config-row').forEach(row => {
      const id = Number(row.getAttribute('data-id'));
      row.querySelector('[data-act="edit"]').addEventListener('click', () => {
        const d = list.find(x => x.id === id); if (!d) return;
        $('fId').value = d.id; $('fName').value = d.name; $('fType').value = d.type;
        $('fUrl').value = d.url; $('fUser').value = d.username; $('fPass').value = '';
        $('fEnabled').checked = !!d.enabled; $('formTitle').textContent = '编辑下载器'; $('formMsg').textContent = '';
      });
      row.querySelector('[data-act="del"]').addEventListener('click', async () => {
        // 应用内二次确认：原生 confirm 在无边框透明窗上会弹出游离的系统模态框，体验割裂
        const btn = row.querySelector('[data-act="del"]');
        if (btn.dataset.armed !== '1') {
          btn.dataset.armed = '1'; btn.textContent = '再点一次确认';
          setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ''; btn.textContent = '删除'; } }, 3000);
          return;
        }
        const r = await window.flow.dlDelete(id);
        if (r && r.error) { $('formMsg').textContent = '删除失败：' + r.error; return; }
        await renderDlConfig(); refreshAll(false);
      });
    });
  }
  function renderCollectOptions() {
    const c = state.collect || {};
    window._pollSel = c.poll_interval != null ? c.poll_interval : 5;
    window._trafficSel = c.traffic_interval != null ? c.traffic_interval : 60;
    window._liveSel = c.live_span != null ? c.live_span : 300;
    const mk = (arr, cur, key) => arr.map(v => `<button class="chip ${v === cur ? 'active' : ''}" data-v="${v}" data-key="${key}">${v < 60 ? v + ' 秒' : (v / 60) + ' 分'}</button>`).join('');
    $('pollOptions').innerHTML = mk(RATE_CHOICES, window._pollSel, 'poll');
    $('trafficPollOptions').innerHTML = mk(TRAFFIC_CHOICES, window._trafficSel, 'traffic');
    $('liveOptions').innerHTML = mk(LIVE_CHOICES, window._liveSel, 'live');
    document.querySelectorAll('.opt-row .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const key = chip.getAttribute('data-key'), v = Number(chip.getAttribute('data-v'));
        chip.parentNode.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        if (key === 'poll') window._pollSel = v;
        else if (key === 'traffic') window._trafficSel = v;
        else window._liveSel = v;
      });
    });
    renderCollectInfo();
  }
  function renderCollectInfo() {
    const c = state.collect || {};
    $('collectCurrent').textContent = `当前：速率 ${c.poll_interval || 5}s · 流量 ${c.traffic_interval || 60}s · 实时窗口 ${c.live_span || 300}s`;
  }

  /* ================= 详情弹窗 ================= */
  async function showDlDetail(id) {
    const d = await window.flow.dlDetail(id); if (!d) return;
    $('detailTitle').textContent = d.name + ' · 详情';
    const p = d.periods || {};
    const row = (label, v, cls) => `<div class="kv"><span>${label}</span><b class="${cls || ''}">${fmtBytes(v)}</b></div>`;
    let html = `<div class="detail-sec"><h5>连接状态 ${d.version ? '· ' + esc(d.version) : ''}</h5>
      <div class="hint">${d.status === 'online' ? '在线' : '离线'}${d.error ? ' · ' + esc(d.error) : ''} · ${esc(d.url)}</div></div>`;
    html += `<div class="detail-sec"><h5>累计流量（自安装记账起）</h5><div class="detail-grid">
      ${row('今日上传', p.day && p.day.up, 'u')}${row('今日下载', p.day && p.day.dl, 'd')}
      ${row('本周上传', p.week && p.week.up, 'u')}${row('本周下载', p.week && p.week.dl, 'd')}
      ${row('本月上传', p.month && p.month.up, 'u')}${row('本月下载', p.month && p.month.dl, 'd')}
      ${row('本年上传', p.year && p.year.up, 'u')}${row('本年下载', p.year && p.year.dl, 'd')}
      ${row('累计上传', p.all && p.all.up, 'u')}${row('累计下载', p.all && p.all.dl, 'd')}
    </div></div>`;
    if (d.torrents) {
      const t = d.torrents, c = t.counts || {};
      html += `<div class="detail-sec"><h5>种子状态</h5><div class="detail-grid">
        <div class="kv"><span>总数</span><b>${c.total || 0}</b></div><div class="kv"><span>总大小</span><b>${fmtBytes(t.total_size)}</b></div>
        <div class="kv"><span>做种中</span><b>${c.seeding || 0}</b></div><div class="kv"><span>下载中</span><b>${c.downloading || 0}</b></div>
        <div class="kv"><span>暂停</span><b>${c.paused || 0}</b></div><div class="kv"><span>错误</span><b>${c.error || 0}</b></div>
      </div></div>`;
    }
    $('detailBody').innerHTML = html;
    $('detailModal').hidden = false;
  }
  async function showSummaryDetailAll() {
    const d = await window.flow.dlDetailSummary(); if (!d) return;
    $('detailTitle').textContent = '全部下载器 · 汇总详情';
    const p = d.periods || {};
    const row = (label, v, cls) => `<div class="kv"><span>${label}</span><b class="${cls || ''}">${fmtBytes(v)}</b></div>`;
    let html = `<div class="detail-sec"><h5>全部下载器汇总</h5><div class="detail-grid">
      ${row('今日上传', p.day && p.day.up, 'u')}${row('今日下载', p.day && p.day.dl, 'd')}
      ${row('本周上传', p.week && p.week.up, 'u')}${row('本周下载', p.week && p.week.dl, 'd')}
      ${row('本月上传', p.month && p.month.up, 'u')}${row('本月下载', p.month && p.month.dl, 'd')}
      ${row('本年上传', p.year && p.year.up, 'u')}${row('本年下载', p.year && p.year.dl, 'd')}
    </div></div><div class="detail-sec"><h5>逐台明细</h5><div class="detail-grid">`;
    for (const x of d.downloaders) {
      html += `<div class="kv"><span>${esc(x.name)} 上传</span><b class="u">${fmtBytes(x.periods.all.up)}</b></div>`;
      html += `<div class="kv"><span>${esc(x.name)} 下载</span><b class="d">${fmtBytes(x.periods.all.dl)}</b></div>`;
    }
    html += '</div></div>';
    $('detailBody').innerHTML = html; $('detailModal').hidden = false;
  }
  function showSummaryDetail(key) { showPeriodHistory(key); }
  async function showPeriodHistory(gran) {
    const data = await window.flow.periods(gran); if (!data) return;
    const names = { day: '日', week: '周', month: '月', year: '年' };
    $('detailTitle').textContent = `历史${names[gran] || ''}数据`;
    $('detailBody').innerHTML = `<div class="detail-sec"><h5>最近 ${data.items.length} 个周期</h5>
      <table style="width:100%;font-size:11px;border-collapse:collapse">
      <thead><tr style="color:var(--ink-soft);text-align:left"><th style="padding:4px 0">周期</th><th>上传</th><th>下载</th></tr></thead>
      <tbody>${data.items.map((it, i) => `<tr style="border-top:1px dashed rgba(123,159,196,.2)"><td style="padding:4px 0">${esc(it.label)}${i === 0 ? ' · 当前' : ''}</td><td style="color:var(--up)">${fmtBytes(it.up)}</td><td style="color:var(--down)">${fmtBytes(it.dl)}</td></tr>`).join('')}</tbody></table></div>`;
    $('detailModal').hidden = false;
  }
  $('closeDetail').addEventListener('click', () => $('detailModal').hidden = true);
  $('detailModal').addEventListener('click', e => { if (e.target === $('detailModal')) $('detailModal').hidden = true; });

  /* ================= 正在下载的种子 =================
     名称简略显示：中间省略（保头保尾），完整名称放 title，鼠标悬停即见。
     头部通常是剧名/番号，尾部是分辨率与压制组，对 PT 用户都是关键信息，
     所以不能简单截断。 */
  const truncMid = (s, head, tail) => {
    const str = String(s || '');
    if (str.length <= head + tail + 1) return str;
    return str.slice(0, head) + '…' + str.slice(str.length - tail);
  };
  const STATE_TEXT = {
    downloading: '下载中', stalled: '等待中', seeding: '做种', paused: '暂停', error: '出错', checking: '校验中', other: '—'
  };
  function fmtEta(sec) {
    const n = Number(sec) || 0;
    if (n <= 0) return '—';
    if (n > 86400) return '>1 天';
    const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60);
    if (h) return `${h}时${m}分`;
    return `${m}分${Math.floor(n % 60)}秒`;
  }
  async function loadActiveTorrents() {
    try {
      const d = await window.flow.activeTorrents();
      state.activeTorrents = d;
      renderActiveTorrents();
    } catch (e) { }
  }
  function renderActiveTorrents() {
    const box = $('torrentList'); if (!box) return;
    const d = state.activeTorrents || { list: [], total_up_rate: 0 };
    const list = d.list || [];
    // 与站点列表同理：全量重建会把滚动位置归零，翻到一半被弹回顶部。
    const keepTop = box.scrollTop;
    if (!list.length) {
      $('torrentSub').textContent = '';
      box.innerHTML = `<div class="empty-line">当前没有正在下载的种子</div>`;
      return;
    }
    const sumRate = list.reduce((a, t) => a + (t.dl_rate || 0), 0);
    $('torrentSub').textContent = `${list.length} 个 · ${fmtRate(sumRate)}`;
    box.innerHTML = list.map(t => {
      const pct = Math.max(0, Math.min(100, (t.progress || 0) * 100));
      // 站点标记：无站点的种子（本机/私有种子）和未识别站不显示标签，避免噪声
      const site = t.site && t.site !== '未知站点' && t.site !== '无站点'
        ? `<span class="tor-site">${esc(t.site)}</span>` : '';
      const speed = t.dl_rate > 0 ? `<span class="tor-speed">↓${fmtRate(t.dl_rate)}</span>` : `<span class="tor-speed idle">${esc(STATE_TEXT[t.state] || '—')}</span>`;
      return `<div class="tor-row" title="${esc(t.name)}">
        <div class="tor-head">
          <span class="tor-name">${esc(truncMid(t.name, 20, 12))}</span>
          ${site}
        </div>
        <div class="tor-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="tor-meta">
          <span class="tor-pct">${pct.toFixed(1)}%</span>
          <span class="tor-size">${fmtBytes(t.amount_left)} 剩</span>
          <span class="tor-eta">${fmtEta(t.eta)}</span>
          ${speed}
        </div>
      </div>`;
    }).join('');
    if (keepTop > 0) box.scrollTop = keepTop;
    if (window.__syncTorMask) window.__syncTorMask();
  }

  /* ================= PT 站点流量 ================= */
  async function loadSites() {
    try {
      const d = await window.flow.siteTotals();
      state.siteData = d;
      renderSites();
    } catch (e) { }
  }
  function renderSites() {
    const box = $('siteList'); if (!box) return;
    const d = state.siteData || { sites: [] };
    const all = d.sites || [];
    const p = state.sitePeriod || 'day';
    // 列出所有「有种子」的站，而不是只列该周期有流量的站。
    // 之前的过滤会让今日只显示 5~7 个，用户以为漏统计了 —— 实际上大部分站
    // 只是今天还没产生流量。全列出来才看得到完整版图，0 流量的沉到底部。
    // 排序：本周期有流量的按流量降序在前，其余按累计流量降序在后。
    const trafficOf = s => (s[p] ? s[p].up + s[p].dl : 0);
    // 「无站点」（本机做种/私有种子，没有 tracker）不是 PT 站，不能参与站点排行：
    // 它的量级往往最大（真实数据里曾占今日 0.41T↑/0.98T↓），会把真正的站挤到下面。
    // 单独挑出来放到列表末尾，卡片脚注里再提示，既不失真也不干扰排行。
    const isNoSite = s => s.key === 'no-site';
    const noSiteRow = all.find(isNoSite) || null;
    const ptRows = all.filter(s => !isNoSite(s));
    const rows = ptRows.slice().sort((a, b) => {
      const ta = trafficOf(a) > 0, tb = trafficOf(b) > 0;
      if (ta !== tb) return ta ? -1 : 1;                 // 有流量的优先
      if (ta && tb) return trafficOf(b) - trafficOf(a);  // 都有的按本周期流量降序
      return (b.all.up + b.all.dl) - (a.all.up + a.all.dl); // 都没有的按累计降序
    });
    // 段选按钮高亮
    for (const id of ['sitePeriodDay', 'sitePeriodWeek', 'sitePeriodAll']) {
      const el = $(id); if (!el) continue;
      el.classList.toggle('active', el.dataset.p === p);
    }
    if (!rows.length) {
      $('siteSub').textContent = '';
      $('siteTotUp').textContent = '↑0';
      $('siteTotDl').textContent = '↓0';
      $('siteNote').textContent = '';
      const empty = p === 'day' ? '今日还没有站点流量' : (p === 'week' ? '本周还没有站点流量' : '还没有累计站点流量');
      box.innerHTML = `<div class="empty-line">${empty}</div>`;
      syncSiteScrollMask();
      return;
    }
    const tot = rows.reduce((a, s) => ({ up: a.up + (s[p].up || 0), dl: a.dl + (s[p].dl || 0) }), { up: 0, dl: 0 });
    // 全部渲染，靠 .site-scroll 的模块内滚动查看其余站点 —— 不靠折叠、也不撑高窗口
    $('siteSub').textContent = `${rows.length} 站`;
    // 「无站点」的量单独提示，不混进站点合计（否则用户以为某站偷跑）
    const nUp = noSiteRow ? (noSiteRow[p].up || 0) : 0;
    const nDl = noSiteRow ? (noSiteRow[p].dl || 0) : 0;
    $('siteTotUp').textContent = '↑' + fmtBytes(tot.up);
    $('siteTotDl').textContent = '↓' + fmtBytes(tot.dl);
    $('siteNote').textContent = (nUp + nDl) > 0
      ? `另有本机/私有种子 ↑${fmtBytes(nUp)} ↓${fmtBytes(nDl)}，不计入站点`
      : '';
    const max = Math.max(...rows.map(s => Math.max(s[p].up, s[p].dl)), 1);
    // 全量重建会让滚动位置归零：用户正在往下翻站点时，每 30s 一次的数据刷新
    // 都把他弹回顶部，等于这个列表没法翻。重建前后保存/恢复滚动偏移。
    const sc = $('siteScroll');
    const keepTop = sc ? sc.scrollTop : 0;
    box.innerHTML = rows.map(s => {
      const upW = Math.min(100, (s[p].up / max * 100)).toFixed(1);
      const dlW = Math.min(100, (s[p].dl / max * 100)).toFixed(1);
      // 未收录站优先显示域名本身（name 已是域名），title 给出完整域名便于排查收录
      const title = s.known
        ? (s.full ? `${s.full}${s.host ? ' · ' + s.host : ''}` : (s.host || s.name))
        : `${s.host || s.name} · 未收录，可加入 sites.js 规则`;
      return `<div class="site-row" title="${esc(title)}">
        <div class="site-name">
          <b>${esc(s.name)}</b>
          ${s.known ? '' : '<i class="site-unknown">未收录</i>'}
        </div>
        <div class="site-nums">
          <span class="sn up"><i class="sn-bar" style="width:${upW}%"></i><em>${fmtBytes(s[p].up)}</em></span>
          <span class="sn dl"><i class="sn-bar" style="width:${dlW}%"></i><em>${fmtBytes(s[p].dl)}</em></span>
        </div>
      </div>`;
    }).join('');
    if (sc && keepTop > 0) sc.scrollTop = keepTop;
    syncSiteScrollMask();
  }
  /* 滚动区上下渐隐遮罩状态：到顶去掉顶部渐隐、到底去掉底部渐隐，
     内容不够长（无滚动）时两边都不要，避免短列表上下发灰。 */
  function syncSiteScrollMask() {
    const sc = $('siteScroll'); if (!sc) return;
    const max = sc.scrollHeight - sc.clientHeight;
    sc.classList.toggle('at-top', sc.scrollTop <= 1);
    sc.classList.toggle('at-end', max <= 1 || sc.scrollTop >= max - 1);
  }

  /* ================= 托盘信息 ================= */
  function updateTrayInfo() {
    if (!state.overview || state.settings && state.settings.trayInfo === false) return;
    const t = state.overview.total || {};
    const txt = `↑${fmtRate(t.up_rate)} ↓${fmtRate(t.dl_rate)} · 今日 ↑${fmtBytes(t.day.up)} ↓${fmtBytes(t.day.dl)}`;
    window.flow.trayInfo(txt);
  }

  /* ================= iOS 式惯性滚动 =================
     移植自天气台：原生 Windows 滚轮一格一格跳，观感生硬。
     拦截 wheel 累积目标位置、rAF 指数插值追目标，得到平滑减速；
     滚动期给容器加 .scrolling 关掉卡片 backdrop-filter——透明窗上每帧重采样桌面是掉帧主因。 */
  function markScrolling(el) {
    if (!el.classList.contains('scrolling')) el.classList.add('scrolling');
    const panel = el.classList.contains('panel-body') ? document.querySelector('.panel') : null;
    if (panel) {
      panel.classList.add('scrolling');
      clearTimeout(panel._scrollEndTimer);
      panel._scrollEndTimer = setTimeout(() => panel.classList.remove('scrolling'), 180);
    }
    clearTimeout(el._scrollEndTimer);
    el._scrollEndTimer = setTimeout(() => el.classList.remove('scrolling'), 180);
  }
  function initSmoothScroll(el, opts) {
    if (!el) return;
    const o = opts || {};
    const outer = o.chainOuter || null;   // 滚到边界时把滚轮交给外层容器
    let target = el.scrollTop, animating = false, raf = 0, selfTop = -1, lastStep = 0;
    const EASE = 0.18;
    const maxTop = () => Math.max(0, el.scrollHeight - el.clientHeight);
    // 边界判断留 1px 容差：分数滚动位置下 scrollTop 很难精确等于 maxTop
    const atEdge = dir => dir > 0 ? el.scrollTop >= maxTop() - 1 : el.scrollTop <= 1;

    function step(now) {
      raf = 0;
      // rAF 被系统掐断再恢复时不能按冻结的旧 target 硬拽回去；短暂掉帧则一次落地，长挂起才放弃
      if (lastStep && now - lastStep > 250) {
        const gap = now - lastStep;
        if (gap < 2000) {
          const safe = Math.min(Math.max(0, target), maxTop());
          selfTop = safe; el.scrollTop = safe;
        } else {
          target = el.scrollTop;
        }
        animating = false; return;
      }
      lastStep = now;
      if (target > maxTop()) target = maxTop();
      const cur = el.scrollTop;
      const next = cur + (target - cur) * EASE;
      if (Math.abs(target - cur) < 0.6) {
        selfTop = target; el.scrollTop = target; animating = false; return;
      }
      selfTop = next; el.scrollTop = next;
      markScrolling(el);
      raf = requestAnimationFrame(step);
    }
    el.addEventListener('wheel', e => {
      // 图表区域滚轮交给图表自己处理（隐藏提示），且 Ctrl+滚轮缩放交还原生
      if (e.ctrlKey) return;
      if (e.target.closest && e.target.closest('.chart-viewport')) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      // 只有自己已经滚到边界，才把滚轮让给外层；否则内层吃掉滚动，用户
      // 鼠标停在列表上时整页就滚不动了。交还时不动 preventDefault。
      if (outer && atEdge(e.deltaY)) return;
      // 内层消费了滚轮就必须截断冒泡：外层 #widget 也挂了同一套 handler，
      // 不截断会两层同时滚动 —— 观感是"列表在跑、整页也在跑"，非常飘。
      e.stopPropagation();
      e.preventDefault();
      const raw = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? el.clientHeight : 1);
      // 一格 120px 直接跳太猛：0.55 缩放 + 72px 封顶 ≈ 一格 66px（约 3 行）
      const d = e.deltaMode === 2 ? raw * 0.85 : Math.sign(raw) * Math.min(Math.abs(raw) * 0.55, 72);
      if (!animating) target = el.scrollTop;
      target = Math.min(maxTop(), Math.max(0, target + d));
      markScrolling(el);
      if (!animating) {
        animating = true; lastStep = 0;
        selfTop = el.scrollTop;
        raf = requestAnimationFrame(step);
      }
    }, { passive: false });
    // 外部滚动（脚本 / 键盘 / 滚动条）→ 取消惯性并接管目标，避免被旧 target 拽回
    el.addEventListener('scroll', () => {
      if (animating && selfTop >= 0 && Math.abs(el.scrollTop - selfTop) < 1.5) { markScrolling(el); return; }
      animating = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      target = el.scrollTop;
      markScrolling(el);
    }, { passive: true });
  }

  /* ================= 鼠标纵向拖拽滚屏 =================
     滚动条隐藏后按住内容上下拖 = 1:1 跟手，松手按速度惯性滑行；
     方向锁避免与窗口拖拽打架，交互控件豁免。 */
  function initDragScrollY(el) {
    if (!el) return;
    // 嵌套滚动区冲突：外层 #widget 与内层 .site-scroll 都监听 window 的 mousemove，
    // 事件会冒泡，两层会同时被拖。mousedown 阶段就把「本次拖拽归谁」定下来：
    // 若按下点落在带 data-scroll-self 的内层里，外层直接不接管。
    const claimedByInner = e => {
      if (!el.dataset || !el.dataset.scrollSelf) {
        const inner = e.target.closest && e.target.closest('[data-scroll-self]');
        if (inner && inner !== el) return true;
      }
      return false;
    };
    let down = false, axis = '', startX = 0, startY = 0, startTop = 0, lastY = 0, lastT = 0, vel = 0, raf = 0, moved = false;
    const stopInertia = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      if (claimedByInner(e)) return;
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      const bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;
      if (e.clientX - r.left - bl >= el.clientWidth || e.clientY - r.top - bt >= el.clientHeight) return;
      const t = e.target;
      if (t.closest && t.closest('.drag, .mod-handle, input, textarea, select, button, a, label, .dl-switch')) return;
      down = true; axis = ''; moved = false;
      startX = e.clientX; startY = lastY = e.clientY; startTop = el.scrollTop;
      lastT = performance.now(); vel = 0;
      stopInertia();
    });
    window.addEventListener('mousemove', e => {
      if (!down) return;
      const dy = e.clientY - startY, dx = e.clientX - startX;
      if (!axis) {
        if (Math.abs(dy) < 5 && Math.abs(dx) < 5) return;
        axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
      }
      if (axis !== 'y') return;
      e.preventDefault();
      if (Math.abs(dy) > 3) moved = true;
      el.scrollTop = startTop - dy;
      const now = performance.now(), dt = now - lastT;
      if (dt > 0) { vel = (e.clientY - lastY) / dt; lastY = e.clientY; lastT = now; }
      markScrolling(el);
    });
    const end = () => {
      if (!down) return;
      down = false;
      if (moved) {
        const kill = ev => { ev.stopPropagation(); ev.preventDefault(); };
        el.addEventListener('click', kill, { capture: true, once: true });
        setTimeout(() => el.removeEventListener('click', kill, true), 400);
      }
      if (axis === 'y' && Math.abs(vel) > 0.12 && performance.now() - lastT < 80) {
        const step = () => {
          vel *= 0.94;
          el.scrollTop -= vel * 16;
          markScrolling(el);
          const edge = el.scrollTop <= 0 || el.scrollTop >= el.scrollHeight - el.clientHeight - 1;
          if (Math.abs(vel) > 0.02 && !edge) raf = requestAnimationFrame(step);
          else raf = 0;
        };
        raf = requestAnimationFrame(step);
      }
    };
    window.addEventListener('mouseup', end);
    window.addEventListener('blur', end);
    el.addEventListener('wheel', stopInertia, { passive: true });
    el.addEventListener('dragstart', e => e.preventDefault());
  }

  /* ================= 图表悬停提示 =================
     图表引擎在 drawLines/drawBars 后把命中所需的几何数据留在 cv._geom，
     这里做 hit-test 并把结果写进 #tooltip。此前 hover 链路完全没接线，
     README 里写的"悬停读数"其实是死功能。 */
  function bindChartHover(canvasId, which) {
    const cv = $(canvasId);
    if (!cv) return;
    const tip = $('tooltip');
    const host = cv.parentElement;
    let raf = 0;
    function hit(clientX, clientY) {
      const g = cv._geom;
      if (!g) return null;
      const r = cv.getBoundingClientRect();
      const x = clientX - r.left, y = clientY - r.top;
      if (x < g.pad.l || x > g.w - g.pad.r || y < g.pad.t || y > g.h - g.pad.b) return null;
      let i;
      if (g.type === 'lines') {
        i = Math.round(((x - g.pad.l) / (g.w - g.pad.l - g.pad.r)) * (g.n - 1));
      } else {
        i = Math.floor((x - g.pad.l) / g.groupW);
      }
      return Math.max(0, Math.min((g.type === 'lines' ? g.n : g.groups.length) - 1, i));
    }
    function show(clientX, clientY) {
      const st = state[which], data = st && st.data;
      if (!data) return;
      const i = hit(clientX, clientY);
      if (i == null) { hide(); return; }
      if (st.hover !== i) {
        st.hover = i;
        // 只重绘数据层，不动坐标轴；用 rAF 合并高频 mousemove，避免掉帧
        if (!raf) raf = requestAnimationFrame(() => {
          raf = 0;
          if (which === 'rate') drawRate(false); else drawTraffic(false);
        });
      }
      const title = (data.spans && data.spans[i]) ? fmtSpanTitle(data.spans[i][0], data.spans[i][1]) : (data.labels ? data.labels[i] : '');
      const rows = [`<b>${esc(title || '')}</b>`];
      if (which === 'rate') {
        // 汇总永远置顶；单机按当前点数值大小排序，只显示前 4 台，避免十几行提示框盖住半屏
        const series = pickSeries(data).slice();
        const sum = series.find(s => s.id === 0);
        if (sum) {
          const u = sum.up && sum.up[i], d = sum.down && sum.down[i];
          if (u != null) rows.push(`<span style="color:${sum.color_up}">↑ 汇总 ${fmtRate(u)}</span>`);
          if (d != null) rows.push(`<span style="color:${sum.color_down}">↓ 汇总 ${fmtRate(d)}</span>`);
        }
        const others = series.filter(s => s.id !== 0).map(s => ({
          s, v: Math.max(Number(s.up && s.up[i]) || 0, Number(s.down && s.down[i]) || 0)
        })).sort((a, b) => b.v - a.v).slice(0, 4);
        for (const { s } of others) {
          const u = s.up && s.up[i], d = s.down && s.down[i];
          if (u != null) rows.push(`<span style="color:${s.color_up}">↑ ${esc(s.name)} ${fmtRate(u)}</span>`);
          if (d != null) rows.push(`<span style="color:${s.color_down}">↓ ${esc(s.name)} ${fmtRate(d)}</span>`);
        }
        const hidden = series.length - 1 - others.length;
        if (hidden > 0) rows.push(`<span style="color:var(--ink-soft)">…另有 ${hidden} 台</span>`);
      } else {
        const grp = data._groups && data._groups[i];
        if (grp) {
          rows.push(`<span class="u">↑ ${fmtBytes(grp.up)}</span>`);
          rows.push(`<span class="d">↓ ${fmtBytes(grp.down)}</span>`);
          const top = (grp.upParts || []).concat(grp.downParts || [])
            .filter(p => p.value > 0).sort((a, b) => b.value - a.value).slice(0, 3);
          for (const p of top) rows.push(`<span style="color:${p.color}">${esc(p.name)} ${fmtBytes(p.value)}</span>`);
        }
      }
      tip.innerHTML = rows.join('<br>');
      tip.hidden = false;
      // 贴着鼠标放，靠近右/下边界时翻到另一侧
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = clientX + 14, top = clientY + 14;
      if (left + tw > window.innerWidth - 8) left = clientX - tw - 14;
      if (top + th > window.innerHeight - 8) top = clientY - th - 14;
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = Math.max(4, top) + 'px';
    }
    function hide() {
      if (tip) tip.hidden = true;
      const st = state[which];
      if (st && st.hover != null) {
        st.hover = null;
        if (!raf) raf = requestAnimationFrame(() => {
          raf = 0;
          if (which === 'rate') drawRate(false); else drawTraffic(false);
        });
      }
    }
    host.addEventListener('mousemove', e => show(e.clientX, e.clientY));
    host.addEventListener('mouseleave', hide);
    host.addEventListener('wheel', hide, { passive: true });
  }

  /* ================= 吸顶小窗拖拽 ================= */
  (function bindDrag() {
    let dragging = false;
    // 两个抓手都要绑定。此前用 `a || b`，而 .pill-grip 始终在 DOM 里（只是 CSS 隐藏），
    // 导致 .hero-top 的手动拖拽回退永远不生效——Win11 下 app-region:drag 失效时大窗拖不动。
    document.querySelectorAll('.pill-grip, .hero-top').forEach(grip => {
      grip.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        if (e.target.closest('button, .dl-switch, input, select, label')) return;
        e.preventDefault();                    // 拖动时不选中文字
        window.flow.winDragEnd();              // 作废旧基准：上次拖拽若丢了 up，按旧基准续算会整窗回跳
        dragging = true;
        window.flow.winDrag(e.screenX, e.screenY);
      });
    });
    window.addEventListener('mousemove', e => { if (dragging) window.flow.winDrag(e.screenX, e.screenY); });
    const end = () => { if (dragging) { dragging = false; window.flow.winDragEnd(); } };
    window.addEventListener('mouseup', end);
    window.addEventListener('blur', end);      // 拖拽中切走窗口松手会卡在拖动态，失焦兜底
  })();

  /* ================= 初始化 ================= */
  async function boot() {
    state.settings = await window.flow.getSettings();
    try { state.collect = await window.flow.settingsGet(); } catch (e) { }
    const off = state.settings.motion === 'off';
    document.documentElement.classList.toggle('motion-off', off);
    if (state.settings.alwaysOnTop) $('btnPin').style.color = 'var(--sun-deep)';
    // flow.version() 走 ipcRenderer.invoke，返回的是 Promise —— 当同步值拼字符串会显示成
    // "[object Promise]"。先给个占位，取到真实值再回填。
    $('panelVersion').textContent = 'v…';
    Promise.resolve(window.flow.version && window.flow.version())
      .then(v => { if (v) $('panelVersion').textContent = 'v' + v; })
      .catch(() => { $('panelVersion').textContent = 'v' + (state.settings.version || ''); });
    tickClock();
    if (!window.__clockTimer) window.__clockTimer = setInterval(tickClock, 1000);
    // 回到前台立刻补一次刷新，避免隐藏期间暂停刷新导致数据看起来是旧的
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshAll(false);
    });
    bindSettings();
    bindUpdate();
    initSmoothScroll($('widget'));
    initSmoothScroll(document.querySelector('.panel-body'));
    initDragScrollY($('widget'));
    // PT 站点模块的独立滚动区：同样上惯性滚动 + 拖拽滚屏，手感与外层一致。
    // 滚到顶/底时把滚轮交回外层 #widget —— 否则鼠标停在列表上就再也滚不动整页。
    initSmoothScroll($('siteScroll'), { chainOuter: $('widget'), maskTarget: $('siteScroll') });
    initDragScrollY($('siteScroll'));
    syncSiteScrollMask();
    if ($('siteScroll')) $('siteScroll').addEventListener('scroll', syncSiteScrollMask, { passive: true });
    // 「正在下载」列表同样是限高滚动区，一并接管，否则只有它一格一格顿着滚。
    const torList = $('torrentList');
    if (torList) {
      torList.setAttribute('data-scroll-self', '1');
      initSmoothScroll(torList, { chainOuter: $('widget') });
      initDragScrollY(torList);
      // 渐隐遮罩状态：与站点列表同一套逻辑（到顶/到底各去掉一侧）
      const syncTorMask = () => {
        const max = torList.scrollHeight - torList.clientHeight;
        torList.classList.toggle('at-top', torList.scrollTop <= 1);
        torList.classList.toggle('at-end', max <= 1 || torList.scrollTop >= max - 1);
      };
      window.__syncTorMask = syncTorMask;
      torList.addEventListener('scroll', syncTorMask, { passive: true });
      syncTorMask();
    }
    bindChartHover('rateChart', 'rate');
    bindChartHover('trafficChart', 'traffic');
    await refreshAll(false);
    animateFlag = true; // 后续刷新启用帧平移动画
    // 实时事件：rate 局部刷新
    window.flow.onData('rate', () => { refreshAll(true); });
    window.flow.onData('traffic', () => { /* traffic 完成由 rate 事件已覆盖，避免双刷 */ });
    // 种子轮（低频）：只刷这两个模块，不牵动整屏图表
    window.flow.onData('sites', () => {
      if (document.hidden) return; // 隐藏时不做无谓请求（与整屏刷新同策略）
      loadActiveTorrents(); loadSites();
    });
    // PT 站点周期切换：今日 / 本周 / 总计（纯本地重排，无需重新请求）
    for (const id of ['sitePeriodDay', 'sitePeriodWeek', 'sitePeriodAll']) {
      const el = $(id);
      if (el) el.addEventListener('click', () => { state.sitePeriod = el.dataset.p; renderSites(); });
    }
    // 吸顶状态
    window.flow.onDockState(s => {
      document.body.classList.toggle('docked', !!s.docked);
      document.body.classList.toggle('expanded', !!s.expanded);
      const collapsed = !!s.docked && !s.expanded;
      $('pill').classList.toggle('show', collapsed);
      $('widget').classList.toggle('dock-hidden', collapsed);
      // 收起为小窗时必须关掉独立覆盖层，否则设置面板 / 详情弹窗会残留在小窗旁边
      // （它们是 fixed 定位、挂在 #widget 之外，不受 dock-hidden 影响）
      if (collapsed) {
        closeSettings();
        closeAllMenus();
        $('detailModal').hidden = true;
      }
      if (s.docked) {
        const pr = document.getElementById('rateChart');
        if (pr) pr.style.display = '';
      }
    });
    // 即时 hover 派发：主进程虽有 260ms 轮询，但没有这条链路时展开/收起总是慢半拍。
    // 鼠标进入/移动立刻通知，离开交给主进程 450ms 收起；按住拖拽期间保活防缩回。
    let hoverTick = 0;
    const sendHover = on => { try { window.flow.dockHover(on); } catch (e) { } };
    document.addEventListener('mouseenter', () => {
      if (document.body.classList.contains('docked')) sendHover(true);
    });
    document.addEventListener('mouseleave', () => {
      if (document.body.classList.contains('docked')) sendHover(false);
    });
    document.addEventListener('mousemove', () => {
      if (!document.body.classList.contains('docked')) return;
      const now = Date.now();
      if (now - hoverTick < 300) return;
      hoverTick = now;
      sendHover(true);
    });
    document.addEventListener('pointerdown', () => {
      if (!document.body.classList.contains('docked')) return;
      sendHover(true);
      clearInterval(window.__dockHold);
      window.__dockHold = setInterval(() => sendHover(true), 250);
    });
    document.addEventListener('pointerup', () => {
      clearInterval(window.__dockHold); window.__dockHold = null;
    });
    window.flow.onTrayAction(a => {
      if (!a) return;
      if (a.type === 'refresh') refreshAll(false);
      else if (a.type === 'show') window.flow.winAction('show');
    });
    // 动态图例 hover（从 charts 的 geom 读取 tooltip 由 charts 内部处理，这里仅占位）
  }
  boot();
})();
