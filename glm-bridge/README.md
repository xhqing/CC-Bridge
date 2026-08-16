# GLM-BRIDGE — Claude Code ↔ GLM（z.ai / 智谱 bigmodel.cn）适配器

CC-Bridge 框架的 GLM 上游适配器，对接 z.ai 国际版与智谱国内版（bigmodel.cn）的 GLM-5.3（两套端点可在同一配置里多端点同配、KEY 按端点绑定容灾，见 `API_BASES`）。

## 它做什么

- 把 Claude Code 发来的 Anthropic `/v1/messages` 请求体适配为 GLM 端点友好的形式（见下表）。
- 按 `MODEL_MAP` 把 `body.model` 从 spoof（如 `claude-opus-4-8` / `claude-haiku-4-5`）改写回 `glm-5.3`。
- **按 target 模型钉死思考等级**（`MODEL_THINKING`，取值 `max` / `high` / `none`）——每个模型各自配置，忽略 Claude Code 传来的 effort 档位。

## 请求体适配项

| 适配项 | 原因 |
|--------|------|
| 按 target 模型钉死 `thinking.type`（`enabled`/`disabled`）、`reasoning_effort`、`output_config.effort` | 由 `MODEL_THINKING` 配置每个模型的思考等级（`max`/`high`/`none`），忽略客户端 `/effort` 档位 |
| 剥离 `context_management` | Claude Code 专有，GLM 端点不识别 |
| 清空 `metadata.user_id` | 设备指纹 / session_id 发给上游无意义且泄露隐私 |
| 递归剥离 `cache_control` | GLM 端点不认 Anthropic 的 cache 标记 |
| 把 `max_tokens` 钳到目标模型上限（GLM 系列表） | 避免过大请求被拒 |
| 剥离 Anthropic 专有 `system` 段（`x-anthropic-billing-header:`、Agent SDK 声明） | 对 GLM 端点无意义 |
| 给 `tools` 尾部打 `cache_control` | 触发 GLM context caching |

## 配置

配置文件：`~/.cc-bridge/glm.env`（模板见本目录 [`glm.env.example`](glm.env.example)）。

主要字段：`API_BASES`（多端点列表 `名字->URL,…`，如 z.ai 国际版 + 智谱国内版同配）、`API_KEY_n` / `API_KEY_n_NAME` / `API_KEY_n_BASE`（每 KEY 一组：KEY 本体、统计展示名、绑定的端点名；某 KEY 失效自动切换下一个，多端点时跨端点容灾）、`MODEL_MAP`（`spoof->target` 映射对，支持多对，默认 `claude-opus-4-8->glm-5.3`）、`MODEL_THINKING`（按 target 模型配思考等级 `max`/`high`/`none`，默认全 `max`）。

## adapter 接口

本目录的 `adapter.js` 导出统一 adapter 接口：`name` / `displayName` / `defaultTarget` / `defaultSpoof` / `defaultThinking` / `modelMaxTokens` / `adaptRequestBody(obj, ctx)`。新增其它上游适配器时实现同一接口即可，框架层（[core/](../core/)）无需改动，详见 [core/adapter.js](../core/adapter.js)。
