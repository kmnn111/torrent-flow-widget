'use strict';
/**
 * 打包完整性回归：构建配置必须覆盖界面所需资源。
 *
 * 事故：某次打包漏了 renderer/charts.js、renderer/icons.js 和 assets/fonts/*，
 * 安装后实时速率 / 流量统计图表空白、图标全丢。这类问题开发态完全看不出来
 * （file:// 直接读源码），只有打包后才暴露，所以要在配置层守住。
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = (pkg.build && pkg.build.files) || [];
const has = glob => files.some(f => f === glob || f.indexOf(glob.replace('**', '').replace('/*', '')) === 0);

console.log('\n=== 打包配置覆盖界面资源 ===');
t('包含 renderer/**/*', files.some(f => /^renderer\/?\*+/.test(f)), JSON.stringify(files));
t('包含 assets/**/*', files.some(f => /^assets\/?\*+/.test(f)), JSON.stringify(files));
t('包含 core/**/*', files.some(f => /^core\/?\*+/.test(f)), JSON.stringify(files));

console.log('\n=== 磁盘上的关键资源真实存在 ===');
const must = [
  'renderer/charts.js', 'renderer/icons.js', 'renderer/index.html', 'renderer/app.js', 'renderer/styles.css',
  'assets/fonts/HarmonyOS_Sans_SC_Regular.woff2',
  'assets/fonts/HarmonyOS_Sans_SC_Medium.woff2',
  'assets/fonts/HarmonyOS_Sans_SC_Bold.woff2',
  'assets/icon.ico'
];
for (const rel of must) {
  t(rel, fs.existsSync(path.join(root, rel)));
}

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===\n`);
process.exitCode = fail ? 1 : 0;
