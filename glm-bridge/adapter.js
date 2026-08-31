'use strict';

// GLM 上游适配器（z.ai 国际版 / 智谱国内版 bigmodel.cn）—— Claude Code ↔ GLM 桥接的上游专属逻辑。
// 框架层（core/server.js）按统一 adapter 接口调用本文件。新增其它上游（Kimi、Qwen…）
// 时，在各自的 <name>-bridge/adapter.js 实现同一接口即可，无需改动 core/。
//
// 透传原则（2026-08-22 T4）：除 model 改写与 max_tokens 钳制外，请求体与 CC 直连官方
// 端点的形态一致——context_management / cache_control / Anthropic 专有 system 段 /
// metadata.user_id / 思考字段全部原样透传（端点对不识别的字段按忽略处理；cache_control
// 智谱端点按显式缓存切分点使用、z.ai 按隐式前缀缓存忽略标记，透传在两种端点下都不劣）。
// user_id 的按 KEY 隐私选项在框架层处理（见 core/server.js 与 API_KEY_n_HIDE_USER_ID）。

// GLM 系列模型的最大输出 token 上限（来自 GLM 官方文档）。用于把 Claude Code 设的
// max_tokens 钳到目标模型的合法范围，避免过大请求被上游拒绝。
const MODEL_MAX_TOKENS = {
  'glm-5.3': 131072,
  'glm-5.3-flash': 131072,
  'glm-5.2': 131072,
  'glm-5.1': 131072,
  'glm-5-turbo': 131072,
  'glm-5v-turbo': 131072,
  'glm-5': 131072,
  'glm-4.7': 131072,
  'glm-4.6': 131072,
  'glm-4.5': 98304,
  'glm-4.5-air': 98304,
  'glm-4.5-x': 98304,
  'glm-4.5-airx': 98304,
  'glm-4.5-flash': 98304,
};

// GLM 系列模型的上下文窗口（来自 GLM 官方文档各模型页，2026-08-31 查证：
// 5.3 / 5.3-Flash / 5.2 = 1M；5.1 / 5 / 5-Turbo / 5V-Turbo / 4.7 / 4.6 = 200K；
// 4.5 系 = 128K）。用于 modelUsage 注入兜底：未显式配 CONTEXT_WINDOW 时按请求的
// target 注入真实窗口——CC 对非官方 base URL 只按内置表猜窗口（claude-opus-4-8 被
// 降级按 200K 保底判断），长会话会在 CC 本地预检被误拒「Prompt is too long」而上游
// 真实 1M 完全装得下。标称 K/M 按十进制换算（1M=1000000），较 2^N 取值（1048576）
// 略保守：宁可 CC 早一点压缩，不让预检放行后被上游拒。
const MODEL_CONTEXT_WINDOW = {
  'glm-5.3': 1000000,
  'glm-5.3-flash': 1000000,
  'glm-5.2': 1000000,
  'glm-5.1': 200000,
  'glm-5-turbo': 200000,
  'glm-5': 200000,
  'glm-5v-turbo': 200000,
  'glm-4.7': 200000,
  'glm-4.6': 200000,
  'glm-4.5': 128000,
  'glm-4.5-air': 128000,
  'glm-4.5-x': 128000,
  'glm-4.5-airx': 128000,
  'glm-4.5-flash': 128000,
};

module.exports = {
  name: 'glm',
  // GLM 适配器可同时接 z.ai 国际版与智谱国内版（API_BASES 多端点），displayName
  // 不再钉死单一厂商，实际端点看横幅的 api bases 行。
  displayName: 'GLM (z.ai / bigmodel.cn)',
  defaultTarget: 'glm-5.3',
  defaultSpoof: 'claude-opus-4-8',
  modelMaxTokens: MODEL_MAX_TOKENS,
  modelContextWindow: MODEL_CONTEXT_WINDOW,

  // 改写 Anthropic 请求体（GLM 专属适配）。ctx = { target }。
  // 唯一改写项：钳 max_tokens 到目标模型上限（偶发超大值保护；CC 实发 64000 远低于
  // 上限、正常从不触发）。其余字段全部原样透传（见文件头「透传原则」）。
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
