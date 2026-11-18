'use strict';
/**
 * 云上晴雨 - 宫崎骏风格 Windows 桌面天气插件
 * Electron 主进程：无边框透明窗体 / 置顶 / 托盘 / 位置记忆 / 数据接口代理
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, shell, Notification, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

// --shot / --shot-globe 截图调试用独立 userData：不与正在运行的正式实例抢单实例锁
const SHOT_MODE = process.argv.includes('--shot') || process.argv.includes('--shot-globe') || process.argv.includes('--shot-update') || process.argv.includes('--shot-dock') || process.env.FLOW_SHOT === '1';
if (SHOT_MODE) {
  try { app.setPath('userData', app.getPath('userData') + '-shot'); } catch (e) { }
}

// 流量统计核心：qB/Tr 直连 + 累计计数器差分 + 采集调度 + 图表数据
const { Store } = require('./core/store.js');
const { Collector } = require('./core/collector.js');
const chartCore = require('./core/chart.js');
const clients = require('./core/clients.js');
const nodePath = require('path');
const DATA_FILE = nodePath.join(app.getPath('userData'), 'traffic.json');
const store = new Store(DATA_FILE);
let collector = null;

/* ---------------- 设置持久化 ---------------- */
let win = null;
let tray = null;
let settings = {
  alwaysOnTop: true,
  autoLaunch: false,
  winPos: null,
  winSize: null,
  edgeDock: true,
  docked: false,
  dockX: null,
  trayInfo: true,
  updateUrl: '',
  motion: 'on'
};
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  const f = settingsFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad shape');
    Object.assign(settings, parsed);
  } catch (e) {
    // 文件损坏（断电/写到一半崩溃）：先留现场 .broken，再尝试从上次原子写的 .bak 恢复；
    // 绝不能静默当「首次运行」并用默认值全量覆盖，否则用户的地点/设置不可恢复地丢失。
    try {
      if (fs.existsSync(f)) fs.copyFileSync(f, f + '.broken');
      if (fs.existsSync(f + '.bak')) Object.assign(settings, JSON.parse(fs.readFileSync(f + '.bak', 'utf8')));
    } catch (e2) { /* 备份也坏：保留默认值，但 .broken 现场仍在 */ }
  }
  // v1.0.11 一次性自愈：旧版存在「顶部吸附」被误关导致小窗丢失的反馈，重新启用一次；
  // 此后完全以用户在设置面板的选择为准（迁移标记 ver，只执行一次）
  if (settings.ver !== 3) {
    settings.ver = 3;
    if (settings.edgeDock === false) settings.edgeDock = true;
    persist();
  }
  // v1.0.28 热修：曾误把动效默认设成「跟随系统」，本机系统减动效让雷达整卡静止。
  // 用户明确否决自动减少动效 → 旧落盘的 system 一次性归位为始终播放（写回后不再触发）。
  if (settings.motion === 'system') { settings.motion = 'on'; persist(); }
}
function persist(patch = {}) {
  Object.assign(settings, patch);
  const f = settingsFile(), tmp = f + '.tmp';
  const data = JSON.stringify(settings, null, 2);
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    try { if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak'); } catch (e) { } // 上一份好文件留作恢复源
    try { fs.renameSync(tmp, f); } catch (e) { fs.writeFileSync(f, data, 'utf8'); } // 原子替换，异常兜底
  } catch (e) { /* 用户数据目录不可写时不能让主进程崩 */ }
  finally { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { } }
}
/* ---------------- 顶部吸附流量小窗 ----------------
   架构：窗口尺寸永远不变，收起/展开只做 CSS 淡入淡出 +
   setShape 裁剪（形状外不渲染、不挡鼠标）。
   避免 Win11 透明窗 resize 造成的白底/直角/卡顿闪烁。 */
const PILL_W = 300, PILL_H = 64;      // 流量小窗尺寸：时间 + 实时上下行速率 + 今日上传/下载量
const SNAP_IN = 26, SNAP_OUT = 90;    // 拖到距顶端 <=26px 吸附；拖离 >90px 解除
let dockExpanded = false;             // 吸顶后是否处于悬停展开态
let dockTimer = null;
let programmatic = 0;                 // 程序改 bounds 的时间戳，抑制吸附/位置记忆
let hoverPoll = null;
let hoverArmed = true;                // "离开再进入"才展开，避免刚放下小窗就弹开
const DESIGN_W = 768, DESIGN_H = 940; // 窗口设计尺寸（固定，resizable:false）：横排四周期卡片 + 双图表
let baseSize = { w: DESIGN_W, h: DESIGN_H }; // 基准尺寸 = 设计常量（落盘 winSize 只当回执，绝不当基准）

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
function setBoundsSafe(r) {
  if (!win || win.isDestroyed()) return;
  programmatic = Date.now();
  win.setBounds(r);
}
/* setShape：窗口只在小窗矩形内渲染/响应鼠标，其余区域完全穿透 */
function pillShapeRect() {
  return [{ x: Math.round((baseSize.w - PILL_W) / 2), y: 0, width: PILL_W, height: PILL_H }];
}
function setShapePill() {
  if (!win || win.isDestroyed()) return;
  try { win.setShape(pillShapeRect()); } catch (e) { }
}
function setShapeFull() {
  if (!win || win.isDestroyed()) return;
  try { win.setShape([{ x: 0, y: 0, width: baseSize.w, height: baseSize.h }]); } catch (e) { }
}
/* #70 真相（探针实锤）：explorer「显示桌面」（Win+D / 任务栏右下角小竖条）对 skipTaskbar 工具窗
   既不最小化也不发 minimize 事件，而是把全屏壁纸 WorkerW 从 z 序底部跃升到普通窗口带顶端——
   非 topmost 的小窗必被壁纸盖住（窗口仍「健康」：visible/on-screen/printwin 完好，但用户看不见）。
   ── 桌面部件语义（置顶关时）：小窗钉在「壁纸层」正上方——平时贴 z 序底部（所有程序窗口之下），
   「显示桌面」壁纸跃升时跟着浮到最上（壁纸之上），全程不挡任何程序（用户实测反馈：不许压浏览器）。
   交互手感保留：小窗被点聚焦 / 展开时允许自然置前，失焦/收起即归位；壁纸可见（桌面态）时强制钉住。
   ── 置顶开时：topmost('screen-saver') 带天然免疫壁纸跃升，浮最上层即用户所愿。
   大窗态一律按用户置顶偏好走（保持系统正常行为）。 */
