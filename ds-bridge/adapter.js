'use strict';

// DeepSeek 上游适配器 —— Claude Code ↔ DeepSeek-V4 桥接的上游专属逻辑。
// 框架层（core/server.js）按统一 adapter 接口调用本文件。新增其它上游时，
// 在各自的 <name>-bridge/adapter.js 实现同一接口即可，无需改动 core/。
//
// DeepSeek 提供官方 Anthropic 兼容端点（base_url 为 https://api.deepseek.com/anthropic，
// 接收标准 Anthropic Messages API 格式），故本桥直接透传 Anthropic 请求体，只需做
// DeepSeek 专属的清洗与思考等级适配。兼容细节见 DeepSeek 官方文档
// 「Using the Anthropic API」一章的 compatibility 表。
//
// 历史：早期 /anthropic 端点对「同一 assistant 消息含多个 tool_use（并发工具调用）」
// 返回 400，故曾临时改走 OpenAI 兼容端点（makeUpstreamCall + core/anthropic-openai-
// converter，见 2.7.6~2.7.9 的 CHANGELOG）。2026-08 实测并发 tool_use 已放行（历史与
// 输出两个方向均 200），切回原生 Anthropic 直传路径——DeepSeek 隐式 Context Caching
// 按「完整前缀单元」匹配，直传时 system / tools / 会话历史前缀稳定，缓存命中率从转换
// 流的 ~65% 恢复到直传的 ~98%。

// DeepSeek 系列模型的最大输出 token 钳制值。DeepSeek-V4 系列（pro / flash）上下文
// 窗口 1M、单次输出能力充裕（官方未公布精确输出上限，第三方实测 v4-flash 可达 384K），
// 远超 Claude Code 单次实际输出。此处钳到 128K 为保守保护值——确保偶发的超大
// max_tokens 不触发上游拒绝，又不人为限制正常输出；需要更大输出可自行调高。
const MODEL_MAX_TOKENS = {
  'deepseek-v4-pro': 131072,
  'deepseek-v4-flash': 131072,
};

