'use strict';
/**
 * PT 站点识别 — 由 tracker 域名反查站点昵称
 *
 * 设计取舍：
 *  1) 只用「域名后缀」匹配，不用完整 URL 匹配。tracker 地址会变（http/https、端口、
 *     passkey 前缀、镜像域名），唯一稳定的是主机名的可识别片段。
 *  2) 昵称优先于英文名：PT 圈内交流几乎只用昵称（彩虹岛 / 馒头 / 我堡），
 *     英文名作为副标题展示，两者都给才不至于让人对不上号。
 *  3) 认不出来的站不硬猜，回落到域名本身（去掉 tracker./t./pt. 前缀的主域），
 *     并在 UI 上以「未收录」的样式区分，避免编造出错误的中文名误导用户。
 *
 * 收录来源：各站公开域名 + PT 圈通行的中文昵称（多来源交叉核对）。
 */

/* 规则按「越具体越靠前」排列，先命中先返回。
   host 为小写主机名，may 含路径无关的域名片段。 */
const RULES = [
  // ---- 综合大站（五大 / 九大 / 十二大）----
  { key: 'mteam', match: ['m-team.cc', 'mteam.cc', 'kp.m-team'], name: '馒头', full: 'M-Team' },
  // CHDBits 的 tracker 域名不止一个：chdbits.xyz / ptchdbits.co / rainbowisland.co
  // 都指向同一个站，必须归到同一个 key，否则同一站会被拆成三行。
  { key: 'chdbits', match: ['chdbits', 'rainbowisland'], name: '彩虹岛', full: 'CHDBits' },
  { key: 'hdsky', match: ['hdsky'], name: '天空', full: 'HDSky' },
  { key: 'hdchina', match: ['hdchina'], name: '瓷器', full: 'HDChina' },
  { key: 'ttg', match: ['totheglory'], name: '套套哥', full: 'TTG' },
  { key: 'ourbits', match: ['ourbits'], name: '我堡', full: 'Ourbits' },
  { key: 'hdhome', match: ['hdhome'], name: '家园', full: 'HDHome' },
  { key: 'keepfrds', match: ['keepfrds'], name: '朋友', full: 'KeepFRDS' },
  { key: 'springsunday', match: ['springsunday'], name: '春天', full: 'Spring Sunday' },
  { key: 'pterclub', match: ['pterclub'], name: '猫站', full: 'PTerClub' },
  { key: 'audiences', match: ['audiences'], name: '观众', full: 'Audiences' },
  { key: 'hhanclub', match: ['hhanclub'], name: '憨憨', full: 'HHanClub' },

  // ---- 中坚与新站 ----
  { key: 'hdarea', match: ['hdarea'], name: '视界', full: 'HDArea' },
  { key: 'panda', match: ['pandapt'], name: '熊猫', full: 'Panda' },
  { key: 'piggo', match: ['piggo'], name: '猪猪', full: 'PigGo' },
  { key: 'crabpt', match: ['crabpt'], name: '蟹', full: 'CrabPt' },
  { key: 'hdcity', match: ['hdcity'], name: '城市', full: 'HDCity' },
  { key: 'pthome', match: ['pthome'], name: '铂金家', full: 'PTHome' },
  { key: 'btschool', match: ['btschool'], name: '学校', full: 'BTSchool' },
  { key: 'hdtime', match: ['hdtime'], name: '时间', full: 'HDTime' },
  { key: 'nicept', match: ['nicept'], name: '老师', full: 'NicePT' },
  { key: 'lemonhd', match: ['lemonhd', 'leaguehd'], name: '柠檬', full: 'LemonHD' },
  { key: 'hddolby', match: ['hddolby'], name: '杜比', full: 'HDDolby' },
  { key: 'hd4fans', match: ['hd4fans'], name: '兽站', full: 'HD4Fans' },
  { key: 'ptsbao', match: ['ptsbao'], name: '烧包', full: 'PTSbao' },
  { key: 'hdfans', match: ['hdfans'], name: '红豆饭', full: 'HDFans' },
  { key: 'haidan', match: ['haidan'], name: '海胆', full: 'HaiDan' },
  { key: 'pttime', match: ['pttime'], name: '5元神站', full: 'PTTime' },
  { key: 'ccfbits', match: ['ccfbits'], name: '吹吹风', full: 'CCFBits' },
  { key: 'tccf', match: ['et8.org', 'torrentccf'], name: '他吹吹风', full: 'TCCF' },
  { key: 'opencd', match: ['open.cd', 'opencd'], name: '皇后', full: 'OpenCD' },
  { key: 'u2', match: ['u2.dmhy'], name: '幼儿园', full: 'U2 动漫花园' },
  { key: 'skyey', match: ['skyey'], name: '天雪', full: 'SkyeySnow' },
  { key: 'hdatmos', match: ['hdatmos'], name: '全景声', full: 'HDAtmos' },
  { key: 'hdroute', match: ['hdroute', 'hdroad'], name: '思路', full: 'HDRoute' },
  { key: 'ptlsp', match: ['ptlsp'], name: '拉面', full: 'PTLSP' },
  { key: 'ptcafe', match: ['ptcafe'], name: '咖啡', full: 'PTcafe' },
  { key: 'rousi', match: ['rousi'], name: '肉丝', full: 'RouSi' },
  { key: 'zmpt', match: ['zmpt'], name: '织梦', full: 'ZMPT' },
  { key: 'qingwa', match: ['qingwapt'], name: '青蛙', full: 'QingWa' },
  { key: 'ptfans', match: ['ptfans'], name: 'PTFans', full: 'PTFans' },
  { key: 'ptlgs', match: ['ptlgs'], name: '劳改所', full: 'PTLGS' },
  { key: 'ultrahd', match: ['ultrahd'], name: 'UltraHD', full: 'UltraHD' },
  { key: 'leaves', match: ['leaves.red'], name: '红叶', full: 'RedLeaves' },
  { key: 'cyanbug', match: ['cyanbug'], name: '大青虫', full: 'CyanBug' },
  { key: 'ubits', match: ['ubits'], name: '你堡', full: 'UBits' },
  { key: 'kufei', match: ['kufei'], name: '苦咖啡', full: 'KuFei' },
  { key: 'agsv', match: ['agsvpt'], name: 'AGSV', full: 'AGSVPT' },
  { key: 'cspt', match: ['cspt'], name: 'CS', full: 'CSPT' },
  { key: 'sunnytk', match: ['sunnytk'], name: 'SunnyTK', full: 'SunnyTK' },

  // ---- 教育网 ----
  { key: 'tjupt', match: ['tjupt'], name: '北洋园', full: 'TJUPT' },
  { key: 'byrbt', match: ['byrbt', 'byr.pt'], name: '北邮人', full: 'BYRBT' },
  { key: 'sjtu', match: ['pt.sjtu', 'sjtu.edu'], name: '葡萄', full: 'SJTU' },
  { key: 'hitpt', match: ['hitpt'], name: '百川', full: 'HITPT' },
  { key: 'nanyangpt', match: ['nanyangpt'], name: '南洋', full: 'NanyangPT' },
  { key: 'hdupt', match: ['hdupt'], name: '好多油', full: 'HDU' },
  { key: 'hudbt', match: ['hudbt'], name: '蝴蝶', full: 'HUDBT' },
  { key: 'neu6', match: ['neu6'], name: '六维空间', full: 'NEU6' },
  { key: 'nwsuaf6', match: ['nwsuaf'], name: '麦田', full: 'NWSUAF6' },
  { key: 'npupt', match: ['npupt'], name: '蒲公英', full: 'NPUPT' }
];