let glueTimer = null, glueU32 = null;
function glueInit() {
  if (glueU32) return glueU32;
  try {
    const koffi = require('koffi');
    const u = koffi.load('user32.dll');
    glueU32 = {
      getDesktop: u.func('void *GetDesktopWindow()'),
      getWindow: u.func('void *GetWindow(void *h, uint cmd)'),
      getClassName: u.func('int GetClassNameW(void *h, uint16 *buf, int max)'),
      getRect: u.func('bool GetWindowRect(void *h, void *rect)'),
      isVisible: u.func('bool IsWindowVisible(void *h)'),
      findChild: u.func('void *FindWindowExW(void *p, void *after, str16 cls, str16 name)'),
      setPos: u.func('bool SetWindowPos(void *h, void *after, int x, int y, int cx, int cy, uint flags)'),
      isWindow: u.func('bool IsWindow(void *h)')
    };
  } catch (e) { glueU32 = null; }
  return glueU32;
}
/* 壁纸层定位：全屏 WorkerW（唯一恒定特征：class=WorkerW、w>1200、h>700）。
   实测（probe-setpos Win+D diff）：该窗常态沉在 z 序底（无 DefView、不可见）；explorer Toggle Desktop
   （Win+D / 任务栏小竖条）把它「带 SHELLDLL_DefView」跃升到普通窗口带顶端盖一切——注意跃升后它「有」
   DefView（图标层搬进去了），按无 DefView 过滤会永远找不到跃升层（v1.0.26 前的坑）！
   每 tick 重扫、不缓存句柄（跃升=换位+变形，缓存必失手）；自顶向下扫描、上限 2000（本机实测顶层窗口
   1145 个，旧「自底向上 n<300」在跃升态根本扫不到目标）。可见者取最靠上（跃升态）；全不可见取最靠下（常态）。 */
