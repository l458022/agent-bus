#!/usr/bin/env node
/**
 * bridge/overlay-to-film.mjs —— 把 Overlay Studio 的 OverlayDoc JSON 变成 OpenFilm 能抓帧的项目。
 *
 * 这一层就是两个项目之间唯一缺的那段：
 *   overlay-studio 吐 `{version, theme, cards:[{id,kind,start,end,params}]}`
 *   openfilm 只认「给一个 t 就画出那一帧」的网页（window.film）
 *   中间没有东西把前者翻译成后者 —— 这个脚本就是它。
 *
 * 用法：
 *   node bridge/overlay-to-film.mjs <overlay.json>            # 生成项目，不渲染
 *   node bridge/overlay-to-film.mjs <overlay.json> --render    # 生成并直接出 MP4
 *   node bridge/overlay-to-film.mjs <overlay.json> -o DIR --name launch --duration 12.5 --fps 60
 *
 * 生成的目录就是一个合法的 OpenFilm 项目：
 *   <out>/film.html     剪辑：一条轨，一个 page clip
 *   <out>/overlay.html  page：window.film = { frame(t) }，内部驱动 Overlay Studio 的导出视图
 *   <out>/assets/...    Overlay Studio 的构建产物（从 motion-playground/dist 复制）
 *
 * 关键设计（踩过才知道的）：
 *   1. openfilm 的 host 以 film.html 所在目录为 HTTP 根，不能引用上级目录 ——
 *      所以必须把 dist 的产物复制进来，靠 `/assets/...` 绝对路径正好对上。
 *   2. openfilm 的 host 在每帧后调 `filmHost.settle(t)`，它把 CSSTransition 直接
 *      `finish()` —— 所有进场过渡会瞬间跳到终态。必须覆盖成按 t 对齐的版本。
 *   3. Overlay Studio 自己的导出视图是 `?export=1` + `window.__setExportT(sec)`，
 *      它的时间是渲染期读 `__fxExportMs` 得到的纯函数值，正好满足 openfilm
 *      「一帧是 t 的函数」那条硬规则。我们只做接线，不改它的渲染。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * 工作区根。这个脚本是**示例**，不是 agent-bus 的一部分 —— 它跟某几个具体项目
 * 的目录形状绑死了（Overlay Studio 的 dist、openfilm 的 CLI、契约校验器）。
 * 所以工作区用环境变量覆盖，而不是猜：
 *   AGENT_BUS_WORKSPACE=<你的工作区> node overlay-to-film.mjs <overlay.json>
 * 不给就从本文件位置往上两级（agent-bus/examples → 上层目录）。
 */
const WS = process.env.AGENT_BUS_WORKSPACE
  ? resolve(process.env.AGENT_BUS_WORKSPACE)
  : resolve(HERE, '..', '..');
const STUDIO_DIR = join(WS, 'incoming', 'overlay-studio', 'motion-playground');
const STUDIO_DIST = join(STUDIO_DIR, 'dist');
const VALIDATOR = join(WS, 'contracts', 'validate-overlay.mjs');
const OPENFILM_BIN = join(WS, 'incoming', 'openfilm', 'packages', 'openfilm', 'bin', 'openfilm.mjs');
/** openfilm 自己也要 ffprobe，PATH 里有的前提下直接用名字 */
const FFPROBE = 'ffprobe';

/** OverlayDoc 的退场淡出时长，与 motion-playground/src/overlay/types.ts 的 OUTRO_SEC 保持一致 */
const OUTRO_SEC = 0.3;
/** 画布尺寸，与 motion-playground/src/stage.ts 的 STAGE 保持一致 */
const STAGE = { w: 1920, h: 1080 };