/* 无意义前缀：tracker / t / tr / announce / bt 等子域不参与回退展示 */
const NOISE_LABEL = /^(tracker|trackers|t|tr|bt|announce|www|ssl|open|pt)$/i;

/* ---------------- 别名自学习 ----------------
   一个种子常同时挂同站的多个 tracker 域名（如 CHDBits 的 chdbits.xyz /
   ptchdbits.co / rainbowisland.co）。只要「同一个种子里」既有已收录的站、
   又有没收录的域名，那么这个没收录的域名就极可能属于同一个站 —— 记下来即可，
   下次直接命中。这样新增/换域名的站不用改代码，跑一轮就自动认全。

   ⚠️ 边界：同一个种子里若出现两个不同的已收录站（交叉辅种），说明这组 tracker
   并非同站，此时不做任何学习，避免把 A 站的域名错误地归到 B 站。 */
const learned = new Map(); // host → {key,name,full}

/**
 * 观察一个种子的整组 tracker，学习未知域名的归属
 * @param {string[]} urls 该种子的全部 tracker 地址
 * @returns {string} 学习到的站点 key（无则 ''）
 */
function learnFromTorrent(urls) {
  if (!Array.isArray(urls) || !urls.length) return '';
  const knownHits = new Map(); // key → rule
  const unknownHosts = [];
  for (const u of urls) {
    const host = hostOf(u);
    if (!host) continue;
    const hit = matchRule(host);
    if (hit) { if (!knownHits.has(hit.key)) knownHits.set(hit.key, hit); }
    else if (!learned.has(host)) unknownHosts.push(host);
  }
  // 同组出现多个不同站 = 交叉辅种，语义不明确，放弃学习
  if (knownHits.size !== 1) return knownHits.size ? '' : '';
  const rule = [...knownHits.values()][0];
  for (const host of unknownHosts) {
    // 统一用 baseDomain 作为键：学习与查询必须同口径，否则永远查不中
    const bd = baseDomain(host);
    if (bd) learned.set(bd, { key: rule.key, name: rule.name, full: rule.full });
  }
  return rule.key;
}

