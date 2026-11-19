'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 渲染层 → 主进程的唯一桥接。只暴露白名单方法，不直接暴露 ipcRenderer。
contextBridge.exposeInMainWorld('flow', {
  /* 窗口 / 桌面机制 */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  winAction: (act, arg) => ipcRenderer.invoke('win:action', act, arg),
  winDrag: (sx, sy) => ipcRenderer.send('win:drag', sx, sy),
  winDragEnd: () => ipcRenderer.send('win:drag-end'),
  dockHover: (inside) => ipcRenderer.send('dock:hover', !!inside),
  onDockState: (cb) => ipcRenderer.on('dock:state', (_e, s) => cb && cb(s)),
  trayInfo: (text) => ipcRenderer.send('tray:info', String(text || '').slice(0, 120)),
  onTrayAction: (cb) => ipcRenderer.on('tray:action', (_e, a) => cb && cb(a)),
  version: () => ipcRenderer.invoke('app:version'),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),

  /* 流量数据 */
  overview: () => ipcRenderer.invoke('app:overview'),
  downloaders: () => ipcRenderer.invoke('app:downloaders'),
  settingsGet: () => ipcRenderer.invoke('app:settings-get'),
  periods: (gran) => ipcRenderer.invoke('app:periods', gran),
  chart: (p) => ipcRenderer.invoke('app:chart', p),
  isDemo: () => ipcRenderer.invoke('app:is-demo'),
  onData: (kind, cb) => ipcRenderer.on('data:' + kind, (_e, d) => cb && cb(d)),

  /* 下载器管理 */
  dlAdd: (d) => ipcRenderer.invoke('dl:add', d),
  dlUpdate: (id, patch) => ipcRenderer.invoke('dl:update', id, patch),
  dlDelete: (id) => ipcRenderer.invoke('dl:delete', id),
  dlResetDemo: () => ipcRenderer.invoke('dl:reset-demo'),
  dlReorder: (ids) => ipcRenderer.invoke('dl:reorder', ids),
  dlRecolor: () => ipcRenderer.invoke('dl:recolor'),
  dlTest: (d) => ipcRenderer.invoke('dl:test', d),
  dlDetail: (id) => ipcRenderer.invoke('dl:detail', id),
  dlDetailSummary: () => ipcRenderer.invoke('dl:detail-summary'),

  /* 采集设置 */
  settingsCollect: (patch) => ipcRenderer.invoke('app:settings-collect', patch),
  refresh: () => ipcRenderer.invoke('app:refresh'),

  /* OTA（保留机制，更新源可在设置里配置） */
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateState: () => ipcRenderer.invoke('update:state'),
  onUpdateState: (cb) => ipcRenderer.on('update:state', (_e, s) => cb && cb(s))
});