function glueWallpaper() {
  const A = glueInit(); if (!A) return null;
  let p = A.getWindow(A.getDesktop(), 5), n = 0; // GW_CHILD：自顶向下
  const seen = new Set();
  const nameBuf = Buffer.alloc(256);
  let visBest = null, hidBest = null;
  while (p && p !== 0n && n < 2000) {
    const s = String(p); if (seen.has(s)) break; seen.add(s);
    const len = A.getClassName(p, nameBuf, 128);
    if (nameBuf.subarray(0, len * 2).toString('utf16le') === 'WorkerW') {
      const r = Buffer.alloc(16); A.getRect(p, r);
      const w = r.readInt32LE(8) - r.readInt32LE(0), h = r.readInt32LE(12) - r.readInt32LE(4);
      if (w > 1200 && h > 700) {
        if (A.isVisible(p)) { if (!visBest) visBest = p; } // 第一个可见 = 最靠上（跃升壁纸层）
        else hidBest = p;                                  // 最后写入 = 最靠下（常态壁纸层）
      }
    }
    p = A.getWindow(p, 2); n++; // GW_HWNDNEXT 向 z 序下方
  }
  return visBest || hidBest;
}
function glueTick() {
  const A = glueInit(); if (!A || !win || win.isDestroyed()) return;
  const W = glueWallpaper(); if (!W) return; // 找不到壁纸层（异形系统）→ 退回自然 z 序，不硬抬
  const wallUp = A.isVisible(W);
  // 常态下交互放行（聚焦/展开允许自然置前，v1.0.24 手感）；壁纸可见=桌面态必须钉住（#70）
  if (!wallUp && (win.isFocused() || dockExpanded)) return;
  const hw = win.getNativeWindowHandle().readBigUInt64LE(0);
  // 目标态：小窗紧贴壁纸层「上方」（其下邻=壁纸层）。
  // SetWindowPos(A, B) 是把 A 插到 B【下方】（probe-setpos 实锤）——要插壁纸层上方须用「壁纸层的上邻」做锚；
  // W 已是链顶时上邻为 NULL(=HWND_TOP)，仍在 W 上方。旧代码直接以 W 为锚+检查上邻，方向全反（小窗被钉壁纸之下）。
  if (A.getWindow(hw, 2) !== W) {
    const anchor = A.getWindow(W, 3) || 0n;
    A.setPos(hw, anchor, 0, 0, 0, 0, 0x1B); // SWP_NOSIZE|NOMOVE|NOSENDCHANGING|NOACTIVATE
  }
}
function setGlue(on) {
  if (on) {
    if (!glueTimer) glueTimer = setInterval(glueTick, 100);
    glueTick();
  } else if (glueTimer) {
    clearInterval(glueTimer); glueTimer = null;
  }
}
function applyTopmost() {
  if (!win || win.isDestroyed()) return;
  try {
    if (settings.docked && settings.alwaysOnTop) {
      win.setAlwaysOnTop(true, 'screen-saver'); // 置顶用户：浮最上层，「显示桌面」天然免疫
      setGlue(false);
    } else {
      win.setAlwaysOnTop(!!settings.alwaysOnTop, 'floating');
      setGlue(!!settings.docked && !settings.alwaysOnTop); // 桌面部件：钉壁纸层上沿
    }
  } catch (e) { }
}
function sendDockState() {
  if (win && !win.isDestroyed()) win.webContents.send('dock:state', { docked: !!settings.docked, expanded: dockExpanded });
}
/* 悬停检测：拖拽区不派发 DOM 鼠标事件，用主进程光标轮询兜底（渲染层 mouse 事件走同一入口） */
function handleDockHover(inside) {
  if (!win || win.isDestroyed() || !settings.docked || settings.edgeDock === false) return;
  if (SHOT_MODE) return; // 截图调试：冻结悬停自动收/展，避免抓不到大窗
  if (inside) {
    if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
    if (hoverArmed && !dockExpanded) expandDock();
  } else {
    hoverArmed = true; // 离开 → 重新武装，下次进入才展开
    // 已有待触发的收起定时器就不重建（轮询会反复进来，重建会永远不触发）
    if (dockExpanded && !dockTimer) {
      dockTimer = setTimeout(() => {
        dockTimer = null;
        if (win && !win.isDestroyed() && settings.docked && dockExpanded) collapseDock();
      }, 450);
    }
  }
}
function ensureHoverPoll() {
  if (hoverPoll) return;
  hoverPoll = setInterval(() => {
    if (!win || win.isDestroyed()) { stopHoverPoll(); return; } // 窗口销毁后不许残留 interval
    if (!settings.docked || settings.edgeDock === false) return;
    if (!win.isVisible()) { stopHoverPoll(); return; } // 隐藏到托盘时不空转光标轮询
    const b = win.getBounds();
    const p = screen.getCursorScreenPoint();
    // 收起态只认小窗矩形；展开态认整个窗口
    const z = dockExpanded ? b : (r => ({ x: b.x + r.x, y: b.y + r.y, width: r.width, height: r.height }))(pillShapeRect()[0]);
    const inZone = p.x >= z.x && p.x <= z.x + z.width && p.y >= z.y && p.y <= z.y + z.height;
    if (!dockExpanded && inZone && p.x < z.x + 46) return; // 收起态左侧抓手只用于拖拽，不触发展开
    handleDockHover(inZone);
  }, 260);
}
function stopHoverPoll() { clearInterval(hoverPoll); hoverPoll = null; if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; } }
function dockWindow() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  // 只移动、不改尺寸（一律按基准尺寸算，异常宽度不会被带进吸附位）：小窗 x 为中心记忆位
  const px = clamp(Math.round(b.x + baseSize.w / 2 - PILL_W / 2), wa.x, wa.x + wa.width - PILL_W);
  if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
  dockExpanded = false;
  hoverArmed = false; // 刚放下不展开，等光标离开后再进入才展开
  settings.docked = true; settings.dockX = px;
  persist({ docked: true, dockX: px });
  setBoundsSafe({ x: px - Math.round((baseSize.w - PILL_W) / 2), y: wa.y, width: baseSize.w, height: baseSize.h });
  setShapePill();
  applyTopmost(); // 吸顶小窗恒 topmost：「显示桌面」壁纸跃升盖不住（#70）
  sendDockState();
  ensureHoverPoll();
}
function undockWindow() {
  if (!win || win.isDestroyed()) return;
  if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
  dockExpanded = false;
  settings.docked = false;
  const b = win.getBounds();
  persist({ docked: false, winPos: { x: b.x, y: b.y } });
  setShapeFull();
  applyTopmost(); // 脱离吸顶 → 回归用户置顶偏好（大窗态系统行为不变）
  sendDockState();
  stopHoverPoll();
}
function expandDock() {
  if (!win || win.isDestroyed()) return;
  dockExpanded = true;
  setShapeFull();          // 先放开整个窗口，再由 CSS 淡入
  sendDockState();
  ensureHoverPoll();
}
function collapseDock() {
  if (!win || win.isDestroyed()) return;
  dockExpanded = false;
  hoverArmed = false;
  sendDockState();         // CSS 先淡出 + 天空层形变收进小窗
  setTimeout(() => {       // 淡出/形变（~240ms）完成后再裁剪形状，避免内容突然消失
    if (!win || win.isDestroyed() || !settings.docked || dockExpanded) return;
    // 小窗按大窗平移后的位置对位：x 跟随大窗中心、y 贴回顶边（吸顶归位），并固化位置记忆
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const px = clamp(Math.round(b.x + baseSize.w / 2 - PILL_W / 2), wa.x, wa.x + wa.width - PILL_W);
    const nx = px - Math.round((baseSize.w - PILL_W) / 2);
    if (nx !== b.x || b.y !== wa.y) setBoundsSafe({ x: nx, y: wa.y, width: baseSize.w, height: baseSize.h });
    if (px !== settings.dockX) { settings.dockX = px; persist({ dockX: px }); }
    setShapePill();
  }, 260);
  ensureHoverPoll();
}
/* 拖拽结束：距顶端够近 → 吸顶收起；吸顶态拖离 → 恢复完整插件 */
function checkSnap() {
  if (!win || win.isDestroyed()) return;
  // 最小化时窗口飞到屏外 (-32000)，b.y - wa.y 恒「贴顶」会把最小化误判成吸顶反手 dock
  if (win.isMinimized()) return;
  if (Date.now() - programmatic < 600) return;
  if (settings.edgeDock === false) {
    if (settings.docked) undockWindow();
    return;
  }
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  if (!settings.docked) {
    if (b.y - wa.y <= SNAP_IN) dockWindow();
  } else if (b.y - wa.y > SNAP_OUT) {
    undockWindow();
  } else if (!dockExpanded) {
    dockWindow(); // 仍在顶部附近松手 → 回吸对齐
  }
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  ipcMain.handle('settings:get', () => settings);
  const SETTINGS_KEYS = new Set(['alwaysOnTop', 'autoLaunch', 'edgeDock', 'updateUrl', 'trayInfo', 'motion']);
  ipcMain.handle('settings:update', (_e, patch) => {
    const safe = {};
    if (patch && typeof patch === 'object') {
      for (const k of Object.keys(patch)) {
        if (!SETTINGS_KEYS.has(k)) continue;
        const v = patch[k];
        if (k === 'updateUrl') {
          const u = String(v == null ? '' : v).trim().slice(0, 500);
          if (!u) { safe.updateUrl = ''; continue; }
          let parsed = null; try { parsed = new URL(u); } catch (e) { }
          const local = parsed && /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(parsed.hostname);
          if (!parsed || parsed.username || parsed.password ||
              (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))) continue;
          safe.updateUrl = parsed.href.replace(/\/+$/, '');
        } else if (k === 'motion') {
          if (v === 'on' || v === 'off') safe.motion = v;
        } else if (typeof v === 'boolean') {
          safe[k] = v;
        }
      }
    }
    persist(safe);
    if (typeof safe.alwaysOnTop === 'boolean') applyTopmost();
    if (win) applyAutoLaunch(settings.autoLaunch);
    if (safe.edgeDock === false && settings.docked) undockWindow();
    return settings;
  });

  // 吸顶小窗悬停：进入 → 展开；离开 → 延时收起
  ipcMain.on('dock:hover', (_e, inside) => handleDockHover(!!inside));

  // 系统通知（渲染层组装文案）
  ipcMain.on('notify', (_e, p) => {
    if (!p || typeof p !== 'object') return;
    const title = String(p.title == null ? '' : p.title).slice(0, 60);
    const body = String(p.body == null ? '' : p.body).slice(0, 300);
    if (title) pushNotify(title, body);
  });

  // 托盘动态信息：悬停即见实时速率 / 今日流量
  ipcMain.on('tray:info', (_e, text) => refreshTrayMenu(String(text == null ? '' : text)));

  /* ================= 流量数据接口（替代原 HTTP API，走 IPC） ================= */
  ipcMain.handle('app:overview', () => store.overview());
  ipcMain.handle('app:downloaders', () => store.listDownloaders());
  ipcMain.handle('app:settings-get', () => store.getSettings());
  ipcMain.handle('app:periods', (_e, gran) => store.periodSeries(gran));
  ipcMain.handle('app:chart', (_e, p) => chartCore.build(store, p && p.range, p && p.metric, p && p.offset));
  ipcMain.handle('app:is-demo', () => !!(collector && collector.isDemo()));

  function sanitizeDl(d) {
    if (!d || typeof d !== 'object') return null;
    const url = String(d.url == null ? '' : d.url).trim().slice(0, 500);
    try { const u = new URL(url); if (u.protocol !== 'http:' && u.protocol !== 'https:') return null; }
    catch (e) { return null; }
    return {
      name: String(d.name == null ? '' : d.name).trim().slice(0, 60) || '下载器',
      type: d.type === 'tr' ? 'tr' : 'qb',
      url,
      username: String(d.username == null ? '' : d.username).slice(0, 120),
      password: String(d.password == null ? '' : d.password).slice(0, 200),
      enabled: d.enabled !== false,
      color_up: /^#[0-9a-fA-F]{6}$/.test(d.color_up || '') ? d.color_up : '',
      color_down: /^#[0-9a-fA-F]{6}$/.test(d.color_down || '') ? d.color_down : ''
    };
  }
  ipcMain.handle('dl:add', (_e, d) => {
    const s = sanitizeDl(d); if (!s) return { error: '地址无效，请填写完整的 http(s) 地址' };
    const row = store.addDownloader(s); if (collector) collector.restart();
    return { id: row.id };
  });
  ipcMain.handle('dl:update', (_e, id, patch) => {
    const s = sanitizeDl(patch); if (!s) return { error: '地址无效' };
    store.updateDownloader(id, s); if (collector) collector.restart(); return { ok: true };
  });
  ipcMain.handle('dl:delete', (_e, id) => { store.deleteDownloader(id); if (collector) collector.restart(); return { ok: true }; });
  ipcMain.handle('dl:reorder', (_e, ids) => { if (Array.isArray(ids)) store.reorderDownloaders(ids); return { ok: true }; });
  ipcMain.handle('dl:recolor', () => { store.recolor(); return { ok: true }; });
  ipcMain.handle('dl:test', async (_e, d) => {
    const s = sanitizeDl(d); if (!s) return { ok: false, error: '地址无效' };
    try {
      const cfg = Number(store.getSettings().request_timeout) || 5;
      const c = clients.makeClient(s, cfg * 1000);
      const r = await c.fetch();
      let ver = ''; try { ver = clients.shortVersion(await c.version()); } catch (e) { }
      return { ok: true, version: ver, dl_rate: r.dl_rate, up_rate: r.up_rate, source: r.extra && r.extra.source };
    } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });
  ipcMain.handle('dl:detail', async (_e, id) => {
    const d = store.getDownloader(id); if (!d) return null;
    const cfg = Number(store.getSettings().request_timeout) || 5;
    const c = clients.makeClient(d, cfg * 1000);
    const info = { name: d.name, type: d.type, url: d.url, periods: store.periodTotalsFor(id) };
    try { info.version = clients.shortVersion(await c.version()); } catch (e) { info.version = ''; }
    try { info.torrents = await c.torrents(); } catch (e) { info.torrents = null; }
    const st = store.getState(id);
    info.status = st.status; info.error = st.error || ''; info.extra = st.extra || {};
    return info;
  });
  ipcMain.handle('dl:detail-summary', () => {
    const out = { periods: store.periodTotals(), downloaders: [] };
    for (const d of store.listDownloaders()) {
      out.downloaders.push({ id: d.id, name: d.name, color_up: d.color_up, color_down: d.color_down, periods: store.periodTotalsFor(d.id) });
    }
    return out;
  });
  ipcMain.handle('app:settings-collect', (_e, patch) => {
    if (patch && typeof patch === 'object') {
      const safe = {};
      const ranges = { poll_interval: [0.2, 300], traffic_interval: [5, 1800], live_span: [30, 1800], request_timeout: [1, 60], tz_offset: [-12, 14], sample_retention_days: [1, 365] };
      for (const k of Object.keys(ranges)) {
        if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
        const v = Number(patch[k]);
        if (!Number.isFinite(v)) continue;
        safe[k] = Math.min(ranges[k][1], Math.max(ranges[k][0], v));
      }
      store.updateSettings(safe);
      if (collector) collector.restart();
    }
    return store.getSettings();
  });
  ipcMain.handle('app:refresh', () => { if (collector) { collector.pollRate(); collector.pollTraffic(); } return true; });

  ipcMain.handle('win:action', (_e, act) => {
    if (!win) return;
    if (act === 'close') { stopHoverPoll(); win.hide(); }
    else if (act === 'quit') { stopHoverPoll(); win = null; app.quit(); }
    else if (act === 'hide') { stopHoverPoll(); win.hide(); }
    else if (act === 'show') win.show();
    else if (act === 'pin') { const on = !settings.alwaysOnTop; persist({ alwaysOnTop: on }); applyTopmost(); return on; }
  });

  ipcMain.handle('app:version', () => app.getVersion());

  // OTA 在线更新
  ipcMain.handle('update:check', () => { checkForUpdates(true); return true; });
  ipcMain.handle('update:download', () => { startUpdateDownload(); return true; });
  ipcMain.handle('update:install', () => { installUpdate(); return true; });
  ipcMain.handle('update:state', () => updateState);

  // 窗口手动拖拽兜底：Win11 透明无边框窗 + setShape 下 -webkit-app-region:drag 可能失效。
  // 失效时渲染进程发来鼠标屏幕坐标，这里移动窗口；原生拖拽生效时渲染进程收不到事件，不会冲突。
  let dragBase = null;
  ipcMain.on('win:drag', (_e, sx, sy) => {
    if (!win || win.isDestroyed()) return;
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return; // NaN/Infinity 不进 setPosition
    if (!dragBase) {
      const p = win.getPosition();
      dragBase = { sx, sy, wx: p[0], wy: p[1] };   // 首帧只建基准，不动
      return;
    }
    win.setPosition(dragBase.wx + Math.round(sx - dragBase.sx), dragBase.wy + Math.round(sy - dragBase.sy));
  });
  ipcMain.on('win:drag-end', () => { dragBase = null; });
}