/** 纯规则匹配（不含学习表），供 learnFromTorrent 判断「已收录」 */
function matchRule(host) {
  for (const r of RULES) {
    for (const frag of r.match) {
      if (host === frag || host.endsWith('.' + frag) || host.indexOf(frag) >= 0) return r;
    }
  }
  return null;
}

/** 从 tracker URL 提取主机名（失败返回 ''） */
function hostOf(url) {
  if (!url) return '';
  let s = String(url).trim();
  if (!s) return '';
  // 裸主机名（'tracker.m-team.cc'）补协议后再解析，否则 URL 构造必然抛错
  if (!/^[a-z0-9+.-]+:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    return (u.hostname || '').toLowerCase();
  } catch (e) {
    const m = s.match(/^[a-z0-9+.-]+:\/\/([^/:?#]+)/i);
    return m ? m[1].toLowerCase() : '';
  }
}

/** 去掉噪声子域后的展示用域名：tracker.m-team.cc → m-team.cc */
function prettyHost(host) {
  if (!host) return '';
  const parts = host.split('.');
  while (parts.length > 2 && NOISE_LABEL.test(parts[0])) parts.shift();
  return parts.join('.');
}

/**
 * 兜底主域：只保留「注册域 + 顶级域」两级（example.co.uk 这类除外）。
 * 用于未收录域名的稳定分组键 —— tracker2.foo.com 和 tracker3.foo.com
 * 必须归到同一个 foo.com，否则同一站会被拆成多行。
 */
function baseDomain(host) {
  if (!host) return '';
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const last = parts[parts.length - 1];
  const snd = parts[parts.length - 2];
  // 常见二级后缀（co.uk / com.cn 等）保留三级
  const TL2 = /^(co|com|net|org|gov|edu|ac)$/i;
  if (TL2.test(snd) && parts.length >= 3) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

/**
 * tracker URL / 主机名 → 站点信息
 * @returns {{key,name,full,host,known}} known=false 表示未收录，name 回落为域名
 */
function identify(input) {
  const host = hostOf(input);
  if (!host) return { key: '', name: '未知站点', full: '', host: '', known: false };
  const hit = matchRule(host);
  if (hit) return { key: hit.key, name: hit.name, full: hit.full, host, known: true };
  // 自学习表：同一批 tracker 里学到的别名域名（键为 baseDomain，与写入同口径）
  const bd = baseDomain(host);
  const lr = learned.get(bd);
  if (lr) return { key: lr.key, name: lr.name, full: lr.full || '', host, known: true, learned: true };
  return { key: 'host:' + bd, name: bd || prettyHost(host), full: '', host, known: false };
}

/** 仅取站点键（用于记账分组；未收录站也稳定，因其基于域名） */
function siteKey(input) {
  return identify(input).key;
}

module.exports = { identify, siteKey, hostOf, prettyHost, baseDomain, learnFromTorrent, matchRule, RULES };