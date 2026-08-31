'use strict';

/**
 * CC-Bridge — Claude Code 上游桥接框架（公共服务器）。
 *
 * 本文件是与上游无关的公共框架：接收 Claude Code 的 /v1/messages 请求，按当前
 * adapter 做请求体适配，按 MODEL_MAP（spoof→target 多对）把 body.model 改写为真实
 * 模型，转发到上游；响应原样回传（注入 modelUsage 让 webview 显示真实窗口）。
 *
 * 上游专属逻辑（请求体适配、字段清洗等）由对应
 * adapter 提供（见 glm-bridge/adapter.js），框架层通过 adapter.adaptRequestBody 调用。
 *
 * 多 KEY 容灾：API_KEY 支持逗号分隔多个，某 KEY 返回 401/403（失效/欠费）时熔断
 * 并切换下一个 KEY；瞬态错误先同 KEY 重试、用尽再换 KEY。
 */

const http = require('http');
const https = require('https');
// 按 KEY 的端点协议选 http/https 模块（KEY.base 的 scheme 决定；生产端点都是 https，
// http 供本地 mock / 内网自建网关用）。
const transportFor = (keyUp) => (keyUp.protocol === 'http:' ? http : https);
const fs = require('fs');
const path = require('path');
const { resolvePairs, statsPathFor } = require('./config');
const classifier = require('./classifier');

// --- 同 KEY 瞬态重试 --------------------------------------------------------
// 上游遇瞬态错误（DNS 失败 / 连接挂断 / 429 / 5xx）时，对同一 KEY 重试 N 次、
// 指数退避，吸收毫秒级短抖动。重试只发生在「响应头尚未写给客户端」之前——
// 一旦开始流式写回就不能再切。
const UPSTREAM_RETRY_DELAYS = [200, 500]; // 第 1、2 次重试前的退避时长（毫秒）

// --- KEY 熔断 ---------------------------------------------------------------
// 某个 KEY 被上游判定失效 / 欠费（401/403）后，在 KEY_BLOCK_SECONDS 秒内直接跳过它、
// 优先用其它 KEY，避免每条请求都先撞一次已知坏 KEY 制造延迟和日志噪音。熔断只针对
// 401/403（KEY 自身的问题）；瞬态错误（5xx/网络）不熔断 KEY——那是网关/链路问题，
// 换 KEY 也一样，不应连累无辜 KEY。
const KEY_BLOCK_SECONDS = 60;

// 判定是否为瞬态错误（这类才重试；4xx 业务错误中的 400/404 等不重试）。
function isTransient(err, status) {
  if (err && /ENOTFOUND|ETIMEDOUT|ECONNRESET|EPIPE|hang up|socket|timeout/i.test(err.message)) {
    return true;
  }
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return false;
}

// 判定是否为 KEY 级错误（该换 KEY）：401/403 表示这个 KEY 失效 / 欠费 / 无权限。
function isKeyError(status) {
  return status === 401 || status === 403;
}

// --- 断流续写（continuation recovery）常量 -----------------------------------
// 正文期断流后用 assistant prefill 让上游从断点续写（详见请求处理处的实现注释）。
// 续写次数上限：防「续写流又断 → 再续 → 又断」长尾请求无限循环。GLM 网关 ~15s
// 空闲即 RST（2026-08-30 实测），正常一次续写即可恢复；上限 3 次给长生成留余量，
// 仍失败则降级 SSE error（CC 侧 finalize partial，与现状一致）。
const CONTINUATION_MAX_RETRY = 3;

// --- 会话标题提示词语言示例修正 ------------------------------------------------
// Claude Code 客户端生成的会话标题提示词（内嵌于 native binary，2.1.226 实测）只有
// 英语示例 + 一条「Good (Korean session)」韩语示例，没有中文示例。非英语会话（如
// 中文）生成标题时，模型容易照抄韩语示例、输出韩语标题（DeepSeek 实测高频出现）。
// 桥接层在转发前对请求体做结构化改写：递归遍历对象、只改文本节点，把韩语示例改成
// 中文示例（语言标签同步改为 Chinese），让标题跟随对话语言生成。特征字符串
// 「Good (Korean session)」只出现在该提示词里、其它请求不含，故命中即替换、未命中
// 原样不动，零副作用；客户端将来改动提示词措辞导致特征失效时静默跳过即可。
const TITLE_PROMPT_LANG_FIXES = [
  // 原：Good (Korean session): {"title": "결제 모듈 리팩토링"}（韩语会话示例）
  ['Good (Korean session): {"title": "결제 모듈 리팩토링"}',
   'Good (Chinese session): {"title": "重构支付模块"}'],
  // 原：Bad (English title for a Korean session): {"title": "Refactor payment module"}
  ['Bad (English title for a Korean session)',
   'Bad (English title for a Chinese session)'],
];

// 递归改写请求体中的文本节点（system / messages 的 text 等），仅命中标题提示词
// 特征时替换；非文本节点 / 未命中一律原样不动。
function fixTitlePromptLanguage(node) {
  if (typeof node === 'string') {
    let s = node;
    for (const [from, to] of TITLE_PROMPT_LANG_FIXES) {
      if (s.includes(from)) s = s.split(from).join(to);
    }
    return s;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = fixTitlePromptLanguage(node[i]);
      if (v !== node[i]) node[i] = v;
    }
    return node;
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = fixTitlePromptLanguage(node[k]);
      if (v !== node[k]) node[k] = v;
    }
  }
  return node;
}

// --- 缓存命中观测 ----------------------------------------------------------
// 从上游响应的 usage 对象里提取缓存命中信息，返回一行可读日志；usage 不存在返回 null。
// 用途：长期观测上游 context caching 的命中情况——命中率、缓存读 / 写 token 数，便于
// 判断缓存是否生效、优化后是否提升、上游规则是否变动。
// 说明：部分上游（如 z.ai）的缓存是隐式的（按内容相似度自动匹配，不读 cache_control），
// 命中信息通过 usage 透传——所以观测缓存的正确方向是看 usage，而非在请求体打 cache_control。
// 兼容两种 usage 格式（z.ai /api/anthropic 端点具体返回哪种需实测，两种都认）：
//   · Anthropic 风格：cache_read_input_tokens / cache_creation_input_tokens / input_tokens
//     （三者相加 ≈ 总输入；命中率 = read / 三者之和）
//   · OpenAI 风格：prompt_tokens_details.cached_tokens（已含在 prompt_tokens 内；
//     命中率 = cached / prompt_tokens）
// 若 usage 存在但两种缓存字段都没有，列出 usage 的 keys，便于判断上游到底返回了什么。
function formatCacheUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;

  // Anthropic 风格
  if (usage.cache_read_input_tokens != null || usage.cache_creation_input_tokens != null) {
    const read = usage.cache_read_input_tokens || 0;
    const created = usage.cache_creation_input_tokens || 0;
    const input = usage.input_tokens || 0;
    const output = usage.output_tokens;
    const totalIn = read + created + input;
    const hitPct = totalIn > 0 ? Math.round(read / totalIn * 100) : 0;
    return `cache(anthropic): read=${read} created=${created} input=${input} out=${output != null ? output : '-'}  →  命中 ${hitPct}%`;
  }

  // OpenAI 风格
  const details = usage.prompt_tokens_details;
  if (details && details.cached_tokens != null) {
    const cached = details.cached_tokens || 0;
    const prompt = usage.prompt_tokens || 0;
    const completion = usage.completion_tokens;
    const hitPct = prompt > 0 ? Math.round(cached / prompt * 100) : 0;
    return `cache(openai): cached=${cached} prompt=${prompt} completion=${completion != null ? completion : '-'}  →  命中 ${hitPct}%`;
  }

  // usage 存在但无任何缓存字段：列出 keys 供判断上游返回结构
  const keys = Object.keys(usage).join(', ');
  return `cache: 上游 usage 无缓存字段（keys: ${keys || '空'}）`;
}

// 统计快照落盘节流间隔（毫秒）：内存累计是实时的，落盘每 30s 一次即可，
// 进程退出时（SIGINT/SIGTERM）会强制写一次补上尾部数据。
const STATS_FLUSH_MS = 30 * 1000;