/* ────────────────────────── 小工具 ────────────────────────── */

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** 媒体文件的时长（秒）；探不出来就 null，不硬猜 */
function probeDuration(file) {
  try {
    const out = execFileSync(
      FFPROBE,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { encoding: 'utf8', windowsHide: true }
    ).trim();
    const d = Number(out);
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/** 落盘文件名：去掉目录、把不认识的字换成 - */
const safeFile = (p) => p.replace(/^.*[\\/]/, '').replace(/[^\w\u4e00-\u9fff.-]/g, '-');

function say(msg) {
  process.stdout.write(msg + '\n');
}
function die(msg) {
  process.stderr.write('✗ ' + msg + '\n');
  process.exit(1);
}

/** 极简参数解析：`--key value` / `--flag` / 位置参数 */
function parseArgs(argv) {
  const out = { _: [], flags: new Set() };
  const takesValue = new Set(['-o', '--out', '--name', '--duration', '--fps', '--workers', '--video']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (takesValue.has(a)) {
      const v = argv[++i];
      if (v === undefined) die(`参数 ${a} 缺少取值`);
      out[a.startsWith('--') ? a.slice(2) : a === '-o' ? 'out' : a] = v;
    } else if (a.startsWith('--')) {
      out.flags.add(a.slice(2));
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** 递归复制目录，跳过指定文件名（用相对路径比对） */
function copyTree(src, dst, skip = new Set()) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    if (skip.has(name)) continue;
    if (statSync(s).isDirectory()) copyTree(s, d, new Set());
    else copyFileSync(s, d);
  }
}

/* ────────────────────────── 1. 契约校验 ────────────────────────── */

/**
 * 调 contracts/validate-overlay.mjs 查契约层。这是跨项目接缝的唯一裁判，
 * 不在这里重写一套规则 —— 规则只能有一份，否则两边迟早对不上。
 */
function validate(file) {
  const r = spawnSync(process.execPath, [VALIDATOR, file, '--json'], {
    encoding: 'utf8',
    cwd: WS,
  });
  if (r.status === 2) die(`契约校验器跑不起来：\n${r.stderr || r.stdout}`);
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    die(`契约校验器输出不是 JSON：\n${r.stdout}\n${r.stderr}`);
  }
  if (report.errors && report.errors.length) {
    die(
      `契约校验没过（${report.errors.length} 个 error），先修完再转换：\n` +
        report.errors.map((e) => '  ✗ ' + e).join('\n')
    );
  }
  if (report.warns && report.warns.length) {
    say(`  ! 契约校验有 ${report.warns.length} 条 warn（不挡路，附在交付说明里过目）`);
    for (const w of report.warns) say('    ' + w);
  }
  return report;
}

/* ────────────────────────── 2. 构建产物体检 ────────────────────────── */

/** 从 dist/index.html 里抠出真正的 assets 文件名，不靠猜哈希 */
function readDistEntry() {
  if (!existsSync(STUDIO_DIST)) {
    die(
      `没找到 ${STUDIO_DIST}\n` +
        `  先构建 Overlay Studio：\n` +
        `    cd incoming/overlay-studio/motion-playground && npm run build`
    );
  }
  const html = readFileSync(join(STUDIO_DIST, 'index.html'), 'utf8');
  const js = /<script[^>]+src="([^"]+\.js)"/.exec(html);
  const css = /<link[^>]+href="([^"]+\.css)"/.exec(html);
  if (!js) die('dist/index.html 里找不到入口 JS —— 构建产物不完整，重新 npm run build');
  const pick = (m) => m[1].replace(/^\//, ''); // "/assets/x.js" → "assets/x.js"
  return { js: pick(js), css: css ? pick(css) : null };
}

/* ────────────────────────── 3. 时间轴 ────────────────────────── */

function computeDuration(doc, override) {
  if (override != null) {
    const d = Number(override);
    if (!Number.isFinite(d) || d <= 0) die(`--duration 要一个正数秒，收到 "${override}"`);
    return d;
  }
  const last = doc.cards.reduce((m, c) => Math.max(m, Number(c.end) || 0), 0);
  if (!(last > 0)) die('这份编排没有任何卡片有正的 end，算不出片长；用 --duration 指定');
  return Number((last + OUTRO_SEC).toFixed(3));
}

/* ────────────────────────── 4. 生成 overlay.html ────────────────────────── */

/**
 * page 的 HTML。三段：
 *   1. `window.__EXPORT_DOC` —— 先把整份编排塞进全局，ExportView 启动时读它
 *   2. dist 的 css / js —— 原样加载 Overlay Studio 的构建产物
 *   3. `window.film` —— 适配层：把 openfilm 的 frame(t) 接到 `__setExportT(t)`
 */
