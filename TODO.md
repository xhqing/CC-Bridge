# TODO

活跃待办（只放 `[ ]` 未完成条目；已处理条目移入 `TODO-archive.md`）。每条附记录时间戳（记录：YYYY-MM-DD HH:MM）。

## 🔴 红色紧急度

### 代码 / 机制

- [ ] **T16** 发 2.15.1 并重装生产 glm 桥：修复（T15 的 SSE 事件破碎修复 + T14 的窗口注入）已完成并通过端到端验证，VERSION / package.json / CHANGELOG（2.15.1 定版条目）已就绪，但**生产 glm 桥仍在运行带 bug 的 2.15.0（2026-08-31 21:25 加载），每轮工具调用都会触发 "JSON Parse error: Unexpected EOF"**——须尽快走 `/commit` + `/release`（tag v2.15.1 + GitHub Release 挂 cc-bridge-2.15.1.tgz），再从 Release 重新全局安装并重启 glm daemon（运行版本与开发版本隔离规则，禁 npm link）。注意：/commit 前需把本次改动的 core/server.js、core/adapter.js、三个 <name>-bridge/adapter.js、VERSION、package.json、CHANGELOG.md、TODO.md 自行 `git add`（暂存区现存的 CHANGELOG/TODO 是修复前的旧版快照）（记录：2026-08-31 22:35）

## 🟠 橙色紧急度

### 上游 / 链路

- [ ] **T12** 向智谱反馈网关 SSE 空闲超时问题并跟踪上游修复：断流模式已定位（2026-08-30 排查完结，见 CHANGELOG 2.15.0「断流续写」条）——bigmodel.cn 网关对 SSE 连接有 ~15s 应用层空闲超时，三次实测断流「距上一包」恰为 15134/15104/15141ms，GLM 长思考 / 生成停顿静默超 15s 即被 RST，TCP keepalive 无效（网关看应用层字节；实测 GLM 只在流开头发一次 ping、思考静默期零字节）。桥接侧已用「断流续写」根治用户可见报错，但每次断流续写仍是额外的重复请求（多耗 token），上游根治（流内定期 ping，官方 Anthropic API 每秒发 ping 正是防此场景）才是正解。**反馈文稿已起草（`tmp/zhipu-sse-feedback.md`，含三次实测证据、TCP keepalive 无效与官方 API 对照、两条建议——工单可直接粘贴），提交智谱开放平台工单 / 用户群待用户执行**（tmp/ 不入库，提交后本文稿内容已进工单即完成使命）。（记录：2026-08-30 20:55，更新：2026-08-31 22:35）