function applyAutoLaunch(on) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath });
  } catch (e) { }
}

/* ---------------- 窗口 ---------------- */
/* 尺寸采纳：基准=设计常量。落盘 winSize 只当「回执」不当「基准」——旧版的宽范围校验
   （380-1280x560-2200）会放过 900x920 这类坏值（旧版拖拽拉伸固化进 settings.json），
   被采纳成 baseSize 后 saveGeom/setShape/自愈全部「纠回」坏尺寸；卸载不清 userData，
   重装也救不回（2026-11-01 用户实报）。任何非设计值一律采纳设计尺寸并清写落盘，
   老机器升级启动即痊愈。 */
function adoptWinSize() {
  const s = settings.winSize;
  if (!s || Math.round(s.w) !== DESIGN_W || Math.round(s.h) !== DESIGN_H) {
    persist({ winSize: { w: DESIGN_W, h: DESIGN_H } }); // 清洗历史坏数据
  }
  return { w: DESIGN_W, h: DESIGN_H };
}
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const size = adoptWinSize();
  baseSize = size;
  const startDocked = !!settings.docked && settings.edgeDock !== false;
  let x, y;
  if (startDocked) {
    // 上次退出时处于吸顶态：窗口尺寸不变，只把小窗对位到顶部
    const px = Number.isFinite(settings.dockX) ? settings.dockX : wa.x + wa.width - PILL_W - 36;
    x = px - Math.round((size.w - PILL_W) / 2);
    y = wa.y;
    x = clamp(x, wa.x, wa.x + wa.width - size.w);
  } else if (settings.winPos && Number.isFinite(settings.winPos.x)) { x = settings.winPos.x; y = settings.winPos.y; }
  else { x = wa.x + wa.width - size.w - 36; y = wa.y + wa.height - size.h - 24; }
  // 位置自愈：落盘位置已完全离开所有屏幕（拔显示器/换分辨率残留的坏数据）→ 回退默认位
  const onScreen = screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return x < a.x + a.width && x + size.w > a.x && y < a.y + a.height && y + size.h > a.y;
  });
  if (!onScreen) { x = wa.x + wa.width - size.w - 36; y = wa.y + wa.height - size.h - 24; }

  win = new BrowserWindow({
    x: Math.round(x), y: Math.round(y),
    width: Math.round(size.w), height: Math.round(size.h),
    frame: false,
    transparent: true,
    // 关掉 Win11 DWM 窗口边框/圆角（"框框"的来源），彻底无边框沉浸
    thickFrame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: !!settings.alwaysOnTop,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    title: '流量台',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  // 导航防护（Electron 安全基线）：单页本地应用不需要任何导航/新窗口，
  // 渲染层即使被注入也不许外跳或开窗
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  applyTopmost();
  /* 吸顶小窗常驻桌面（用户反馈：点「显示桌面」小窗被一起最小化带走）。
     系统级最小化（Win+D / Win+M / 任务栏「显示桌面」）是唯一能让本窗最小化的入口
     （skipTaskbar+无边框，没有最小化按钮），故 docked 态拦截 minimize 原地恢复即可；
     大窗态保持系统正常行为（该最小化就最小化）。恢复用 showInactive 不抢焦点，
     用户仍停留在桌面；置顶层级/形状在恢复后重申一次（最小化可能掉档）。 */
  const undoMinimize = () => {
    if (!win || win.isDestroyed() || !settings.docked) return;
    if (!win.isMinimized()) return;
    try { win.showInactive(); } catch (e) { try { win.restore(); } catch (e2) { } }
    try { win.moveTop(); } catch (e3) { }
    try { applyTopmost(); } catch (e4) { }
    if (settings.docked && !dockExpanded) setShapePill();
  };
  win.on('minimize', () => {
    if (!settings.docked) return;
    setImmediate(undoMinimize);        // 最小化事件后立即拉回
    setTimeout(undoMinimize, 40);      // 系统最小化动画期间再兜一次（事件时序竞争）
    setTimeout(undoMinimize, 250);
  });
  win.on('closed', () => { stopHoverPoll(); setGlue(false); });
  // 隐藏到托盘时停掉 260ms 光标轮询，重新显示时再起（避免后台无效唤醒）
  win.on('hide', stopHoverPoll);
  win.on('show', () => { if (settings.docked && settings.edgeDock !== false) ensureHoverPoll(); });
  // shot 自检：加载前清一次 HTTP 缓存，防止 file:// 的 styles.css 等被磁盘缓存住（改动看似不生效）
  if (SHOT_MODE) { try { win.webContents.session.clearCache().catch(() => { }); } catch (e) { } }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    sendDockState(); if (settings.docked) setShapePill();
    // 更新自检要求横幅每次都真弹：清掉历史运行残留的「稍后」记忆，保证可复现
    if (process.argv.includes('--shot-update')) {
      win.webContents.executeJavaScript('Object.keys(localStorage).filter(k => k.indexOf("updDismiss_") === 0).forEach(k => localStorage.removeItem(k))').catch(() => { });
    }
  });
  if (startDocked) { hoverArmed = true; ensureHoverPoll(); }
  // 启动自愈：窗口贴在屏幕顶端（比如上次拖到顶没吸附成功）→ 自动收起为温度小窗
  if (!SHOT_MODE && !startDocked) setTimeout(checkSnap, 1200);

  // 渲染进程报错输出到控制台，便于排查。
  // Electron 33 起 console-message 改为事件对象携带 level/message（旧位置参数已弃用），
  // 双签名兼容：两种形态都取到等级与文本，warning/error 恒不丢
  win.webContents.on('console-message', (e, level, message) => {
    const lv = level != null ? level : (e && e.level);
    const msg = message != null ? message : String((e && e.message) || '');
    const sev = typeof lv === 'number' ? lv
      : ({ verbose: 0, info: 1, warning: 2, error: 3 })[String(lv)] != null ? ({ verbose: 0, info: 1, warning: 2, error: 3 })[String(lv)] : 0;
    if (sev >= 2 || SHOT_MODE) console.log('[renderer]', msg);
  });

  // 渲染进程崩溃自愈：白屏挂死比崩溃更糟，记录后原地 reload（限次防崩溃循环）
  let goneCount = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    if (!details || details.reason === 'clean-exit') return;
    console.error('[main] renderer gone:', details.reason);
    if (goneCount++ >= 2) return;
    try { win.webContents.reload(); } catch (err) { }
  });

  // --shot：流量台界面自检截图（开发用，输出 ui-*.png）
  // 打包后 exe 的 `--shot` 会被 Chromium 命令行解析拦成 "bad option"，故同时支持 FLOW_SHOT=1 环境变量
  if (process.argv.includes('--shot') || process.env.FLOW_SHOT === '1') {
    const shoot = async (name) => {
      const img = await win.webContents.capturePage();
      // 打包后 __dirname 在 asar 内不可写，落到可写的 userData（Windows 的 Pictures 可能被重定向）
      const dir = app.isPackaged ? app.getPath('userData') : __dirname;
      const out = path.join(dir, name);
      fs.writeFileSync(out, img.toPNG());
      console.log('[shot] saved', out);
    };
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const W = async (js) => { try { return await win.webContents.executeJavaScript(js); } catch (e) { return null; } };
    // 等首屏数据与图表就绪（演示数据在启动 ~1.5s 内灌入，图表再等一帧）
    const ready = async (tries = 30) => {
      for (let i = 0; i < tries; i++) {
        const ok = await W(`(() => {
          const s = window.__flowState;
          return !!(s && s.overview && s.rate && s.rate.data && s.rate.data.series &&
                    s.rate.data.series.some(x => (x.down || []).some(v => v != null)) &&
                    s.traffic && s.traffic.data && s.traffic.data.summary);
        })()`);
        if (ok) return true;
        await wait(400);
      }
      return false;
    };
    setTimeout(async () => {
      await ready();
      await wait(700);
      await shoot('ui-1-main.png');

      // 滚到底部：流量统计图完整可见
      await W(`document.getElementById('widget').scrollTop = 99999`);
      await wait(700);
      await shoot('ui-2-traffic.png');

      // 夜色版式
      await W(`(() => { window.__forceNight = true; })()`);
      await wait(300);
      await W(`document.documentElement.classList.add('night'); document.getElementById('widget').scrollTop = 0`);
      await wait(900);
      await W(`document.getElementById('widget').scrollTop = 0`);
      await wait(400);
      await W(`window.__flowRefresh(false)`);
      await wait(900);
      await shoot('ui-3-night.png');
      await W(`document.getElementById('widget').scrollTop = 99999`);
      await wait(800);
      await shoot('ui-4-night-traffic.png');

      // 恢复白天 + 设置面板
      await W(`(() => { window.__forceNight = null; })()`);
      await W(`document.documentElement.classList.remove('night'); document.getElementById('widget').scrollTop = 0`);
      await wait(400);
      await W(`window.__flowRefresh(false)`);
      await wait(600);
      await W(`document.getElementById('btnSettings').click()`);
      await wait(900);
      await shoot('ui-5-settings.png');

      // 设置-采集页
      await W(`document.querySelector('.st-nav[data-page="collect"]').click()`);
      await wait(500);
      await shoot('ui-6-settings-collect.png');

      // 下载器详情弹窗
      await W(`document.getElementById('closeSettings').click()`);
      await wait(400);
      await W(`document.querySelector('.dl-card[data-dl]') && document.querySelector('.dl-card[data-dl]').click()`);
      await wait(900);
      await shoot('ui-7-detail.png');
      await W(`document.getElementById('detailModal').hidden = true`);

      // 吸顶小窗（模拟 docked 收起态）
      await W(`(() => { document.getElementById('pill').classList.add('show'); document.getElementById('widget').classList.add('dock-hidden'); })()`);
      await wait(600);
      await shoot('ui-8-pill.png');
      await W(`(() => { document.getElementById('pill').classList.remove('show'); document.getElementById('widget').classList.remove('dock-hidden'); })()`);

      console.log('[shot] all done');
      setTimeout(() => { try { app.quit(); } catch (e) { } }, 600);
    }, 1600);
  }

  win.on('closed', () => { win = null; });
}

