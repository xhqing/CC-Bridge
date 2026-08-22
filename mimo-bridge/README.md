# MIMO-BRIDGE — Claude Code ↔ MiMo (小米) 适配器

CC-Bridge 框架的 MiMo 上游适配器，对接小米 [MiMo](https://platform.xiaomimimo.com) 的 MiMo-V2.5-Pro 模型。

## 它做什么

- 把 Claude Code 发来的 Anthropic `/v1/messages` 请求体适配为 MiMo 友好的形式（见下表）。
- 按 `MODEL_MAP` 把 `body.model` 从 spoof（如 `claude-opus-4-8` / `claude-haiku-4-5`）改写回 `mimo-v2.5-pro`。
- **思考字段（`thinking`）原样透传，不做改写**——MiMo 官方 API 的思考模式只有开 / 关两种状态（`enabled` / `disabled`，不支持中间等级），CC 选任何思考档（low 及以上）发 `thinking.enabled`、透传即开启深度思考。

## 支持的模型

| 模型 ID | 上下文窗口 | 最大输出 | 能力 |
|---------|-----------|---------|------|
| mimo-v2.5-pro | 1M | 128K | 文本生成、深度思考、流式输出、函数调用、结构化输出、联网搜索 |
| mimo-v2.5 | 1M | 128K | 文本生成、全模态理解、深度思考、流式输出、函数调用、结构化输出、联网搜索 |

## 请求体适配（透传原则）

除以下两项外，请求体与 Claude Code 直连端点的形态一致——`context_management`、`cache_control`、`metadata.user_id`、Anthropic 专有 `system` 段、思考字段（MiMo 接受 Anthropic 的 `thinking` enabled/disabled，透传即表达开关语义）全部原样透传：

| 改写项 | 原因 |
|--------|------|
| 按 `MODEL_MAP` 改写 `body.model`（spoof → target） | CC 只认白名单 ID、上游只认真实模型名，这是桥的核心职能 |
| 把 `max_tokens` 钳到目标模型上限 | 偶发超大值保护；CC 实发 64000 远低于上限、正常从不触发 |

框架层另有一项按 KEY 的处理：`API_KEY_n_HIDE_USER_ID=1` 的 KEY 转发时清空 `metadata.user_id`（隐私选项，默认透传；见 `mimo.env.example`）。

## 配置

配置文件：`~/.cc-bridge/mimo.env`（模板见本目录 [`mimo.env.example`](mimo.env.example)）。

主要字段：`API_BASE`（MiMo Anthropic 兼容接口地址）、`API_KEY`（逗号分隔多个 MiMo KEY，支持容灾）、`MODEL_MAP`（`spoof->target` 映射对，支持多对，默认 `claude-opus-4-8->mimo-v2.5-pro`）、`API_KEY_n_HIDE_USER_ID`（隐私选项：配 1 时该 KEY 清空 `metadata.user_id`，默认透传）。思考开关无需配置——`thinking` 字段透传，CC 的思考档即开启深度思考。

## adapter 接口

本目录的 `adapter.js` 导出统一 adapter 接口：`name` / `displayName` / `defaultTarget` / `defaultSpoof` / `modelMaxTokens` / `adaptRequestBody(obj, ctx)`。新增其它上游适配器时实现同一接口即可，框架层（[core/](../core/)）无需改动，详见 [core/adapter.js](../core/adapter.js)。
