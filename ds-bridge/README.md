# DS-BRIDGE — Claude Code ↔ DeepSeek-V4 适配器

CC-Bridge 框架的 DeepSeek 上游适配器，对接 [DeepSeek](https://api-docs.deepseek.com) 的 DeepSeek-V4 系列（`deepseek-v4-pro` / `deepseek-v4-flash`）。adapter 直接透传 Anthropic 格式请求到 DeepSeek 官方 Anthropic 兼容端点（`/anthropic`，即 `API_BASE=https://api.deepseek.com/anthropic`），只需做 DeepSeek 专属的请求体清洗（思考字段原样透传，见下）。

> 早期曾因 `/anthropic` 端点并发 `tool_use` 400 临时改走 OpenAI 端点（`/chat/completions` + 格式转换，2.7.6~2.7.9）。2026-08 实测并发 `tool_use` 已放行（历史含双 `tool_use`、模型并行输出两个方向均 200），故切回直传路径——DeepSeek 隐式 Context Caching 按「完整前缀单元」匹配，直传时 system / tools / 会话历史前缀稳定，缓存命中率恢复 ~98%。

## 它做什么

- 把 Claude Code 发来的 Anthropic `/v1/messages` 请求体适配为 DeepSeek 友好的形式（见下表）。
- 按 `MODEL_MAP` 把 `body.model` 从 spoof（如 `claude-opus-4-8` / `claude-haiku-4-5`）改写回 `deepseek-v4-pro` / `deepseek-v4-flash`。
- **思考字段（`thinking` / `output_config.effort`）原样透传，不做改写**——Claude Code 的 `/effort` 档位由 DeepSeek 端点按官方映射解读（`low→low`、`medium/high/xhigh→high`、`max→max`，V4-Flash-0731 与 V4-Pro-0813 官方明文一致；Claude Code 类 Agent 请求端点自动设为 `max`）。⚠️ `output_config.effort` 枚举不认 `none`（请求 400，2026-08-10 实测），CC 侧 `/effort` 无 `none` 档、正常不会触发。

## 支持的模型

| 模型 ID | 上下文窗口 | 钳制 max_tokens | 说明 |
|---------|-----------|----------------|------|
| `deepseek-v4-pro` | 1M | 128K | 旗舰（V4-Pro-0813），思考默认开启（effort 默认 high，Agent 请求自动 max） |
| `deepseek-v4-flash` | 1M | 128K | 高性价比（V4-Flash-0731），思考默认开启（effort 默认 high，Agent 请求自动 max） |

> DeepSeek-V4 上下文窗口 1M、单次输出能力充裕（官方未公布精确输出上限，第三方实测 flash 可达 384K）。上表「钳制 max_tokens」是 adapter 为避免偶发超大 `max_tokens` 触发上游拒收而设的保守保护值，不限制正常输出；需要更大输出可改 `ds-bridge/adapter.js` 的 `MODEL_MAX_TOKENS`。
>
> 旧模型名 `deepseek-chat` / `deepseek-reasoner` 已于 2026/07/24 弃用（分别对应 `deepseek-v4-flash` 的非思考 / 思考模式），本适配器只使用 V4 新名。

## 请求体适配（透传原则 + 功能性修复）

除以下功能性改写外，请求体与 Claude Code 直连端点的形态一致——`context_management`、`cache_control`、`metadata.user_id`、Anthropic 专有 `system` 段、思考字段全部原样透传：

| 改写项 | 原因 |
|--------|------|
| 按 `MODEL_MAP` 改写 `body.model`（spoof → target） | CC 只认白名单 ID、上游只认真实模型名，这是桥的核心职能 |
| 修复 tool 消息序列（`repairToolSequence`） | 功能性修复：DeepSeek `/anthropic` 端点对 server_tool_use / 孤立 tool_use / 交错的校验会 400，不修无法正常工作（直连用户同样会踩） |
| 把 `max_tokens` 钳到目标模型上限 | 偶发超大值保护；CC 实发 64000 远低于上限、正常从不触发 |

框架层另有一项按 KEY 的处理：`API_KEY_n_HIDE_USER_ID=1` 的 KEY 转发时清空 `metadata.user_id`（隐私选项，默认透传；见 `ds.env.example`）。

## 配置

配置文件：`~/.cc-bridge/ds.env`（模板见本目录 [`ds.env.example`](ds.env.example)）。

主要字段：`API_BASE`（DeepSeek Anthropic 兼容端点，`https://api.deepseek.com/anthropic`，**必须带 `/anthropic` 后缀**）、`API_KEY`（逗号分隔多个 DeepSeek KEY，支持容灾）、`MODEL_MAP`（`spoof->target` 映射对，支持多对，默认 `claude-opus-4-8->deepseek-v4-pro`）、`API_KEY_n_HIDE_USER_ID`（隐私选项：配 1 时该 KEY 清空 `metadata.user_id`，默认透传）。思考等级无需配置——`/effort` 档位透传、端点按官方映射解读（映射表见 `ds.env.example` 顶部注释）。

## adapter 接口

本目录的 `adapter.js` 导出统一 adapter 接口：`name` / `displayName` / `defaultTarget` / `defaultSpoof` / `modelMaxTokens` / `adaptRequestBody(obj, ctx)`。ds 不实现 `makeUpstreamCall`——请求体经 `adaptRequestBody` 清洗后由框架层（[core/server.js](../core/server.js)）直接透传到 `API_BASE`（`/anthropic` 端点）。框架对实现 `makeUpstreamCall` 的上游（如历史版本的 ds）仍保留 adapter 接管路径，详见 [core/server.js](../core/server.js)。
