'use strict';

// 用量统计：读各上游 server 落盘的 stats-<upstream>.json，聚合出「按 KEY」与「按模型」
// 两个维度的用量。数据层（v2）按小时分桶跨进程续存，因此可按任意时间窗口聚合：
//   · aggregate(fromISO, toISO)  把 [from, to] 窗口内的小时桶合并成两维表（GUI 用）
//   · showStats()                CLI 文本模式（--text / 无浏览器环境兜底）呈现全量窗口
// 只读不改：server 侧（core/server.js）负责累计与写盘，本模块不依赖 daemon 是否在
// 运行——daemon 停掉后仍能展示最近一次落盘的快照。

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
// 返回 [{upstream, file}]。旧版本快照（无 hours 分桶）也纳入——聚合时按迁移口径处理。
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

// --- v2（hours 分桶）↔ v1（顶层 models/keys 进程累计）统一视图 ----------------------
// 把任意版本的快照归一成 [{hk, models, keys}]（hk 为 UTC 整点 key）：
//   v2 → hours 原样展开；v1 → 总量视为 startedAt 所在小时的一个桶（粗化迁移口径，
//        与 server 启动载入时的迁移一致）。
function normalizedHours(stats) {
  if (!stats) return [];
  if (stats.hours && typeof stats.hours === 'object') {
    return Object.entries(stats.hours)
      .filter(([hk]) => /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(hk))
      .map(([hk, hb]) => ({ hk, models: hb.models || {}, keys: hb.keys || {} }));
  }
  if (stats.models || stats.keys) {
    const t = new Date(stats.startedAt);
    if (isNaN(t.getTime())) return [];
    return [{ hk: t.toISOString().slice(0, 13), models: stats.models || {}, keys: stats.keys || {} }];
  }
  return [];
}

