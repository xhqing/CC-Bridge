'use strict';

// 用量统计展示：读各上游 server 落盘的 stats-<upstream>.json，聚合输出两张表：
//   · 按 KEY（key-name 维度，用量归因：哪个账号用了多少；KEY 本体不落盘、不展示）
//   · 按模型（target 模型维度：输入 / 输出 / 缓存命中 / 命中率）
// 默认聚合所有上游（ds / glm 最近都用了就一起呈现出来）；`cc-bridge <upstream> stats`
// 只看单上游明细。只读不改：server 侧（core/server.js）负责累计与写盘，本模块不依赖
// daemon 是否在运行——daemon 停掉后仍能展示最近一次落盘的快照。

const fs = require('fs');
const path = require('path');
const { configDir, statsPathFor } = require('./config');
const { listUpstreams, isImplemented } = require('./adapter');

// 读取单上游 stats 快照。文件不存在 / 解析失败返回 null（首次使用或尚未落盘）。
function loadStats(upstream, configPath) {
  const file = statsPathFor(upstream, configPath);
  try {
    const stats = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return { file, stats };
  } catch {
    return { file, stats: null };
  }
}

// 扫描配置目录，列出「有 stats 快照文件」的上游（不管 daemon 是否在跑、注册表状态）。
// 返回 [{upstream, file}]。旧版本快照（无 keys 维度）也纳入——展示时按 models 表展示。
function discoverUpstreamsWithStats() {
  const dir = configDir();
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries
    .filter((n) => /^stats-(.+)\.json$/.test(n))
    .map((n) => {
      const upstream = n.slice('stats-'.length, -'.json'.length);
      return { upstream, file: path.join(dir, n) };
    })
    .sort((a, b) => a.upstream.localeCompare(b.upstream));
}

