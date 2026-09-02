# TODO

活跃待办（只放 `[ ]` 未完成条目；已处理条目移入 `TODO-archive.md`）。每条附记录时间戳（记录：YYYY-MM-DD HH:MM）。

## 🟠 橙色紧急度

### 上游 / 链路

- [ ] **T12** 向智谱反馈网关 SSE 空闲超时问题并跟踪上游修复：断流模式已定位（2026-08-30 排查完结，见 CHANGELOG 2.15.0「断流续写」条）——bigmodel.cn 网关对 SSE 连接有 ~15s 应用层空闲超时，三次实测断流「距上一包」恰为 15134/15104/15141ms，GLM 长思考 / 生成停顿静默超 15s 即被 RST，TCP keepalive 无效（网关看应用层字节；实测 GLM 只在流开头发一次 ping、思考静默期零字节）。桥接侧已用「断流续写」根治用户可见报错，但每次断流续写仍是额外的重复请求（多耗 token），上游根治（流内定期 ping，官方 Anthropic API 每秒发 ping 正是防此场景）才是正解。**反馈文稿已起草（`tmp/zhipu-sse-feedback.md`，含三次实测证据、TCP keepalive 无效与官方 API 对照、两条建议——工单可直接粘贴），提交智谱开放平台工单 / 用户群待用户执行**（tmp/ 不入库，提交后本文稿内容已进工单即完成使命）。（记录：2026-08-30 20:55，更新：2026-08-31 22:35）

- [ ] **T18** agnes 网关流式响应缺 `message_delta` 事件的框架侧补齐：agnes 流只发 start / block* / stop（2026-09-01 多轮实测，见 CHANGELOG 2.16.0「已知限制」），导致 ① modelUsage 注入落空（注入点在 message_delta，CC 将按内置表把窗口猜成 200K，agnes-2.5-flash 实际 512K——长会话 >200K 会被 CC 本地预检误拒）② 流式 output 用量统计记 0（非流式正常）。补丁方向：框架转发循环在 message_stop 前检测本流未出现过 message_delta 时合成补发一个（可注入 modelUsage 与 usage 累计；stop_reason 用保守值或不带）——做成框架通用能力（对其它不发 delta 的不规范网关同样生效），注意与断流续写路径的交互。（记录：2026-09-01 21:25）