function renderOverlayHtml({ docJson, cssHref, jsSrc, duration, name }) {
  const safeDoc = docJson.replace(/</g, '\\u003c'); // 防止编排文本里出现 </script>
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${STAGE.w}, height=${STAGE.h}">
<title>${name} — overlay</title>
${cssHref ? `<link rel="stylesheet" crossorigin href="/${cssHref}">
<style>
/* 透明是这一层的契约，不是下游 CSS 的副产品。
   Overlay Studio 自己用 .stage.is-export { background: transparent !important } 清底，
   但那条规则和 .stage.is-hud { background: var(--hud-canvas) !important } 特异性相同、
   谁后加载谁赢 —— 换个打包顺序就翻车。这里在样式表之后内联覆盖一次，把结果钉死。 */
/* color-scheme 是关键：Overlay Studio 的 index.css 在 :root 上写了 color-scheme: dark，
   而 Chromium 在 color-scheme: dark 时会把「根元素背景为 transparent」的 canvas 画成深色底
   —— 于是 background: transparent 全部失效，整层变成不透明的深灰，把下面的口播糊死。
   归一成 normal 才能真的透出下面的轨道。 */
html { background: transparent !important; color-scheme: normal !important; }
body, #root { background: transparent !important; margin: 0 !important; }
.stage, .stage.is-hud, .stage.is-export { background: transparent !important; border: none !important; }
.stage::before, .stage.is-hud::before, .stage.is-export::before { display: none !important; }
</style>` : ''}
<script>
/* ExportView 只在 export=1 时才挂载。film.html 的 clip 已经带上这个查询参数，
   这里再兜一次：本页被别的宿主直接打开、参数丢了，也仍然进导出视图。 */
if (!/[?&]export=1(&|$)/.test(location.search)) {
  try { history.replaceState(null, '', location.pathname + '?export=1' + location.hash); } catch (e) {}
}
window.__EXPORT_DOC = ${safeDoc};
</script>
</head>
<body>
<div id="root"></div>
<script type="module" crossorigin src="/${jsSrc}"></script>
<script>
/* ── OpenFilm ⇄ Overlay Studio 适配层 ─────────────────────────────────────
 * openfilm 要的是 window.film = { frame(t), duration, width, height, ready }；
 * Overlay Studio 给的是 ?export=1 视图 + window.__setExportT(秒)。
 * 中间只差「一次渲染要等多久」和「CSS 过渡跟着谁走」，就在这里补。
 */
(function () {
  'use strict';

  var DURATION = ${duration};
  var STAGE_W = ${STAGE.w};
  var STAGE_H = ${STAGE.h};
  var READY_DEADLINE_MS = 20000;

  function raf() { return new Promise(function (r) { requestAnimationFrame(function () { r(); }); }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* openfilm 的 host 每帧调 filmHost.settle(t)，它看到 CSSTransition 直接 finish()，
     于是所有进场过渡瞬间跳到终态——进场动画全没了。这里换成按 t 对齐的版本：
     每个动画第一次出现时记下当下的 t（= 它出生的影片时刻），之后每一次都把
     currentTime 设成 (t - 出生时刻)*1000。这样 CSS 过渡也变成了 t 的函数，
     和 useExportMs 那条 JS 时间线走同一个钟。 */
  var birth = new WeakMap();
  function settleAt(t) {
    var list;
    try { list = document.getAnimations ? document.getAnimations() : []; } catch (e) { list = []; }
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var b = birth.get(a);
      if (b === undefined) { birth.set(a, t); b = t; }
      try {
        a.pause();
        a.currentTime = Math.max(0, (t - b) * 1000);
      } catch (e) { /* 有些动画不接受写入，跳过就好 */ }
    }
  }
  if (window.filmHost) window.filmHost.settle = function () { /* 由 settleAt 接管 */ };

  /* 卡里的图片是普通 <img>，换 t 之后要等它们落地才截图 */
  function imagesSettled() {
    var imgs = Array.prototype.slice.call(document.images || []);
    var pending = imgs.filter(function (im) {
      return im.getAttribute('src') && !im.complete;
    });
    if (!pending.length) return Promise.resolve();
    return new Promise(function (done) {
      var left = pending.length;
      var one = function () { if (--left <= 0) done(); };
      pending.forEach(function (im) {
        im.addEventListener('load', one, { once: true });
        im.addEventListener('error', one, { once: true });
      });
      setTimeout(done, 2000); // 图挂了也不许把整帧卡死
    });
  }

  /* 等 React 挂上 ExportView：__setExportT 是它在 useEffect 里装的，有它就说明已挂载 */
  function readyForExport() {
    return new Promise(function (ok, fail) {
      var t0 = Date.now();
      (function poll() {
        if (typeof window.__setExportT === 'function' && document.getElementById('root')) return ok();
        if (Date.now() - t0 > READY_DEADLINE_MS) {
          return fail(new Error('Overlay Studio 的导出视图没有在 ' + READY_DEADLINE_MS + 'ms 内就绪'));
        }
        setTimeout(poll, 16);
      })();
    }).then(function () {
      // 字体：等不到就别等，离线时 Google Fonts 会一直挂着
      var fonts = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
      return Promise.race([fonts, sleep(3000)]);
    }).then(function () {
      // 空跑一帧：让 stage 真正绘制一次，之后每帧都是重绘
      window.__setExportT(0);
      return raf().then(raf).then(function () { settleAt(0); });
    });
  }

  var readyP = readyForExport();

  window.film = {
    duration: DURATION,
    width: STAGE_W,
    height: STAGE_H,
    ready: readyP,
    frame: function (t) {
      return readyP
        .then(function () {
          window.__setExportT(t);
          return raf();
        })
        .then(raf)  // useEnter 的双 rAF：第一层
        .then(raf)  // 第二层 —— entered 从 false 翻到 true，过渡在这一帧创建
        .then(function () { return imagesSettled(); })
        .then(function () { settleAt(t); });
    }
  };
})();
</script>
</body>
</html>
`;
}

/* ────────────────────────── 5. 生成 film.html ────────────────────────── */

/**
 * 剪辑文件。
 *
 * 轨的顺序是「第一条在最上」，所以动效那条必须写在前面：它要盖在口播画面上。
 * 给 `--video` 时是两条轨（动效 + 口播），不给就只出透明动效层。
 *
 * page 自带 duration，不需要 `#t=0,length`；page 的 width/height 等于 stage，
 * 所以不给 style —— 按自己尺寸居中，正好铺满。
 * video 不给 style 时也是「铺满 stage」，正合适。
 */
function renderFilmHtml({ name, videoFile }) {
  const overlayTrack = `<section>
<iframe id="overlay" src="overlay.html" at="0"></iframe>
</section>`;
  const videoTrack = videoFile
    ? `
<section>
<video id="talking" src="assets/${videoFile}" at="0"></video>
</section>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${STAGE.w}, height=${STAGE.h}">
</head>
<body>
${overlayTrack}${videoTrack}
</body>
</html>
`;
}

/* ────────────────────────── 6. 主流程 ────────────────────────── */

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args._[0];
  if (!input) {
    die(
      '用法: node bridge/overlay-to-film.mjs <overlay.json> [-o DIR] [--name NAME]\n' +
        '       [--video 口播.mp4] [--duration 秒] [--fps N] [--workers N] [--render]'
    );
  }
  const inputPath = resolve(process.cwd(), input);
  if (!existsSync(inputPath)) die(`读不到 ${inputPath}`);

  say(`\n▸ 输入  ${inputPath}`);

  /* 1. 契约层 —— 不合格就不往下走 */
  const report = validate(inputPath);
  const stat = report.report && report.report[0];
  if (stat) say(`  卡片 ${stat.cards} 张 · kind ${stat.kinds} 种 · seg ${stat.segs} 组 · 末卡 ${stat.duration}s`);

  let doc;
  try {
    doc = JSON.parse(stripBom(readFileSync(inputPath, 'utf8')));
  } catch (e) {
    die(`${inputPath} 不是合法 JSON —— ${e.message}`);
  }

  /* 2. 片长 */
  const duration = computeDuration(doc, args.duration);
  say(`▸ 片长  ${duration}s${args.duration ? '（--duration 指定）' : `（末卡 end + ${OUTRO_SEC}s 退场）`}`);

  /* 2b. 口播素材（可选）—— 给了就多一条轨，动效盖在它上面直接出成片 */
  let videoFile = null;
  let videoPath = null;
  if (args.video) {
    videoPath = resolve(process.cwd(), args.video);
    if (!existsSync(videoPath)) die(`读不到视频 ${videoPath}`);
    videoFile = safeFile(videoPath);
    const vd = probeDuration(videoPath);
    say(`▸ 口播  ${videoFile} · ${vd ? vd.toFixed(2) + 's' : '长度未知（ffprobe 没读到）'}`);
    if (vd && duration > vd + 0.05) {
      say(`  ! 动效比口播长 ${(duration - vd).toFixed(2)}s —— 最后那段画面会停在口播末帧`);
    } else if (vd && vd > duration + 0.05) {
      say(`  ! 口播比动效长 ${(vd - duration).toFixed(2)}s —— 片长按动效收尾，口播尾部 ${duration}s 之后不出现`);
    }
  }

  /* 3. 构建产物 */
  const { js, css } = readDistEntry();
  say(`▸ 构建  ${js}${css ? ' + ' + css : ''}`);

  /* 4. 输出目录 */
  const name = (args.name || input.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'overlay')
    .replace(/[^\w\u4e00-\u9fff.-]/g, '-');
  const outDir = resolve(process.cwd(), args.out || join('bridge', 'out', name));
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  say(`▸ 输出  ${outDir}`);

  /* 5. 复制 dist —— 除 index.html 之外全要：assets、favicon、sfx、demo 里可能有卡片引用的资源 */
  copyTree(STUDIO_DIST, outDir, new Set(['index.html']));

  /* 5b. 口播素材进 assets/ —— openfilm 的根就是 outDir，只能用相对路径 */
  if (videoPath) {
    mkdirSync(join(outDir, 'assets'), { recursive: true });
    copyFileSync(videoPath, join(outDir, 'assets', videoFile));
  }

  /* 6. 两个页面 */
  writeFileSync(
    join(outDir, 'overlay.html'),
    renderOverlayHtml({
      docJson: JSON.stringify(doc),
      cssHref: css,
      jsSrc: js,
      duration,
      name,
    }),
    'utf8'
  );
  writeFileSync(join(outDir, 'film.html'), renderFilmHtml({ name, videoFile }), 'utf8');

  say(`▸ 就绪  ${join(outDir, 'film.html')}`);
  say(
    `        ${videoFile ? '两条轨（动效在上 · 口播在下）' : '一条轨（透明动效层）'} · ${STAGE.w}×${STAGE.h} · ${duration}s\n`
  );

  /* 7. 可选：直接渲染 */
  if (!args.flags.has('render')) {
    say('  预览/出片：');
    say(`    node "${OPENFILM_BIN}" look ${outDir} 1.5`);
    say(`    node "${OPENFILM_BIN}" render ${outDir} --fps ${args.fps || 30}`);
    say('  或直接加 --render 一步到位。\n');
    return { outDir, duration, filmHtml: join(outDir, 'film.html') };
  }

  const fps = String(args.fps || 30);
  say(`▸ 渲染  ${fps}fps ${videoFile ? '（成片 mp4）' : '（透明动效层 webm）'} …`);
  const t0 = Date.now();
  const cmd = [OPENFILM_BIN, 'render', outDir, '--fps', fps];
  /* 单轨就是纯动效层：黑底没意义，要透明 */
  if (!videoFile) cmd.push('--alpha');
  if (args.workers) cmd.push('--workers', String(args.workers));
  const r = spawnSync(process.execPath, cmd, {
    stdio: 'inherit',
    cwd: WS,
    env: process.env,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) die(`openfilm render 退出码 ${r.status}（耗时 ${secs}s）`);
  say(`✓ 渲染完成，耗时 ${secs}s`);
  return { outDir, duration, filmHtml: join(outDir, 'film.html') };
}

main();
