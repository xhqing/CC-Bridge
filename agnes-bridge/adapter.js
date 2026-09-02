'use strict';

// Agnes AI 上游适配器 —— Claude Code ↔ Agnes 桥接的上游专属逻辑。
// 框架层（core/server.js）按统一 adapter 接口调用本文件。新增其它上游时，
// 在各自的 <name>-bridge/adapter.js 实现同一接口即可，无需改动 core/。
//
// Agnes 官方提供 Anthropic 兼容端点 POST /v1/messages（认证 x-api-key +
// anthropic-version，与框架转发头一致），支持流式 / tools / Anthropic 格式 thinking
// 字段（2026-09-01 官方文档 wiki.agnes-ai.com 查证 + 本地实测：非流式 / tools 强制
// 调用 / SSE 流式均通过）。端点在境外，通常需给桥配 UPSTREAM_PROXY 代理（见
// agnes.env.example 与 core/server.js 的代理支持）。
//
// 透传原则（同 MiMo）：除 model 改写与 max_tokens 钳制外，请求体与 CC 直连端点的
// 形态一致——context_management / cache_control / system / metadata.user_id /
// thinking 全部原样透传。user_id 的按 KEY 隐私选项在框架层处理。

// Agnes 系列模型的最大输出 token 上限（来自 Agnes 官方文档模型页 Limits 表，
// 2026-09-01 查证：2.5 系列全系 65.5K = 65536）。用于把 Claude Code 设的 max_tokens
// 钳到目标模型的合法范围，避免过大请求被上游拒绝。
const MODEL_MAX_TOKENS = {
  'agnes-2.5-flash': 65536,
  'agnes-2.5-pro': 65536,
  'agnes-2.5-pro-beta': 65536,
};

// Agnes 系列模型的上下文窗口（来自 Agnes 官方文档模型页，2026-09-01 查证：
// 2.5-flash 512K，2.5-pro / 2.5-pro-beta 1M）。用于 modelUsage 注入兜底：未显式配
// CONTEXT_WINDOW 时按请求的 target 注入真实窗口，免得 CC 按内置表把
// claude-opus-4-8 猜成 200K、长会话在本地预检被误拒。标称 K/M 按十进制换算
// （512K=512000 / 1M=1000000），较 2^N 取值略保守：宁可 CC 早一点压缩。
const MODEL_CONTEXT_WINDOW = {
  'agnes-2.5-flash': 512000,
  'agnes-2.5-pro': 1000000,
  'agnes-2.5-pro-beta': 1000000,
};

module.exports = {
  name: 'agnes',
  displayName: 'Agnes AI',
  defaultTarget: 'agnes-2.5-flash',
  defaultSpoof: 'claude-opus-4-8',
  modelMaxTokens: MODEL_MAX_TOKENS,
  modelContextWindow: MODEL_CONTEXT_WINDOW,

  // 改写 Anthropic 请求体（Agnes 专属适配）。ctx = { target }。
  // 唯一改写项：钳 max_tokens 到目标模型上限（2.5 系列 65536）。其余字段全部
  // 原样透传（见文件头「透传原则」）。
  adaptRequestBody(obj, ctx) {
    if (!obj || typeof obj !== 'object') return obj;
    const targetModel = (ctx && ctx.target) || this.defaultTarget;

    // 钳 max_tokens 到目标模型上限
    if (obj.max_tokens != null) {
      const cap = MODEL_MAX_TOKENS[targetModel];
      if (cap != null && obj.max_tokens > cap) obj.max_tokens = cap;
    }

    return obj;
  },
};
