# GLM-BRIDGE — Claude Code ↔ GLM（z.ai / 智谱 bigmodel.cn）适配器

CC-Bridge 框架的 GLM 上游适配器，对接 z.ai 国际版与智谱国内版（bigmodel.cn）的 GLM-5.3（两套端点可在同一配置里多端点同配、KEY 按端点绑定容灾，见 `API_BASES`）。

## 它做什么

- 把 Claude Code 发来的 Anthropic `/v1/messages` 请求体适配为 GLM 端点友好的形式（见下表）。
- 按 `MODEL_MAP` 把 `body.model` 从 spoof（如 `claude-opus-4-8` / `claude-haiku-4-5`）改写回 `glm-5.3`。
- **思考字段（`thinking` / `output_config.effort`）原样透传，不做改写**——Claude Code 的 `/effort` 档位由 GLM 端点按官方映射解读（low/medium/high → high、xhigh/max/ultracode → max；GLM-5.3，官方文档 docs.bigmodel.cn/cn/guide/develop/claude）。
- **CC 安全分类器路由**（`CLASSIFIER_MODE`，见下节）——把 auto mode 高频分类器请求从 GLM 端点转走，省下额度大头。

## 请求体适配（透传原则）

除以下两项外，请求体与 Claude Code 直连官方端点的形态一致——`context_management`、`cache_control`（客户端原生打标）、`metadata.user_id`、Anthropic 专有 `system` 段、思考字段全部原样透传（端点对不识别的字段按忽略处理；`cache_control` 智谱端点按显式缓存切分点使用、z.ai 按隐式前缀缓存忽略标记，透传在两种端点下都不劣）：

| 改写项 | 原因 |
|--------|------|
| 按 `MODEL_MAP` 改写 `body.model`（spoof → target） | CC 只认白名单 ID、上游只认真实模型名，这是桥的核心职能 |
| 把 `max_tokens` 钳到目标模型上限 | 偶发超大值保护；CC 实发 64000 远低于上限、正常从不触发 |

框架层另有一项按 KEY 的处理：`API_KEY_n_HIDE_USER_ID=1` 的 KEY 转发时清空 `metadata.user_id`（隐私选项，默认透传；见 `glm.env.example`）。

## 配置

配置文件：`~/.cc-bridge/glm.env`（模板见本目录 [`glm.env.example`](glm.env.example)）。

主要字段：`API_BASES`（多端点列表 `名字->URL,…`，如 z.ai 国际版 + 智谱国内版同配）、`API_KEY_n` / `API_KEY_n_NAME` / `API_KEY_n_BASE`（每 KEY 一组：KEY 本体、统计展示名、绑定的端点名；某 KEY 失效自动切换下一个，多端点时跨端点容灾）、`MODEL_MAP`（`spoof->target` 映射对，支持多对，默认 `claude-opus-4-8->glm-5.3`）、`API_KEY_n_HIDE_USER_ID`（隐私选项：配 1 时该 KEY 清空 `metadata.user_id`，默认透传）、`CLASSIFIER_MODE`（CC 安全分类器路由，`on`/`off`，见上节）。

## adapter 接口

本目录的 `adapter.js` 导出统一 adapter 接口：`name` / `displayName` / `defaultTarget` / `defaultSpoof` / `modelMaxTokens` / `adaptRequestBody(obj, ctx)`。新增其它上游适配器时实现同一接口即可，框架层（[core/](../core/)）无需改动，详见 [core/adapter.js](../core/adapter.js)。
