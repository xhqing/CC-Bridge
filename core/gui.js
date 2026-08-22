'use strict';

// 用量统计 dashboard：`cc-bridge dashboard`（或 `cc-bridge stats --gui`）默认以后台
// 模式起一个本地 HTTP 服务（detached 子进程，CLI 立即返回），启动完成后自动打开
// 浏览器呈现用量面板（概览卡、趋势图、按上游 / KEY / 模型明细表）；`--fg` 保留前台
// 模式（Ctrl-C 退出），`dashboard stop` 停掉后台面板。数据接口复用 core/stats.js 的
// aggregate()（读 stats-<upstream>.json 快照，daemon 不在跑也能查）。
//
// 安全设计：只绑 127.0.0.1（不暴露局域网）；端口优先取 PROXY_PORT+1，被占用则自动
// 顺延找空闲端口；带一次性随机 token（URL 查询参数校验），防止本机其它页面跨站
// 探测本服务；页面加载完成后服务仍保留（供窗口切换时重新拉数据）。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { aggregate } = require('./stats');
const { sleep } = require('./util');
const { dashboardPidPath, dashboardUrlPath, dashboardLogPath, ensureDir } = require('./config');

const GUI_HTML = path.join(__dirname, 'gui.html');

// 顺延找空闲端口：从 start 起（含）依次试，最多试 20 个。全忙返回 null。
function findFreePort(start) {
  const net = require('net');
  return new Promise((resolve) => {
    const tryPort = (p, left) => {
      if (left <= 0) return resolve(null);
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1, left - 1));
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start, 20);
  });
}

// 打开系统默认浏览器（macOS open / Windows start / Linux xdg-open）。失败静默——
// URL 已打印在终端，用户可手动点。
function openBrowser(url) {
  const plat = process.platform;
  const cmd = plat === 'darwin' ? ['open', [url]]
    : plat === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(...cmd, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch { /* 打不开就打印 URL，用户手动开 */ }
}

// JSON 响应便捷函数。
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// 数据接口注册表：路径 → handler(u, res)。后续 dashboard 新模块的数据接口在这里
// 加一行注册即可（token 校验 / 404 兜底由下方服务框架统一处理，新接口不用重复写）。
const API_ROUTES = {
  // 用量统计模块：?from=ISO&to=ISO 起止时间（闭区间，可只带一侧）。空 → 不设限（全量）。
  '/api/stats': (u, res) => {
    const from = u.searchParams.get('from') || '';
    const to = u.searchParams.get('to') || '';
    sendJSON(res, 200, aggregate(from, to));
  },
};

// 起 GUI 服务并打开浏览器。两种调用形态：
//   · CLI 前台模式（`dashboard --fg`）：opts = { basePort, open: true, quit: true }——
//     监听成功后自动开浏览器、打印 Ctrl-C 提示、挂信号处理，Ctrl-C / 进程退出清理。
//   · 后台子进程模式（父进程经 CC_BRIDGE_GUI_FG=1 spawn 本模块）：监听成功后把
//     rootUrl 写入 dashboard.url（父进程轮询该文件作为「就绪」信号），不开浏览器
//     （父进程等 url 落盘后再开，避免竞态）、不打印交互提示。
// opts.open=false 时不自动开浏览器（后台子进程模式用）。
async function startGui(opts = {}) {
  const basePort = opts.basePort || 8788;
  const port = await findFreePort(basePort);
  if (!port) {
    throw new Error(`no free port found from ${basePort} to ${basePort + 19} for the dashboard`);
  }
  const token = crypto.randomBytes(16).toString('hex');
  const rootUrl = `http://127.0.0.1:${port}/?token=${token}`;

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    // 一致性校验：页面与数据接口都要求带一次性 token，防本机其它页面跨站探测。
    if (u.searchParams.get('token') !== token) {
      sendJSON(res, 403, { error: 'forbidden' });
      return;
    }
    if (req.method === 'GET' && u.pathname === '/') {
      try {
        const html = fs.readFileSync(GUI_HTML, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`gui.html missing: ${e.message}`);
      }
      return;
    }
    const handler = API_ROUTES[u.pathname];
    if (req.method === 'GET' && handler) {
      try {
        handler(u, res);
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
      return;
    }
    sendJSON(res, 404, { error: 'not found' });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  // 后台子进程模式：url 落盘 = 就绪信号（父进程轮询到即开浏览器）。
  if (opts.writeUrl) {
    try { fs.writeFileSync(DASH_URL, rootUrl + '\n'); } catch { /* 父进程会超时报错 */ }
  }

  console.log(`[bridge] usage dashboard listening on ${rootUrl}`);
  if (opts.open !== false) openBrowser(rootUrl);
  if (opts.open !== false) console.log('[bridge] (browser not opened? copy the URL above manually)');
  if (opts.quit) {
    console.log('[bridge] press Ctrl-C to exit');
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => {
        console.log(`\n[bridge] ${sig} received, closing usage dashboard`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 300); // close 卡住（长连接等）也最多等 300ms
      });
    }
  }
  return { port, token, rootUrl, server };
}

