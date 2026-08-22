'use strict';

// 用量统计 dashboard：`cc-bridge dashboard`（或 `cc-bridge stats --gui`）在本地起
// 一个临时 HTTP 服务、自动打开浏览器呈现用量面板（概览卡、趋势图、按上游 / KEY /
// 模型明细表），查完 Ctrl-C 退出。数据接口复用 core/stats.js 的 aggregate()（读
// stats-<upstream>.json 快照，daemon 不在跑也能查）。
//
// 安全设计：只绑 127.0.0.1（不暴露局域网）；端口优先取 PROXY_PORT+1，被占用则自动
// 顺延找空闲端口；带一次性随机 token（URL 查询参数校验），防止本机其它页面跨站
// 探测本服务；页面加载完成后服务仍保留（供窗口切换时重新拉数据），Ctrl-C 退出。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { aggregate } = require('./stats');

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

// 起 GUI 服务并打开浏览器。opts: { basePort }。返回 Promise<void>（Ctrl-C / 进程
// 退出时 resolve）。服务只活在本进程生命周期内——CLI 命令退出即全部清理。
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
  console.log(`[bridge] usage dashboard listening on ${rootUrl}`);
  openBrowser(rootUrl);
  console.log('[bridge] (browser not opened? copy the URL above manually)');
  console.log('[bridge] press Ctrl-C to exit');

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`\n[bridge] ${sig} received, closing usage dashboard`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 300); // close 卡住（长连接等）也最多等 300ms
    });
  }
}

module.exports = { startGui };
