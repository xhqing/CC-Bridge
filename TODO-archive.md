# TODO Archive

已完成 / 已更新的待办条目归档于此（从 TODO.md 移入，不删除，供回溯）。

## 功能 / 机制

- ✅**已放弃** **T7** 拟真度差异自查工具（T4 落地后改名「请求体改写审计」更贴切）：对比「当前代码改写后的请求体」与「CC 直连基线请求体」的字段级差异清单（用 T6 抓的直连基线做参照，基线捕获件在 `tmp/baseline/`、不入库），逐项列 ✅ 一致 / ❌ 偏离，偏离项标明由哪个代码路径引入。（放弃：2026-08-22 21:51）放弃理由：用户裁定 TODO 全部清空——T4 后请求体仅剩 model 改写 + max_tokens 钳制 + 按需 user_id 清空 + DS tool 序列修复 + 标题语言修正五项已知改写，均有明确存在理由（已记 CHANGELOG 与各 README），当前无需专用审计工具防漂移；将来 adapter 新增改写项时再按需重建类似检查。


- ✅**已完成** **T8** README「请求体透传」文档：主 README 中英补一节说明桥的透传原则（透传即默认且唯一——除 model 改写与少量功能性修复外请求体与直连一致；`API_KEY_n_HIDE_USER_ID` 按 KEY 隐私选项；「透传不是合规保证、官方判定逻辑不公开」的边界声明）；三桥 README 适配表按 T4 落地后的实际行为重写。T4 落地时随代码一并写。（记录：2026-08-22 16:07） → 已随 T4 同日落地：主 README 中英「Request-body passthrough / 请求体透传」表述（intro + What it does + Multi-key 节 per-key privacy option + Notes 边界声明「设计选择而非合规声明」）、三桥 README「透传原则」适配表全部就位。（完成：2026-08-22 21:45）

- ✅**已完成** **T4** 移除请求体各剥离改写，改为透传即默认且唯一的行为（2026-08-22 21:21 用户裁定：不加 `FIDELITY` 开关——透传形态全面更优或持平，开关多余）：三桥 adapter（glm / ds / mimo）删除以下改写逻辑——① 剥 `context_management`；② 剥 Anthropic 专有 system 段（billing header / Agent SDK 声明）；③ 递归剥客户端 `cache_control`（恢复 CC 原生打标：system 尾 + 最后可缓存块——对智谱显式缓存是有效切分点、对 z.ai 隐式缓存无影响，见 2026-08-22 缓存分析）；④ tools 尾重打 `cache_control`（直连 tools 全程无标，T6 实锤，打了反偏离基线）。**`metadata.user_id` 改为按 KEY 配置的隐私选项**：新增每 KEY 属性 `API_KEY_n_HIDE_USER_ID`（默认不配 = 原样透传；配 `1` = 该 KEY 转发时清空 `metadata.user_id`），`core/config.js` 的 `collectKeys` 收集 + `validateKeyAttrs` 校验（值仅认 0/1，非法入 validate 报告）+ KEYS 数组透出 `hideUserId` 字段；`core/server.js` 转发路径按当前 KEY 的 `hideUserId` 决定清空与否（在框架层做，三桥 adapter 各自的 `metadata.user_id` 清空逻辑全删）。**开源仓库措辞纪律（2026-08-22 用户立）**：本功能在所有仓库内文档（README / 模板注释 / CHANGELOG / TODO）一律只写中性技术语义（「不希望设备标识离开本机的隐私偏好场景」），不出现任何具体使用场景暗示。**保留不动**：model spoof→target 改写、max_tokens 钳制（CC 实发 64000 远低于上限、从不触发、零成本保险）、思考字段透传（T11 已完成）、`fixTitlePromptLanguage`（功能优先裁定）、DS 的 `repairToolSequence`（功能性修复，不修会 400，直连用户同样会踩）。同步五个 env 模板（新增 `API_KEY_n_HIDE_USER_ID` 说明 + cache_control 透传说明）、三桥 README、主 README 中英。验收：智谱 key（zhipu-cn）改后观测 `cache(anthropic)` 命中率不降（应升——恢复有效切分点）；zai key 命中率不变。（记录：2026-08-22 16:07）（完成：2026-08-22 21:45）

- ✅**已完成** **T11** 移除思考等级钉死功能（`MODEL_THINKING` / `MODEL_THINKING_DEFAULT` 整套下线）：CC VSCode 扩展 2.1.226 的 effort 枚举已与 CLI 对齐（binary 实测 `["low","medium","high","xhigh","max"]` 五档、spoof ID `claude-opus-4-8` 带 `max_effort` 能力、模型门控按 capability 表判断而非旧硬编码），立项时「VS Code 插件 max 不可用、须靠桥钉死」的前提已消失；且 GLM 端点官方映射表（low/medium/high→high、xhigh/max/ultracode→max、默认即 max）已保障透传链路的 max 思考——钉死功能失去存在理由，还引入「写直连没有的顶层 `reasoning_effort` 字段」的拟真偏差（T6 实测直连无此字段）。改动范围：`core/config.js` 删 `parseModelThinking` 与两配置项解析、`glm-bridge/adapter.js` / `ds-bridge/adapter.js` / `mimo-bridge/adapter.js` 删三字段对称写入与 `mapEffortToGLM`/`mapEffortToDeepSeek` 遗留函数、`core/server.js` 删注入与 banner 行、`glm.env.example` 删配置块（官方映射表注释已先行标注，见 2026-08-22 变更）、ds/mimo 同名模板同步、三桥 README 与主 README 中英删「按模型配思考等级」节、CHANGELOG 记录（含回归评估：DS 的 `none` 400 边界说明一并移除是否影响用户——功能整个下线则无从触发 400，说明随之删）。破坏性变更，需 bump minor 版本并在 README 标注 breaking。（记录：2026-08-22 20:02）（完成：2026-08-22 20:21）

