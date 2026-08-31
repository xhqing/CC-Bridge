# TODO

活跃待办（只放 `[ ]` 未完成条目；已处理条目移入 `TODO-archive.md`）。每条附记录时间戳（记录：YYYY-MM-DD HH:MM）。

## 🟠 橙色紧急度

### 上游 / 链路

- [ ] **T12** 向智谱反馈网关 SSE 空闲超时问题并跟踪上游修复：断流模式已定位（2026-08-30 排查完结，见 CHANGELOG Unreleased「断流续写」条）——bigmodel.cn 网关对 SSE 连接有 ~15s 应用层空闲超时，三次实测断流「距上一包」恰为 15134/15104/15141ms，GLM 长思考 / 生成停顿静默超 15s 即被 RST，TCP keepalive 无效（网关看应用层字节；实测 GLM 只在流开头发一次 ping、思考静默期零字节）。桥接侧已用「断流续写」根治用户可见报错，但每次断流续写仍是额外的重复请求（多耗 token），上游根治（流内定期 ping，官方 Anthropic API 每秒发 ping 正是防此场景）才是正解。反馈渠道：智谱开放平台工单 / 用户群，附三次实测证据（记录：2026-08-30 20:55）
- [ ] **T14** 把上下文窗口下沉到 adapter 按 target 注入（modelUsage 默认值兜底）：现状 `CONTEXT_WINDOW` 是全局单值（core/server.js「所有 target 共享」），不配则 modelUsage 不注入，CC 客户端只能按内置表猜窗口——实测坑（2026-08-30）：走桥接时 `ANTHROPIC_BASE_URL` 非 `api.anthropic.com`，CC 对 `claude-opus-4-8`（原生 1M，`native_1m:true`）降级按 200K 保底判断，长会话 20.98 万 token 在本地预检被拒「Prompt is too long」（请求未发出去，上游 GLM-5.3 真实 1M 完全装得下；手动 /compact 可过反证非上游限制）。改法：各 `<name>-bridge/adapter.js` 增加 `MODEL_CONTEXT_WINDOW` 表（按 target 模型，来源官方文档，仿现有 `MODEL_MAX_TOKENS` 的做法），`buildModelUsage()` 未显式配 `CONTEXT_WINDOW` 时按本次请求的 target 从 adapter 取真实窗口注入——多对 MODEL_MAP（如 glm-5.3=1M / glm-4.6=200K）也能各自正确。本次实测链路证据与 CC 侧判定函数链（`hf()` base URL 白名单 → `U1()` 不通过 → 窗口落回 `nye=200000`）已在 2026-08-30 QuantStrategistAgent 会话中查证（记录：2026-08-30 18:36）
