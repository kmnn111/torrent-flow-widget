'use strict';
/**
 * 发版打包：把 dist/ 里的 NSIS 产物复制成 ASCII 三件套到 dist-gh/，
 * 供 GitHub Release 直接上传（中文文件名在 /releases/latest/download/ 直链下会 404）。
 *
 * 用法：node scripts/prepare-release.js
 *   1. 先跑 npm run dist 产出 dist/TorrentFlow-Setup-x.y.z.exe（artifactName 已是 ASCII）
 *   2. 本脚本把 exe / blockmap / latest.yml 三件套归整到 dist-gh/
 *   3. 顺带校验 latest.yml 里的 sha512 与 size 和 exe 实际值一致
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'dist-gh');

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const exeName = `TorrentFlow-Setup-${version}.exe`;

  if (!fs.existsSync(DIST)) {
    fail(`dist/ 不存在，先跑 npm run dist`);
  }
  const exePath = path.join(DIST, exeName);
  if (!fs.existsSync(exePath)) {
    const cands = fs.readdirSync(DIST).filter(f => f.endsWith('.exe'));
    fail(`找不到 ${exeName}\n  dist 里现有 exe：${cands.join(', ') || '（无）'}`);
  }

  fs.mkdirSync(OUT, { recursive: true });

  // 1. exe 本体
  const exeOut = path.join(OUT, exeName);
  fs.copyFileSync(exePath, exeOut);
  const size = fs.statSync(exeOut).size;

  // 2. blockmap（可选，缺失则全量下载）
  const blockSrc = exePath + '.blockmap';
  let blockOk = false;
  if (fs.existsSync(blockSrc)) {
    fs.copyFileSync(blockSrc, path.join(OUT, exeName + '.blockmap'));
    blockOk = true;
  }

  // 3. latest.yml：以 electron-builder 产出的为准，缺失则自己生成
  const ymlSrc = path.join(DIST, 'latest.yml');
  let sha512;
  if (fs.existsSync(ymlSrc)) {
    const raw = fs.readFileSync(ymlSrc, 'utf8');
    sha512 = (raw.match(/sha512:\s*(\S+)/) || [])[1];
    // electron-builder 有时把 exe 名写成中文（旧配置残留），统一改回 ASCII
    const fixed = raw
      .replace(/url:\s*.*\.exe/, `url: ${exeName}`)
      .replace(/^path:\s*.*\.exe/m, `path: ${exeName}`)
      .replace(/size:\s*\d+/, `size: ${size}`);
    fs.writeFileSync(path.join(OUT, 'latest.yml'), fixed, 'utf8');
  } else {
    // 自己算 sha512（base64）+ 拼 latest.yml
    const buf = fs.readFileSync(exeOut);
    sha512 = crypto.createHash('sha512').update(buf).digest('base64');
    const yml = [
      `version: ${version}`,
      'files:',
      `  - url: ${exeName}`,
      `    sha512: ${sha512}`,
      `    size: ${size}`,
      `path: ${exeName}`,
      `sha512: ${sha512}`,
      `releaseDate: '${new Date().toISOString()}'`,
      ''
    ].join('\n');
    fs.writeFileSync(path.join(OUT, 'latest.yml'), yml, 'utf8');
  }

  // 4. 校验：yml 里的 sha512 / size 与真实文件是否一致
  const exeBuf = fs.readFileSync(exeOut);
  const realSha = crypto.createHash('sha512').update(exeBuf).digest('base64');
  const ymlOut = fs.readFileSync(path.join(OUT, 'latest.yml'), 'utf8');
  const ymlSha = (ymlOut.match(/sha512:\s*(\S+)/) || [])[1];
  const ymlSize = Number((ymlOut.match(/size:\s*(\d+)/) || [])[1]);
  const shaOk = !ymlSha || ymlSha === realSha;
  const sizeOk = !ymlSize || ymlSize === size;

  console.log(`\n[release] 版本 ${version}`);
  console.log(`[release] 产物目录 ${OUT}`);
  console.log(`  ✓ ${exeName}  ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  ${blockOk ? '✓' : '·'} ${exeName}.blockmap${blockOk ? '' : '（缺失，将走下全量下载）'}`);
  console.log(`  ✓ latest.yml`);
  console.log(`  ${shaOk ? '✓' : '✗'} sha512 校验${shaOk ? '一致' : '不一致！'}`);
  console.log(`  ${sizeOk ? '✓' : '✗'} size 校验${sizeOk ? '一致' : '不一致！'}`);
  if (!shaOk || !sizeOk) {
    console.error('[release] latest.yml 与安装包不符，客户端更新会校验失败，请重跑 npm run dist 后再来');
    process.exit(1);
  }
  console.log('\n[release] 把 dist-gh/ 下三个文件上传到 GitHub Release 即可（资产名保持 ASCII）\n');
}

function fail(msg) {
  console.error('[release] ' + msg);
  process.exit(1);
}

main();