// ISO 时间戳 → 本地时间字符串（YYYY-MM-DD HH:MM:SS），解析失败返回 '-'。
function fmtTime(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const fmt = (n) => (n || 0).toLocaleString('en-US');

// 命中率 = 缓存命中 token / 总输入（总输入已含命中，口径与 server 累计一致）。
function hitPct(inputTokens, cacheHitTokens) {
  return inputTokens > 0 ? (cacheHitTokens / inputTokens * 100).toFixed(1) + '%' : '-';
}

const ZERO = { requests: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheCreatedTokens: 0 };

// 把一个 bucket 累加进 target（同名字段相加；缺失字段按 0）。返回 target（链式用）。
function addBucket(target, s) {
  target.requests += (s && s.requests) || 0;
  target.inputTokens += (s && s.inputTokens) || 0;
  target.outputTokens += (s && s.outputTokens) || 0;
  target.cacheHitTokens += (s && s.cacheHitTokens) || 0;
  target.cacheCreatedTokens += (s && s.cacheCreatedTokens) || 0;
  return target;
}

// 通用表格渲染：rows = [{label, s}]，按 label 对齐输出数值列 + 合计行。
function renderTable(title, rows) {
  const total = rows.reduce((t, { s }) => addBucket(t, s), { ...ZERO });
  const w = Math.max(title.length, ...rows.map((r) => r.label.length));
  const pad = (s) => String(s).padEnd(w);
  const num = (s, w2) => String(s).padStart(w2);
  const W = { req: 7, tok: 14, pct: 7 };
  console.log(`  ${pad(title)}  ${num('reqs', W.req)}  ${num('input', W.tok)}  ${num('cache-hit', W.tok)}  ${num('hit%', W.pct)}  ${num('output', W.tok)}`);
  for (const { label, s } of rows) {
    console.log(`  ${pad(label)}  ${num(fmt(s.requests), W.req)}  ${num(fmt(s.inputTokens), W.tok)}  ${num(fmt(s.cacheHitTokens), W.tok)}  ${num(hitPct(s.inputTokens, s.cacheHitTokens), W.pct)}  ${num(fmt(s.outputTokens), W.tok)}`);
  }
  console.log(`  ${pad('total')}  ${num(fmt(total.requests), W.req)}  ${num(fmt(total.inputTokens), W.tok)}  ${num(fmt(total.cacheHitTokens), W.tok)}  ${num(hitPct(total.inputTokens, total.cacheHitTokens), W.pct)}  ${num(fmt(total.outputTokens), W.tok)}`);
}

// `cc-bridge stats`（聚合所有上游）与 `cc-bridge <upstream> stats`（单上游）共用入口。
// 单上游模式：cfg 由 CLI 按该上游加载传入；聚合模式：cfg 为 null。
function showStats(cfg) {
  if (cfg) return showSingleUpstream(cfg);
  return showAllUpstreams();
}

// 聚合模式：所有有快照的上游合并——按 key-name 维度一张表（跨上游同名 key-name 视为
// 同一个账号合并；不同上游的 #n 兜底名可能撞名，撞名时加 <upstream>#n 前缀消歧），
// 按「上游/模型」维度一张表（模型名跨上游基本不重名，重名则直接合并——同名模型本来
// 就是同一个东西的用量）。
function showAllUpstreams() {
  const found = discoverUpstreamsWithStats();
  const loaded = found
    .map(({ upstream, file }) => {
      let stats = null;
      try { stats = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { /* 损坏跳过 */ }
      return stats ? { upstream, file, stats } : null;
    })
    .filter(Boolean);
  if (!loaded.length) {
    console.log(`[bridge] no stats found (no stats-<upstream>.json under ${configDir()})`);
    console.log('[bridge] start a daemon and make a few requests, then re-run.');
    return;
  }

  // key-name 表：同 key-name 合并；兜底名（#n）在多个上游间撞名时用 <upstream>#n。
  const keysAgg = {};
  const hasKeyName = new Set(); // 有用户命名 key-name 的名字集合（兜底名不得与其撞）
  for (const { stats } of loaded) {
    for (const name of Object.keys(stats.keys || {})) hasKeyName.add(name);
  }
  const fallbackSeen = new Map(); // "#n" -> 首个使用它的 upstream
  for (const { upstream, stats } of loaded) {
    for (const [name, s] of Object.entries(stats.keys || {})) {
      let label = name;
      if (/^#\d+$/.test(name)) {
        // 兜底名：多上游撞名（或与用户命名撞名）时加 <upstream> 前缀消歧。
        if (fallbackSeen.has(name) && fallbackSeen.get(name) !== upstream) {
          label = `${upstream}${name}`;
        } else if (hasKeyName.has(name)) {
          label = `${upstream}${name}`;
        } else {
          fallbackSeen.set(name, upstream);
        }
      }
      keysAgg[label] ||= { ...ZERO };
      addBucket(keysAgg[label], s);
    }
  }

  // 模型表：按「上游/模型」聚合（不同上游的模型名即使相同也分行——标签带上上游，
  // 一眼看出 glm 的 glm-5.3 与 ds 的 deepseek-v4-flash 各用了多少）。
  const modelAgg = {};
  for (const { upstream, stats } of loaded) {
    for (const [model, s] of Object.entries(stats.models || {})) {
      const label = `${upstream}/${model}`;
      modelAgg[label] ||= { ...ZERO };
      addBucket(modelAgg[label], s);
    }
  }

  const windowFrom = loaded.map((l) => l.stats.startedAt).filter(Boolean).sort()[0];
  const windowTo = loaded.map((l) => l.stats.updatedAt).filter(Boolean).sort().pop();

  console.log(`[bridge] all upstreams — token stats (${loaded.map((l) => l.upstream).join(' + ')})`);
  console.log(`[bridge] window    : ${fmtTime(windowFrom)} → ${fmtTime(windowTo)} (per-daemon-process windows merged)`);
  console.log('');

  const keyRows = Object.entries(keysAgg)
    .filter(([, s]) => s.requests > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (keyRows.length) {
    console.log('[bridge] by key (API_KEY_n_NAME; unconfigured keys fall back to #n):');
    renderTable('key-name', keyRows.map(([label, s]) => ({ label, s })));
    console.log('');
  } else if (loaded.some((l) => Object.keys(l.stats.models || {}).length)) {
    console.log('[bridge] by key: (no per-key data — snapshot written by an older version; restart the daemon to start recording)');
    console.log('');
  }

  const modelRows = Object.entries(modelAgg)
    .filter(([, s]) => s.requests > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (modelRows.length) {
    console.log('[bridge] by model (upstream/model):');
    renderTable('model', modelRows.map(([label, s]) => ({ label, s })));
    console.log('');
  }

  console.log('[bridge] input = 输入 token 合计（已含缓存命中）；hit% = cache-hit / input；');
  console.log('[bridge] 命中率只计 server 侧能解析 usage 的请求（上游未返回 usage 的请求仅计入 reqs）。');
  console.log(`[bridge] 注意：各上游快照为各自 daemon 进程窗口（重启即重置），合并仅作总览。`);
}

// 单上游模式：`cc-bridge <upstream> stats`——按模型 + 按 KEY 两张明细表。
function showSingleUpstream(cfg) {
  const { file, stats } = loadStats(cfg.upstream, cfg.configPath);
  if (!stats) {
    console.log(`[bridge] no stats for upstream '${cfg.upstream}' yet (no file at ${file})`);
    console.log('[bridge] start the daemon and make a few requests, then re-run.');
    return;
  }

  const models = Object.entries(stats.models || {})
    .filter(([, s]) => s && s.requests > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  const keys = Object.entries(stats.keys || {})
    .filter(([, s]) => s && s.requests > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (!models.length && !keys.length) {
    console.log(`[bridge] no requests recorded for upstream '${cfg.upstream}' (file at ${file})`);
    return;
  }

  console.log(`[bridge] ${cfg.upstream} — token stats`);
  console.log(`[bridge] window    : ${fmtTime(stats.startedAt)} → ${fmtTime(stats.updatedAt)}`);
  console.log(`[bridge] file      : ${file}`);
  console.log('');

  if (keys.length) {
    console.log('[bridge] by key (API_KEY_n_NAME; unconfigured keys fall back to #n):');
    renderTable('key-name', keys.map(([label, s]) => ({ label, s })));
    console.log('');
  }

  if (models.length) {
    console.log('[bridge] by model:');
    renderTable('model', models.map(([model, s]) => ({ label: model, s })));
    console.log('');
  }

  console.log('[bridge] input = 输入 token 合计（已含缓存命中）；hit% = cache-hit / input；');
  console.log('[bridge] 命中率只计 server 侧能解析 usage 的请求（上游未返回 usage 的请求仅计入 reqs）。');
}

module.exports = { loadStats, discoverUpstreamsWithStats, showStats };