// 修复 Anthropic 消息序列中的 tool 校验问题（DeepSeek /anthropic 端点硬校验，实测
// 会 400「tool_use ids were found without tool_result blocks immediately after」）：
//   1) Claude Code 的 server tools（如 webReader，服务端执行）会把 server_tool_use 块
//      与结果 tool_result 块一并塞进同一条 assistant 消息——DeepSeek 校验器不认这种
//      结构（把 server_tool_use 当 tool_use，要求结果在「下一条消息」；且 assistant
//      消息里不允许出现 tool_result），直接 400。把 server_tool_use / 同消息
//      tool_result 展开为纯 text，保留内容、去掉 tool 语义。
//   2) 上下文压缩（/compact、自动压缩）会留下孤立 tool_use（丢掉了随后的 tool_result）：
//      从 assistant 消息剥离未配对 tool_use；反向的孤立 tool_result 一并剥离。
//   3) tool_use 块连续化：DeepSeek /anthropic 校验器对「tool_use 与 thinking/text 交错」的
//      assistant 消息会误判 tool_use 无 tool_result（400「tool_use ids were found without
//      tool_result blocks」，实测 63 个并行 tool_use 交错时 400、挪到消息末尾连续时 200）。
//      仅当存在交错时才重排，顺序稳定不影响缓存前缀。
// 说明：thinking 块空 signature 不影响 DeepSeek（不校验 signature），无需处理。
function repairToolSequence(messages) {
  if (!Array.isArray(messages)) return messages;
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') { out.push(m); continue; }
    const next = messages[i + 1];

    if (m.role === 'assistant' && Array.isArray(m.content)) {
      // 1) server_tool_use / 同消息 tool_result → text（保留内容）
      let need = false;
      const nc = m.content.map((b) => {
        if (!b || typeof b !== 'object') return b;
        if (b.type === 'server_tool_use') {
          need = true;
          return { type: 'text', text: `[server_tool_use: ${b.name || 'tool'}]` };
        }
        if (b.type === 'tool_result') {
          need = true;
          const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
          return { type: 'text', text: `[tool_result]\n${txt}` };
        }
        return b;
      });
      let content = need ? nc : m.content;

      // 2) tool_use 块连续化：存在「非 tool_use 块出现在 tool_use 之后/之间」的交错时，
      //    把全部 tool_use 挪到消息末尾（保持相对顺序），规避 DeepSeek 校验器的误判。
      let firstToolIdx = -1;
      let lastNonToolIdx = -1;
      content.forEach((b, j) => {
        if (b && b.type === 'tool_use') { if (firstToolIdx < 0) firstToolIdx = j; }
        else if (b) lastNonToolIdx = j;
      });
      if (firstToolIdx >= 0 && lastNonToolIdx >= firstToolIdx) {
        const tools = content.filter((b) => b && b.type === 'tool_use');
        content = content.filter((b) => !(b && b.type === 'tool_use')).concat(tools);
      }

      // 3) 孤立 tool_use：其 id 未被下一条消息的 tool_result 覆盖 → 剥离
      const tuIds = content
        .filter((b) => b && b.type === 'tool_use' && b.id)
        .map((b) => b.id);
      if (tuIds.length && next && typeof next === 'object' && next.role === 'user' && Array.isArray(next.content)) {
        const covered = new Set(
          next.content
            .filter((b) => b && b.type === 'tool_result' && b.tool_use_id)
            .map((b) => b.tool_use_id),
        );
        const orphan = tuIds.filter((id) => !covered.has(id));
        if (orphan.length) {
          content = content.filter((b) => !(b.type === 'tool_use' && orphan.includes(b.id)));
        }
      }
      if (content !== m.content) out.push({ ...m, content });
      else out.push(m);
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      // 4) 孤立 tool_result：其 tool_use_id 不在前一条 assistant 消息的 tool_use 里 → 剥离
      const prev = out[out.length - 1];
      const prevIds = new Set(
        (prev && prev.role === 'assistant' && Array.isArray(prev.content))
          ? prev.content
              .filter((b) => b && (b.type === 'tool_use' || b.type === 'server_tool_use') && b.id)
              .map((b) => b.id)
          : [],
      );
      const bad = new Set(
        m.content
          .filter((b) => b && b.type === 'tool_result' && b.tool_use_id != null && !prevIds.has(b.tool_use_id))
          .map((b) => b.tool_use_id),
      );
      if (bad.size) {
        out.push({ ...m, content: m.content.filter((b) => !(b.type === 'tool_result' && bad.has(b.tool_use_id))) });
      } else {
        out.push(m);
      }
    } else {
      out.push(m);
    }
  }
  return out;
}

module.exports = {
  name: 'ds',
  displayName: 'DeepSeek-V4 (api.deepseek.com)',
  defaultTarget: 'deepseek-v4-pro',
  defaultSpoof: 'claude-opus-4-8',
  modelMaxTokens: MODEL_MAX_TOKENS,

  // 改写 Anthropic 请求体（DeepSeek 专属适配）。ctx = { target }。
  // 透传原则（2026-08-22 T4）：除下述功能性改写外全部原样透传——思考字段、
  // context_management、cache_control（DeepSeek 按隐式前缀缓存忽略标记）、
  // metadata.user_id（按 KEY 隐私选项在框架层处理）、Anthropic 专有 system 段。
  // 改写项：
  //   · 修复 tool 消息序列（功能性修复：不修会触发 /anthropic 端点 400 校验）
  //   · 钳 max_tokens 到目标模型上限
  adaptRequestBody(obj, ctx) {
    if (!obj || typeof obj !== 'object') return obj;
    const targetModel = (ctx && ctx.target) || this.defaultTarget;

    // 修复 tool 消息序列（server_tool_use 展开 / 孤立 tool_use、tool_result 剥离，
    // 见 repairToolSequence 注释——不修会触发 /anthropic 端点的 400 校验）
    if (Array.isArray(obj.messages)) obj.messages = repairToolSequence(obj.messages);

    // 钳 max_tokens 到目标模型上限
    if (obj.max_tokens != null) {
      const cap = MODEL_MAX_TOKENS[targetModel];
      if (cap != null && obj.max_tokens > cap) obj.max_tokens = cap;
    }

    return obj;
  },
};