// Create and start the bridge server from an already-loaded config + adapter.
function startServer(cfg, adapter) {
  const PORT = cfg.PORT;
  const KEYS = cfg.KEYS || [];
  const VERBOSE = cfg.VERBOSE;

  // --- 按小时分桶的用量统计（跨请求累计、跨进程续存，`cc-bridge stats` GUI 读取） ------
  // 两个维度各一张表（每个小时桶各一套）：
  //   hours[hk].models[model]   按 target 模型：请求数 + 输入 / 输出 / 缓存命中 / 缓存创建合计
  //   hours[hk].keys[keyName]   按 KEY 统计名（API_KEY_n_NAME，未配则 #n）：同上口径
  // hk 为 UTC 整点 key（如 "2026-08-20T04"，桶代表 [04:00, 05:00)）。按 KEY 维度用于
  // 用量归因（哪个账号用了多少），KEY 本体绝不落盘——只落 key-name。输入口径与
  // formatCacheUsage 一致（Anthropic 风格三者相加 ≈ 总输入，OpenAI 风格 prompt_tokens
  // 已含 cached）——按两种风格二选一分支累计，保证命中率 = 命中 / 总输入 的口径在
  // 单请求与跨请求汇总之间一致。
  // 持久化：内存实时累计 + 节流写盘到 ~/.cc-bridge/stats-<upstream>.json（随 config
  // 目录，兼容 $CC_BRIDGE_CONFIG 覆盖）。启动时载入既有历史（跨进程续存、重启不再
  // 清零），旧格式（顶层 models/keys 进程累计）迁移为起点所在小时的一个桶；滚动保留
  // STATS_RETENTION_HOURS，过期小时桶在每次写盘时清理。
  const STATS_FILE = statsPathFor(cfg.upstream, cfg.configPath);
  const STATS_RETENTION_HOURS = 24 * 30; // 滚动保留 30 天（GUI 最长快捷窗口）
  const stats = {
    upstream: cfg.upstream,
    version: 2,
    updatedAt: null,
    hours: {},
  };
  let statsDirty = false;
  let lastStatsFlush = 0;
  const zeroBucket = () => ({
    requests: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheCreatedTokens: 0,
  });

  // UTC 整点 key（"YYYY-MM-DDTHH"）；任意 ISO 时间转桶 key，无效输入返回 null。
  const hourKeyNow = () => new Date().toISOString().slice(0, 13);
  const hourKeyOf = (iso) => {
    const t = new Date(iso);
    return isNaN(t.getTime()) ? null : t.toISOString().slice(0, 13);
  };
  const hourBucket = (hk) => (stats.hours[hk] ||= { models: {}, keys: {} });

  // 清掉保留窗口之外的小时桶（写盘前调用；启动载入后也调一次）。
  function pruneOldHours() {
    const cutoff = Date.now() - STATS_RETENTION_HOURS * 3600 * 1000;
    for (const hk of Object.keys(stats.hours)) {
      const t = Date.parse(`${hk}:00:00Z`);
      if (!isNaN(t) && t < cutoff) delete stats.hours[hk];
    }
  }

  // 启动载入历史：v2（hours 分桶）直接续用；旧格式（顶层 models/keys 累计、重启即
  // 重置）把总量迁移成 startedAt 所在小时的一个桶——历史总量保住，时间粗化到该小时。
  (function loadStatsHistory() {
    try {
      const prev = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
      if (prev && prev.hours && typeof prev.hours === 'object') {
        stats.hours = prev.hours;
      } else if (prev && (prev.models || prev.keys)) {
        const hk = hourKeyOf(prev.startedAt);
        if (hk) stats.hours[hk] = { models: prev.models || {}, keys: prev.keys || {} };
      }
    } catch { /* 首次使用或文件损坏 → 从零开始 */ }
    pruneOldHours();
  })();

  // 把一次上游响应的 usage 累计进 bucket（hourBucket.models[model] / .keys[keyName]）。
  // usage 结构未知时只记请求数。partial=true：流式末尾 message_delta.usage——Anthropic
  // 规范里它只含输出侧统计（output_tokens，部分上游还带 cache_creation_input_tokens），
  // 只补充累计、不重复计请求数（同一请求的请求数已在 message_start 计过）。
  // base（可选）：本请求 message_start 记入前的输入侧快照。DS 等走 OpenAI 转换的
  // 上游，流式真实 usage 只在 delta 返回（message_start 只有估算值），传入 base 后
  // delta 用真实值「回退估算 + 重记真实」输入侧，避免估算污染 stats。
  function recordInto(bucket, usage, partial, base) {
    const s = bucket;
    if (partial) {
      // message_start 的 usage 里 output_tokens 恒为 0（规范如此），真实输出数
      // 只在流末尾的 delta 返回——必须在这里补累计，否则 stats 的 output 恒为 0
      // （DeepSeek 兼容端点即如此；z.ai 不规范、反而在 message_start 就返回）。
      // 缓存创建数部分上游也在 delta 报（start 为 0）——实测 glm / ds 的
      // message_start 均无 creation，一并累计不会重复；若未来某上游 start / delta
      // 都报 creation，此处会重复累计，需注意。
      s.outputTokens += usage.output_tokens || 0;
      s.cacheCreatedTokens += usage.cache_creation_input_tokens || 0;
      // 输入侧真实值只在 delta 返回（DeepSeek OpenAI 转换流）：回退本请求
      // message_start 的估算输入，按「read + created + input_tokens」口径改记真实值
      // （与 message_start 分支同口径，保证命中率 = 命中 / 总输入 一致）。Anthropic
      // 规范上游的 delta 不带输入侧字段（input_tokens 不存在或为 0），此分支不触发。
      if (base && (usage.input_tokens > 0 || usage.cache_read_input_tokens > 0)) {
        const read = usage.cache_read_input_tokens || 0;
        const created = usage.cache_creation_input_tokens || 0;
        s.inputTokens = base.inputTokens + read + created + (usage.input_tokens || 0);
        s.cacheHitTokens = base.cacheHitTokens + read;
        s.cacheCreatedTokens = base.cacheCreatedTokens + created;
      }
      return;
    }
    s.requests++;
    if (usage.cache_read_input_tokens != null || usage.cache_creation_input_tokens != null || usage.input_tokens != null) {
      // Anthropic 风格：input_tokens 不含缓存部分，总输入 = input + read + created。
      const read = usage.cache_read_input_tokens || 0;
      const created = usage.cache_creation_input_tokens || 0;
      s.inputTokens += read + created + (usage.input_tokens || 0);
      s.cacheHitTokens += read;
      s.cacheCreatedTokens += created;
      s.outputTokens += usage.output_tokens || 0;
    } else if (usage.prompt_tokens != null || (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens != null)) {
      // OpenAI 风格：prompt_tokens 已含 cached，命中 = cached。
      const cached = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
      s.inputTokens += usage.prompt_tokens || 0;
      s.cacheHitTokens += cached;
      s.outputTokens += usage.completion_tokens || 0;
    } else {
      // usage 存在但两种风格都不认：只记请求数与可能的输出，不污染输入 / 命中口径。
      s.outputTokens += usage.output_tokens || usage.completion_tokens || 0;
    }
  }

  // recordUsage 的入口：同一份 usage 同时累计进当前小时桶的「按模型」与「按 KEY」
  // 两张表。keyName 为空（异常情况）时只累计按模型表。base 是 message_start 前的
  // 两表快照 {models, keys}（各自可能为 null），按维度分发。详见 recordInto 的
  // partial / base 语义。
  function recordUsage(model, keyName, usage, partial, base) {
    if (!usage || typeof usage !== 'object') return;
    const hb = hourBucket(hourKeyNow());
    if (model) recordInto(hb.models[model] ||= zeroBucket(), usage, partial, base && base.models);
    if (keyName) recordInto(hb.keys[keyName] ||= zeroBucket(), usage, partial, base && base.keys);
    stats.updatedAt = new Date().toISOString();
    statsDirty = true;
    maybeFlushStats();
  }

  // 节流落盘：距上次写盘超过 STATS_FLUSH_MS 才写；force 无视节流（进程退出前用）。
  function maybeFlushStats(force) {
    if (!statsDirty) return;
    const now = Date.now();
    if (!force && now - lastStatsFlush < STATS_FLUSH_MS) return;
    lastStatsFlush = now;
    try {
      pruneOldHours();
      fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
      statsDirty = false;
    } catch (e) {
      log(`  stats flush failed: ${e.message}`);
    }
  }

  if (!cfg.API_BASE) {
    console.error(`[bridge] API_BASE not set for upstream '${adapter.name}'`); process.exit(1);
  }
  if (!KEYS.length) {
    console.error(`[bridge] API_KEY not set for upstream '${adapter.name}' (need at least one key)`); process.exit(1);
  }

  // 模型映射（多对 spoof→target）：同一上游可把多个 Claude 白名单模型路由到真实模型，
  // 例如 claude-opus-4-8 和 claude-haiku-4-5 都指向 glm-5.3。用户未配时用 adapter
  // 默认单对兜底。contextWindow / maxOutputTokens 为全局（一个上游共享），挂到每一对上
  // 方便路由代码直接取用。apiBase 不再挂对上——多端点（API_BASES）下转发按每 KEY 的
  // base（KEYS[i].base）而非全局。
  const pairs = resolvePairs(cfg, adapter).map((p) => ({
    spoof: p.spoof,
    target: p.target,
    contextWindow: cfg.CONTEXT_WINDOW || (adapter.modelContextWindow || {})[p.target] || 0,
    maxOutputTokens: cfg.MAX_OUTPUT_TOKENS,
  }));
  // 注入 apiBase（首个端点）供 adapter.makeUpstreamCall 派生 OpenAI 端点地址用。
  adapter.apiBase = cfg.API_BASE;

  // 展示用：首个端点 URL（banner / health）。实际转发按每 KEY 的 base。
  const apiBase = cfg.API_BASE;
  // 每个 KEY 的目标端点 URL 对象（与 KEYS 一一对应；多端点时各 KEY 可能不同）。
  const keyUpstreams = KEYS.map((k) => new URL(k.base));

  // 每个 KEY 的熔断到期时间戳（0 = 未熔断）。
  const keyBlockedUntil = new Array(KEYS.length).fill(0);

  // 每行日志带 ISO 时间戳，便于把日志与实时故障逐请求对齐定位。
  const log = (...a) => { if (VERBOSE) console.log(`[bridge ${new Date().toISOString()}]`, ...a); };

  // --- modelUsage 注入 ----------------------------------------------------
  // 构建 modelUsage 对象注入 API 响应，让 CLI 把真实的上下文窗口传给 webview / 本地
  // 预检。contextWindow 优先级：显式配置 CONTEXT_WINDOW（全局，向后兼容）> adapter
  // 的 modelContextWindow 表按 target 取值（T14：多对 MODEL_MAP 下各 target 各自
  // 正确，如 glm-5.3=1M / glm-4.6=200K；表里没有的 target 不注入窗口）。maxOutputTokens
  // 仍为全局显式配置。用所有出现过的 spoof 和 target 名作为 key 注入——CLI 的
  // currentMainLoopModel 可能取响应里的 model（target 名），也可能取它自己记录的请求
  // model（spoof 名），多对时取到哪个名都命中（spoof 名挂其映射对的 entry）。
  function buildModelUsage() {
    const acw = adapter.modelContextWindow || {};
    const mo = cfg.MAX_OUTPUT_TOKENS;
    const entryByTarget = new Map();
    for (const p of pairs) {
      if (!p.target) continue;
      const cw = cfg.CONTEXT_WINDOW || acw[p.target] || 0;
      if (!cw && !mo) continue;
      const entry = {};
      if (cw) entry.contextWindow = cw;
      if (mo) entry.maxOutputTokens = mo;
      entryByTarget.set(p.target, entry);
    }
    if (!entryByTarget.size) return null;
    const mu = {};
    for (const p of pairs) {
      const e = entryByTarget.get(p.target);
      if (!e) continue;
      mu[p.target] = e;
      if (p.spoof) mu[p.spoof] = e;
    }
    return Object.keys(mu).length ? mu : null;
  }

  // Headers we must NOT blindly copy from the client request:
  //   host/connection/transfer-encoding  → hop-by-hop, we set our own
  //   accept-encoding                     → force identity so we can log & the body is plain
  //   content-length                      → recompute after body rewrite
  //   x-api-key                           → inject from config (overrides whatever client sent)
  const DROP_HEADERS = new Set([
    'host', 'connection', 'transfer-encoding',
    'accept-encoding', 'content-length', 'x-api-key',
  ]);

  const server = http.createServer((clientReq, clientRes) => {
    // Local health/readiness endpoint — does not hit upstream.
    if (clientReq.url === '/health' || clientReq.url === '/') {
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({
        status: 'ok',
        upstream: adapter.name,
        display: adapter.displayName,
        api_base: apiBase,
        api_bases: cfg.API_BASES,
        spoof: pairs[0] ? pairs[0].spoof : null,   // 主力对（兼容旧消费者）
        target: pairs[0] ? pairs[0].target : null,
        modelMap: pairs.map((p) => ({ spoof: p.spoof, target: p.target })),
        keys: KEYS.length,
      }));
      return;
    }

    const chunks = [];
    clientReq.on('data', (c) => chunks.push(c));
    clientReq.on('end', () => {
      let body = Buffer.concat(chunks);
      let modelIn = null;
      let effort = null;
      let stream = false;
      let rewritten = false;
      let obj = null; // parsed Anthropic request body (if any)
      const urlPath = clientReq.url.split('?')[0];
      const isMessages = clientReq.method === 'POST' && urlPath.startsWith('/v1/messages') && !urlPath.startsWith('/v1/messages/count_tokens');
      // 本次请求的真实 target 模型（spoof 改写后 / 直传），提升到回调级供
      // handleUpstreamResponse 使用（按模型统计需要它在响应处理时可见）。
      let currentTarget = null;
      // 本次实际使用的 KEY 的统计名（按 KEY 维度用量归因用；随 KEY 轮换更新）。
      let currentKeyName = null;
      // 本请求 message_start 记入前的输入侧快照（models / keys 两张表各一份）：DS 等
      // 转换流的真实 usage 在 message_delta 才返回，需用它回退估算值（见 recordUsage
      // 的 base 参数）。
      let msgStartBase = null;
      // 上游响应是否已开始写给客户端（handleUpstreamResponse 已处理过一次）。置真后
      // 重试 / 换 KEY 窗口关闭：响应头已发出、流已部分转发，无法透明重试。
      let responseStarted = false;

      // 断流诊断：记录上游响应最近一次收到数据的时刻与累计收到的字节数。断流
      // （ECONNRESET 等）发生时，据「距上一包的空闲时长 + 已收字节数」可分辨两种
      // 掐断模式——空闲掐（长静默后被服务端 / 中间设备当死连接回收，idle 大，典型
      // 是 GLM 长思考期间不吐 SSE 字节）与活跃掐（数据正在流动中被掐，idle 小）。
      // 对症处理不同（空闲掐→调 keepalive / 向上游反馈；活跃掐→查网络路径），故
      // 断流日志必须带上这两个数（2026-08-30 glm 上游每日数十次 reset，待定位）。
      let lastUpDataAt = 0;
      let upBytes = 0;
      function streamDiag() {
        if (!lastUpDataAt) return '，断流诊断：未收到任何数据包';
        return `，断流诊断：距上一包 ${Date.now() - lastUpDataAt}ms、已收 ${upBytes}B`;
      }

      // 流式中断收尾：向已开始的 SSE 流补发一个协议内 error 事件后干净 end，
      // 而不是硬掐 TCP（clientRes.destroy()）。硬掐时 CC 只能显示 "Connection
      // closed mid-response" 并停止本轮；而 Anthropic 流式协议允许在任意时刻
      // 送达 {"type":"error"} 事件，CC 对「还没产出正文」的流内错误会自动重试
      // 整轮。注意（2026-08-30 反编译 CC 2.1.226 确认）：已产出正文（text /
      // tool_use 块）后收到流内错误，CC 一律 finalize partial response——把
      // "API Error: Server error mid-response" 当文本 yield 给用户、本轮不重试。
      // 所以本函数只是「思考期断流」的兜底（CC 会自动重试）；正文期断流走
      // continueInterrupted（断流续写），不要落到这里。
      function abortWithSseError(reason) {
        if (clientRes.headersSent && !clientRes.writableEnded) {
          try {
            clientRes.write('event: error\n');
            clientRes.write(
              'data: ' + JSON.stringify({
                type: 'error',
                error: {
                  type: 'overloaded_error',
                  message: 'upstream stream interrupted (' + reason + '); retried by client',
                },
              }) + '\n\n',
            );
            clientRes.end();
          } catch { try { clientRes.destroy(); } catch { /* already gone */ } }
        } else {
          try { clientRes.destroy(); } catch { /* already gone */ }
        }
      }

      // --- 断流续写（continuation recovery）状态 ---------------------------------
      // 病灶（2026-08-30 实测定位）：bigmodel.cn 网关对 SSE 连接有 ~15s 应用层空闲
      // 超时——流上 15s 无字节即 RST（三次实测距上一包 15134/15104/15141ms，TCP
      // keepalive 挡不住，网关看的是应用层字节）。GLM-5.3 思考期 / 生成中途停顿
      // 静默超 15s → 连接被掐。断在思考期（无正文）时 CC 自动重试、用户无感；断在
      // 正文期时 CC 收到 error 事件也绝不重试（见 abortWithSseError 注释），用户
      // 看到 "API Error: Server error mid-response"。
      //
      // 治法：正文期断流后不向 CC 报错，而是让上游「从断点接着写」——把已转发的
      // 正文作为 assistant prefill 重发请求（GLM 端点支持，2026-08-30 实测：字符串
      // / 块数组 prefill、thinking 开启、句中断点三种场景都能精准续写；偶发把整个
      // prefill 重复输出，约 50%/场景随机，用后缀匹配去重兜住），续写流的正文块以
      // 递增编号续在原消息后面转发。CC 收到的是一条协议完整的消息（块 0 思考、
      // 块 1 半截正文、块 2 续写正文……），全程无 error 事件、无感。
      // 前提：本请求可解析（obj 非空）、流式、且原始请求体可用（续写要重发对话）。
      const continuation = {
        // 已转发给 CC 的正文块快照：[{type:'text',text},...]。断流时拼成 prefill。
        // thinking 块不进 prefill（续写流自带新思考）；tool_use 块进 prefill 时
        // 半截 JSON 无法续（见下 toolBuffer 说明），只进完整的。
        blocks: [],
        // 续写次数（上限 CONTINUATION_MAX_RETRY，防长尾请求无限续）。
        attempt: 0,
        // 续写恢复中标记：置真期间上游静默属预期（重连 + 重新思考），CC 方向靠
        // keepaliveTimer 的 SSE 注释行喂字节看门狗。
        recovering: false,
      };
      // SSE 块状态引用：handleUpstreamResponse 的流式分支创建 sseState 后回填到
      // 这里，供 attachContinuationStream（块编号续接、partialText 拼 prefill）读取。
      // 请求初期为 null（还没收到上游响应）。
      let sseStateRef = null;
      // 上游流静默看门狗：正文期断流全部是「静默 15s → RST」模式，与其等网关掐，
      // 不如桥接在 12s 静默时主动判定断流、立即走续写——省 3s 等待，且把「被动
      // RST」变「主动恢复」，日志可控。仅正文已开始转发后启用（思考期断流交给
      // CC 自动重试，那是已验证的好路径）。
      let idleWatchdog = null;
      const UP_IDLE_TIMEOUT_MS = 12000;
      // CC 方向保活：续写重连期间 CC 收不到正文字节，其字节看门狗（默认 3 分钟）
      // 若触发会整轮报废。每 5s 发一条 SSE 注释行（": keepalive"，协议规定客户端
      // 忽略注释，但字节确实在流动）。仅在需要时启动（续写恢复期 / 静默期）。
      let keepaliveTimer = null;
      function startKeepalive() {
        if (keepaliveTimer || clientRes.writableEnded || clientRes.destroyed) return;
        keepaliveTimer = setInterval(() => {
          if (clientRes.writableEnded || clientRes.destroyed) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
            return;
          }
          try { clientRes.write(': keepalive\n\n'); } catch { /* client gone */ }
        }, 5000);
      }
      function stopKeepalive() {
        if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
      }

      // prefill 续写去重：GLM 偶发把 prefill 的尾部（乃至整段）重复输出在续写正文
      // 开头（实测约半数场景随机出现）。找最长的 s 满足 prefillTail.endsWith(s) &&
      // contText.startsWith(s)，剥掉续写正文开头的 s。只做行对齐匹配（s 必须从
      // prefillTail 的某个行首开始），避免误剥「正常续写恰好重复几个字符」的场景。
      function stripRepeatedPrefix(prefillTail, contText) {
        const window = prefillTail.slice(-4096); // 匹配窗口 4KB 足够（重复的是尾部）
        const max = Math.min(window.length, contText.length);
        // len >= 2：单字符「重复」多为巧合（如标点、换行），剥了弊大于利。
        for (let len = max; len >= 2; len--) {
          const start = window.length - len;
          // 行对齐：候选 s 在 prefillTail 里的起点必须是行首（前一个字符是 \n
          // 或就是窗口开头）。起点不在行首的部分重复不值得冒误剥风险。
          if (start > 0 && window[start - 1] !== '\n') continue;
          const s = window.slice(start);
          if (contText.startsWith(s)) return contText.slice(len);
        }
        return contText;
      }

      // 断流续写主入口：上游流断了且正文已转发给 CC 时调用。构造 prefill 请求让
      // 上游从断点接着写，续写流剥壳后（跳过 message_start / thinking / 已去重的
      // 重复前缀）以递增块编号续转发。失败（重试用尽 / 请求构造不出）降级为
      // abortWithSseError。
      function continueInterrupted(reason) {
        // 重入 guard：已在续写恢复中（静默看门狗 destroy 的回声 error / 续写流
        // 自身的错误路径可能并发到达），只让第一个触发方驱动恢复。
        if (continuation.recovering) return;
        // 客户端已断 / 已收尾：无事可做。
        if (clientRes.writableEnded || clientRes.destroyed) return;
        // 无可续内容（正文块为空 = 断在思考期）或不可构造续写请求：CC 侧走
        // thinking-only 自动重试路径。
        // 可续内容 = 已收全的完整块 或 正在写的半截 text 块（都可作为 prefill）。
        const hasPartialText = !!(sseStateRef && sseStateRef.partialText);
        const canContinue = (continuation.blocks.length > 0 || hasPartialText) && obj && isMessages && stream;
        if (!canContinue || continuation.attempt >= CONTINUATION_MAX_RETRY) {
          if (continuation.attempt >= CONTINUATION_MAX_RETRY && canContinue) {
            log(`  断流续写已达上限（${CONTINUATION_MAX_RETRY}），降级 SSE error 收尾`);
          }
          if (sseStateRef) sseStateRef.abandoned = true; // 原流停止写（防 write-after-end）
          abortWithSseError(reason);
          return;
        }
        continuation.attempt++;
        continuation.recovering = true;
        if (sseStateRef) sseStateRef.abandoned = true; // 原流停止写，续写流接管
        startKeepalive();
        log(`  断流续写 #${continuation.attempt}/${CONTINUATION_MAX_RETRY}：正文已转发 ${continuation.blocks.length} 块，prefill 重发请求恢复`);

        // 构造续写请求体：原对话 + assistant prefill（已转发正文的块数组）。
        // prefill 只放完整块——半截 text 块（断流时正在写的那个）拼成完整 text
        // 块给 prefill（LLM 视角就是「我写到这里的完整发言」）；半截 tool_use
        // 块（input JSON 没收全）不能拼进 prefill，该块的已转发部分只能截断——
        // 用 content_block_stop 补一个闭合的空壳块收尾（见 finishTruncatedToolUse）。
        try {
          const contBody = JSON.parse(body.toString('utf-8')); // 从改写后的请求体复制（模型改写 / adapter 适配都保留）
          const prefillBlocks = continuation.blocks.map((b) => ({ ...b }));
          // 半截 text 块：断流时正在写的那个 text 块已累计的文本，拼进 prefill
          // 末尾（prefill 块必须完整，半截 text 直接以文本形式拼上即可——LLM 视角
          // 就是「我说到这里」）。
          if (sseStateRef && sseStateRef.partialText) {
            prefillBlocks.push({ type: 'text', text: sseStateRef.partialText });
          }
          // prefill 追加为末尾 assistant 消息：常规请求最后一条是 user / tool_result，
          // 直接 push；CC 的结构化输出等场景原请求就带 assistant prefill（末条已是
          // assistant），此时把断点块并进那条消息（两条 assistant 相邻会 400）。
          const lastMsg = contBody.messages[contBody.messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            const existing = typeof lastMsg.content === 'string'
              ? [{ type: 'text', text: lastMsg.content }]
              : (Array.isArray(lastMsg.content) ? lastMsg.content : []);
            lastMsg.content = existing.concat(prefillBlocks);
          } else {
            contBody.messages.push({ role: 'assistant', content: prefillBlocks });
          }
          // 续写轮不需要再思考一遍（首思考已在断流前转发了；续写直接出正文）。
          // 但 GLM 端点 thinking 参数留着也无妨（实测带 thinking 续写精准），
          // 删掉 budget 可省 token：保守起见保持原样，行为与实测一致。
          const contBodyBuf = Buffer.from(JSON.stringify(contBody), 'utf-8');

          // 走与 send() 相同的 KEY 选择 / 熔断逻辑，但响应处理换成续写壳。
          const tryKeys = [];
          for (let i = 0; i < KEYS.length; i++) if (!tried.has(i)) tryKeys.push(i);
          if (!tryKeys.length) tryKeys.push(currentKey);
          const attemptCont = (ki) => {
            if (ki >= tryKeys.length) {
              log('  断流续写：所有 KEY 失败，降级 SSE error 收尾');
              continuation.recovering = false;
              stopKeepalive();
              abortWithSseError(reason + ' (continuation failed)');
              return;
            }
            const keyIdx2 = tryKeys[ki];
            const keyUp = keyUpstreams[keyIdx2];
            const transport2 = transportFor(keyUp);
            const upReq = transport2.request({
              hostname: keyUp.hostname,
              port: keyUp.port || (keyUp.protocol === 'http:' ? 80 : 443),
              path: keyUp.pathname.replace(/\/+$/, '') + clientReq.url,
              method: clientReq.method,
              headers: buildHeaders(KEYS[keyIdx2].value, keyUp, contBodyBuf),
            });
            upReq.setSocketKeepAlive(true, 15000);
            upReq.on('response', (res2) => {
              if (res2.statusCode !== 200) {
                // 读错误响应体帮助定位（422 语义错误等），读完再换 KEY。
                let errBody = '';
                res2.on('data', (c) => { errBody += c; });
                res2.on('end', () => {
                  log(`  断流续写：上游 ${res2.statusCode}（${errBody.slice(0, 300)}），换 KEY 重试`);
                  attemptCont(ki + 1);
                });
                return;
              }
              log(`  断流续写：← 200（key=${KEYS[keyIdx2].name}），续写流接入`);
              continuation.recovering = false;
              // keepalive 不在这里停：续写流剥壳后（丢弃 thinking / message_start），
              // 首 text 块还要整块缓冲去重，CC 方向可能持续无正文字节；keepalive
              // 由 attachContinuationStream 在真正开始转发正文后自行停掉。
              attachContinuationStream(res2, keyIdx2);
            });
            upReq.on('error', (err2) => {
              log(`  断流续写：请求错误 ${err2.message}，换 KEY 重试`);
              attemptCont(ki + 1);
            });
            upReq.end(contBodyBuf);
          };
          attemptCont(0);
        } catch (e) {
          log(`  断流续写：构造请求失败（${e.message}），降级 SSE error 收尾`);
          continuation.recovering = false;
          stopKeepalive();
          abortWithSseError(reason + ' (continuation build failed)');
        }
      }

      // 续写流接入：把 prefill 续写请求的响应流接成原消息的后续块。
      // 剥壳规则（CC 侧原消息已在转发中，续写流的协议框架不能重复出现）：
      //   message_start / ping / message_stop —— 丢弃（原流的框架已在 CC 侧）。
      //   thinking 块（content_block_start type=thinking 及其 delta/stop）——
      //     丢弃（prefill 里没放 thinking，但模型仍可能再思考一段；CC 侧消息
      //     结构里再插思考块会打乱「思考→正文」叙事，且内容是重复思考，无用）。
      //   message_delta —— 透传（stop_reason / usage 收尾）。usage 会把续写轮的
      //     token 计入统计（recordUsage 由原流的 message_delta 处理器管，这里只
      //     改写 delta 正文后透传）。
      //   text 块 —— 首个 text 块做去重（stripRepeatedPrefix 剥掉模型重复输出的
      //     prefill 尾部），以递增编号（sseState.nextBlockIndex 起）作为新
      //     content_block 续转发；后续 text 块同样处理。
      //   tool_use 块 —— 整块缓冲完整后以递增编号转发（与原流 toolBuffer 同理）。
      // 续写流再断（recursive interruption）：正文期静默 / RST 同样处理——再续
      //（attempt 上限内）或降级。CC 方向在续写流接入前由 keepalive 喂着，
      // 接入后恢复真实字节。
      function attachContinuationStream(upRes2, keyIdx2) {
        currentKeyName = KEYS[keyIdx2].name;
        const decoder2 = new TextDecoder('utf-8');
        let buf2 = '';
        let ev2 = '';
        // 续写流自身的块解析状态：
        let contTextStarted = false;   // 是否已见到首个（去重后的）text 块
        let firstTextDone = false;     // 首个 text 块是否已完成去重转发
        let dedupedAny = false;        // 首块去重是否剥掉了内容（打日志用）
        let accText = '';              // 首个 text 块累计（收全一定量再判去重？不——
        // 去重要在首 delta 到达时就判定前缀重复，但重复部分可能跨多条 delta。
        // 折中：首个 text 块整体缓冲到 content_block_stop，一次去重后整块发出。
        // 首块通常是「重复的 prefill 尾 + 少量新内容」，整块发不损失体验（续写
        // 恢复本身就有秒级延迟）。后续 text 块恢复逐 delta 转发。
        let firstTextBuf = null;       // { index, start data obj, delta lines }
        let toolBuf2 = null;           // 续写流的 tool_use 缓冲（同原流 toolBuffer）
        const prefillTailForDedup = (() => {
          const parts = continuation.blocks.map((b) => (b.type === 'text' ? b.text : ''));
          if (sseStateRef && sseStateRef.partialText) parts.push(sseStateRef.partialText);
          return parts.join('\n');
        })();

        // 静默看门狗（续写流自己的正文期监控）：与原流同条件——只在该续写流已
        // 转发过正文块后才武装（contEmittedBody 标记）。续写流的思考期（thinking
        // 被剥壳、CC 侧无字节）静默属正常，提前武装会在思考静默 12s 时误判再断流、
        // 打断本可成功的恢复。CC 方向靠 keepalive 维持。
        let wd2 = null;
        let contEmittedBody = false;
        const arm2 = () => {
          if (!contEmittedBody) return;
          if (wd2) clearTimeout(wd2);
          wd2 = setTimeout(() => {
            wd2 = null;
            if (clientRes.writableEnded || clientRes.destroyed) return;
            log(`  续写流静默 ${UP_IDLE_TIMEOUT_MS}ms，再次断流续写`);
            try { upRes2.destroy(); } catch { /* already gone */ }
            continueInterrupted('continuation idle ' + UP_IDLE_TIMEOUT_MS + 'ms');
          }, UP_IDLE_TIMEOUT_MS);
        };
        const disarm2 = () => { if (wd2) { clearTimeout(wd2); wd2 = null; } };

        const finishFatal = (why) => {
          disarm2();
          stopKeepalive();
          abortWithSseError(why);
        };

        upRes2.on('data', (chunk) => {
          if (clientRes.destroyed || clientRes.writableEnded) {
            try { upRes2.destroy(); } catch { /* already gone */ }
            return;
          }
          buf2 += decoder2.decode(chunk, { stream: true });
          let nl;
          while ((nl = buf2.indexOf('\n')) >= 0) {
            const line = buf2.slice(0, nl);
            buf2 = buf2.slice(nl + 1);
            if (line.startsWith('event:')) { ev2 = line; continue; }
            if (!line.startsWith('data:')) continue;
            let data;
            try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }

            if (ev2.includes('message_start') || ev2.includes('ping')) {
              continue; // 剥壳：原流框架已在 CC 侧
            }
            if (ev2.includes('content_block_start')) {
              const cb = data.content_block || {};
              if (cb.type === 'thinking') continue; // 剥壳：重复思考丢弃
              if (cb.type === 'text') {
                if (!firstTextDone) {
                  // 首个 text 块：缓冲整块做去重。
                  firstTextBuf = { start: data, deltas: [] };
                } else {
                  // 后续 text 块：以递增编号实时转发。
                  const idx = sseStateRef ? sseStateRef.nextBlockIndex++ : data.index;
                  const nd = { ...data, index: idx };
                  clientRes.write('event: content_block_start\n');
                  clientRes.write('data: ' + JSON.stringify(nd) + '\n\n');
                  contEmittedBody = true;
                }
              } else if (cb.type === 'tool_use') {
                toolBuf2 = { index: data.index, lines: [data] };
              } else {
                // 其它类型（redacted_thinking 等）：按 text 块外路径以递增编号转发。
                const idx = sseStateRef ? sseStateRef.nextBlockIndex++ : data.index;
                const nd = { ...data, index: idx };
                clientRes.write('event: content_block_start\n');
                clientRes.write('data: ' + JSON.stringify(nd) + '\n\n');
              }
              continue;
            }
            if (ev2.includes('content_block_delta')) {
              const d = data.delta || {};
              if (d.thinking_delta || d.signature_delta) continue; // 剥壳：思考丢弃
              if (toolBuf2 && data.index === toolBuf2.index) {
                toolBuf2.lines.push(data); // tool_use delta 攒着
                continue;
              }
              if (firstTextBuf && data.index === firstTextBuf.start.index) {
                firstTextBuf.deltas.push(data); // 首 text 块攒着（去重用）
                continue;
              }
              if (typeof d.text === 'string' && !firstTextDone) continue; // 首块外的意外 text delta（防御）
              // 后续 text 块的 delta：重映射编号转发。
              const idx = sseStateRef ? sseStateRef.nextBlockIndex - 1 : data.index;
              const nd = { ...data, index: idx };
              clientRes.write('event: content_block_delta\n');
              clientRes.write('data: ' + JSON.stringify(nd) + '\n\n');
              continue;
            }
            if (ev2.includes('content_block_stop')) {
              if (toolBuf2 && data.index === toolBuf2.index) {
                // 续写流 tool_use 收全：递增编号整块转发（start + deltas + stop）。
                // 每个事件都以空行收口——SSE 事件以空行分隔，缺了会把多行 data 拼
                // 成单事件、JSON.parse 失败（同主转发循环 2.15.0 的 bug，一并修）。
                const baseIdx = sseStateRef ? sseStateRef.nextBlockIndex++ : data.index;
                clientRes.write('event: content_block_start\n');
                clientRes.write('data: ' + JSON.stringify({ ...toolBuf2.lines[0], index: baseIdx }) + '\n\n');
                for (const dl of toolBuf2.lines.slice(1)) {
                  clientRes.write('event: content_block_delta\n');
                  clientRes.write('data: ' + JSON.stringify({ ...dl, index: baseIdx }) + '\n\n');
                }
                clientRes.write('event: content_block_stop\n');
                clientRes.write('data: ' + JSON.stringify({ type: 'content_block_stop', index: baseIdx }) + '\n\n');
                contEmittedBody = true;
                // 续写的 tool_use 块同样记入 prefill 素材（支持再断再续）。
                try {
                  let json2 = '';
                  for (const dl of toolBuf2.lines.slice(1)) {
                    const dd = dl.delta || {};
                    if (typeof dd.partial_json === 'string') json2 += dd.partial_json;
                  }
                  let input2 = {};
                  try { input2 = JSON.parse(json2); } catch {}
                  continuation.blocks.push({
                    type: 'tool_use',
                    id: toolBuf2.lines[0].content_block.id,
                    name: toolBuf2.lines[0].content_block.name,
                    input: input2,
                  });
                } catch {}
                toolBuf2 = null;
                continue;
              }
              if (firstTextBuf && data.index === firstTextBuf.start.index) {
                // 首 text 块收全：拼全文 → 去重 → 以递增编号整块转发。
                let full = '';
                for (const dl of firstTextBuf.deltas) {
                  if (typeof dl.delta.text === 'string') full += dl.delta.text;
                }
                const deduped = stripRepeatedPrefix(prefillTailForDedup, full);
                if (deduped !== full) dedupedAny = true;
                firstTextDone = true;
                firstTextBuf = null;
                if (deduped) {
                  const idx = sseStateRef ? sseStateRef.nextBlockIndex++ : 0;
                  // 每个事件以空行收口（同上，SSE 事件分隔，缺了会拼接多行 data）。
                  clientRes.write('event: content_block_start\n');
                  clientRes.write('data: ' + JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }) + '\n\n');
                  clientRes.write('event: content_block_delta\n');
                  clientRes.write('data: ' + JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: deduped } }) + '\n\n');
                  clientRes.write('event: content_block_stop\n');
                  clientRes.write('data: ' + JSON.stringify({ type: 'content_block_stop', index: idx }) + '\n\n');
                  continuation.blocks.push({ type: 'text', text: deduped });
                  contEmittedBody = true;
                  stopKeepalive(); // 正文开始真实流动，注释行功成身退
                } else {
                  // 去重后为空（模型只重复了 prefill、无新内容）：不发块，
                  // 等后续块或收尾。
                }
                continue;
              }
              // 后续 text / 其它块的 stop：重映射编号转发。
              const idx = sseStateRef ? sseStateRef.nextBlockIndex - 1 : data.index;
              clientRes.write('event: content_block_stop\n');
              clientRes.write('data: ' + JSON.stringify({ ...data, index: idx }) + '\n\n');
              if (sseStateRef) {
                // 后续 text 块收全也记入 prefill 素材（再断再续时用）。
                // 上面的 start/delta 处理里没有为后续 text 块累计文本，这里从
                // data 里拿不到全文——为简化，续写流的后续 text 块不进 prefill
                // 素材（再断时 prefill 缺这部分，恢复内容可能轻微回退）。
                // 概率极低（续写又断 + 恰有多 text 块），接受此权衡。
              }
              continue;
            }
            if (ev2.includes('message_delta')) {
              // 收尾 delta（stop_reason / usage）：透传。usage 计入统计由上游
              // message_delta 的 recordUsage 路径管不了这里——直接补记一次。
              try {
                recordUsage(currentTarget, currentKeyName, data.usage);
              } catch {}
              clientRes.write('event: message_delta\n');
              clientRes.write('data: ' + JSON.stringify(data) + '\n\n');
              continue;
            }
            if (ev2.includes('message_stop')) {
              // 原消息收尾：透传 message_stop 后 end。
              clientRes.write('event: message_stop\n');
              clientRes.write('data: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
              try { clientRes.end(); } catch { /* already gone */ }
              log(`  断流续写完成（#${continuation.attempt}，去重${dedupedAny ? '生效' : '未触发'}，累计 ${continuation.blocks.length} 块）`);
              return;
            }
            if (ev2.includes('error')) {
              // 续写流自己报了错误事件：再试一次（上限内）或降级。
              log(`  续写流内错误事件：${JSON.stringify(data).slice(0, 200)}`);
              if (continuation.attempt < CONTINUATION_MAX_RETRY) {
                continueInterrupted('continuation stream error');
              } else {
                finishFatal('continuation stream error (max retry)');
              }
              return;
            }
          }
          arm2();
        });
        upRes2.on('end', () => {
          disarm2();
          stopKeepalive();
          // 上游正常关流但没到 message_stop（罕见）：补 message_delta + message_stop
          // 干净收尾，比挂着强。
          if (clientRes.writableEnded || clientRes.destroyed) return;
          try {
            clientRes.write('event: message_delta\n');
            clientRes.write('data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }) + '\n\n');
            clientRes.write('event: message_stop\n');
            clientRes.write('data: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
            clientRes.end();
            log('  断流续写完成（上游 end 提前，已补干净收尾）');
          } catch { /* client gone */ }
        });
        upRes2.on('error', (err2) => {
          disarm2();
          log(`  续写流错误：${err2 && err2.message}`);
          if (continuation.attempt < CONTINUATION_MAX_RETRY &&
              !clientRes.writableEnded && !clientRes.destroyed) {
            continueInterrupted(err2 && err2.message);
          } else {
            finishFatal(err2 && err2.message);
          }
        });
      }

      // Only rewrite the model on /v1/messages POSTs with a JSON body.
      if (clientReq.method === 'POST' && urlPath.startsWith('/v1/messages') && body.length) {
        try {
          obj = JSON.parse(body.toString('utf-8'));
          // 分类器优先：CC 安全分类器请求走 agnes（on）或放行（off），不转发 z.ai 上游。
          // 分类器请求高频且原本吃 opus 倍率，是 Coding Plan 额度大头；转走 agnes 免费 / 直接放行后省下。
          if (isMessages && classifier.isClassifierRequest(obj)) {
            classifier.handleClassifier(obj, cfg).then((result) => {
              const respBody = JSON.stringify(result.body);
              clientRes.writeHead(result.status, {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(respBody),
              });
              clientRes.end(respBody);
            });
            return;
          }
          modelIn = obj.model || null;
          effort = obj.output_config?.effort || obj.effort || null;
          stream = obj.stream === true;
          // 多对路由：在 pairs 里查 obj.model。命中某对的 spoof → 改写为该对 target；
          // 命中某对的 target → 原样直传；都不命中 → 400（绝不静默改写到默认对）。
          // currentTarget 记下本次真实 target，供 adapter 适配与 dump 命名使用。
          currentTarget = pairs[0] ? pairs[0].target : null;
          if (obj.model) {
            const spoofHit = pairs.find((p) => p.spoof === obj.model);
            if (spoofHit) {
              // 已知 spoof → 改写为该对的 target。
              obj.model = spoofHit.target;
              currentTarget = spoofHit.target;
              rewritten = obj.model;
            } else if (pairs.some((p) => p.target === obj.model)) {
              // 已是某对的 target → 原样直传，currentTarget 即它本身。
              currentTarget = obj.model;
            } else {
              // 未知 model：不静默改写，直接 400 报错。客户端发的 model 必须显式等于
              // 某个配置对的 spoof 或 target，否则会在不知情的情况下被改写。
              const legal = [...new Set(pairs.flatMap((p) => [p.spoof, p.target]))].join(', ');
              log(`  rejected unknown model: ${obj.model}`);
              clientRes.writeHead(400, { 'Content-Type': 'application/json' });
              clientRes.end(JSON.stringify({
                type: 'error',
                error: {
                  type: 'invalid_request_error',
                  message: `cc-bridge (${adapter.name}): unknown model "${obj.model}". Configured models: ${legal}. Edit ~/.cc-bridge/${adapter.name}.env (MODEL_MAP), or switch Claude Code to a configured model.`,
                },
              }));
              return;
            }
          }
          // 在 model 改写之后调用 adapter 做上游专属请求体适配。
          adapter.adaptRequestBody(obj, { target: currentTarget });
          // 会话标题提示词语言示例修正：把客户端提示词里的韩语示例替换为中文示例
          //（见 TITLE_PROMPT_LANG_FIXES），避免中文会话标题被模型照抄韩语示例。
          fixTitlePromptLanguage(obj);
          body = Buffer.from(JSON.stringify(obj), 'utf-8');
          // 受 PROXY_DUMP=1 控制：dump 改写后的请求体（用于验证适配是否生效）。
          // 注：dump 记录的是 adapter 改写后、KEY 级处理前的形态——API_KEY_n_HIDE_USER_ID
          // 的 user_id 清空发生在稍后的 send(keyIdx)（KEY 选定才知道该不该清），dump 里
          // 仍显示原值属预期，实际转发体已按当前 KEY 处理。
          if (process.env.PROXY_DUMP === '1' || cfg.DUMP) {
            try {
              // dump 目录跟随配置文件（默认 ~/.cc-bridge/dumps），与 log / pid 同处，
              // 不写到项目目录。用 path.dirname(cfg.configPath) 派生，兼容 $CC_BRIDGE_CONFIG 覆盖。
              const dumpDir = path.join(path.dirname(cfg.configPath), 'dumps');
              fs.mkdirSync(dumpDir, { recursive: true });
              const ts = new Date().toISOString().replace(/[:.]/g, '-');
              const safeTarget = (currentTarget || 'unknown').replace(/[\/]/g, '-');
              const dumpFile = path.join(dumpDir, `${ts}-rewritten-${safeTarget}.json`);
              fs.writeFileSync(dumpFile, JSON.stringify(obj, null, 2));
              log(`  dumped rewritten request → ${dumpFile}`);
            } catch (e) {
              log(`  dump failed: ${e.message}`);
            }
          }
        } catch {
          // Not JSON / unparseable — forward the original body untouched.
        }
      }

      // Curate forwarded headers. The bridge sends x-api-key + anthropic-version per
      // attempt (the key itself rotates per attempt; host follows that key's endpoint).
      // content-length 必须跟「本次实际发送的请求体」：常规转发是闭包的 body，
      // 断流续写是更长的 contBodyBuf（2026-08-30 实测：不覆盖时上游按原 body 长度
      // 截断续写体，报 422 json_invalid）——故加可选参 sendBody，默认 body。
      const buildHeaders = (apiKey, keyUp, sendBody) => {
        const headers = {};
        for (const [k, v] of Object.entries(clientReq.headers)) {
          if (DROP_HEADERS.has(k.toLowerCase())) continue;
          headers[k] = v;
        }
        headers['host'] = keyUp.host;
        headers['x-api-key'] = apiKey;
        if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
        const b = sendBody || body;
        headers['content-length'] = String(b.length);
        return headers;
      };

      // 处理「已落到客户端的上游响应」：重试 / 换 KEY 窗口（建连 / 拿到首个上游
      // 响应前）已过，后续 stream / non-stream 改写都不再切换。
      function handleUpstreamResponse(upRes) {
        // 双保险：本请求已有响应在处理（responseStarted）或响应头已发给客户端
        // （headersSent）时，绝不能再次 writeHead——否则 ERR_HTTP_HEADERS_SENT
        // 未捕获异常会打死整个 daemon（2026-08-16 前 glm 27 次 / ds 9 次崩溃的
        // 根因）。丢弃本次迟到的上游响应、断开客户端即可。
        if (responseStarted || clientRes.headersSent) {
          log(`  ← ${upRes.statusCode}  丢弃迟到响应（响应已开始转发，不二次写头），补发 SSE error 事件收尾`);
          try { upRes.destroy(); } catch { /* already gone */ }
          abortWithSseError('late response discarded');
          return;
        }
        responseStarted = true;
        log(`  ← ${upRes.statusCode}  ${Date.now() - t0}ms  ct=${upRes.headers['content-type'] || '-'}  key=${currentKeyName || '#' + (currentKey + 1)}`);

        // 如果配置了 contextWindow / maxOutputTokens，注入 modelUsage 到响应，
        // 让 CLI 把正确的上下文窗口传给 webview；没配则 mu 为 null、不注入。
        // 注意：统计（recordUsage）与注入解耦——即便不注入，仍要走下面的解析
        // 路径提取 usage 累计（否则 cc-bridge stats 永远没有数据）。
        const mu = isMessages ? buildModelUsage() : null;

        if (stream) {
          // Streaming: intercept SSE events, inject modelUsage into message_delta.
          const streamHeaders = { ...upRes.headers };
          delete streamHeaders['content-length'];  // chunked encoding, no fixed length
          streamHeaders['transfer-encoding'] = 'chunked';
          clientRes.writeHead(upRes.statusCode || 502, streamHeaders);
          // SSE 事件感知状态（断流续写靠它知道「已转发了什么」）：
          //   nextBlockIndex —— 下一个要分配的 content_block 编号（原流从上游来，
          //     续写流由桥接继续递增分配）。
          //   partialText —— 正在转发的 text 块累计文本（断流时拼进 prefill）。
          //   toolBuffer —— tool_use 块缓冲：整个事件（event 行 + data 行 + 事件
          //     间空行）逐行攒着，content_block_stop 事件收全后按上游原始顺序一次性
          //     转发给 CC。半截 tool JSON 落到 CC 无意义（它要等完整 JSON 才能执行），
          //     且断流时半截块既拼不进 prefill 也撤不回——缓冲完整再发，断流损失为零。
          //   seenBodyBlock —— 是否已转发过正文块（text / tool_use），决定断流时
          //     走续写（true）还是让 CC 自动重试（false）。
          //   forwarded —— 已写给 CC 的正文文本累计（prefill 依据，含 partialText）。
          const sseState = {
            nextBlockIndex: 0,
            partialText: '',
            toolBuffer: null, // { index, lines } —— 整事件的原始行（event/data/空行）
            seenBodyBlock: false,
            // 本流已被放弃（断流续写接管 / SSE error 收尾后）：转发循环停止写、
            // 销毁上游流。防 write-after-end（2026-08-30 断流续写实测抓到）。
            abandoned: false,
          };
          sseStateRef = sseState; // 回填请求级引用，供续写流接入读块编号 / partialText
          let sseBuf = '';
          let pendingEvent = '';
          // event: 行延迟写出：先暂存，等同一事件的 data: 行 / 空行到达再按序写出
          //（或 tool_use 识别后连它一起扣进 toolBuffer）。原因：tool_use 要到
          // content_block_start 的 data 行才能识别，若 event: 行已实时透传，CC 会
          // 收到「无 data 的悬空 event 行」，缓冲的 data 行补发时又缺事件间空行
          // 分隔——按 SSE 规范多行 data 以换行拼成单事件，JSON.parse 必然失败
          //（2.15.0 "JSON Parse error" 根因，2.15.1 修复）。非 tool_use 路径各字
          // 节仍按原顺序写出，与实时透传逐字节一致，只是写入时机推迟到事件边界。
          let pendingEventLine = null;
          const flushEventLine = () => {
            if (pendingEventLine !== null) { clientRes.write(pendingEventLine + '\n'); pendingEventLine = null; }
          };
          // TextDecoder stream 模式处理跨 chunk 的 UTF-8 多字节字符（中文 3 字节/字），
          // 避免 chunk 边界切断中文字符产生 U+FFFD 乱码（单 chunk toString 会丢字节）。
          const decoder = new TextDecoder('utf-8');
          // 上游静默看门狗：正文期断流全是「静默 15s → 网关 RST」，桥接 12s 先行
          // 判定、立即续写（省 3s，且不等 RST）。只在正文已开始转发后武装；每收
          // 到字节刷新。思考期（未转发正文）不武装——那段的断流由 CC 自动重试
          // 消化，桥接提前介入反而剥夺 CC 的重试。
          const armIdleWatchdog = () => {
            if (!sseState.seenBodyBlock) return; // 正文未开始，交给 CC
            if (idleWatchdog) clearTimeout(idleWatchdog);
            if (continuation.recovering) return; // 续写重连期静默属预期
            idleWatchdog = setTimeout(() => {
              idleWatchdog = null;
              if (clientRes.writableEnded || clientRes.destroyed) return;
              log(`  上游静默 ${UP_IDLE_TIMEOUT_MS}ms（正文期），主动断流续写${streamDiag()}`);
              try { upRes.destroy(); } catch { /* already gone */ }
              continueInterrupted('upstream idle ' + UP_IDLE_TIMEOUT_MS + 'ms');
            }, UP_IDLE_TIMEOUT_MS);
          };
          const disarmIdleWatchdog = () => {
            if (idleWatchdog) { clearTimeout(idleWatchdog); idleWatchdog = null; }
          };
          upRes.on('data', (chunk) => {
            // 刷新断流诊断计数（idle / 累计字节），见变量声明处说明。
            lastUpDataAt = Date.now();
            upBytes += chunk.length;
            // 防御：客户端响应已结束 / 已断开（如中途断连已补发 SSE error 收尾 / 续写
            // 已接管）时，不再往 clientRes 写（write after end 会抛
            // ERR_STREAM_WRITE_AFTER_END），直接丢弃上游残留数据并断开源流。
            if (clientRes.destroyed || clientRes.writableEnded || sseState.abandoned) {
              sseState.abandoned = true;
              try { upRes.destroy(); } catch { /* already gone */ }
              return;
            }
            sseBuf += decoder.decode(chunk, { stream: true });
            let nl;
            while ((nl = sseBuf.indexOf('\n')) >= 0) {
              const line = sseBuf.slice(0, nl);
              sseBuf = sseBuf.slice(nl + 1);
              // --- 块状态跟踪（断流续写的依据，只观测不改写转发内容） -------------
              // text 块：content_block_start/delta 照常实时转发（体验不变），
              // delta 的文本顺带累计进 partialText（断流时拼 prefill）。
              // tool_use 块：start/delta 攒进 toolBuffer 不转发，content_block_stop
              // 时一次性转发缓冲的全部行——半截 tool JSON 对 CC 无用，缓冲完整再
              // 发，断流零损失（详见 sseState.toolBuffer 声明处注释）。
              try {
                if (pendingEvent.includes('content_block_start')) {
                  const data = JSON.parse(line.slice(5).trim());
                  if (data.content_block && data.content_block.type === 'tool_use') {
                    // 从 event 行起攒整个事件（event 行 + data 行），后续 delta 事件
                    // 与事件间空行一并入缓冲（见 pendingEventLine 声明处说明）。
                    sseState.toolBuffer = {
                      index: data.index,
                      lines: [pendingEventLine, 'data: ' + JSON.stringify(data)].filter((l) => l !== null),
                    };
                    pendingEventLine = null;
                    sseState.nextBlockIndex = Math.max(sseState.nextBlockIndex, data.index + 1);
                    sseState.seenBodyBlock = true;
                    continue; // 不转发，等收全
                  }
                  if (data.content_block && data.content_block.type === 'text') {
                    sseState.partialText = '';
                    sseState.nextBlockIndex = Math.max(sseState.nextBlockIndex, data.index + 1);
                    sseState.seenBodyBlock = true;
                  }
                } else if (pendingEvent.includes('content_block_delta')) {
                  const data = JSON.parse(line.slice(5).trim());
                  if (sseState.toolBuffer && data.index === sseState.toolBuffer.index) {
                    if (pendingEventLine !== null) sseState.toolBuffer.lines.push(pendingEventLine);
                    pendingEventLine = null;
                    sseState.toolBuffer.lines.push('data: ' + JSON.stringify(data));
                    continue; // tool_use 的 delta 攒着（event 行一并入缓冲）
                  }
                  if (data.delta && typeof data.delta.text === 'string') {
                    sseState.partialText += data.delta.text;
                  }
                } else if (pendingEvent.includes('content_block_stop')) {
                  const data = JSON.parse(line.slice(5).trim());
                  if (sseState.toolBuffer && data.index === sseState.toolBuffer.index) {
                    // tool_use 收全：按上游原始顺序一次性转发缓冲的全部行（各事件的
                    // event 行 + data 行 + 空行都在），再补本条 stop 事件的 event 行与
                    // data 行；stop 事件结尾的空行随后到达时走正常路径，事件完整。
                    for (const buffered of sseState.toolBuffer.lines) {
                      clientRes.write(buffered + '\n');
                    }
                    // 完整 tool_use 块记入续写 prefill 素材（input 已在 start+deltas 里）。
                    try {
                      // 缓冲里混有 event 行与空行，只取 data 行解析。
                      const dataLines = sseState.toolBuffer.lines.filter((l) => l.startsWith('data:'));
                      const start = JSON.parse(dataLines[0].slice(5).trim());
                      // partial_json 拼接成完整 input：GLM 实测整段 JSON 放单条
                      // partial_json，但规范允许多条分片——先把所有分片按序拼成
                      // 一个字符串再 parse，天然覆盖两种形态。
                      let json = '';
                      for (const l of dataLines.slice(1)) {
                        const d = JSON.parse(l.slice(5).trim());
                        if (d.delta && typeof d.delta.partial_json === 'string') json += d.delta.partial_json;
                      }
                      let input = {};
                      try { input = JSON.parse(json); } catch { /* 上游给的拼不完整，尽力而为 */ }
                      continuation.blocks.push({
                        type: 'tool_use',
                        id: start.content_block.id,
                        name: start.content_block.name,
                        input,
                      });
                    } catch { /* prefill 素材尽力积累，失败不影响转发 */ }
                    flushEventLine(); // 写出 stop 事件自己的 event: 行
                    clientRes.write(line + '\n');
                    pendingEvent = '';
                    sseState.toolBuffer = null;
                    continue;
                  }
                  if (sseState.partialText) {
                    // text 块收全：完整文本记入续写 prefill 素材，清空累计。
                    continuation.blocks.push({ type: 'text', text: sseState.partialText });
                    sseState.partialText = '';
                  }
                }
              } catch { /* 块跟踪解析失败不影响原样转发 */ }
              if (line.startsWith('event:')) {
                // 不立即写出：暂存到事件边界再发（见 pendingEventLine 声明处说明）。
                // 防御：连续两条 event 行（无 data 的事件紧挨着）时按序补发前一条，防丢。
                if (pendingEventLine !== null) clientRes.write(pendingEventLine + '\n');
                pendingEvent = line;
                pendingEventLine = line;
              } else if (line.startsWith('data:') && pendingEvent.includes('message_delta')) {
                // message_delta 的 usage 是输出侧统计（output_tokens，部分上游还带
                // cache_creation_input_tokens）：Anthropic 规范里 message_start 的
                // usage 只含输入侧、output_tokens 恒为 0——真实输出数在流末尾的
                // delta 才返回，必须在这里补累计，否则 cc-bridge stats 的 output
                // 恒为 0（DeepSeek 兼容端点即如此；z.ai 不规范、反而在 start 就返回）。
                // 统计与注入解耦：无论 mu 是否为空都解析提取 usage 累计。
                // 注入 modelUsage 到 message_delta data（仅当 mu 非空；空则原样转发）。
                // 同时确保 total_cost_usd 存在（webview 只在 total_cost_usd 存在时才读
                // modelUsage；非官方上游可能省略它）。
                let out = line;
                try {
                  const data = JSON.parse(line.slice(5).trim());
                  recordUsage(currentTarget, currentKeyName, data.usage, true, msgStartBase);
                  msgStartBase = null; // delta 每请求只来一次，用后即弃防重复回退
                  // 缓存命中观测：DS 等转换流的真实缓存信息只在 delta 返回，
                  // 与 message_start 的旁路观测互补（Anthropic 规范上游的 delta
                  // 无缓存字段，不会打日志）。
                  if (data.usage &&
                      (data.usage.cache_read_input_tokens != null || data.usage.cache_creation_input_tokens != null)) {
                    const cu = formatCacheUsage(data.usage);
                    if (cu) log('  ' + cu);
                  }
                  if (mu) {
                    data.modelUsage = mu;
                    if (data.total_cost_usd === undefined) data.total_cost_usd = 0;
                    out = 'data: ' + JSON.stringify(data);
                  }
                } catch { /* parse 失败原样转发 */ }
                flushEventLine();
                clientRes.write(out + '\n');
                pendingEvent = '';
              } else if (line.startsWith('data:') && pendingEvent.includes('message_start')) {
                // 缓存命中观测：从 message_start 的 message.usage 提取缓存命中数。
                // 不改写内容，记日志后原样转发（usage 透传给客户端，这里只是旁路观测）。
                // 同一份 usage 同时累计进按模型统计（recordUsage），供 cc-bridge stats 读取。
                try {
                  const data = JSON.parse(line.slice(5).trim());
                  const u = data.message && data.message.usage;
                  // 先快照再累计：供 message_delta 用真实 usage 回退本请求的估算输入
                  //（models / keys 两张表各一份快照）。
                  const snap = (b) => b
                    ? { inputTokens: b.inputTokens, cacheHitTokens: b.cacheHitTokens, cacheCreatedTokens: b.cacheCreatedTokens }
                    : null;
                  const hb = hourBucket(hourKeyNow());
                  const m0 = currentTarget && hb.models[currentTarget];
                  const k0 = currentKeyName && hb.keys[currentKeyName];
                  msgStartBase = { models: snap(m0), keys: snap(k0) };
                  recordUsage(currentTarget, currentKeyName, u);
                  const cu = formatCacheUsage(u);
                  if (cu) log('  ' + cu);
                } catch {}
                flushEventLine();
                clientRes.write(line + '\n');
                pendingEvent = '';
              } else if (line.trim() === '') {
                // 事件边界空行：tool_use 缓冲进行中则空行随事件入缓冲（保持缓冲内
                // 事件完整）；否则按序补发暂存的 event 行后转发空行，事件收口。
                if (sseState.toolBuffer) {
                  if (pendingEventLine !== null) { sseState.toolBuffer.lines.push(pendingEventLine); pendingEventLine = null; }
                  sseState.toolBuffer.lines.push('');
                } else {
                  flushEventLine();
                  clientRes.write(line + '\n');
                }
                pendingEvent = '';
              } else {
                flushEventLine();
                clientRes.write(line + '\n');
              }
            }
            armIdleWatchdog();
          });
          upRes.on('end', () => {
            disarmIdleWatchdog();
            stopKeepalive();
            sseBuf += decoder.decode();  // flush 剩余字节（正常为空）
            if (clientRes.destroyed || clientRes.writableEnded) return; // 已补发 error 收尾，不再写
            if (sseBuf.trim()) clientRes.write(sseBuf);
            clientRes.end();
          });
          upRes.on('error', (err) => {
            disarmIdleWatchdog();
            log(`  upstream 流错误：${err && err.message}${streamDiag()}`);
            // 静默看门狗主动 destroy 后随之而来的 error（ECONNRESET 等）是预期回声，
            // 续写已由看门狗发起，不要重复触发。
            if (continuation.recovering) return;
            // 正文期断流走续写（不向 CC 报错）；思考期断流维持 SSE error 收尾
            //（CC 自动重试）。
            if (sseState.seenBodyBlock && !clientRes.writableEnded && !clientRes.destroyed) {
              continueInterrupted(err && err.message);
            } else {
              abortWithSseError(err && err.message);
            }
          });
        } else {
          // Non-streaming: buffer JSON, record usage, inject modelUsage (when mu), send.
          const respChunks = [];
          upRes.on('data', (c) => respChunks.push(c));
          upRes.on('end', () => {
            const raw = Buffer.concat(respChunks).toString('utf-8');
            try {
              const respBody = JSON.parse(raw);
              // 统计无条件：与是否注入 modelUsage 无关。
              recordUsage(currentTarget, currentKeyName, respBody.usage);
              const cu = formatCacheUsage(respBody.usage);
              if (cu) log('  ' + cu);
              if (mu) {
                respBody.modelUsage = mu;
                if (respBody.total_cost_usd === undefined) respBody.total_cost_usd = 0;
              }
              const modified = JSON.stringify(respBody);
              const hdrs = { ...upRes.headers, 'content-length': String(Buffer.byteLength(modified)) };
              delete hdrs['transfer-encoding'];
              clientRes.writeHead(upRes.statusCode || 200, hdrs);
              clientRes.end(modified);
            } catch {
              // Parse failed — forward original.
              clientRes.writeHead(upRes.statusCode || 502, upRes.headers);
              clientRes.end(raw);
            }
          });
        }
      }

      // --- 多 KEY failover -------------------------------------------------
      // tried 记录本轮请求已经试过的 KEY 索引，避免对同一 KEY 反复试导致死循环。
      // currentKey 是当前要用的 KEY 索引；attemptInKey 是当前 KEY 的第几次重试。
      const tried = new Set();
      let currentKey = -1;
      let attemptInKey = 0;
      let t0 = Date.now(); // 当前 attempt 的起始时间；每次重试 / 换 KEY 会重置

      // 从 startIdx 起找下一个可用的 KEY：优先「未试过且未熔断」；若未试过的都
      // 熔断了，退而取「未试过」的第一个（熔断只是优化、不是硬约束，总得试一个）；
      // 全试过了返回 -1。
      function pickNextKey() {
        for (let i = 0; i < KEYS.length; i++) {
          if (!tried.has(i) && Date.now() >= keyBlockedUntil[i]) return i;
        }
        for (let i = 0; i < KEYS.length; i++) {
          if (!tried.has(i)) return i;
        }
        return -1;
      }

      // 所有 KEY 都试遍仍失败：把最后的错误返回给客户端。
      function finalError(last) {
        if (clientRes.headersSent) { try { clientRes.destroy(); } catch {} return; }
        const status = last && last.status ? last.status : 502;
        let msg;
        if (last && last.err) {
          msg = `upstream error on all ${KEYS.length} key(s): ${last.err.message}`;
        } else if (last && last.status) {
          msg = `upstream returned ${last.status} on all ${KEYS.length} key(s)`;
        } else {
          msg = 'upstream error';
        }
        clientRes.writeHead(status, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({
          type: 'error',
          error: {
            type: (status === 401 || status === 403) ? 'authentication_error' : 'api_error',
            message: msg,
          },
        }));
      }

      let activeUpReq = null;
      clientReq.on('error', () => { if (activeUpReq) { try { activeUpReq.destroy(); } catch {} } });

      function send(keyIdx) {
        t0 = Date.now();
        const keyUp = keyUpstreams[keyIdx];
        currentKeyName = KEYS[keyIdx].name;
        // 隐私选项（按 KEY）：该 KEY 配了 HIDE_USER_ID=1 时清空 metadata.user_id（设备 /
        // 会话标识），其余 KEY 原样透传。在 KEY 选定处做（而非解析处），KEY 轮换 / 容灾
        // 切换后行为跟着当前 KEY 走。
        if (obj && KEYS[keyIdx].hideUserId && obj.metadata && 'user_id' in obj.metadata) {
          obj.metadata.user_id = '';
          body = Buffer.from(JSON.stringify(obj), 'utf-8');
        }
        const upPath = keyUp.pathname.replace(/\/+$/, '') + clientReq.url;
        log(
          `${clientReq.method} ${clientReq.url}  ` +
          `model=${modelIn || '-'}${rewritten ? ' → ' + rewritten : ' (passthrough)'}  ` +
          `effort=${effort || '-'}  stream=${stream}  key=${KEYS[keyIdx].name}/${KEYS.length}` +
          (KEYS.length > 1 || cfg.API_BASES.length > 1 ? `  base=${KEYS[keyIdx].baseName || 'default'}` : '') +
          (KEYS[keyIdx].hideUserId ? '  user_id=hidden' : ''),
        );

        // adapter 接管路径：adapter 实现了 makeUpstreamCall 时，由 adapter 全权处理
        // 请求格式转换、上游调用、响应格式转回（如 DeepSeek：Anthropic → OpenAI →
        // Anthropic，绕开其 Anthropic 端点的并发 tool_use 限制）。
        if (typeof adapter.makeUpstreamCall === 'function' && isMessages) {
          adapter.makeUpstreamCall({
            apiKey: KEYS[keyIdx].value,
            anthropicBody: obj,
            stream,
            log,
          }).then((adapterRes) => {
            // 构造一个模拟的 http.IncomingMessage 给 handleUpstreamResponse
            const { PassThrough } = require('stream');
            const fakeRes = new PassThrough();
            fakeRes.statusCode = adapterRes.status || 200;
            fakeRes.headers = adapterRes.headers || {};
            if (adapterRes.stream) {
              // 流式：adapter 返回的 stream pipe 到 fakeRes
              adapterRes.stream.pipe(fakeRes);
            } else {
              // 非流式：直接写入 body
              fakeRes.end(adapterRes.body || Buffer.alloc(0));
            }
            handleUpstreamResponse(fakeRes);
          }).catch((errInfo) => {
            const status = (errInfo && errInfo.status) || 502;
            const err = (errInfo && errInfo.err) || errInfo;
            const canRetry = attemptInKey < UPSTREAM_RETRY_DELAYS.length;

            if (isKeyError(status)) {
              keyBlockedUntil[keyIdx] = Date.now() + KEY_BLOCK_SECONDS * 1000;
              log(`  ← ${status}  key=#${keyIdx + 1} 认定失效 / 欠费，熔断 ${KEY_BLOCK_SECONDS}s 并切换`);
              tried.add(keyIdx);
              attemptInKey = 0;
              currentKey = pickNextKey();
              if (currentKey === -1) return finalError({ status });
              send(currentKey);
              return;
            }
            if (isTransient(err, status) && canRetry) {
              const delay = UPSTREAM_RETRY_DELAYS[attemptInKey];
              log(`  ← ${status} adapter 瞬态错误（${Date.now() - t0}ms），${delay}ms 后重试`);
              attemptInKey++;
              setTimeout(() => send(keyIdx), delay);
              return;
            }
            if (isTransient(err, status)) {
              log(`  ← ${status} adapter 同 KEY 重试用尽，切换下一个 KEY`);
              tried.add(keyIdx);
              attemptInKey = 0;
              currentKey = pickNextKey();
              if (currentKey === -1) return finalError({ status });
              send(currentKey);
              return;
            }
            finalError({ status, err });
          });
          return;
        }

        // 默认路径：直接透传 Anthropic 请求体到上游（端点随 KEY：KEYS[keyIdx].base，
        // 协议随端点 scheme：http/https）
        const transport = transportFor(keyUp);
        const opts = {
          hostname: keyUp.hostname,
          port: keyUp.port || (keyUp.protocol === 'http:' ? 80 : 443),
          path: upPath,
          method: clientReq.method,
          headers: buildHeaders(KEYS[keyIdx].value, keyUp),
        };
        activeUpReq = transport.request(opts, (upRes) => {
          // 出站 socket 开 TCP keepalive：长流（SSE 数十分钟）期间若 TCP 层无数据
          // 往返，部分中间设备（运营商 NAT / 负载均衡）会把「静默」连接当死连接
          // RST 掉。keepalive 探测包让连接始终保持活性证据，降低被中途掐断的
          // 概率（ECONNRESET 在长流高发、缓解而非根治——服务端仍可能主动回收）。
          activeUpReq.setSocketKeepAlive(true, 15000);
          const status = upRes.statusCode || 502;
          const canRetry = attemptInKey < UPSTREAM_RETRY_DELAYS.length;

          // KEY 级错误：熔断此 KEY，立即换下一个 KEY（不退避，这 KEY 死了等也没用）。
          if (isKeyError(status)) {
            keyBlockedUntil[keyIdx] = Date.now() + KEY_BLOCK_SECONDS * 1000;
            log(`  ← ${status}  key=#${keyIdx + 1} 认定失效 / 欠费，熔断 ${KEY_BLOCK_SECONDS}s 并切换`);
            upRes.resume();
            tried.add(keyIdx);
            attemptInKey = 0;
            currentKey = pickNextKey();
            if (currentKey === -1) return finalError({ status });
            send(currentKey);
            return;
          }

          // 瞬态错误 + 还能重试：同 KEY 退避重试。
          if (isTransient(null, status) && canRetry) {
            const delay = UPSTREAM_RETRY_DELAYS[attemptInKey];
            log(`  ← ${status} 瞬态响应（${Date.now() - t0}ms），${delay}ms 后同 KEY 重试`);
            upRes.resume();
            attemptInKey++;
            setTimeout(() => send(keyIdx), delay);
            return;
          }

          // 瞬态错误但同 KEY 重试用尽：换下一个 KEY 再来一轮。
          if (isTransient(null, status)) {
            log(`  ← ${status} 同 KEY 重试用尽，切换下一个 KEY`);
            upRes.resume();
            tried.add(keyIdx);
            attemptInKey = 0;
            currentKey = pickNextKey();
            if (currentKey === -1) return finalError({ status });
            send(currentKey);
            return;
          }

          // 成功，或非瞬态业务错误（400/404 等，换 KEY 也无用）：正常处理。
          handleUpstreamResponse(upRes);
        });

        activeUpReq.on('error', (err) => {
          // 响应已开始转发后收到的迟到错误（典型：长流中途被上游掐断，ECONNRESET
          // 落在请求级 error 而非响应流 error）——重试会拿到第二个 200、对同一
          // clientRes 二次 writeHead 打死 daemon（2026-08-16 前的崩溃根因），不能
          // 重试。改为向流内补发 SSE error 事件（overloaded_error）后干净收尾：
          // CC ≥2.1.199 对流内错误事件自动重试整轮，任务不中断（替代原先硬掐 TCP
          // ——硬掐时 CC 端显示 "Connection closed mid-response" 并停轮等人工）。
          if (responseStarted || clientRes.headersSent) {
            log(`  upstream 迟到错误（响应已开始转发，不重试）：${err.message}（${Date.now() - t0}ms）${streamDiag()}，补发 SSE error 事件收尾（CC 将自动重试）`);
            abortWithSseError(err.message);
            return;
          }
          const canRetry = attemptInKey < UPSTREAM_RETRY_DELAYS.length;
          if (isTransient(err) && canRetry) {
            const delay = UPSTREAM_RETRY_DELAYS[attemptInKey];
            log(`  upstream 瞬态错误：${err.message}（${Date.now() - t0}ms），${delay}ms 后同 KEY 重试`);
            attemptInKey++;
            setTimeout(() => send(keyIdx), delay);
            return;
          }
          // 同 KEY 用尽或非瞬态网络错误：换下一个 KEY 兜底。
          log(`  upstream 错误：${err.message}（${Date.now() - t0}ms），切换下一个 KEY`);
          tried.add(keyIdx);
          attemptInKey = 0;
          currentKey = pickNextKey();
          if (currentKey === -1) return finalError({ err });
          send(currentKey);
        });

        if (body.length) activeUpReq.write(body);
        activeUpReq.end();
      }

      // 开门第一发：从首个可用 KEY 起步。
      currentKey = pickNextKey();
      if (currentKey === -1) {
        finalError({});
        return;
      }
      send(currentKey);
    });

    clientReq.on('error', () => {
      if (!clientRes.headersSent) clientRes.destroy();
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[bridge] port ${PORT} already in use. Run 'cc-bridge stop' or change PROXY_PORT.`);
    } else {
      console.error('[bridge] server error:', err.message);
    }
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[bridge] listening on http://127.0.0.1:${PORT}`);
    console.log(`[bridge] upstream     : ${adapter.displayName}`);
    if (cfg.API_BASES.length > 1) {
      console.log(`[bridge] api bases    : ${cfg.API_BASES.map((b) => `${b.name}=${b.url}`).join('   |   ')}`);
    } else {
      console.log(`[bridge] api base     : ${apiBase}`);
    }
    console.log(`[bridge] spoof → target : ${pairs.map((p) => `${p.spoof} → ${p.target}`).join('   |   ')}`);
    console.log(`[bridge] API keys     : ${KEYS.map((k) => k.name).join(', ')}`);
    console.log(`[bridge] logging      : ${VERBOSE ? 'on' : 'off'}`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      maybeFlushStats(true);  // 退出前强制落盘，补上最后一段统计
      console.log(`\n[bridge] ${sig} received, shutting down`);
      process.exit(0);
    });
  }

  // 进程级兜底：daemon 是长驻后台进程，任何未预见的同步异常 / 未处理 rejection
  // 默认会打死整个进程、桥上所有请求断流（历史上 ERR_HTTP_HEADERS_SENT 即如此，
  // 2026-08-16 前 glm 崩 27 次 / ds 崩 9 次）。本地代理各请求状态互相隔离，单个
  // 异常不污染其它请求——记完整堆栈进 daemon 日志（供排障），继续运行；仅统计
  // 落盘不受影响（每 30s 节流 + 退出前 flush 照常）。
  process.on('uncaughtException', (err) => {
    console.error(`[bridge ${new Date().toISOString()}] uncaughtException（已兜底，daemon 继续运行）:`, err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`[bridge ${new Date().toISOString()}] unhandledRejection（已兜底，daemon 继续运行）:`, reason);
  });

  return server;
}

// Allow `node core/server.js` (used by daemon/claude spawn). Upstream comes from
// $CC_BRIDGE_UPSTREAM, else the user-set default (~/.cc-bridge/default-upstream),
// else the built-in default. Loads config from $CC_BRIDGE_CONFIG or the
// per-upstream default, validates, then starts.
if (require.main === module) {
  const { getDefaultUpstream, loadAdapter } = require('./adapter');
  const { loadConfig, validate } = require('./config');
  const upstream = process.env.CC_BRIDGE_UPSTREAM || getDefaultUpstream();
  let adapter;
  try {
    adapter = loadAdapter(upstream);
  } catch (e) {
    console.error(`[bridge] ${e.message}`);
    process.exit(1);
  }
  const cfg = loadConfig({ upstream });
  const missing = validate(cfg);
  if (missing.length) {
    console.error(`[bridge] missing required config: ${missing.join(', ')}`);
    console.error(`[bridge] run 'cc-bridge ${upstream} config' to edit ${cfg.configPath}`);
    process.exit(1);
  }
  startServer(cfg, adapter);
}

module.exports = { startServer };
