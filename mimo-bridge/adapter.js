'use strict';

// MiMo（小米）上游适配器 —— Claude Code ↔ MiMo 桥接的上游专属逻辑。
// 框架层（core/server.js）按统一 adapter 接口调用本文件。新增其它上游时，
// 在各自的 <name>-bridge/adapter.js 实现同一接口即可，无需改动 core/。
//
// 透传原则（2026-08-22 T4）：除 model 改写与 max_tokens 钳制外，请求体与 CC 直连
// 端点的形态一致——context_management / cache_control / Anthropic 专有 system 段 /
// metadata.user_id / 思考字段（MiMo 接受 Anthropic 的 thinking enabled/disabled，透传
// 即表达开关语义）全部原样透传。user_id 的按 KEY 隐私选项在框架层处理（见
// core/server.js 与 API_KEY_n_HIDE_USER_ID）。

// MiMo 系列模型的最大输出 token 上限（来自小米 MIMO 文档）。用于把 Claude Code 设的
// max_tokens 钳到目标模型的合法范围，避免过大请求被上游拒绝。
const MODEL_MAX_TOKENS = {
  'mimo-v2.5-pro': 131072,
  'mimo-v2.5': 131072,
};

module.exports = {
  name: 'mimo',
  displayName: 'MiMo (Xiaomi)',
  defaultTarget: 'mimo-v2.5-pro',
  defaultSpoof: 'claude-opus-4-8',
  modelMaxTokens: MODEL_MAX_TOKENS,

  // 改写 Anthropic 请求体（MiMo 专属适配）。ctx = { target }。
  // 唯一改写项：钳 max_tokens 到目标模型上限（偶发超大值保护）。其余字段全部
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