// --- 时间窗口聚合（CLI 文本与 GUI dashboard 共用的数据接口） -----------------------
// 把窗口 [fromISO, toISO]（闭区间，任一为空表示该侧不设限）内的小时桶合并，返回：
//   {
//     upstreams: ['ds', 'glm'],             // 有快照的上游
//     window: { from, to, requestedFrom, requestedTo },  // 实际覆盖范围 + 请求范围
//     totals: bucket,                       // 全部上游合计（dashboard 概览卡）
//     upstreamTotals: { name: bucket },     // 按上游合计（dashboard 明细表 / 趋势图图例）
//     keys:   { label: bucket },            // 跨上游合并的按 KEY 表（label 消歧规则同 CLI）
//     models: { label: bucket },            // 按「上游/模型」合并的按模型表
//     series: [{ hk, upstream, bucket }],   // 小时 × 上游序列（dashboard 趋势图）
//   }
// bucket 字段：requests / inputTokens / outputTokens / cacheHitTokens / cacheCreatedTokens。
// 时间比较用「桶起点」：桶 hk 落入窗口 ⇔ from ≤ hk:00 ≤ to。边界用宽松口径——窗口边
// 上被部分覆盖的小时桶整桶计入（小时粒度下的最简诚实呈现；GUI 会标注窗口为小时粒度）。
function aggregate(fromISO, toISO) {
  const loaded = discoverUpstreamsWithStats()
    .map(({ upstream, file }) => {
      let stats = null;
      try { stats = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { /* 损坏跳过 */ }
      return stats ? { upstream, stats } : null;
    })
    .filter(Boolean);
  const agg = aggregateFromLoaded(loaded, fromISO, toISO);
  // key-name 消歧：兜底名（#n）在多个上游间（或与用户命名）撞名时加 <upstream> 前缀。
  // 必须先收集全部 key-name 再改标签，故作为后处理在 aggregateFromLoaded 结果上做。
  const hasKeyName = new Set();
  for (const { stats } of loaded) {
    for (const { keys } of normalizedHours(stats)) {
      for (const name of Object.keys(keys || {})) {
        if (!/^#\d+$/.test(name)) hasKeyName.add(name);
      }
    }
  }
  const fallbackSeen = new Set(); // 已出现的兜底名（首个不用前缀）
  const renamed = {};
  for (const label of Object.keys(agg.keys)) {
    if (!/^#\d+$/.test(label)) { renamed[label] = agg.keys[label]; continue; }
    if (fallbackSeen.has(label) || hasKeyName.has(label)) {
      // 撞名：按上游拆开重聚合。标签只有名字没有上游信息，这里从 loaded 重新归集。
      renamed[label] = agg.keys[label]; // 占位，下面重聚合覆盖
    } else {
      fallbackSeen.add(label);
      renamed[label] = agg.keys[label];
    }
  }
  // 兜底名撞名的精确消歧：直接按「上游 + 名」重新归集窗口内的 key 桶。
  if (fallbackSeen.size !== Object.keys(agg.keys).filter((k) => /^#\d+/.test(k)).length) {
    // 有撞名：重做 key 聚合（带前缀消歧），model 表不受影响。
    const fromT = fromISO ? Date.parse(fromISO) : null;
    const toT = toISO ? Date.parse(toISO) : null;
    const inWindow = (hk) => {
      const t = Date.parse(`${hk}:00:00Z`);
      if (isNaN(t)) return false;
      if (fromT != null && !isNaN(fromT) && t < fromT) return false;
      if (toT != null && !isNaN(toT) && t > toT) return false;
      return true;
    };
    const seen = new Map(); // "#n" -> 首个使用它的 upstream
    const keysAgg = {};
    for (const { upstream, stats } of loaded) {
      for (const { hk, keys } of normalizedHours(stats)) {
        if (!inWindow(hk)) continue;
        for (const [name, s] of Object.entries(keys || {})) {
          let label = name;
          if (/^#\d+$/.test(name)) {
            if ((seen.has(name) && seen.get(name) !== upstream) || hasKeyName.has(name)) {
              label = `${upstream}${name}`;
            } else {
              seen.set(name, upstream);
            }
          }
          keysAgg[label] ||= { ...ZERO };
          addBucket(keysAgg[label], s);
        }
      }
    }
    agg.keys = keysAgg;
  }
  return agg;
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

// `cc-bridge stats --text`（文本模式）：aggregate() 全量窗口 + 表格渲染。聚合模式
// （所有上游）与单上游共用——单上游只是把数据源缩到该上游。
function showStats(cfg) {
  const agg = aggregateWindowFor(cfg);
  if (!agg.window.from) {
    console.log(`[bridge] no stats found (no usable stats-<upstream>.json under ${configDir()})`);
    console.log('[bridge] start a daemon and make a few requests, then re-run.');
    console.log('[bridge] 需要看更详细的用量统计信息可以使用 cc-bridge dashboard。');
    return;
  }
  const scope = agg.upstreams.join(' + ');
  console.log(`[bridge] ${scope} — token stats`);
  console.log(`[bridge] window    : ${fmtTime(agg.window.from)} → ${fmtTime(agg.window.to)} (hourly buckets, daemon restarts preserved)`);
  console.log('');

  const keyRows = Object.entries(agg.keys)
    .filter(([, s]) => s.requests > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (keyRows.length) {
    console.log('[bridge] by key (API_KEY_n_NAME; unconfigured keys fall back to #n):');
    renderTable('key-name', keyRows.map(([label, s]) => ({ label, s })));
    console.log('');
  }

  const modelRows = Object.entries(agg.models)
    .filter(([, s]) => s.requests > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (modelRows.length) {
    console.log('[bridge] by model (upstream/model):');
    renderTable('model', modelRows.map(([label, s]) => ({ label, s })));
    console.log('');
  }

  console.log('[bridge] input = 输入 token 合计（已含缓存命中）；hit% = cache-hit / input；');
  console.log('[bridge] 命中率只计 server 侧能解析 usage 的请求（上游未返回 usage 的请求仅计入 reqs）。');
  console.log(`[bridge] 时间粒度为小时桶：窗口边界上的小时整桶计入（窗口即小时粒度）。`);
  console.log('[bridge] 需要看更详细的用量统计信息可以使用 cc-bridge dashboard。');
}

// 单上游模式的窗口聚合：数据源缩到指定上游（cfg 传入时），聚合模式（cfg=null）合并
// 所有上游。复用 aggregate() 的合并 / 消歧逻辑，避免两份口径。
function aggregateWindowFor(cfg, fromISO, toISO) {
  if (!cfg) return aggregate(fromISO, toISO);
  const { file, stats } = loadStats(cfg.upstream, cfg.configPath);
  if (!stats) return { upstreams: [], window: { from: null, to: null }, totals: { ...ZERO }, upstreamTotals: {}, keys: {}, models: {}, series: [] };
  // 借道 aggregate：把单上游数据临时放进聚合器。直接内联窗口过滤更简单——
  // 复用 normalizedHours + 同一套消歧 / 合并规则，只是数据源只有一份。
  return aggregateFromLoaded([{ upstream: cfg.upstream, stats }], fromISO, toISO);
}

// aggregate() 与 aggregateWindowFor() 共用的核心：对已加载的 [{upstream, stats}]
// 做窗口过滤 + 两维合并。抽出来避免单上游模式重复实现（口径必须与聚合模式一致）。
// 除按 KEY / 按模型两维表外，同时产出 totals（全上游合计）、upstreamTotals（按上游
// 合计）与 series（小时 × 上游序列）——dashboard 的概览卡、按上游表与趋势图数据。
function aggregateFromLoaded(loaded, fromISO, toISO) {
  const fromT = fromISO ? Date.parse(fromISO) : null;
  const toT = toISO ? Date.parse(toISO) : null;
  const inWindow = (hk) => {
    const t = Date.parse(`${hk}:00:00Z`);
    if (isNaN(t)) return false;
    if (fromT != null && !isNaN(fromT) && t < fromT) return false;
    if (toT != null && !isNaN(toT) && t > toT) return false;
    return true;
  };
  const keysAgg = {};
  const modelAgg = {};
  const upstreamAgg = {};
  const series = [];
  const coveredFrom = [];
  const coveredTo = [];
  for (const { upstream, stats } of loaded) {
    for (const { hk, models, keys } of normalizedHours(stats)) {
      if (!inWindow(hk)) continue;
      coveredFrom.push(`${hk}:00:00.000Z`);
      if (stats.updatedAt) coveredTo.push(stats.updatedAt);
      // 每小时桶每上游一个合计桶（series 与 upstreamTotals 都从它来），桶内两张
      // 维度表任一有数即成行——同一小时桶两维度合计口径天然一致（同一份累计）。
      const hbTotal = { ...ZERO };
      for (const [name, s] of Object.entries(keys || {})) {
        keysAgg[name] ||= { ...ZERO };
        addBucket(keysAgg[name], s);
      }
      for (const [model, s] of Object.entries(models || {})) {
        const label = `${upstream}/${model}`;
        modelAgg[label] ||= { ...ZERO };
        addBucket(modelAgg[label], s);
        addBucket(hbTotal, s);
      }
      if (hbTotal.requests > 0) {
        series.push({ hk, upstream, bucket: hbTotal });
        upstreamAgg[upstream] ||= { ...ZERO };
        addBucket(upstreamAgg[upstream], hbTotal);
      }
    }
  }
  series.sort((a, b) => (a.hk < b.hk ? -1 : a.hk > b.hk ? 1 : a.upstream.localeCompare(b.upstream)));
  const totals = { ...ZERO };
  for (const b of Object.values(upstreamAgg)) addBucket(totals, b);
  return {
    upstreams: loaded.map((l) => l.upstream),
    window: {
      from: coveredFrom.sort()[0] || null,
      to: coveredTo.sort().pop() || null,
      requestedFrom: fromISO || null,
      requestedTo: toISO || null,
    },
    totals,
    upstreamTotals: upstreamAgg,
    keys: keysAgg,
    models: modelAgg,
    series,
  };
}

module.exports = { loadStats, discoverUpstreamsWithStats, aggregate, aggregateWindowFor, showStats };
