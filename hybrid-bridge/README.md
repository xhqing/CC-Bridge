# HYBRID-BRIDGE — Claude Code ↔ 多模型提供商混合桥（混合上游适配器）

CC-Bridge 框架的混合上游适配器：**一个本地端口同时服务多个模型提供商**，按请求的模型路由到对应提供商的端点 / KEY。成员从已实现的上游里任选组合（[glm](../glm-bridge/) / [ds](../ds-bridge/) / [mimo](../mimo-bridge/) / [agnes](../agnes-bridge/)，不能嵌套 hybrid 自身）——比如同一端口里 `claude-opus-4-8` 走 GLM-5.3、`claude-haiku-4-5` 走 DeepSeek-V4-Flash，Claude Code 只配一个 `ANTHROPIC_BASE_URL`，`/model` 切换即切背后的提供商。

## 它做什么

- **按模型路由**：`MODEL_MAP` 的 target 带「提供商:」前缀（`claude-opus-4-8->glm:glm-5.3`）；省略前缀时（`->glm-5.3`）桥在各成员的模型表里查这个模型名自动限定归属（恰好一家认识才通过，零家 / 多家都在启动校验报错）。
- **成员内多 KEY 容灾**：某成员的 KEY 失效（401/403）只在该成员的 KEY 里切换，**绝不跨成员切换**——模型在别家不存在，切过去只会 400。
- **成员专属适配照常生效**：请求体适配委派给成员 adapter（GLM 钳 `max_tokens`、DeepSeek 修 tool 序列等），思考字段仍原样透传、由各成员端点按官方映射解读。
- **modelUsage 注入**：各成员的官方文档窗口表按「provider:model」键合并注入（`glm:glm-5.3` = 1M、`ds:deepseek-v4-pro` = 1M……），多对映射各注各的真实窗口。

## 配置

配置文件：`~/.cc-bridge/hybrid.env`（模板见本目录 [`hybrid.env.example`](hybrid.env.example)）。按「成员分节」组织，节前缀 = 成员名大写（`GLM_BASES` / `GLM_API_KEY_1` / `DS_BASE` / `DS_API_KEY_1` / `MIMO_…`），节内变量语义与单上游桥的平铺写法一致；`MODEL_MAP` 的 target 用 `provider:model` 限定。分节与顶层平铺（`API_BASES` / `API_KEY_n`）不能混用；`CLASSIFIER_*` 等全局变量仍写顶层。分节变量只从配置文件读取（顶层平铺变量仍支持 shell 环境变量覆盖）。

用法与其它上游一致：`cc-bridge hybrid start` / `cc-bridge hybrid config` / `cc-bridge hybrid stats`……也可 `cc-bridge set default upstream hybrid` 把它设为默认上游。

## 实现说明（adapter 接口扩展）

本目录的 `adapter.js` 除标准 adapter 接口外，用了框架的两个**可选**钩子（其它上游不受影响）：

- `preprocessEnv(env)`——`core/config.js` 解析平铺变量前调用：把成员分节摊平为标准平铺变量（端点名加 `<provider>-` 前缀、KEY 跨节重编号、MODEL_MAP 限定 target），并合并成员模型表。
- `routeKeys(target, KEYS)`——`core/server.js` 每请求调用：按 target 的 provider 前缀返回该成员的 KEY 索引集合，KEY 轮换 / 熔断只在此集合内进行。