let trayInfoText = '流量台 · 实时速率';
/* 托盘右键菜单：刷新 / 切城市直达；tooltip 随天气刷新动态更新。
   菜单每次重建（频率=刷新周期），保证地点列表与「窗口置顶」勾选态始终是最新的。 */
function refreshTrayMenu(text) {
  if (!tray) return;
  if (text) trayInfoText = String(text).slice(0, 120) || trayInfoText;
  try { tray.setToolTip(trayInfoText); } catch (e) { }
  try {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: trayInfoText, enabled: false },
      { type: 'separator' },
      { label: '显示流量台', click: () => win && win.show() },
      { label: '立即刷新', click: () => { if (win && !win.isDestroyed()) win.webContents.send('tray:action', { type: 'refresh' }); } },
      { label: '窗口置顶', type: 'checkbox', checked: !!settings.alwaysOnTop, click: (m) => { persist({ alwaysOnTop: m.checked }); win && applyTopmost(); refreshTrayMenu(); } },
      { type: 'separator' },
      { label: '退出', click: () => { win = null; app.quit(); } }
    ]));
  } catch (e) { }
}
function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    refreshTrayMenu();
    tray.on('double-click', () => win && win.show());
  } catch (e) { }
}

/* ---------------- OTA 在线更新 ----------------
   generic 更新源：把 dist 里的 latest.yml + 安装包 + .blockmap 上传到任意
   HTTP(S) 静态服务器，在设置页填地址（或发布前替换 DEFAULT_UPDATE_URL）。
   流程：启动/每 4 小时后台检查 → 发现新版本弹横幅提醒 → 用户点「立即更新」
   后台下载（带进度）→ 下载完成提示重启安装。 */