- ✅**已完成** **T1** GLM 上游支持多个 BASE_URL：适配国际版（z.ai）与国内版（智谱 open.bigmodel.cn）两套端点，可同时配置、按可用性选择。→ 2.9.1 实现：`API_BASES` 多端点 + `API_KEY_n_BASE` 端点绑定 + KEY 轮换跨端点容灾（`core/config.js` / `core/server.js` / `glm.env.example`）。（记录：2026-08-15 20:51）（完成：2026-08-15 21:38）

- ✅**已完成** **T2** `cc-bridge stats` 用量按 API KEY 分类展示：不显示 KEY 本身，配置文件给每个 KEY 配 `API_KEY_n_NAME`，统计表按 key-name 分类；所有已注册 key-name 不允许重复（重复即配置错误，启动校验拦截）。→ 2.9.1 实现：`validateKeyAttrs` 查重 + server 落盘新增 `keys` 维度（KEY 本体不落盘）+ stats 展示 by key 表。（记录：2026-08-15 20:51）（完成：2026-08-15 21:38）

- ✅**已完成** **T3** `cc-bridge stats` 合并展示所有上游：不按 upstream 区分，把最近用过的上游（如 ds 与 glm）的用量一起呈现出来（聚合各 `stats-<upstream>.json`）；用 key-name 区分即可区分上游与账号。→ 2.9.1 实现：裸 `stats` 聚合全部快照（by key 合并同名 + by upstream/model 带前缀），显式 `<upstream> stats` 仍看单上游明细。（记录：2026-08-15 20:51）（完成：2026-08-15 21:38）

- ✅**已放弃** **T9** `CLASSIFIER_MODE` 拟真行为评估（仅分析、不改代码）：`off` 模式下 CC auto 模式的安全分类器请求（约为主对话 3 倍量）被桥本地伪造放行、不转发上游——上游侧该 KEY 的请求量画像约为直连的 1/4，是请求体之外更大的流量形态差异。（放弃：2026-08-22 18:48）放弃理由：用户裁定——分类器路由不只为了省钱，分类器直连上游的使用体验太差、影响正常使用，`off`（本地放行）是功能选择而非可让渡的优化项，不为拟真度牺牲功能，故本评估无意义、不做。

- ✅**已完成** **T6** 实测核实「CC 直连 GLM `/api/anthropic` 时请求体里是否带顶层 `reasoning_effort` 字段」及 `cache_control` 打标分布：→ 2026-08-22 完成。方法：本地起假 `/api/anthropic` 端点（`tmp/baseline/capture2.js`，回最小合法 SSE 流 + 首轮强制 tool_use、次轮收尾，逼出完整工具回合），用 `CLAUDE_CONFIG_DIR` 隔离配置（避开 `~/.claude/settings.json` 里指向生产桥的 `ANTHROPIC_BASE_URL` 覆盖——首次尝试即踩此坑、测试流量误打生产桥）+ `ANTHROPIC_BASE_URL=http://127.0.0.1:18999` 跑 `claude --print` 2.1.226，捕获 CC 发出的原始请求（首轮 + 工具回合第二轮）。结论：① 顶层**无** `reasoning_effort`，思考形态为 `thinking={"type":"adaptive","display":"omitted"}` + `output_config={"effort":"high"}`；② `cache_control` 分布 = system 尾部 2 block + messages 最后一条可缓存块（tool_result / 上轮 system 块），**tools 数组无任何 cache_control**；③ 恒带 `context_management`（clear_thinking_20251015）、`metadata.user_id`（device_id+session_id JSON）、`max_tokens=64000`；④ 头层面 UA `claude-cli/2.1.226 (external, claude-vscode, agent-sdk/0.3.226)` + 全套 `x-stainless-*`。已回填 T4（faithful 透传形态）与 T5（思考钉死 faithful 默认关）。捕获件存 `tmp/baseline/cap2-0{1,2}.json`（含 cap-06/07，不入库）。（记录：2026-08-22 16:07）（完成：2026-08-22 19:08）

- ✅**已放弃** **T10** `fixTitlePromptLanguage`（会话标题提示词韩语→中文修正）在 faithful 模式下的去留决策：该改写只命中标题生成请求（特征 `Good (Korean session)` 命中才替换、面窄），但 faithful 语义是「与直连一致」，保留修正则与直连有已知差异、关掉则中文标题可能回退为韩语。（放弃：2026-08-22 18:48）放弃理由：用户裁定——该修正影响功能（中文标题质量），不为拟真度牺牲功能；faithful 模式下 `fixTitlePromptLanguage` 无条件保留、不设开关，无需再评估。


- ✅**已完成** **T13** 2.14.0 发版（SSE error 收尾 + 断流诊断日志）：→ 2026-08-30 完成。流程：commit 6d748b2 → tag v2.14.0 → push（main + tag）→ GitHub Release v2.14.0（挂 cc-bridge-2.14.0.tgz）→ 从 Release 重新全局安装 → glm daemon 重启运行 2.14.0 安装副本（pid 85807），生产请求正常、诊断代码在安装副本中确认存在（grep 断流诊断 ×4）。（记录：2026-08-30 14:36）（完成：2026-08-30 15:02）