// --- 后台模式 ------------------------------------------------------------------------
// 借鉴 daemon.js：spawn detached 子进程跑前台模式（--fg 由子进程内部识别），日志写
// ~/.cc-bridge/dashboard.log，pid / url 存 dashboard.pid / dashboard.url。父进程等
// url 文件出现（子进程就绪信号）后自动开浏览器、打印提示、退出（子进程继续活着）。
// 已有后台实例在跑时不再重复起：直接复用既有 url 重新打开浏览器。

const DASH_PID = dashboardPidPath();
const DASH_URL = dashboardUrlPath();
const DASH_LOG = dashboardLogPath();

// 读后台实例状态：pid 存活 + url 文件在 → { running: true, pid, url }。
function dashboardStatus() {
  let pid = null;
  try { pid = Number(fs.readFileSync(DASH_PID, 'utf-8').trim()); } catch { /* none */ }
  if (pid) {
    try { process.kill(pid, 0); } catch { pid = null; } // pid 文件在但进程已死 → 视为无实例
  }
  if (!pid) return { running: false, pid: null, url: null };
  let url = null;
  try { url = fs.readFileSync(DASH_URL, 'utf-8').trim() || null; } catch { /* none */ }
  return { running: true, pid, url };
}

function stopDashboard() {
  const st = dashboardStatus();
  if (!st.running) {
    console.log('[bridge] dashboard not running.');
    try { fs.unlinkSync(DASH_PID); } catch { /* gone */ }
    try { fs.unlinkSync(DASH_URL); } catch { /* gone */ }
    return;
  }
  try {
    process.kill(st.pid, 'SIGTERM');
    console.log(`[bridge] dashboard stopped (pid ${st.pid})`);
  } catch (e) {
    console.log(`[bridge] pid ${st.pid} not running (${e.message})`);
  }
  try { fs.unlinkSync(DASH_PID); } catch { /* gone */ }
  try { fs.unlinkSync(DASH_URL); } catch { /* gone */ }
}

// 后台启动：已有存活实例 → 复用（重新开浏览器）；否则 spawn detached 子进程。子进程
// 就绪后写 dashboard.url，父进程轮询该文件出现（最多 10s）即开浏览器、返回。
async function startDashboardBackground(opts = {}) {
  ensureDir();
  const st = dashboardStatus();
  if (st.running) {
    console.log(`[bridge] dashboard already running (pid ${st.pid}) — reopening`);
    if (st.url) {
      openBrowser(st.url);
      console.log(`[bridge] ${st.url}`);
    } else {
      console.log('[bridge] url file missing — run `cc-bridge dashboard stop` then start again');
    }
    return;
  }
  // 清理残留的 pid / url 文件（上一次异常退出留下的孤儿文件）。
  try { fs.unlinkSync(DASH_PID); } catch { /* gone */ }
  try { fs.unlinkSync(DASH_URL); } catch { /* gone */ }

  const logFd = fs.openSync(DASH_LOG, 'a');
  const child = spawn(process.execPath, [__filename, '--fg'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, CC_BRIDGE_GUI_FG: '1' },
  });
  child.unref();
  fs.writeFileSync(DASH_PID, String(child.pid));

  // 等待子进程就绪：url 文件出现（子进程监听成功后写入）。子进程中途死掉则报错退出。
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { process.kill(child.pid, 0); } catch {
      console.error('[bridge] dashboard child exited early — recent log:');
      try {
        const tail = fs.readFileSync(DASH_LOG, 'utf-8').split('\n').slice(-10).join('\n');
        if (tail.trim()) console.error(tail);
      } catch { /* no log */ }
      try { fs.unlinkSync(DASH_PID); } catch { /* gone */ }
      process.exit(1);
    }
    let url = null;
    try { url = fs.readFileSync(DASH_URL, 'utf-8').trim(); } catch { /* not yet */ }
    if (url) {
      console.log(`[bridge] usage dashboard (background, pid ${child.pid})`);
      console.log(`[bridge] ${url}`);
      openBrowser(url);
      console.log('[bridge] (browser not opened? copy the URL above manually)');
      console.log(`[bridge] stop : cc-bridge dashboard stop   (or: kill ${child.pid})`);
      console.log('[bridge] logs : cc-bridge dashboard logs');
      return;
    }
    await sleep(200);
  }
  console.error('[bridge] dashboard did not become ready within 10s.');
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  try { fs.unlinkSync(DASH_PID); } catch { /* gone */ }
  process.exit(1);
}

module.exports = { startGui, startDashboardBackground, stopDashboard, dashboardStatus };

// 直接执行入口（`node core/gui.js`）：后台模式启动时父进程 spawn 本文件作为
// detached 子进程。此时开前台服务（不开浏览器、写 url 盘），Ctrl-C / 信号退出。
if (require.main === module) {
  const { loadConfig } = require('./config');
  const cfg = loadConfig({});
  startGui({ basePort: cfg.PORT + 1, open: false, quit: true, writeUrl: true }).catch((e) => {
    console.error(`[bridge] dashboard failed to start: ${e.message}`);
    process.exit(1);
  });
}