const DEFAULT_UPDATE_URL = 'https://github.com/kmnn111/torrent-flow-widget/releases/latest/download';
let autoUpdater = null;
let updateState = { type: 'idle' };
let updateTimer = null;
let checkWatchdog = null; // 检查看门狗：网络异常时更新请求可能永远挂起不回调，超时收场别让界面一直转圈
let pendingUpdateSha = ''; // 本次下载完成的安装包 sha512；用户确认安装时落盘为消费标记（防同版本热修重推循环）

function otaLog(...args) {
  console.log('[ota]', ...args);
  const logPath = process.argv.find(a => a.startsWith('--ota-log='));
  if (logPath || process.argv.includes('--ota-test')) {
    try {
      const p = logPath ? logPath.slice('--ota-log='.length) : path.join(app.getPath('userData'), 'ota-test.log');
      fs.appendFileSync(p, new Date().toISOString() + ' ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');
    } catch (e) { }
  }
}

function effectiveUpdateUrl() {
  const cli = process.argv.find(a => a.startsWith('--update-url='));
  const url = cli ? cli.slice('--update-url='.length) : (settings.updateUrl || DEFAULT_UPDATE_URL);
  return String(url || '').trim().replace(/\/+$/, '');
}

// 系统推送通知：吸顶小窗看不到更新横幅，发现新版本/更新就绪时发系统通知（每版本每类型只推一次）
const notifiedUpdate = { available: '', downloaded: '' };
function pushNotify(title, body) {
  try {
    if (SHOT_MODE || !Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on('click', () => {
      if (win && !win.isDestroyed()) {
        win.show();
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
    n.show();
  } catch (e) { otaLog('notify failed', String(e)); }
}

function sendUpdateState(s) {
  if (checkWatchdog) { clearTimeout(checkWatchdog); checkWatchdog = null; } // 有任何状态推进 = 请求活着
  updateState = s;
  if (s && s.type === 'available' && s.version && notifiedUpdate.available !== s.version) {
    notifiedUpdate.available = s.version;
    pushNotify('云上晴雨有新版本 v' + s.version, '当前 v' + (s.current || app.getVersion()) + '，点击打开并更新');
  } else if (s && s.type === 'downloaded' && s.version && notifiedUpdate.downloaded !== s.version) {
    notifiedUpdate.downloaded = s.version;
    pushNotify('新版本 v' + s.version + ' 已就绪', '点击打开，重启后完成安装');
  }
  if (win && !win.isDestroyed()) win.webContents.send('update:state', s);
}

function setupAutoUpdate() {
  try {
    const { autoUpdater: au } = require('electron-updater');
    autoUpdater = au;
    // electron-updater 6.x 未打包时 checkForUpdates 静默 resolve(null)（无事件、无请求）：
    // 开发/自检态强制启用，让 --shot-update 假源链路真实跑通（打包版不受影响）
    if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.autoDownload = false;        // 下载需用户点「立即更新」
    autoUpdater.autoInstallOnAppQuit = false; // 安装需用户确认重启
    autoUpdater.on('checking-for-update', () => otaLog('checking'));
    autoUpdater.on('update-available', (info) => {
      // 同版本热修重推防回环（消费标记法）：热修 latest.yml 触发号恒大于本版（否则过不了 semver 闸），
      // 装没装过就看安装包字节——上次「立即重启」安装时记录的 sha512 与本次 offer 相同 = 已装即已拥有，
      // 按「已是最新」收场，不弹横幅不循环下载；热修复换了新安装包（sha512 不同）→ 正常弹出安装。
      // 旧规则「安装包名 == 本版本名即跳过」已废弃：热修包名必然=本版本名，会把热修 offer 永远静默吞掉。
      const sha = String((info && info.files && info.files[0] && info.files[0].sha512) || '');
      if (sha && sha === String(settings.updSha512 || '')) {
        otaLog('skip consumed repush offer', sha.slice(0, 12));
        sendUpdateState({ type: 'up-to-date', current: app.getVersion() });
        return;
      }
      otaLog('available', info.version);
      sendUpdateState({ type: 'available', version: info.version, current: app.getVersion() });
    });
    autoUpdater.on('update-not-available', () => {
      otaLog('not-available');
      sendUpdateState({ type: 'up-to-date', current: app.getVersion() });
    });
    autoUpdater.on('download-progress', (p) => sendUpdateState({ type: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => {
      pendingUpdateSha = String((info && info.files && info.files[0] && info.files[0].sha512) || '');
      otaLog('downloaded', info.version);
      sendUpdateState({ type: 'downloaded', version: info.version });
    });
    autoUpdater.on('error', (err) => {
      const msg = String((err && err.message) || err);
      otaLog('error', msg);
      sendUpdateState({ type: 'error', message: msg });
    });
    otaLog('autoUpdater ready');
  } catch (e) { otaLog('autoUpdater init failed', String(e)); }
}

function checkForUpdates(manual) {
  const cli = process.argv.find(a => a.startsWith('--update-url='));
  const testing = !!cli || process.argv.includes('--shot-update'); // 自检模式：开发态也真跑更新链路
  const url = effectiveUpdateUrl();
  if (!autoUpdater) { if (manual) sendUpdateState({ type: 'error', message: '更新组件未就绪' }); return; }
  if (!app.isPackaged && !testing) { if (manual) sendUpdateState({ type: 'error', message: '开发模式不支持在线更新' }); return; }
  if (!url) {
    otaLog('skip check: update url not configured');
    if (manual) sendUpdateState({ type: 'unconfigured' });
    return;
  }
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url });
    otaLog('checking', url);
    // 看门狗：更新请求可能被坏代理/网络挂死（不回调、不报错），25 秒无状态推进按超时收场
    if (checkWatchdog) clearTimeout(checkWatchdog);
    checkWatchdog = setTimeout(() => {
      checkWatchdog = null;
      otaLog('check timeout');
      sendUpdateState({ type: 'error', message: '检查超时，请检查网络后重试' });
    }, 25000);
    const p = autoUpdater.checkForUpdates();
    if (p && p.catch) p.catch(err => {
      const msg = String((err && err.message) || err);
      otaLog('check error', msg);
      if (checkWatchdog) { clearTimeout(checkWatchdog); checkWatchdog = null; }
      if (manual) sendUpdateState({ type: 'error', message: msg });
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    otaLog('check threw', msg);
    if (checkWatchdog) { clearTimeout(checkWatchdog); checkWatchdog = null; }
    if (manual) sendUpdateState({ type: 'error', message: msg });
  }
}

function startUpdateDownload() {
  if (!autoUpdater) return;
  otaLog('download start');
  sendUpdateState({ type: 'downloading', percent: 0 });
  const p = autoUpdater.downloadUpdate();
  if (p && p.catch) p.catch(err => { const msg = String((err && err.message) || err); otaLog('download error', msg); sendUpdateState({ type: 'error', message: msg }); });
}

function installUpdate() {
  if (!autoUpdater) return;
  otaLog('quitAndInstall');
  // 消费标记落盘：本次安装的安装包 sha512 → 重启后同 offer 按「已装」跳过（防循环弹窗）。
  // 必须在「确认安装」这一刻记录而不是下载完成时——下载后点「稍后」并未拥有，offer 应继续弹。
  if (pendingUpdateSha) { try { persist({ updSha512: pendingUpdateSha }); } catch (e) { } }
  try { autoUpdater.quitAndInstall(false, true); } catch (e) { otaLog('install error', String(e)); }
}

function scheduleUpdateChecks() {
  const cli = process.argv.find(a => a.startsWith('--update-url='));
  setTimeout(() => checkForUpdates(false), cli ? 3000 : 30000); // 启动后首检（测试模式 3 秒）
  updateTimer = setInterval(() => checkForUpdates(false), 4 * 3600 * 1000); // 每 4 小时
}

/* ---------------- 启动 ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    loadSettings();
    // 截图自检环境常报「减少动态效果」；自检要验证形变插值本身，强制走 on 档，
    // 只影响 shot profile 内存态，不写盘、不影响正式实例。
    if (SHOT_MODE) settings.motion = 'on';
    registerIpc();
    createWindow();
    createTray();
  // 启动流量采集（演示/真实由 store 中下载器数量决定）
  collector = new Collector(store, (kind) => {
    if (win && !win.isDestroyed() && !win.isMinimized()) {
      try { win.webContents.send('data:' + kind, { at: Math.floor(Date.now() / 1000) }); } catch (e) { }
    }
    if (kind === 'traffic') store.flush();
  });
  collector.start();
    applyAutoLaunch(settings.autoLaunch);
    setupAutoUpdate();
    scheduleUpdateChecks();
  });
  app.on('window-all-closed', () => app.quit());
}

app.on('before-quit', () => { try { if (store) store.flush(); if (collector) collector.stop(); } catch (e) { } });
