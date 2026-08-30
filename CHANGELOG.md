# Changelog

本项目所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [2.14.0] - 2026-08-30

### 变更（流式中断不再硬掐客户端连接：改发协议内 SSE error 事件，触发 CC 自动重试续跑）

- **为什么改**：上游（GLM cn 端点）在长流中途掐断 TCP 的现象慢性存在（glm.log 实证：2026-08-16 起累计 138 次 / 112,420 请求，全局 0.12%，但集中砸在 effort=high 的长回复上——高发窗口实测 100 次请求挂 8 次、中断时长的中位数 108 秒，恰是用户盯着等的那批回复）。桥接此前对这类「迟到错误」的收尾方式是 `clientRes.destroy()` 硬掐 TCP：Claude Code 收到的是 `Connection closed mid-response` 网络错误，**不自动重试、整轮停止等人工**——任务停下来用户还不知道，白白浪费时间。查官方错误文档确认：CC ≥2.1.199 对流内 `overloaded_error` / 5xx 错误**事件**会 mid-stream 自动重试整轮、任务不中断；对硬 TCP 重置则只能停轮。两类失败的差别就在「桥接怎么收尾」——同样的上游断连，硬掐 = 任务停，发协议内错误事件 = CC 退避重发、用户无感。国际站端点当前不可用无法分流对比，故从桥接侧解决。
- **改了什么**（全在 `core/server.js`）：
  - **新增 `abortWithSseError(reason)`**（请求闭包内）：响应头已发出且未 end 时，向 SSE 流补发 `event: error` + `{"type":"error","error":{"type":"overloaded_error",...}}` 后干净 `end()`（写失败兜底 destroy）；非流式 / 未发头场景仍走 destroy（无 SSE 通道，CC 按普通连接错误处理）。
  - **三处硬掐点改调 `abortWithSseError`**：① 请求级迟到错误（主场景，上游掐长流 ECONNRESET 落请求级 error）；② 响应流 `upRes.on('error')`；③ `handleUpstreamResponse` 入口丢弃迟到响应的双保险。原「不重试」判定保留——重试会对同一 clientRes 二次 writeHead 打死 daemon（2026-08-16 修复的崩溃根因），改的只是收尾方式。
  - **防御**：SSE 转发的 `data` / `end` 事件入口加 `clientRes.destroyed || writableEnded` 检查，已补发 error 收尾后上游残留数据直接丢弃断源，防 `ERR_STREAM_WRITE_AFTER_END`。
  - **根因缓解**：出站请求 `setSocketKeepAlive(true, 15000)`——长流期间 TCP 层静默时中间设备（NAT / 负载均衡）会把连接当死连接 RST，keepalive 探测包保持连接活性证据，降低被掐概率（缓解而非根治，服务端主动回收仍可能发生）。
- **实测验证**：`tmp/test-sse-abort.js` 端到端三场景 ALL-PASS——① 正常完整流不受影响（200 + message_stop、无 error 事件）；② **中途 RST 主场景：客户端收到 200 + 部分 delta + `event: error`（overloaded_error）+ 干净 end、无网络错误**（对照旧行为：TCP 硬重置）；③ 429 → 同 KEY 退避重试成功（重试窗口在首响应前，不受改造影响，上游命中 2 次）。已重装全局并重启 glm 守护进程，health ok、生产请求正常走新桥接。

## [2.13.0] - 2026-08-22

（本版条目内容即原 [Unreleased] 段全部记录：T4 执行请求体全面透传 + 按 KEY 隐私选项 HIDE_USER_ID、T11 思考等级钉死功能下线改为透传、T6 直连基线实测与 T4/T5/T7/T8 拟真度系列待办闭环。发布定版时归入本版本号。）

### 变更（T4 执行：请求体改全面透传——删四类剥离；新增按 KEY 隐私选项 HIDE_USER_ID）

- **为什么改**：T4 方案定稿（见下条）裁定不加 `FIDELITY` 开关、透传即唯一行为：各剥离改写（`context_management` / Anthropic 专有 system 段 / `cache_control` 剥离 + tools 尾重打）的理由经 T6 直连基线实测与官方文档核对全部站不住——端点对不识别字段按忽略处理（剥离纯制造签名），tools 尾打标偏离直连形态且对智谱显式缓存有害；`metadata.user_id` 改为按 KEY 的隐私选项（`API_KEY_n_HIDE_USER_ID`，默认透传、配 1 清空），既保留「不希望设备标识离开本机」的隐私能力，又不强制全局偏离直连形态。开源仓库措辞纪律：功能文档一律中性表述（隐私偏好场景），不出现具体使用场景暗示。
- **改了什么**：
  - **三桥 adapter**：`glm-bridge/adapter.js` 与 `mimo-bridge/adapter.js` 重写为「透传 + 钳 max_tokens」两项（文件头加「透传原则」说明）；`ds-bridge/adapter.js` 同步删四类剥离、保留 `repairToolSequence`（功能性修复）与钳制。`stripCacheControl` 函数三处全删。
  - **`core/config.js`**：`collectKeys` 新增 `API_KEY_n_HIDE_USER_ID` 收集（`hideUserIdRaw`）；`validateKeyAttrs` 校验值仅认 0/1（非法入 validate 报告）；`KEYS` 透出 `hideUserId` 布尔字段（未配 / 0 = false）。
  - **`core/server.js`**：`send(keyIdx)` 内按**当前 KEY** 的 `hideUserId` 清空 `metadata.user_id` 并重序列化 body（KEY 轮换 / 容灾切换后行为跟 KEY 走），请求日志追加 `user_id=hidden` 标记；`PROXY_DUMP` 注释补「dump 记录 KEY 级处理前形态、user_id 原值属预期」说明。
  - **五个 env 模板**：`API_KEY_n_HIDE_USER_ID` 中性说明（隐私选项，默认透传）+ glm/ds 加注释示例行。
  - **文档**：三桥 README 适配表重写为「透传原则」节（glm/mimo 两项改写、ds 三项含 tool 序列修复 + 框架层按 KEY 处理说明）；主 README 中英——intro 与 What it does 的「Request-body adaptation / 请求体适配」改写为「Request-body passthrough / 请求体透传」、Multi-key failover 节补 per-key privacy option 条目、Notes 补「透传是设计选择而非合规声明」边界句；架构 bullet 的 quirks 措辞同步。
- **实测验证**：三 adapter + config + server 模块加载正常；`hideUserId` 解析与校验单测通过（配 1 → true、不配 → false、非法值进 validate）；真实 KEY 端到端——透传配置（不配 HIDE）请求 200、dump 显示 `cache_control`（system 尾 + 消息块）与 `metadata.user_id` 原样保留、tools 无标（直连形态）；`HIDE_USER_ID=1` 配置请求 200、日志出现 `user_id=hidden`、转发体 user_id 已清空（send 内重序列化路径验证）。
- **待观察**（验收标准，发布后生效）：智谱 key（zhipu-cn）`cache(anthropic)` 命中率不降应升（恢复 CC 原生缓存切分点）；zai key 命中率不变。
- **兼容性**：破坏性变更（请求体形态变化：原被剥字段恢复透传；无配置迁移需求——`HIDE_USER_ID` 可选新增）；与 T11 同属下个 minor 版本的行为变更集。
- **待办闭环**：T4 / T8 归档（T8 的 README 透传文档随 T4 同日落地：中英透传表述 + per-key privacy option + 非合规声明边界句全部就位）；T7（请求体改写审计工具）用户裁定放弃归档——T4 后请求体仅剩五项已知改写、均有明确存在理由，当前无需专用审计工具防漂移。TODO 清空，拟真度系列待办（T4/T6/T7/T8/T11）全部闭环。

### 变更（T4 方案定稿：弃 FIDELITY 开关，透传即默认；user_id 按 KEY 配置隐藏）

- **为什么改**：原 T4 方案是加 `FIDELITY` 开关（compat 现状默认 / faithful 形态对齐直连）。用户复盘后裁定（2026-08-22）：逐项审判 compat 的六处改写——剥 `context_management` / system 段 / `cache_control` / tools 尾重打标全部站不住（「端点不识别」= 忽略而非拒绝，剥离纯制造签名；tools 尾打标反而偏离 T6 实测的直连基线，且对智谱显式缓存有害、对 z.ai 隐式缓存无益）；钳 max_tokens 从不触发（CC 实发 64000 远低于上限）留着即可——**faithful 全面更优或持平，开关没有存在必要，直接改为最优行为**。唯一例外 `metadata.user_id`：定为**按 KEY 配置的隐私选项**——新增 `API_KEY_n_HIDE_USER_ID`（默认不配 = 透传；配 1 = 该 KEY 清空 user_id），供不希望设备标识离开本机的隐私偏好场景按 KEY 独立控制。开源仓库措辞纪律（2026-08-22 用户立）：本功能在仓库内文档一律只写中性技术语义、不出现具体使用场景暗示。
- **改了什么**：`TODO.md` T4 按定稿重写（无开关，直接删三桥 adapter 的四类剥离逻辑；user_id 上移到 `core/server.js` 框架层按 KEY 处理，`collectKeys` 收集 + `validateKeyAttrs` 校验 + KEYS 透出 `hideUserId`）；T7 改名「请求体改写审计」（T4 后预期仅剩 model 改写 + 钳制 + 按需 user_id 清空 + DS tool 序列修复 + 标题修正）；T8 文档主题改为「请求体透传」原则。原 FIDELITY / FAITHFUL_PIN_THINKING / FAITHFUL_CLAMP_TOKENS 等配置项设计作废（后者已随 T11 失去意义）。
- **边界**：本次为方案定稿（改 TODO），代码未动；T4 实现含验收标准——智谱 key 改后 `cache(anthropic)` 命中率不降（应升，恢复有效缓存切分点）、zai key 不变。

### 变更（T11 执行：思考等级钉死功能整套下线，思考字段改为原样透传）

- **为什么改**：2026-07-07 立项时的前提「CC VS Code 扩展 effort 枚举缺 max、须靠桥钉死思考」已消失（2.1.226 扩展 binary 实测枚举五档含 max、spoof ID `claude-opus-4-8` 带 `max_effort` capability）；且各上游官方文档均给出 CC `/effort` 档位的解读映射（GLM-5.3：low/medium/high→high、xhigh/max/ultracode→max、默认即 max；DeepSeek-V4-Flash-0731 与 V4-Pro-0813 官方明文映射一致：low→low、medium/high/xhigh→high、max→max、Agent 请求自动 max），透传链路已有官方保障。钉死功能失去存在理由，且写入直连流量不存在的顶层 `reasoning_effort` 字段构成拟真偏差（T6 实测直连无此字段）。用户裁定：功能下线、映射表注明在配置文件即可、用不到的字段不留在配置里防误导。
- **改了什么**：
  - **`core/config.js`**：`parseModelThinking` 清空为兼容空实现（旧配置残留 `MODEL_THINKING` 行静默忽略不报错）；删 `THINK_MAP`/`THINK_DEFAULT` 的解析赋值与 `thinkingError`（validate / show 两处消费同步删），返回对象中两字段保留为空 / null 仅为下游读取契约兼容。
  - **`core/server.js`**：删启动时向 adapter 注入 `modelThinking`/`thinkingDefault` 的两行与 banner 的 `thinking:` 行；头注释「GLM 的 thinking 归一化」措辞改为「请求体适配」。
  - **三桥 adapter（glm / ds / mimo）**：删 `adaptRequestBody` 里的思考字段写入块（三字段对称写入）、`mapEffortToGLM`/`mapEffortToDeepSeek`/`mapEffortToMiMo` 三个遗留函数、`defaultThinking` 导出字段；改写项注释改为「思考字段原样透传」。
  - **`core/adapter.js`**：接口文档注释删 `defaultThinking` 条目、补透传说明。
  - **五个配置模板**：`glm.env.example`（注：GLM-5.3 官方映射表 + 「/effort 必须选一个值、想始终 max 选 xhigh 或 max」+ 注明 2026-08 版本口径防将来映射变化误导）、`ds.env.example`（注：DeepSeek 官方映射表 + V4-Flash-0731 / V4-Pro-0813 两版本一致 + `none` 400 警告保留 + 提示 xhigh 在 DS 侧只到 high 与 GLM 不同）、`mimo.env.example`（注：两态开关、透传即开）、`kimi`/`qwen` 预留模板（注释同步）。所有模板的 `MODEL_THINKING` / `MODEL_THINKING_DEFAULT` 配置块整体删除（不留在配置文件防误导）。
  - **文档**：三桥 README + 主 README 中英——删「按 target 模型钉死思考等级」特性条目与适配表行、`MODEL_THINKING` 字段说明；主 README 的「Per-model thinking level / 按模型配思考等级」节整体重写为「Thinking level passthrough / 思考等级透传」（含三上游官方映射表 + 版本口径提醒）；快速开始「配 MODEL_THINKING」步骤改为「无需配置、/effort 原样转发」；adapter 接口文档删 `defaultThinking`；文件表与注意事项同步。
- **回归评估**（对照 CHANGELOG 历史条目）：① 2.6.0 引入 `MODEL_THINKING` 的「忽略 /effort 钉死」能力随功能整体下线——用户已裁定该能力失去存在理由（前提消失 + 官方映射保障），属有意回归；② 2.8.x「DS none=400」的配置边界说明：功能下线后桥不再写 `output_config.effort`，400 无从被桥触发，警告转为「CC 侧别把 effort 关到 none」的环境提示保留在 ds.env.example；③ 2.7.2「MiMo MODEL_THINKING 验证失败修复」、2.7.x「OpenAI 路径 reasoning_effort 透传」：随钉死机制一并消失，历史条目保留不改写；④ 拟真度待办（T4）相应简化——faithful 模式无需思考子开关（原 T5 已随功能取消），思考字段无条件透传。
- **兼容性**：破坏性变更（`MODEL_THINKING` 配置不再生效、静默忽略）；下一版本 bump minor 并在 README 标注。实测：三 adapter 与 server 模块加载正常；生产 glm.env / ds.env（含残留 MODEL_THINKING 行）加载无错；`adaptRequestBody` 对 CC 原始请求体（thinking adaptive + output_config.effort）逐字段透传、不新增 `reasoning_effort`。

### 变更（glm.env.example 注明 CC /effort → GLM 官方映射表；思考钉死功能立项移除）

- **为什么改**：用户核实 CC VSCode 扩展（2.1.226）的 effort 枚举已与 CLI 对齐（binary 实测 `["low","medium","high","xhigh","max"]` 五档、spoof ID `claude-opus-4-8` 带 `max_effort` capability）——2026-07-07 立项时「VS Code 插件 max 不可用（枚举缺 max、静默回 high）、须靠桥钉死思考」的前提已消失；且 GLM 端点官方映射表（智谱文档：low/medium/high→high、xhigh/max/ultracode→max、默认档即 max）已保障 `/effort` 透传链路的 max 思考。钉死功能失去存在理由，且写入直连流量不存在的顶层 `reasoning_effort` 字段（T6 实测）构成拟真偏差。用户指示：思考等级映射关系表注明在 glm.env 配置文件中即可（即不靠桥钉死、档位透传 + 注释告知官方映射）。
- **改了什么**：`glm.env.example` 顶部注释块补「不钉死（两项注释掉）即透传 CC /effort」的用法说明 + CC /effort → GLM 官方映射表（含出处 docs.bigmodel.cn 两处链接、「默认档即 max」的优先级说明）；`MODEL_THINKING` 配置块上方注释同步补交叉引用。TODO 立项：**T11** 移除思考等级钉死功能（全套 `MODEL_THINKING` / `MODEL_THINKING_DEFAULT` / 三字段对称写入 / mapEffort 遗留函数 / 注入与 banner / 三桥模板与 README，含 DS none=400 边界说明随功能下线一并删的回归评估、bump minor 标 breaking）；原 **T5**（faithful 思考钉死子开关）随功能移除而取消（T4 中相关表述同步改为「思考字段全透传」）。
- **边界**：本次仅改 `glm.env.example` 注释与 TODO 立项，代码未动（`MODEL_THINKING` 仍可用，行为不变）；功能实体移除由 T11 执行。

### 调研（T5 思考链路核实：faithful 关钉死后 max 思考如何保障——官方文档为准）

- **为什么查**：T5 定案「faithful 默认关思考钉死」后留下关键问题——关掉后 GLM 还能不能用上 max 思考、是不是只靠 CC 的 `/effort`。用户指出此前凭本地实验下结论不如查官方文档（其记忆中 GLM-5.2 官方文档规定 `/effort xhigh` 可映射到 max）。
- **查证结论**：用户记忆属实。智谱官方文档两处明文：① 「Claude Code」页（docs.bigmodel.cn/cn/guide/develop/claude）给出 effort 映射表——CC 选 `low/medium/high → GLM high`、`xhigh/max/ultracode → GLM max`，并推荐 Coding 任务切 `max` effort；② 「如何切换模型」页（docs.bigmodel.cn/cn/coding-plan/latest-model）写明 GLM-5.3 下 `/effort` **默认档即 max**、处理优先级「显式 effort > thinking 开关 > 默认 max」。即端点对 CC 流量的 effort 语义有官方承诺的解读规则——faithful 透传后 `/effort xhigh`（或 max）即得 max 思考，无需桥介入。此前本地 A/B 实测（adaptive+effort 各档梯度生效、budget_tokens 被忽略、冲突时 effort 优先）与官方口径一致，互为印证。
- **改动**：核实结论回填 `TODO.md` T5（含官方映射表原文与两处文档出处），faithful 默认关钉死的定案不变——max 思考经官方映射链路保障。

### 变更（T6 完成：实测 CC 直连基线请求体，回填拟真度待办）

- **为什么改**：T4（`FIDELITY` 开关）与 T5（思考钉死 / 钳制子开关）的默认值依赖「CC 直连 GLM 端点时请求体长什么样」的客观事实——此前对「直连是否带顶层 `reasoning_effort`」「`cache_control` 打标分布」只有推断（TODO 里标注「待实测核实」），不抓基线就没法定 faithful 的正确形态。
- **改了什么**：在 `tmp/baseline/`（git 忽略）本地起假 `/api/anthropic` 捕获端点（`capture.js` / `capture2.js`——后者首轮回 tool_use、次轮回文本，逼 CC 走完整工具回合），用 `CLAUDE_CONFIG_DIR` 隔离配置跑 `claude --print`（CC 2.1.226）两轮，原样落盘 CC 发出的请求（`cap2-01/02.json`）。**实测结论**：① 直连顶层**无** `reasoning_effort` 字段，思考控制形态为 `thinking={"type":"adaptive","display":"omitted"}` + `output_config={"effort":"high"}`——此前「钉死思考会写直连没有的字段」的推断证实，T5 faithful 默认关思考钉死定案；② `cache_control` 真实分布 = system 尾部 2 个 block + messages 里最后一条可缓存块（当前轮 tool_result 或上一轮 system 块），**tools 数组全程无 cache_control**——桥现状「全剥 + tools 尾重打」与基线双向偏离，T4 faithful 停打标、客户端原标透传即天然对齐；③ 直连恒带 `context_management`（clear_thinking_20251015）、`metadata.user_id`（device_id+session_id JSON）、`max_tokens=64000`（在 GLM 上限内，钳制实际不触发）——证实这些字段剥离均偏离基线；④ 头层面实测确认 UA / `x-stainless-*` 全套指纹（与此前分析一致）。结论已回填 `TODO.md` T4 / T5（T6 本体移入归档）。
- **过程备注**：首次尝试用环境变量 `ANTHROPIC_BASE_URL` 覆盖失败——`~/.claude/settings.json` 的 `env` 块优先级更高，测试流量误打了生产桥（glm.log 留痕，无副作用）；改用 `CLAUDE_CONFIG_DIR` 指向隔离目录后成功。此坑对将来复测有参考价值：**抓 CC 原始请求必须隔离 CLAUDE_CONFIG_DIR，否则拿不到想要的目标流量**。mitmproxy 方案因本机代理环境（IPv6 出口）不可用而弃用，假端点方案更干净（无证书 / 无代理链干扰，且天然就是「CC 直连任意 /api/anthropic 端点」的形态）。

### 变更（TODO 立项：拟真度提升——请求体改写与 CC 直连流量形态对齐）

- **为什么改**：用户调研智谱 GLM Coding Plan 的工具识别机制后决定「保持现有功能不变、尽可能增加拟真度」。核对结论：GLM `/api/anthropic` 端点官方支持 CC 直连，直连流量天然携带 `metadata.user_id` / `context_management` / Anthropic 专有 system 段 / `cache_control` 且被端点正常接受——现有各剥离改写是隐私 / 瘦身习惯而非功能必须，每剥一处都使请求偏离官方见惯的直连基线，成为请求体层面唯一的拟真差异来源。方案定为新增 `FIDELITY` 拟真度开关（`compat` 现状默认 / `faithful` 形态对齐直连），保持现有功能不变、faithful 为纯增模式。
- **改了什么**：`TODO.md` 新增 7 条待办（**T4**~**T10**，编号接续归档最大值 T3）：T4 `FIDELITY` 开关主体（faithful 下停止各剥离、只留 model 改写 + 可选钳制 / 思考钉死）；T5 思考钉死 / max_tokens 钳制独立子开关（思考钉死写入的顶层 `reasoning_effort` 可能是直连没有的结构性差异）；T6 实测 CC 直连基线请求体（`reasoning_effort` 有无、`cache_control` 打标分布，回填 T5 默认值）；T7 拟真度差异自查工具（字段级对比清单）；T8 README 拟真度文档（含「faithful 不是合规保证」边界声明）；T9 `CLASSIFIER_MODE` 流量画像评估（off 时上游请求量约为直连 1/4，请求体之外更大的差异，仅分析不改码）；T10 `fixTitlePromptLanguage` 在 faithful 下的去留实测。
- **边界**：本次仅立项（写 TODO），无代码 / 配置 / 文档行为变更；实现按 T4→T6→T5 顺序推进（先抓直连基线再定子开关默认值）。同日用户裁定放弃 T9 / T10：分类器路由（`CLASSIFIER_MODE=off`）是功能选择（分类器直连上游体验太差、影响正常使用，非单纯省钱），标题语言修正也影响功能——功能优先于拟真度，两者不做、已归档留痕；faithful 模式下 `fixTitlePromptLanguage` 无条件保留。

## [2.12.0] - 2026-08-22

### 新增（cc-bridge dashboard：本地浏览器面板呈现最详细用量统计）

- **为什么改**：用户要求 `cc-bridge stats` 改回默认终端显示数据，并在输出尾部加一句提示「需要看更详细的用量统计信息可以使用 cc-bridge dashboard」；dashboard 是一个后续还会加别的功能的通用面板（本次只装用量统计模块，其余功能后续完善）。
- **改了什么**：
  - **CLI**（`bin/cc-bridge.js`）：`cc-bridge stats` 默认回归终端文本模式（聚合 / 单上游判断不变），`--text` / `-t` 保留为兼容别名；新增 `cc-bridge dashboard`（及别名 `stats --gui` / `-g`）弹本地浏览器面板；HELP 与 README 中英同步。
  - **dashboard 页面**（`core/gui.html`）：概览卡 6 枚（含此前有数但从未展示的「缓存创建」）；「用量趋势」纯 SVG 多系列折线图（按上游分系列、请求数 / 输入 / 输出指标切换、超 48 桶自动按天归并、resize 自适应）；明细表扩为按上游 / 按 KEY / 按模型三张（全部带「缓存创建」列）；上游系列色固定槽位分配（light / dark 双模式）；新增暗色模式（跟随系统）。页面模块化（`<div class="module">`），后续功能以并列模块追加；服务端（`core/gui.js`）路由改为 `API_ROUTES` 注册表。
  - **聚合层**（`core/stats.js`）：`aggregate()` / `aggregateWindowFor()` 返回值新增 `totals` / `upstreamTotals` / `series` 三块；stats 终端输出尾部加 dashboard 提示语。
  - 修复趋势图空渲染 bug（某小时桶缺某上游时抛 TypeError，补齐矩阵按 0 落点）。

### 变更（README 补「为什么需要桥接」立项理由 + 特有能力价值表述）

- **为什么改**：主 README 中英此前只讲 What / How、不讲 Why——「Claude Code 只接受白名单内的模型 ID」这个立项前提在正式文档零提及；分类器路由（`CLASSIFIER_MODE`）、modelUsage 注入、请求体适配等多项桥接特有能力也体现不全；intro 举例停留在「GLM / Kimi / Qwen」与实现进展（glm/ds/mimo）脱节。
- **改了什么**：主 README 中英新增「Why a bridge? / 为什么要桥接？」节（spoof→target 改写的必然性 + 六项纯配置给不了的能力）；What it does 补请求体适配、安全分类器路由、modelUsage 注入三条；intro 举例改「GLM / DeepSeek / MiMo」。`glm-bridge/README.md` 新增「CC 安全分类器路由（CLASSIFIER_MODE）」整节（两态行为与代价对照表、agnes 全失败 502 兜底语义）。

### 变更（README 补「为什么需要桥接」立项理由 + 特有能力价值表述，分类器路由补文档）

- **为什么改**：主 README 中英只讲 What / How、不讲 Why——第一版 claude-proxy 的 Why 一节在 2.8.2 删「解锁 /effort xhigh」卖点时被连带删掉，但其中「Claude Code 只接受白名单内的模型 ID」这个立项前提至今成立，却只剩 kimi/qwen 预留模板注释里还有、正式文档零提及；读者（含用户本人复盘）会问「为什么不直接配置 CC 的配置文件指向上游」，README 答不了。同时多项桥接特有能力体现不全：分类器路由（`CLASSIFIER_MODE`，实测占 z.ai Coding Plan 额度约 70% 的额度大头开关）在所有 README 里零文档；modelUsage 注入只剩架构图里的一个术语、没讲作用；请求体适配只在各上游子 README 有清单、主 README 没点明「直连会把 CC 专有字段原样发过去」这个价值点；intro 举例还停在「GLM / Kimi / Qwen」与实现进展（glm/ds/mimo）脱节。
- **改了什么**：
  - **主 README 中英**：新增「Why a bridge? / 为什么要桥接？」节（置于 Available upstreams 之前）——讲清两侧对 `model` 字段的相反要求（CC 只认白名单 ID ↔ 上游只认真实模型名、`model` 只有一个），spoof→target 改写是唯一粘合方式；随后列出六项纯配置给不了的能力（多 KEY 容灾、思考等级钉死、请求体适配、分类器路由、modelUsage 注入、用量统计）。What it does 补三条：请求体适配（点明剥离 CC 专有字段 / 钳 max_tokens / 打缓存标的价值）、安全分类器路由（高频 3 倍 + 约 70% 额度 + `on`/`off` 语义）、modelUsage 注入（`CONTEXT_WINDOW` / `MAX_OUTPUT_TOKENS` 的作用——客户端显示真实窗口而非 spoof 模型窗口）。架构图 modelUsage 行加注「真实上下文窗口」。intro 举例「GLM / Kimi / Qwen」改「GLM / DeepSeek / MiMo」。
  - **glm-bridge/README.md**：新增「CC 安全分类器路由（CLASSIFIER_MODE）」整节——分类器是什么、为什么高频费额度（约 70%）、`on`（AGNES 免费模型 + 主备容灾 + 协议转换 + 走系统代理）与 `off`（默认，本地伪造放行、0 消耗无判断）两态行为与代价对照表、agnes 全失败时 502 不放行的兜底语义；「它做什么」补一条分类器路由；配置主要字段清单补 `CLASSIFIER_MODE`。
- **边界**：纯文档改动，无代码 / 配置变更；`MODEL_THINKING` 等既有表述不动。

### 变更（stats 回归终端文本默认 + 新增 cc-bridge dashboard：本地浏览器面板呈现最详细用量统计）

- **为什么改**：用户要求 `cc-bridge stats` 改回默认终端显示数据，并在输出尾部加一句提示「需要看更详细的用量统计信息可以使用 cc-bridge dashboard」；dashboard 是一个后续还会加别的功能的通用面板（本次只装用量统计模块，其余功能后续完善），名字就叫 cc-bridge dashboard。
- **改了什么**：
  - **CLI**（`bin/cc-bridge.js`）：`cc-bridge stats` 默认回归终端文本模式（聚合 / 单上游判断不变），`--text` / `-t` 保留为兼容别名；新增 `cc-bridge dashboard`（及别名 `stats --gui` / `-g`）弹本地浏览器面板；HELP 与 README 中英同步。
  - **提示语**（`core/stats.js`）：stats 终端输出尾部（含无数据分支）加 `[bridge] 需要看更详细的用量统计信息可以使用 cc-bridge dashboard。`。
  - **聚合层增产**（`core/stats.js`）：`aggregate()` / `aggregateWindowFor()` 返回值新增三块——`totals`（全部上游合计，概览卡用）、`upstreamTotals`（按上游合计，按上游明细表用）、`series`（`[{hk, upstream, bucket}]` 小时 × 上游序列，趋势图用；从 models 维度合计，与既有两维表同一累计口径）；单上游无快照的空返回同步带这三字段。
  - **dashboard 页面重写**（`core/gui.html`）：概览卡 6 枚（请求数 / 输入 / 缓存命中 / 命中率 / **缓存创建** / 输出——缓存创建列此前落盘有数但从未展示）；「用量趋势」纯 SVG 多系列折线图（按上游分系列、请求数 / 输入 / 输出指标切换、y 轴漂亮刻度、hover crosshair 吸附最近时间点 + 单 tooltip 列全部上游数值、超过 48 个小时桶自动按天归并、窗口 resize 自适应重绘）；明细表从 2 张扩为 3 张（按上游 / 按 KEY / 按模型），全部加「缓存创建」列；上游系列色按固定槽位分配（同一上游过滤前后颜色不变，8 槽 light / dark 双模式经 dataviz 调色板校验器验证通过）；新增暗色模式（跟随系统 `prefers-color-scheme`）；重拉数据时保留旧渲染降透明度（不闪骨架屏）。**模块化留扩展**：页面主体为 `<div class="module">`（用量统计为模块一），后续功能各成一模块并列追加；服务端（`core/gui.js`）路由从 if 链改为 `API_ROUTES` 注册表（新数据接口加一行注册，token 校验 / 404 兜底框架统一处理）。
  - **修复趋势图空渲染 bug**：某小时桶只覆盖部分上游时 `merged[tk][u]` 为 undefined 抛 TypeError（控制台实锤），补齐矩阵（缺失上游按 0 条目、折线落到 0）。
  - 实测：`cc-bridge stats`（聚合 / 单上游）终端输出 + 提示语正常；`cc-bridge dashboard` 起服务（token 校验：无 / 错 token 403、带 token 200、未知路径 404）；`/api/stats` 返回 totals / upstreamTotals / series 与既有 keys / models 两表口径交叉核对一致（各维度 reqs 合计相等）；Chrome headless 截图确认页面渲染完整（趋势图双系列折线、图例、刻度、三张明细表、无控制台报错）。

### 修复（TODO / MEMO 编号加粗脚本截断事故：批量脚本切片 bug 把条目正文截空，从多恢复源全量重建）

- **为什么改**：上一条「全量补编号」执行时，第二步「编号加粗」脚本存在切片 bug（`m.group(0)[m.end(3)+1:]` 起点算错），把所有被匹配条目的正文截成空壳（只剩 `- [ ] **Tn** `），共波及 1 个文件 3 条。发现后立即启动恢复（无 Time Machine / APFS 快照可用）。
- **改了什么**：多恢复源重建并回写——① git 暂存区 / HEAD 旧版（TODO-archive.md）；② Claude Code file-history 检查点（Edit 前快照，无）；③ 会话转写重放（按时间序重放历史 Edit / heredoc 写入，补齐检查点之后的新增条目，如 DayTradingAgent 今晚新增的 5 条活跃待办与「2026-08-21 批量处理」4 条归档）。重建后统一按规则加粗编号（**Tn** / **Mn**），DayTradingAgent 连续 T1~T115、DayTradingAgent-win 连续 T1~T44，正文经抽样与恢复源逐字一致。受损壳快照留存本机 tmp（/tmp/todo-damage-backup/）。
- **边界**：恢复目标是「截断事故前的状态」（即编号未加粗、但已编号的正文完整版）；编号加粗为规则要求的新格式。git 未提交的其它改动不受影响。

### 变更（TODO / MEMO 条目全量补编号：按新立待办编号规则一次性补齐存量）

- **为什么改**：2026-08-21 用户新立全局规则「每条待办必须有唯一待办编号」（格式 T+序号 / M+序号，如 T11 / M11，连写、项目内递增、永不复用、归档保留），并指示存量待办与归档待办全部补上编号——编号用于用户与 AI 针对性沟通（「T11 处理了吗」），避免复述长正文。
- **改了什么**：TODO-archive.md 3 条归档条目补编号 T1~T3。正文内容零改动（只插入编号，不改写、不重排、时间戳不变）；编号顺序 = 活跃文件在前、归档在后、文件内按行序。

## [2.11.0] - 2026-08-20

### 新增（用量统计 GUI：时间窗口查询 + 按维度呈现）

- **为什么改**：用户要求 `cc-bridge stats` 直接弹出用量统计 GUI，且 GUI 里要能选择起始 / 终止时间、呈现相应时间段内按 model-id / key-name 维度的输入 Token、缓存命中 Token、缓存命中率与输出 Token。原有 stats 只有终端文本、数据模型是「每 daemon 进程一份累计、重启即清零」，既没有 GUI、也无法按时间窗口查询——必须先改数据层才有历史可查。
- **改了什么**：
  - **数据层改按小时分桶持久化**（`core/server.js`）：stats 结构从顶层 `models`/`keys` 进程累计改为 `hours[hk].models/.keys` 小时桶（hk 为 UTC 整点 key，如 `"2026-08-20T04"`，桶代表 `[04:00, 05:00)`）；启动时载入既有快照跨进程续存（**daemon 重启不再清零**）；旧格式（v1 进程累计）自动迁移为 startedAt 所在小时的一个桶（历史总量保住、时间粗化到小时）；滚动保留 30 天（`STATS_RETENTION_HOURS`，写盘前清理过期桶）；`stats.version` 标 2。usage 归因口径（Anthropic / OpenAI 两种风格、message_start / message_delta 双时点、base 回退估算）与命中数计算逻辑完全不变，只是累计目标从进程级两张表变为当前小时桶里的两张表。
  - **聚合层新增时间窗口聚合**（`core/stats.js`）：`aggregate(fromISO, toISO)` 把窗口内（按桶起点、闭区间、边界小时整桶计入）的小时桶合并成「按 KEY（跨上游同名合并、兜底名 #n 撞名加 `<upstream>` 前缀消歧）」与「按模型（`upstream/model` 标签）」两维表；`normalizedHours()` 统一 v1 / v2 快照视图（读盘兼容旧文件）；CLI 文本模式 `showStats()` 重写为走聚合层（窗口为全量），输出窗口行从「per-daemon-process windows merged」改为「hourly buckets, daemon restarts preserved」。
  - **本地 GUI 服务**（新增 `core/gui.js`）：`cc-bridge stats` 起临时 HTTP 服务（仅绑 127.0.0.1，端口从 `PROXY_PORT+1` 顺延找空闲，最多试 20 个）、生成一次性随机 token（URL 查询参数校验、不带 / 错 token 一律 403，防本机其它页面跨站探测）、自动打开系统默认浏览器（macOS `open` / Windows `start` / Linux `xdg-open`，打不开则打印 URL 手动开）、Ctrl-C 退出。数据接口 `GET /api/stats?from=&to=` 复用 `aggregate()`，daemon 停着也能查（读快照文件）。
  - **GUI 页面**（新增 `core/gui.html`，零依赖单文件）：顶部起止时间选择器（`datetime-local`，本地时区）+「查询」按钮 + 快捷窗口（今天 / 近 7 天 / 近 30 天 / 全部，默认近 7 天）；概览卡片五枚（请求数 / 输入 Token / 缓存命中 Token / 缓存命中率 / 输出 Token）；「按 KEY（key-name）」与「按模型（upstream / model）」两张表，列与 CLI 文本模式一致（reqs / input / cache-hit / hit% / output + total 行）；页脚标注口径与小时桶粒度说明。
  - **CLI 接入**（`bin/cc-bridge.js`）：`cc-bridge stats` 默认弹 GUI；新增 `--text`（或 `-t`）参数保留原终端文本模式（单上游 / 聚合模式判断不变）；HELP 与 README（中英双语同步）更新。
  - 实测：窗口过滤单测 11 项全过（v1/v2 兼容、闭区间边界、单侧窗口、空窗口）；端到端过桥请求验证 v1 快照迁移 + 新请求计入新桶 + SIGTERM 落盘 v2；GUI 服务 token 校验（带 token 200 / 无 token 403 / 错 token 403 / 未知路径 403）；Chrome headless 截图确认页面渲染正常（表格数据完整对齐、无乱码）。

### 变更（Visitors 徽章更名 Visits/day (14d)：alt 文本与 xhqing 集中统计新 label 对齐）

- **为什么改**：用户要求（2026-08-17）访问量徽章名需表达「最近半月日均访问量」口径——xhqing 集中统计侧的 badge JSON label 已从 `Visitors` 改为 `Visits/day (14d)`（`Visits/day` 是 shields.io 表达日均的惯例写法、`(14d)` 标注 14 天滚动窗口），各仓 README 的徽章 alt 文本同步对齐，避免 alt 与徽章实际显示文字脱节。
- **改了什么**：README 徽章区 `alt="Visitors"` → `alt="Visits/day (14d)"`，仅改 alt 文本，endpoint URL、数据源、徽章口径均不变（口径改动记 xhqing 仓库 CHANGELOG，本仓只改 alt）。

## [2.10.1] - 2026-08-16

### Fixed

- **修复 daemon 频繁崩溃（上游掐长流触发重试后二次写响应头，`ERR_HTTP_HEADERS_SENT` 未捕获异常打死进程）**：用户长期遇到「cc-bridge 后台服务莫名其妙挂了、不得不手动重启」——日志实锤 glm 通道同签名崩溃 27 次、ds 通道 9 次（2026-07-28 至 2026-08-16），2026-08-16 16:57 又发生一次。根因链：① 流式请求上游秒回 200，桥已把响应头写给客户端（`writeHead` 已执行）、SSE 流开始转发；② 数十秒后连接被 RST 掐断，`read ECONNRESET` 落在**请求级** `activeUpReq.on('error')` 处理器（而非响应流上只断客户端的无害路径）；③ 该处理器只判断「是否瞬态错误」就重试，违反了代码注释里自己声明的设计意图（「重试窗口在拿到首个上游响应前已过，之后不再切换」）；④ 重试又拿到 200，对同一个客户端响应第二次 `writeHead` → Node 抛 `ERR_HTTP_HEADERS_SENT`，异常发生在 socket 数据回调的异步上下文、无人捕获 → 进程退出、daemon 死亡、桥上所有进行中请求断流。修复三层（互为保险）：**主修复**——每个请求闭包新增 `responseStarted` 标志，`handleUpstreamResponse` 入口置真；`activeUpReq.on('error')` 里响应已开始则不重试、直接断开客户端（流已部分转发本就无法透明重试，Claude Code 会自行重发该请求）。**防御纵深**——`handleUpstreamResponse` 入口检查 `responseStarted || clientRes.headersSent`，已发过头的迟到上游响应丢弃并断开，绝不二次写头（兜住所有迟到错误的变种）。**进程级兜底**——注册 `process.on('uncaughtException')` / `unhandledRejection`，记完整堆栈进 daemon 日志后继续运行（本地代理各请求状态互相隔离，继续运行安全），保证今后任何未预见的 bug 不再把 daemon 打死。修复后遇上游掐流的表现从「整个进程崩溃、手动重启」变为「单条请求断流（CC 端自行重试），daemon 活着」。实测复现验证：mock 上游首回 200 + 流中途 `resetAndDestroy()`（RST，错误落请求级 error、与生产日志一字不差）+ 重试回 200——旧版（2.10.0 安装副本）跑同场景堆栈与生产完全一致地崩溃；修复版同场景存活且日志显示「upstream 迟到错误（响应已开始转发，不重试）」按设计工作；429 / 500 瞬态重试、非流式请求的回归测试 3/3 通过（重试 / failover 行为未破坏）。原因：上游偶发掐长流本身难免（glm.log 中触发外因全是 ECONNRESET / ETIMEDOUT），把「掐流」放大成「整个 daemon 崩溃」是桥的重试时序漏洞，必须修。

## [2.10.0] - 2026-08-16

### 变更（Visitors 徽章 alt 文本首字母大写：README 访问量徽章命名统一）

- **为什么改**：用户指令（2026-08-16）「Visitors 徽章全局统一，首字母大写」——配合全局 `~/.claude/CLAUDE.md`「徽章英文首字母必须大写」新规，集中统计上线时挂的访问量徽章 `alt="visitors"` 为小写存量，与 badge JSON label（`Visits/day`）及大写规范不一致，本次一次收口。
- **改了什么**：README（EN/CN）徽章区 visitors 徽章 `alt="visitors"` → `alt="Visitors"`，仅改 alt 显示文本，endpoint URL 与数据源不变。

### 新增（README 访问量徽章——舰队集中式访问统计）

- **为什么改**：全舰队上线集中式「真去重」访问统计（图片徽章方案无法去重，走官方 Traffic API 路线）：统计集中部署在 xhqing 仓库（`scripts/update_traffic.py` + 每日 GitHub Action），各 fleet 仓库只需在 README 挂徽章、零运行负担。
- **改了什么**：README（EN/CN）徽章区新增 visitors 徽章（shields.io endpoint 指向 `xhqing/xhqing` 仓库 `traffic/badges/<repo>.json`，由每日采集的官方 Traffic API 数据更新）。徽章数字含义：按日去重访客的累计（GitHub 只提供每日 uniques，跨天不去重），自 2026-08-16 起累计。

### Added

- **KEY 优先级（`API_KEY_n_PRIORITY`，高优先级 KEY 先用）**：同一配置配多个 KEY 时，每个 KEY 可配 `API_KEY_n_PRIORITY=<非负整数>`（越大越先用；未配视为 0）。实现方式：`core/config.js` 的 `collectKeys` 收集 `KEY_n_PRIORITY` 原始值、`validateKeyAttrs` 校验必须为非负整数（非法值启动即报 `API_KEY_n_PRIORITY="…" is not a non-negative integer`），`loadConfig` 构建 KEYS 后按「优先级降序 + 同优先级保持编号序（稳定排序）」排好——server 的 KEY 轮换按数组顺序扫，排序后 `pickNextKey` / 熔断 / 回切逻辑天然生效，`core/server.js` 零改动。效果：最高优先级 KEY 承接全部流量，直到它被 401/403 熔断才落到低优先级 KEY；熔断 60 秒到期后自动回切高优先级 KEY——「主力 KEY 先用、备用 KEY 只做容灾」由配置表达，无需增删 KEY 行。全部不配 `PRIORITY` 时排序退化为编号顺序，行为与旧版完全一致（向后兼容）。`cc-bridge config show` 的 KEY 列表加 `prio=` 标注；`glm` / `ds` / `mimo` 三个 env.example 模板补 `API_KEY_n_PRIORITY` 字段说明与主力 / 备用示例；README 中英（特性条目、配置示例、多 KEY 容灾节各补「KEY 优先级」条目）同步。原因：用户要控制多 KEY 的使用顺序（如主力账号先消耗、备用账号只在容灾时启用），此前只能靠调整 `API_KEY_n` 编号顺序表达，加新账号要重排编号、不便维护。实测：本地 mock 双 KEY（低优先级编号在前）——请求先后走高优先级 KEY；高优先级 KEY 恒 401 时熔断切换低优先级 KEY 成功 200；非法 PRIORITY 值被 `validate` 拦截；不配 PRIORITY 时顺序保持编号序。

### Fixed

- **daemon 横幅多端点显示错误（`cc-bridge restart` 后仍显示单端点 `api base`）**：2.9.1 引入 `API_BASES` 多端点时只升级了 server 进程横幅（`core/server.js` 多端点列全部端点），`core/daemon.js` 的 `printBanner`（`restart` / `start` / `claude` 命令输出）仍显示兼容字段 `cfg.API_BASE`（= 首端点 URL）——用户配置 z.ai + 智谱双端点、只启用智谱 KEY 后重启，横幅仍显示 `api base : https://api.z.ai/...`，误导以为流量走 z.ai（实际转发按每 KEY 绑定、日志 `base=cn` 证实走智谱）。`printBanner` 对齐 server 横幅口径：多端点显示 `api bases : zai=… | cn=…` 全部端点，单端点沿用 `api base` 一行；`API keys` 行从数量改为显示 key 名（多端点时 `名字@端点名`，如 `zhipu-cn@cn`），与 server 横幅一致。原因：横幅是用户判断路由的首要窗口，显示的端点与实际转发端点不符会直接误导排障方向。
- **GLM adapter `displayName` 钉死 `(z.ai)` 与多端点现状不符**：`glm-bridge/adapter.js` 的 `displayName` 自 2.9.0 起为 `GLM-5.3 (z.ai)`，2.9.1 支持智谱国内版端点后该名字仍宣称单一厂商，横幅 `upstream : GLM-5.3 (z.ai)` 在走智谱端点时同样误导。改为 `GLM (z.ai / bigmodel.cn)`（不钉死模型版本——版本看 spoof→target 行，实际端点看 api bases 行）。同步修正所有引用旧表述的文档：`glm-bridge/README.md`（标题与正文改为双端点表述、配置字段说明从旧式 `API_BASE` / 逗号分隔 `API_KEY` 更新为 `API_BASES` + `API_KEY_n` 三件套、适配表「z.ai 不识别」等措辞改「GLM 端点」）、`glm-bridge/adapter.js` 头部与注释、主 README 中英（已实现列表、上游表格、文件表 3 处）、`.claude/CLAUDE.md` 已实现列表；`assets/demo/` 6 张 SVG 里残留的 `GLM-5.2 (z.ai)` / `glm-5.2` 一并更新（displayName 双端点、模型名 5.2→5.3、版本注脚 v2.8.1→v2.9.1），并用 rsvg-convert 以 2x 重渲染对应 5 张 PNG。原因：文档与演示图描述的是当前行为，钉死过时的厂商 / 模型版本会让读者误判多端点能力。

## [2.9.1] - 2026-08-15

### Added

- **GLM 上游支持多 BASE_URL（z.ai 国际版 + 智谱国内版同配，KEY 按端点绑定）**：新增 `API_BASES=zai->https://api.z.ai/api/anthropic,cn->https://open.bigmodel.cn/api/anthropic` 配置（`core/config.js` 新增 `parseApiBases`，格式 `名字->URL,名字->URL`），每个 KEY 用 `API_KEY_n_BASE=<名字>` 绑定到其中一个端点（不绑则用第一个端点）；多端点下 KEY 轮换天然跨端点容灾——z.ai 的 KEY 失效（401/403）自动熔断切换到智谱的 KEY。转发层（`core/server.js`）从「全局单一 upstream URL」改为「每 KEY 一个端点 URL」（`keyUpstreams` 数组与 KEYS 一一对应），host / path / 端口按当前 KEY 的端点取；协议按端点 scheme 选 http/https 模块（生产端点都是 https，http 供本地 mock / 内网自建网关）。旧式单变量 `API_BASE=URL` 完全兼容（内部包成单元素 `API_BASES`，行为与之前一致）。`cc-bridge config show` 多端点时列出全部端点、每 KEY 标注 `@端点名`；banner / health 同步展示。`glm.env.example` 模板改为双端点示例（zai + cn 两账号各绑一端点）。原因：用户同时持有 z.ai 国际版与智谱国内版账号，单 `API_BASE` 无法同配，两套账号需要在同一个上游里容灾互备。实测：本地双 mock 端点端到端——KEY1 走 zai 端点 200；KEY1 端点恒 401 时熔断切换 KEY2 走 cn 端点 200，均按预期路由。
- **`cc-bridge stats` 用量按 API KEY 分类呈现（KEY 本身不显示）**：配置文件给每个 KEY 配统计展示名 `API_KEY_n_NAME`（如 `zai-work` / `zhipu-cn`），未配则按 `#n` 兜底；⚠️ 同一配置内 key-name 不允许重复——`core/config.js` 新增 `validateKeyAttrs` 校验（重复名 / `KEY_n_BASE` 绑不存在的端点名都会被 `validate` 拦截，启动即报错，避免重名把两个账号的用量混在一起）。server 统计落盘从单一「按模型」表扩为双维度：`stats-<upstream>.json` 新增 `keys` 表（按 key-name 累计 requests / input / output / cache-hit / cache-created，与 models 表同口径；`KEY 本体绝不落盘`）。`recordUsage` 增加 keyName 参数贯穿 message_start / message_delta / 非流式三条累计路径，`msgStartBase` 快照同步覆盖两张表（DS 转换流的真实 usage 回退估算逻辑在两维度各自生效）。旧版本快照（无 keys 表）仍可展示（by key 节提示「重启 daemon 后开始记录」）。3 个 env.example 模板（glm / ds / mimo）补 `API_KEY_n_NAME` 说明与示例。原因：用户要按账号归因用量（哪个 KEY 用了多少），而 KEY 本身是敏感信息不能出现在展示与落盘里。
- **`cc-bridge stats` 不再区分 upstream，所有上游用量一起呈现**：裸 `cc-bridge stats`（未显式写上游、未带 `--config`）聚合 `~/.cc-bridge/` 下所有 `stats-<upstream>.json`（`core/stats.js` 新增 `discoverUpstreamsWithStats` 扫描）合并呈现两张表——「按 key-name」（跨上游同名 key-name 视为同一账号合并；`#n` 兜底名跨上游撞名时加 `<upstream>#n` 前缀消歧）与「按 upstream/model」（标签带上游前缀，ds 与 glm 的用量一眼分开）。窗口行注明「各上游快照为各自 daemon 进程窗口（重启即重置），合并仅作总览」。显式 `cc-bridge <upstream> stats` 仍看单上游明细（按模型 + 按 KEY 两张表）。`bin/cc-bridge.js` 的 `parseUpstream` 增加 `explicit` 标记区分「用户显式写了上游」与「省略回退默认」（stats 聚合分发的依据），help 文案同步。原因：ds 和 glm 最近都在用，逐个上游查统计太繁琐，直接合并呈现一张总览表。
- **新增 `cc-bridge set default upstream` 命令（默认上游可由用户设置并持久化）**：此前省略 `<upstream>` 时一律用内置默认 `ds`（2.8.2 改），用户切换主力上游只能每次显式写 `cc-bridge glm …`。本次在 `core/adapter.js` 新增用户级默认上游——持久化在 `~/.cc-bridge/default-upstream`（单行上游名，与 `<upstream>.env` / `.pid` / `.log` 同目录）：`getDefaultUpstream()` 读取（未设置 / 文件含未知上游名时回退内置 `ds`）、`setDefaultUpstream(name)` 写入（校验必须为已实现的上游，预留未实现的拒绝设置，避免 `cc-bridge start` 运行时才报错）、`clearDefaultUpstream()` 清除。CLI 新增 `set default upstream <name>`（设置）、省略 name（显示当前值并注明 built-in / user-set）、`--reset`（清除用户设置、恢复内置 `ds`）；help 文案的默认上游行与示例动态反映当前生效值。接入点：`bin/cc-bridge.js` 的 `parseUpstream`（裸命令解析）、`core/config.js` 的 `loadConfig` 兜底、`core/server.js` 直跑路径（`$CC_BRIDGE_UPSTREAM` 未设时）、`scripts/ensure-default-env.js` postinstall（跟随用户设置准备配置）。README 中英用法与文件表、`.claude/CLAUDE.md` 与 `.codebuddy/CLAUDE.md` 架构说明同步（后者顺带修正残留的「默认 glm」与「GLM-5.2」过时表述）。原因：多上游并存时用户有固定主力（如 glm），设置一次后裸命令全部跟随，无需每条命令带 `<upstream>` 前缀。

## [2.9.0] - 2026-08-15

### Changed

- **发版流程与升级解耦（`.claude/rules/cc-bridge-install.md`）**：删去「发新版本流程」第 5 步「发布后从 Release 装到本机并重启 daemon」——发版到 GitHub Release 即止，AI 不替用户在本机安装升级、不重启 daemon（何时升级、重启哪个上游由用户决定），只在汇报里给出升级提示（`cc-bridge --update` + `cc-bridge <upstream> restart`）。原因：2026-08-15 发 2.9.0 时按旧流程顺手重启了本机 daemon，被用户指出不该有——发布是发布，本机升级是升级，两者职责分开；CLI 自带 `--update` 自更新命令，升级由用户自己执行即可。
- **GLM 上游默认模型升级 glm-5.2 → glm-5.3（z.ai 2026-08-14 发布 GLM-5.3）**：z.ai Coding Plan 端点（`https://api.z.ai/api/anthropic`）已支持 `glm-5.3` 并把 glm-5.2 / glm-5.1 请求自动路由到 5.3，桥的默认目标对齐实际路由。改了什么：`glm-bridge/adapter.js`——`MODEL_MAX_TOKENS` 表新增 `glm-5.3: 131072`（上限表保留 glm-5.2 条目，用户显式配 5.2 仍可钳制）、`displayName` 改「GLM-5.3 (z.ai)」、`defaultTarget` 改 `glm-5.3`、文件头注释同步；`glm-bridge/glm.env.example`——`MODEL_MAP` 默认值 `claude-opus-4-8->glm-5.2` 改 `->glm-5.3` 并加注释（5.2/5.1 会被端点自动路由到 5.3，旧值可写但建议直接用 5.3）；`glm-bridge/README.md` 标题与正文、README 中英（已实现列表、上游表格、配置示例、日志示例、`MODEL_THINKING` 示例、文件表）、`.claude/CLAUDE.md` 已实现列表、`package.json` keyword（`glm-5.2` → `glm-5.3`）、`core/config.js` 与 `core/server.js` 注释两处同步。原因：GLM-5.3 与 5.2 同基座、编程能力 +50%（z.ai Code Bench），端点已自动路由，默认值与实际路由对齐后日志 / modelUsage 统计才准确。注意：按 token 计费的开放 API 尚未开放（官方标注 API coming soon），本次仅对齐 Coding Plan 端点。

## [2.8.2] - 2026-08-10

### Fixed

- **修复中文会话标题被生成为韩语（会话标题提示词语言示例修正）**：Claude Code 客户端（2.1.226 实测）内嵌的会话标题生成提示词只有英语示例 + 一条「Good (Korean session)」韩语示例、没有中文示例——中文会话生成标题时，模型（DeepSeek 实测）容易照抄韩语示例、输出韩语标题。`core/server.js` 新增 `fixTitlePromptLanguage`：请求体解析后递归遍历文本节点，命中标题提示词特征（`Good (Korean session)`，只出现在该提示词里）时，把韩语示例替换为中文示例（`Good (Chinese session): {"title": "重构支付模块"}`）、`Bad (English title for a Korean session)` 语言标签同步改为 Chinese；未命中（非标题请求）一律原样不动。原因：标题提示词在客户端 native binary 内、CC-Bridge 无法直接改客户端，在桥接层改写请求体是唯一可行修法；特征命中即替换、零副作用，客户端将来改动提示词措辞导致特征失效时静默跳过即可。实测：用从 binary 提取的真实提示词构造请求经桥接转发，改写后请求体韩语示例已替换为中文示例、上游 200 接受。
- **配置模板与文档补 DeepSeek `MODEL_THINKING=none` 的 400 边界**：实测 DeepSeek `/anthropic` 端点（`https://api.deepseek.com/anthropic`）的 `output_config.effort` 枚举只认 `low`/`medium`/`high`/`xhigh`/`ultra`/`max`，不认 `none`——`MODEL_THINKING` 配 `none`（想「不思考」）会让请求 400。`ds-bridge/ds.env.example` 模板把默认值 `deepseek-v4-flash->none` 改为 `->max`（原默认值照模板配置即会踩 400），取值说明与顶部注释补 ⚠️ 警告（none 只在 GLM 等认「不思考」的上游可用，DeepSeek 该端点暂无法关闭思考、只配 max/high）；`ds-bridge/README.md` 三处（钉死思考等级、适配表、主要字段）与主 README 中英「按模型配思考等级」节的 DeepSeek 示例（`->none` 改 `->max`）同步修正并加警告。原因：文档若仍教人配 `none`、模板默认仍是 `none`，与实测的 400 行为矛盾、照配置即踩坑，说明清楚并改默认值才能防患。（同日补漏：模板顶部取值说明的枚举仍残留「（max/high/none）」与三态对应表述，与下方警告自相矛盾——2026-08-10 改警告时漏改了顶部的枚举行，已同步改为「（max/high）」、删去「none=不思考」的三态对应说法，仅保留「max=Think Max、high=Think High」与 ⚠️ 警告。）

### Changed

- **对外表述移除「unlocks /effort xhigh」，改为「思考等级配置文件配置」**：用户决定思考等级只在 cc-bridge 配置文件中配置（`MODEL_THINKING` / `MODEL_THINKING_DEFAULT`），不再使用 Claude Code 的 `/effort` 功能——`/effort` 选任何等级都不影响实际上游模型的思考等级（思考等级由桥接按配置写入请求体钉死），继续宣传「解锁 xhigh」是误导性卖点。改了什么：README 中英——intro 特性改为「思考等级直接在 cc-bridge 配置文件中配置」、架构说明「effort 映射」改「思考等级映射」、删除「effort 闸门（xhigh 与 max）」整节与「始终 max 思考（GLM）」特性条目、快速开始「在 claude 里运行 /effort 选 xhigh」步骤改为「在 `~/.cc-bridge/<upstream>.env` 配 `MODEL_THINKING`」（日志示例加注：`effort` 字段仅记录客户端传来的档位、实际等级由配置钉死）、注意/限制删除「必须用 xhigh / max 在 VS Code 插件里是坏的」条目、「effort 解锁」表述改为「配置钉死」表述；package.json description 删除「unlocks /effort xhigh」（改为 pins per-model thinking levels via config）、keyword `effort` 改 `thinking`；core/claude.js 启动文案「max/xhigh unlocked」改「thinking levels from cc-bridge config」；kimi/qwen 预留模板注释「绕过客户端 effort 闸门」改「Claude Code 只接受白名单内的模型 ID」、「是否需要强制 max effort」改「MODEL_THINKING 思考等级」；`.claude/CLAUDE.md` 架构说明同步。原因：思考等级已由桥接配置钉死、客户端 `/effort` 档位对上游无实际作用，对外统一「配置文件配置思考等级」的表述。历史 CHANGELOG 条目中的旧表述保留原样（历史记录不改写）。
- **安装 / update 后自动准备默认上游配置 `~/.cc-bridge/ds.env`**：新增 `scripts/ensure-default-env.js` 作为 package.json 的 `postinstall` 钩子（`"scripts"` 加入 `files` 随 tgz 发布）——第一次安装（`npm install -g <tgz>`）或 `cc-bridge update` / `rollback` 重新安装（内部同为 `npm install -g <tgz>`，均会触发）后，若 `~/.cc-bridge/ds.env` 不存在，自动从 `ds-bridge/ds.env.example` 复制一份（内容即模板副本），用户填好 API key 即可直接 `cc-bridge start`；已存在则静默跳过、绝不覆盖用户已有配置。脚本由 `DEFAULT_UPSTREAM` 驱动，默认上游变更时自动跟随。README 中英与 `.claude/rules/cc-bridge-install.md` 安装流程补说明。原因：新环境装完 CLI 即配置就位，省去「先 `cc-bridge ds config` 手动生成」一步。
- **默认上游改为 ds（DeepSeek）**：`core/adapter.js` 的 `DEFAULT_UPSTREAM` 由 `glm` 改为 `ds`，`core/config.js` 的 `loadConfig` 兜底由硬编码 `'glm'` 改为引用 `DEFAULT_UPSTREAM`（保持单一来源）；同步更新 `bin/cc-bridge.js` / `core/server.js` 注释、README 中英（`<upstream>` 参数说明与用法示例）、`.claude/rules/cc-bridge-install.md` 与 `.claude/CLAUDE.md` 的默认上游表述。原因：用户日常主力模型为 DeepSeek，`cc-bridge start` / `restart` 等不带 `<upstream>` 的命令默认即指 `ds-bridge`，无需再显式写 `cc-bridge ds …`；显式 `cc-bridge glm …` 写法不受影响。
- **项目更名 CC-BRIDGE → CC-Bridge**：GitHub 仓库 `xhqing/CC-BRIDGE` 重命名为 `xhqing/CC-Bridge`（公开仓库，旧 URL 自动重定向）；`core/update.js` 的 `REPO`、README（中英）徽章 URL 与署名来源、package.json description、4 个上游 README、`.claude/CLAUDE.md`、logo.svg 与 `assets/demo/` 全部 SVG 的展示名同步改为 CC-Bridge，并用 rsvg-convert 以 2x 重新渲染 6 张演示 PNG（旧版备份于 `tmp/png-backup/`）。原因：公开仓库面向英文读者，「Bridge」一眼可读为单词「桥」、语义更清晰；npm 包名 `cc-bridge` 与 CLI 命令不受影响。
- **`.claude/rules/cc-bridge-install.md` 移除过时描述**：仓库已公开，「为 **private**、`curl` 匿名下载返回 404、必须用带认证的 `gh`」改为「为 **public**、`curl` 匿名下载与带认证的 `gh` 均可」。原因：仓库可见性已变更（2026-08-10 实测 public），规则描述随之更新，核心「从 Release 的 tgz 全局安装、禁 `npm link`」不变。
- **`.claude/` 补齐项目级配置，接入 Anvil 负责制**：新增 `settings.json`（hooks 空）、`settings.local.json` 与 `settings.local.example.json`（允许 `Bash(node *)` / `Bash(npm *)` 白名单），`.gitignore` 追加 `.claude/settings.local.json`（本机配置不入库），`.claude/CLAUDE.md` 顶部新增「负责工程师：Anvil」一节。原因：让用户在只操作 CC-BRIDGE 项目时也能体现本项目归 Anvil（BackendEngineerAgent，用户的后端开发工程师）负责，`.claude/` 配置与 BackendEngineerAgent 项目对齐。
- **`.claude/CLAUDE.md` 并入 Anvil 角色全文（内容超集首次落实）**：新增「## BackendEngineerAgent（Anvil）CLAUDE.md 全文（随附，保证内容超集）」章节，含 Anvil 角色定义 / 工作原则 / 工具 / 约束 / 子项目 `.claude/` 自动同步规则 / 位置，带指代说明（本文件中「本项目」指 BackendEngineerAgent），标题降级为 `###` 避免与本文档层级冲突。原因：按「Agent 项目与子项目 `.claude/` 超集关系」规则（2026-08-10 修订版），Agent 项目 `CLAUDE.md` 的**内容**同样须超集到子项目、实现方式不限——选最简单做法直接并入本文档；本次为首次落实的结构性变更故记录，后续内容更新同步按规则不逐条记录。
- **桥目录名简化 `cc-<name>-bridge/` → `<name>-bridge/`**：5 个上游适配目录重命名（`cc-glm-bridge` → `glm-bridge`、`cc-ds-bridge` → `ds-bridge`、`cc-mimo-bridge` → `mimo-bridge`、`cc-kimi-bridge` → `kimi-bridge`、`cc-qwen-bridge` → `qwen-bridge`），同步 `core/adapter.js` 注册表 `dir` 字段、`package.json` `files` 数组、相关代码注释（`core/adapter.js` / `core/config.js` / `core/server.js` / `glm-bridge/adapter.js` / `ds-bridge/adapter.js`）、README 中英正文与 3 个桥 README（`ds-bridge` / `kimi-bridge` / `qwen-bridge` 的标题与路径引用）、`.claude/CLAUDE.md` 与 `.codebuddy/CLAUDE.md`。原因：目录名去掉与 CLI 命令 `cc-bridge` 重复的 `cc-` 前缀、与 `core/` 一起构成更清晰的顶层结构；上游标识（`glm` / `ds` / `mimo` / `kimi` / `qwen`）、CLI 命令（`cc-bridge <upstream> …`）、配置与模板路径（`~/.cc-bridge/<upstream>.env`、`<name>-bridge/<name>.env.example`）均不受影响，仅目录名简化。CHANGELOG 历史条目中的旧目录名保留原样（历史记录不改写）。

### Docs

- **新增 README 演示图（SVG 源 + PNG 渲染）**：新增 `assets/demo/` 下 6 组演示图——`architecture`（架构图）、`terminal-startup` / `terminal-config` / `terminal-request` / `terminal-stats`（终端界面）、`thinking-config`（思考等级配置），供 README / 文档引用。

## [2.8.1] - 2026-08-05

### Fixed

- **修复 `/anthropic` 直传路径的 tool 序列 400（2.8.0 发布后补录）**：真实 Claude Code 请求触发 DeepSeek `/anthropic` 端点 400（`tool_use ids were found without tool_result blocks immediately after`）。`cc-ds-bridge/adapter.js` 的 `adaptRequestBody` 新增 `repairToolSequence`——`server_tool_use` / 同消息 `tool_result` 展开为纯 `text`（保留内容、去掉 tool 语义）；剥离未被下一条消息 `tool_result` 覆盖的孤立 `tool_use`；剥离无对应前置 `tool_use` 的孤立 `tool_result`；`tool_use` 与其它块交错时整体挪到消息末尾连续放置。实测真实失败请求（396 条消息 / 478k token、844 条消息 / 63 路并行 tool_use / 666k token）修复后均 200，缓存命中 99~100%。

## [2.8.0] - 2026-08-04

### Changed

- **DeepSeek 切回原生 Anthropic 直传端点（`/anthropic`）**：早期 `/anthropic` 端点对「同一 assistant 消息含多个 `tool_use`（并发工具调用）」返回 400，曾改走 OpenAI 兼容端点（`/chat/completions` + `makeUpstreamCall` 转换层，见 2.7.6~2.7.9）。2026-08-04 实测该 400 已修复（历史含双 `tool_use`、模型并行输出两个方向均 200），切回直传路径。
  - **收益**：DeepSeek 隐式 Context Caching 按「完整前缀单元」匹配，直传时 system / tools / 会话历史前缀稳定，缓存命中率从转换流的 ~65% 恢复到直传的 ~98%（实测）；并发 `tool_use` 同步恢复。
  - **变更**：`cc-ds-bridge/adapter.js` 移除 `makeUpstreamCall` 与 `anthropic-openai-converter` 依赖，恢复本地 `stripCacheControl`；`API_BASE` 恢复为 `https://api.deepseek.com/anthropic`（模板 `ds.env.example` 与 `cc-ds-bridge/README.md` 同步）；`core/anthropic-openai-converter.js` 与框架层 `makeUpstreamCall` 接管路径保留，供其它上游复用。

### Fixed

- **修复 `/anthropic` 直传路径的 tool 序列 400**：真实 Claude Code 请求触发 DeepSeek `/anthropic` 端点 400（`tool_use ids were found without tool_result blocks immediately after`，CC 界面表现为「tool use concurrency issues」）。根因三类：①CC 的 server tools（webReader 等服务端执行工具）把 `server_tool_use` 与结果 `tool_result` 一并塞进同一条 assistant 消息，DeepSeek 校验器不认该结构（把 `server_tool_use` 当 `tool_use`、要求结果在「下一条消息」，且 assistant 消息不允许 `tool_result`）；②上下文压缩（`/compact`、自动压缩）留下孤立 `tool_use`（丢掉了随后的 `tool_result`）；③assistant 消息内 `tool_use` 与 `thinking`/`text` 块交错（CC 多子任务编排在单条消息发数十个并行 `tool_use` 时出现），DeepSeek 校验器误判配对（实测 63 个并行 `tool_use` 交错时 400、挪到消息末尾连续时 200）。
  - **adapter（`cc-ds-bridge/adapter.js`）**：`adaptRequestBody` 新增 `repairToolSequence`——`server_tool_use` / 同消息 `tool_result` 展开为纯 `text`（保留内容、去掉 tool 语义）；剥离未被下一条消息 `tool_result` 覆盖的孤立 `tool_use`；剥离无对应前置 `tool_use` 的孤立 `tool_result`；`tool_use` 与其它块交错时整体挪到消息末尾连续放置（仅交错时重排、保持相对顺序，不影响缓存前缀）。实测真实失败请求（396 条消息 / 478k token、844 条消息 / 63 路并行 tool_use / 666k token）修复后均 200，缓存命中 99~100%。

## [2.7.9] - 2026-08-04

### Fixed

- **修复 OpenAI 转换流的 usage 统计口径（输入侧估算污染 / 缓存命中错位）**：OpenAI / DeepSeek 风格 usage 此前直接按 `prompt_tokens` 计入 `input_tokens`，与 server 侧「总输入 = read + created + input」的 Anthropic 口径不一致——缓存命中 token 会被重复计入输入，`cc-bridge ds stats` 的命中率被低估。
  - **转换器（`core/anthropic-openai-converter.js`）**：新增 `openaiUsageToAnthropic()` 统一映射——`input_tokens` = miss（`prompt_tokens - prompt_cache_hit_tokens`，不含命中部分）、`cache_read_input_tokens` = hit（DeepSeek 缓存命中等价于 Anthropic 的 read）、`output_tokens` = `completion_tokens`；同时兼容 `prompt_tokens_details.cached_tokens`（OpenAI 规范口径）。非流式响应与流式末尾均改用该映射。
  - **server（`core/server.js`）**：`recordUsage` 新增 `base` 快照参数——流式 `message_start` 记入前快照本请求输入侧统计，`message_delta` 收到真实 usage 时回退估算值、按「read + created + input」口径改记真实值（DS 等转换流的真实 usage 只在 delta 返回）；`message_delta` 分支同时补充缓存命中观测日志（与 `message_start` 旁路观测互补）。

## [2.7.8] - 2026-08-04

### Fixed

- **修复 DeepSeek 流式响应时 Claude Code 界面 token 计数滞后**：OpenAI 流式端点的 usage 只在流末尾返回（`stream_options.include_usage`），此前实时流式转换器在 `message_start` 里写死 `input_tokens: 0`——CC 界面 token 计数在流式过程中一直是 0，直到流结束 `message_delta` 才跳变，看起来比走 Anthropic 接口（z.ai 在 `message_start` 就带真实 `input_tokens`）慢一拍。
  - **转换器（`core/anthropic-openai-converter.js`）**：新增 `estimateTokens()` / `estimateInputTokens()`（CJK 1 字符 ≈ 1 token、其余 4 字符 ≈ 1 token 的通用估算）；`streamOpenAIToAnthropic()` 新增 `estimatedInputTokens` 参数，`message_start` 用估算值预填 `input_tokens`，让 CC 界面在流一开始就有接近真实的输入计数；`message_delta` 补全真实 `input_tokens`（`prompt_tokens`）+ `output_tokens`，流结束时以精确值覆盖。
  - **adapter（`cc-ds-bridge/adapter.js`）**：`makeUpstreamCall` 在请求侧用 `estimateInputTokens(openaiBody)` 估算并传入流式转换器。`cc-bridge ds stats` 输入侧此前恒 0（流式 start 无 input），现能累计估算值；输出侧仍以流末尾真实值累计，不重复计数。

## [2.7.7] - 2026-08-04

### Fixed

- **修复 DeepSeek 流式响应「卡很久然后突然闪出一大段」**：ds adapter 的流式路径此前把上游 OpenAI SSE 响应**全部缓冲**、等 DeepSeek 完整生成（含长思考 + 长正文）后才一次性转换为 Anthropic SSE 返回——Claude Code 看不到逐字流式，只能等全部结束后突然闪现整段内容。
  - **新增实时流式转换器（`core/anthropic-openai-converter.js`）**：新增 `streamOpenAIToAnthropic()`——逐 chunk 边收边转，thinking / text 内容到达即实时转为 Anthropic 的 `content_block` 事件输出（思考与正文逐字流式显示）；工具调用（`tool_calls`）因 OpenAI 流式按 index 增量分段传输、需收齐才能拼出完整 input，统一在流末尾批量输出（工具调用通常不长，延迟可接受）。
  - **adapter 接入（`cc-ds-bridge/adapter.js`）**：`makeUpstreamCall` 的流式分支改用 `streamOpenAIToAnthropic`，不再缓冲整流；原有非流式路径与 `convertStreamToAnthropicEvents`（保留，供一次性场景）不变。思考内容原本已能显示（2.7.4 的 thinking 块回传），本次仅修复传输节奏。

## [2.7.6] - 2026-08-04

### Fixed

- **修复 DeepSeek 400「assistant tool_calls 后无对应 tool 消息」**：OpenAI 兼容端点（`/chat/completions`）硬性要求带 `tool_calls` 的 assistant 消息之后必须紧接覆盖每个 `tool_call_id` 的 `tool` 消息，中间不能夹 `user` 消息。两类场景触发：①Claude Code 在同一个 `user` 消息里混排正文文本与 `tool_result` 块，转换时正文被插到 assistant `tool_calls` 与 `tool` 响应之间；②上下文压缩（`/compact`、自动压缩）或历史截断把某轮 assistant 的 `tool_use` 留下、丢掉其后的 `tool_result`，形成孤立 `tool_calls`（或孤立 `tool` 消息）。
  - **转换器修复（`core/anthropic-openai-converter.js`）**：同一条 `user` 消息拆开时 **`tool` 响应排前、正文排后**，保证 `tool` 消息紧邻其 assistant `tool_calls`；新增 `repairToolSequences()` 兜底——压缩/截断残留的未响应 `tool_calls` 从对应 assistant 消息剥离（保留正文与思考内容，连带移除已发出的孤儿 `tool` 消息与 `reasoning_content` 占位符），孤立 `tool` 消息直接丢弃，正常历史原样保留。

## [2.7.5] - 2026-08-04

### Changed

- **新增 `.codebuddy` 项目指南与安装规则**：新增 `.codebuddy/CLAUDE.md`（项目指南，含架构要点、新增上游流程、CLI/配置说明）与 `.codebuddy/rules/cc-bridge-install.md`（运行版本必须从 GitHub Release 的 tgz 全局安装、禁止 `npm link` 的规则），供 CodeBuddy 在项目内读取。

## [2.7.4] - 2026-08-04

### Fixed

- **修复 DeepSeek thinking 模式 tool 结果续接请求 400（全量失败）**：DeepSeek-V4 thinking 模式的硬性要求——请求以 tool 消息结尾（tool 结果续接）时，带 `tool_calls` 的 assistant 消息必须携带 `reasoning_content`，否则返回 400 `The reasoning_content in the thinking mode must be passed back to the API`。2.7.3 引入的 OpenAI 转换链路在两个方向都丢了思考内容：响应侧 `reasoning_content` 未转成 Anthropic `thinking` 块（Claude Code 收不到就无法回传），请求侧 `thinking` 块被错误并入正文文本而非 `reasoning_content` 字段——Claude Code 会话天然以 tool_result 结尾，导致每发必 400。
  - **转换器修复（`core/anthropic-openai-converter.js`）**：响应方向 `reasoning_content` → `thinking` 块（居首，流式发 `thinking_delta`）；请求方向 assistant `thinking` 块 → `reasoning_content` 字段；`tool_calls` 回合缺思考内容时补占位符兜底（修复前产生的旧会话无需新开即可用）；新增 `reasoning_effort` / `thinking.disabled` 透传——此前 `MODEL_THINKING` 配置在 OpenAI 路径静默失效，现在 max / none 真实到达上游。
  - **错误透出修复（`cc-ds-bridge/adapter.js`）**：上游 4xx/5xx 时读取错误响应体并在报错中带出 DeepSeek 的具体 message，排障不再只有一句 "returned 400"。

## [2.7.3] - 2026-08-04

### Fixed

- **修复 DeepSeek 并发 tool_use 返回 400**：DeepSeek 的 Anthropic 兼容端点（`/anthropic`）不支持同一 assistant 消息中包含多个 `tool_use` block（Claude Code 的并行工具调用场景），返回 `API Error: 400 due to tool use concurrency issues`。根因是 DeepSeek 的 Anthropic 兼容层实现缺陷——其 OpenAI 兼容端点（`/chat/completions`）完全支持并发 `tool_calls`。
  - **解决方案**：新增 `core/anthropic-openai-converter.js` 格式转换模块（Anthropic ↔ OpenAI 双向转换：请求体、非流式响应、流式 SSE），DeepSeek adapter 新增 `makeUpstreamCall()` 方法接管上游请求——把 Claude Code 的 Anthropic 请求转为 OpenAI 格式调 DeepSeek OpenAI 端点，再把响应转回 Anthropic 格式，对 Claude Code 完全透明。
  - **框架层扩展**：`core/server.js` 的 `send()` 新增 adapter 接管路径——检测到 adapter 实现 `makeUpstreamCall` 时，把请求控制权交给 adapter（adapter 自行构建 HTTPS 请求、处理上游响应、返回 Anthropic 格式结果），server 拿到结果后走 `handleUpstreamResponse`（注入 modelUsage / 统计 usage）；多 KEY 容灾（重试 / 换 KEY / 熔断）逻辑在 adapter reject 时同样生效。对其它上游（GLM / MiMo 等不实现 `makeUpstreamCall` 的 adapter）无任何影响——走原有透传路径。

### Changed

- **DeepSeek 配置模板与文档同步 OpenAI 端点**：`cc-ds-bridge/ds.env.example` 的 `API_BASE` 默认值从 `https://api.deepseek.com/anthropic` 改为 `https://api.deepseek.com`（基地址，adapter 自动走 OpenAI 端点），注释同步更新；`cc-ds-bridge/README.md` 端点描述改为 OpenAI 兼容端点、配置字段说明和 adapter 接口节补充 `makeUpstreamCall` 说明；中英文 README「按模型配思考等级」节标题与正文补上 DeepSeek（此前只提 GLM）。

## [2.7.2] - 2026-08-03

### Fixed

- **修复 `cc-bridge stats` 输出 token 恒为 0（流式请求）**：流式响应此前只从 `message_start` 事件的 `message.usage` 提取统计，而 Anthropic 规范里该 usage 只含输入侧统计（`input_tokens` / 缓存读写），`output_tokens` 恒为 0——真实输出数在流末尾 `message_delta` 事件的 `usage` 里才返回。DeepSeek 兼容端点严格按规范返回，故 `cc-bridge ds stats` 的 output 列恒为 0（glm 不受影响，因 z.ai 兼容实现在 `message_start` 就带出了 output_tokens）。本次在 `message_delta` 分支补提取 usage：`recordUsage` 新增 partial 模式（只补累计输出侧 token、不重复计请求数），无论是否注入 modelUsage 都解析累计（沿用 [2.7.1] 统计与注入解耦的原则）；`cache_creation_input_tokens` 一并补累计（实测 glm / ds 的 `message_start` 均无 creation，不会重复计数）。

## [2.7.1] - 2026-08-03

### Fixed

- **修复 `cc-bridge stats` 永远无数据（stats 不落盘）**：`core/server.js` 把 usage 统计（`recordUsage`）错误地放在「modelUsage 注入」分支内部——`buildModelUsage()` 在未配置 `CONTEXT_WINDOW` / `MAX_OUTPUT_TOKENS` 时返回 `null`，响应走直接 pipe 的提前返回，统计代码不可达，导致所有上游（glm / ds / mimo，均未配这两个参数）的 stats 快照从未写盘、缓存观测日志也从未输出（2.7.0 引入）。本次将统计与注入解耦：无论 `mu` 是否为 `null`，流式 / 非流式响应都走解析路径累计 usage（流式从 `message_start`、非流式从响应体）；modelUsage 注入保持仅在 `mu` 非空时进行，行为不变。

## [2.7.0] - 2026-08-02

### Added

- **按模型 token 统计（`cc-bridge stats <upstream>`）**：新增 CLI 命令与统计落盘，解决「缓存命中信息只有逐请求日志、无法看累计」的问题——此前每请求虽有 `cache(anthropic/openai)` 日志，但要看总量 / 命中率需自己 grep 日志手工算。
  - **采集（`core/server.js`）**：从上游响应的 `usage` 提取四个指标（输入 token、输出 token、缓存命中 token、缓存创建 token），按 **target 模型 ID** 分别累计；口径与既有 `formatCacheUsage` 一致（Anthropic 风格 `read+created+input` ≈ 总输入，OpenAI 风格 `prompt_tokens` 已含 cached），保证命中率 = 命中 / 总输入在单请求与汇总间一致。流式从 `message_start`、非流式从响应体取 usage；usage 结构无法识别时只计请求数、不计入 token，避免污染命中率口径。
  - **持久化**：内存累计 + 每 30s 节流写盘到 `~/.cc-bridge/stats-<upstream>.json`（随 config 目录，兼容 `$CC_BRIDGE_CONFIG` / `--config` 覆盖），SIGINT/SIGTERM 退出前强制写一次补上尾部数据——daemon 停掉后 `stats` 命令仍能读到最近快照。
  - **展示（新模块 `core/stats.js`）**：`cc-bridge stats <upstream>` 读快照排版输出，按模型分行 + 合计行（reqs / input / cache-hit / hit% / output），附统计时间窗口与文件路径；只读不依赖 daemon 运行。
  - **配套**：`core/config.js` 新增 `statsPathFor`（server 写盘与 CLI 读盘共用同一路径解析）；`bin/cc-bridge.js` 注册 `stats` 命令并更新 HELP；中英文 README 命令列表同步。

## [2.6.0] - 2026-08-01

### Added

- **DeepSeek bridge adapter（`cc-ds-bridge`）**：新增 `cc-ds-bridge/` 目录，含 `adapter.js`、`ds.env.example`、`README.md`，对接 DeepSeek-V4 系列（`deepseek-v4-pro` / `deepseek-v4-flash`），经 DeepSeek 官方 Anthropic 兼容端点（`https://api.deepseek.com/anthropic`）接入。在 `core/adapter.js` 注册表新增 `ds` 条目（`implemented: true`）。
  - **思考等级沿用 GLM 模型**：DeepSeek-V4 思考三态（Non-think / Think High / Think Max）与 GLM 的 `none` / `high` / `max` 一一对应，复用同一套 `MODEL_THINKING` 配置与三字段对称写入逻辑（`thinking.type` + `reasoning_effort` + `output_config.effort`）；默认端口 `8792`（glm 8788 / kimi 8789 / qwen 8790 / mimo 8791 / ds 8792）。
  - **与 GLM/MiMo 的差异**：DeepSeek 官方兼容表明确 `cache_control` 标记为 Ignored（其 Context Caching 是隐式自动的），故 adapter 不在 `tools` 尾部打 `cache_control`（GLM/MiMo 会打），仅剥离客户端的 `cache_control` 以避免请求体膨胀；缓存命中由 framework 从上游 `usage` 旁路观测。`metadata.user_id` 虽被 DeepSeek 支持（做限流隔离），但 CC 传的是设备指纹 / session_id，对单用户限流无意义且泄露隐私，仍清空（与 GLM/MiMo 一致）。
  - **模型上限**：DeepSeek-V4 上下文窗口 1M、单次输出能力充裕（官方未公布精确输出上限，第三方实测 flash 可达 384K），`MODEL_MAX_TOKENS` 钳制值取保守的 128K（与 GLM 一致），确保偶发超大 `max_tokens` 不被上游拒收；旧模型名 `deepseek-chat` / `deepseek-reasoner` 已于 2026/07/24 弃用，仅使用 V4 新名。

### Changed

- **`package.json` 同步**：`files` 数组补入 `cc-ds-bridge`（避免重蹈 [2.5.1] mimo 漏打包导致安装后 `Cannot find module` 的覆辙）；`version` bump 至 2.6.0；`description` / `keywords` 补上 DeepSeek。
- **CLI 帮助文案修正**：`bin/cc-bridge.js` 的 help 由静态的「only 'glm' is implemented so far」（自 [2.4.0] mimo 起即已过时）改为动态列举已实现上游（`listUpstreams().filter(isImplemented)`），新增导入 `isImplemented`。
- **顶层 README upstreams 清单补全**：中英文 README 的「可用上游」表此前遗漏了 `mimo`（[2.4.0] 已实现），本次随 `ds` 一并补入 `mimo` + `ds`；「当前已实现」说明与 Files 表同步更新。

## [2.5.2] - 2026-07-30

### Fixed

- **修复 MiMo 的 MODEL_THINKING 配置验证失败**：`parseModelThinking` 仅接受 GLM 的 `max`/`high`/`none` 等级，但 MiMo 使用 `enabled`/`disabled`。已扩展验证支持两种风格的思考等级。

## [2.5.1] - 2026-07-30

### Fixed

- **修复 `cc-mimo-bridge` 未包含在发布包中**：`package.json` 的 `files` 数组遗漏 `cc-mimo-bridge` 目录，导致 npm 安装后 `cc-bridge mimo start` 报错 `Cannot find module '../cc-mimo-bridge/adapter'`。已补充该目录。

## [2.5.0] - 2026-07-30

### Changed

- **`rollback` 支持指定版本**：`cc-bridge rollback`（或 `--rollback`）现在可以接受可选的版本号参数（如 `cc-bridge rollback 2.3.0`），回退到指定版本；不指定版本时保持原有行为（回退到上一个版本）。`core/update.js` 的 `runRollback()` 函数新增 `targetVersion` 参数；CLI 入口 `bin/cc-bridge.js` 将 `sub[0]` 传递给 `runRollback()`；帮助文本和示例同步更新。

## [2.4.1] - 2026-07-30

### Added

- **CLI `update` / `rollback` 命令**：`cc-bridge update`（或 `--update`）从 GitHub Release 自检并安装最新版 tgz；`cc-bridge rollback`（或 `--rollback`）回退到上一个 Release。依赖 `gh`（GitHub CLI）。实现位于 `core/update.js`，CLI 入口 `bin/cc-bridge.js` 新增对应 case 分支与 help 文本。

## [2.4.0] - 2026-07-30

### Added

- **Mimo bridge adapter**：新增 `cc-mimo-bridge/` 目录，包含 `adapter.js`、`mimo.env.example` 和 `README.md`，支持 Mimo 模型。在 `core/adapter.js` 的注册表中添加了 `mimo` 条目（`implemented: true`）。

## [2.3.0] - 2026-07-29

### Added

- **按模型配置思考等级（`MODEL_THINKING`）**：`~/.cc-bridge/glm.env` 新增 `MODEL_THINKING`（格式 `target->level,...`，取值 `max` / `high` / `none`）与 `MODEL_THINKING_DEFAULT`（未列出模型的兜底等级，默认 `max`），可对每个 GLM target 模型单独钉死思考等级、忽略 Claude Code 的 `/effort` 档位。`none` = 不思考（`thinking.type=disabled` + `reasoning_effort=none` + `output_config.effort=none` 三处对称写入）；`max` / `high` 启用思考并写入对应等级。

### Changed

- **移除全局 `forceMaxEffort` 开关**：原 GLM adapter 的 `forceMaxEffort: true` 一刀切强制所有模型 max 思考，改为按 target 模型查 `MODEL_THINKING` 决定等级；未配置时通过 `defaultThinking: 'max'` 保持原有「全 max」默认行为（向后兼容）。`core/config.js` 新增 `parseModelThinking` 解析；`cc-glm-bridge/adapter.js` 的 `adaptRequestBody` 按 `ctx.target` 查表、三字段对称写入；`core/server.js` 启动时注入配置并更新 banner；同步更新 `glm.env.example` 与全部 README（项目主文档 + glm / qwen / kimi bridge）。

## [2.2.5] - 2026-07-28

### Changed

- **CC 安全分类器改走 agnes 免费模型（双模型容灾）+ 三态开关**：重构分类器路由（取代 2.2.3/2.2.4「路由到 glm-4.5-flash」——后者在 Coding Plan 下仍占额度）。新增 `core/classifier.js`：识别 CC auto mode 安全分类器请求后，由 `CLASSIFIER_MODE` 控制：`on` = 走 agnes 免费模型（`agnes-2.5-flash` 主，请求失败立即切 `agnes-2.0-flash`），Anthropic Messages ↔ OpenAI chat completions 协议转换；`off` = 桥直接伪造 `<block>no</block>` 放行响应，不走任何模型（0 消耗，无安全判断）。分类器高频（约是主对话 3 倍）且原本吃 opus 倍率，是 z.ai Coding Plan 额度大头（~70%）；改走免费 agnes 后这部分 0 成本。agnes 在境外，自动走系统代理（`HTTPS_PROXY` 等）；z.ai 境内直连不变。`server.js` 在转发前拦截分类器请求；`adapter.js` 移除 2.2.4 的 flash 路由（分类器不再经 adapter）。

### Added

- **配置项**（`glm.env`，示例见 `glm.env.example`）：`CLASSIFIER_MODE`（on/off，默认 off）、`AGNES_API_BASE`、`AGNES_API_KEY`、`AGNES_MODEL_PRIMARY`、`AGNES_MODEL_FALLBACK`。
- **依赖**：`https-proxy-agent`（agnes 走系统代理用；node 的 https 不像 curl 自动读 HTTPS_PROXY）。

## [2.2.4] - 2026-07-28

### Fixed

- **修复 CC 安全分类器路由漏判**：2.2.3 引入的 `isClassifierRequest` 原用 `startsWith` 识别分类器 system，但 CC 发来的 system 第一个 block 是 billing header（`x-anthropic-billing-header:`），join 后字符串以 billing 开头，`startsWith("You are a security monitor...")` 漏判，导致分类器请求仍走 glm-5.2（没路由到 flash）。改为 `includes` 后正确识别（这段文字足够特定，不会误判其它请求）。即 2.2.3 的路由实际未生效，2.2.4 才真正让分类器走 glm-4.5-flash。

## [2.2.3] - 2026-07-28

### Changed

- **CC auto mode 安全分类器路由到 glm-4.5-flash**：`cc-glm-bridge/adapter.js` 新增 `isClassifierRequest()`，识别请求 system 以 "You are a security monitor for autonomous AI coding agents" 开头的 CC auto mode 安全分类器请求，将其从 glm-5.2 路由到免费的 glm-4.5-flash。CC auto 模式下，主 agent 每次工具调用前都会发一个请求给安全分类器判断该动作是否该 block——它高频（约是主对话请求数的 3 倍）且用 opus 倍率（高峰 3×、非高峰 2×），是 z.ai Coding Plan 额度消耗的大头（实测占 ~70%）。分类器属判断任务，不需要 glm-5.2 顶配，换 flash 后这部分不再消耗 Coding Plan 额度（flash 免费）。代价：安全判断降级到轻量模型（明显危险动作仍能拦，复杂 prompt injection 可能漏判，需使用者权衡）。同时，分类器走 flash 时不再强制 max reasoning（退回跟随客户端 effort），与 CC 自身「减少分类器 reasoning」的优化方向一致，降低分类器延迟。

## [2.2.2] - 2026-07-28

### Added

- **响应侧缓存命中观测日志**：`core/server.js` 新增 `formatCacheUsage()`，从上游响应的 usage 对象提取缓存命中信息（命中读取 / 写入 token 数、命中率），在 streaming 的 `message_start` 事件与 non-streaming 响应体里旁路记日志，不改写任何请求 / 响应内容。兼容 Anthropic 风格（`cache_read_input_tokens` / `cache_creation_input_tokens`）与 OpenAI 风格（`prompt_tokens_details.cached_tokens`）两种 usage 字段；上游未返回缓存字段时列出 usage 的 keys 便于诊断。受 `PROXY_LOG` 控制，关闭时零开销。用途是长期观测上游 context caching 是否生效、命中率随对话如何变化、上游规则是否变动——部分上游（如 z.ai）的缓存是隐式的（按内容相似度自动匹配、不读 `cache_control`），所以观测缓存的正确方向是看 usage，而非在请求体打 `cache_control`。

### Changed

- **`glm.env.example` 补充 `PROXY_DUMP` 配置说明**：模板顶部字段说明与配置块补上 `PROXY_DUMP`（改写后的请求体落盘到 `~/.cc-bridge/dumps/`，默认关、调试用），与 `core/server.js` 已有的 dump 能力对齐。

## [2.2.1] - 2026-07-27

### Fixed

- **GLM 配置模板 `API_BASE` 补上 `/api/anthropic` 路径前缀**：`cc-glm-bridge/glm.env.example`、`README.md`、`README.zh-CN.md` 里的 `API_BASE` 默认值由 `https://api.z.ai` 修正为 `https://api.z.ai/api/anthropic`。原值缺路径前缀，桥接把请求转发到 `https://api.z.ai/v1/messages`——z.ai 网关返回 HTML 404 页面，Claude Code 解析不了非 JSON 响应，抛出笼统的「selected model ... may not exist or you may not have access to it」（首次配置即不可用）。补上 `/api/anthropic` 后请求正确落到 z.ai 的 Anthropic 兼容端点 `https://api.z.ai/api/anthropic/v1/messages`。已按旧模板生成配置的用户：把 `~/.cc-bridge/glm.env` 的 `API_BASE` 改为 `https://api.z.ai/api/anthropic` 后 `cc-bridge restart` 即可。

## [2.2.0] - 2026-07-27

### Changed

- **`cc-bridge start` 改为后台启动**：`start` 不再以前台阻塞方式运行，改为与 `daemon` 一致的后台 detached 模式（调用 `startDaemon`）。`daemon` 命令保留为 `start` 的别名，两者行为完全一致，已有脚本与文档里的 `cc-bridge daemon` 不受影响。前台直接运行的能力收为内部隐藏命令 `_serve`（调试 / 直接 spawn 兜底用），用户面不再暴露前台启动方式。

## [2.1.2] - 2026-07-27

### Fixed

- **GLM 默认端口模板修正为 8788**：`cc-glm-bridge/glm.env.example` 的 `PROXY_PORT` 由 8787 改为 8788。8787 与仍服务主链路的旧 claude-proxy 冲突——复制模板生成 `~/.cc-bridge/glm.env` 时若忘改端口，cc-bridge daemon 会与 claude-proxy 抢同一端口，且 `cc-bridge restart` 会把 claude-proxy 当残留清掉。改为 8788 后两者并行不撞。
- **三上游默认端口顺延、互不冲突**：Kimi 模板 8788→8789、Qwen 模板 8789→8790，给 GLM 让出 8788；三个上游默认端口连续（GLM 8788 / Kimi 8789 / Qwen 8790），并存时各不撞。

### Changed

- **模板文件名改为 `<upstream>.env.example`**：三个上游的配置模板由 `.env.example` 重命名为 `<upstream>.env.example`（即 `glm.env.example` / `kimi.env.example` / `qwen.env.example`），与运行配置 `~/.cc-bridge/<upstream>.env` 命名对齐——看到模板名就知道它生成哪个运行配置。`core/config.js` 的 `templatePath()` 同步改为查找 `<upstream>.env.example`，各 README / 子目录 README 引用一并更新。
- **模板标注运行配置绝对路径**：三个 `cc-*-bridge/<upstream>.env.example` 顶部注明该上游运行配置最终落地路径（GLM → `~/.cc-bridge/glm.env`、Kimi → `~/.cc-bridge/kimi.env`、Qwen → `~/.cc-bridge/qwen.env`），避免复制模板后找错文件位置。

## [2.1.1] - 2026-07-27

### Added

- **API_KEY 编号变量写法**：`~/.cc-bridge/<upstream>.env` 里的 API KEY 除原逗号分隔写法（`API_KEY=k1,k2`）外，新增编号变量写法 `API_KEY_1=…` / `API_KEY_2=…` / `API_KEY_3=…`（每个 KEY 独立成行）。这样每个 KEY 可单独写注释标注账号来源，也可整行注释掉临时禁用某个 KEY——比在一长串逗号串里增删某个值方便。两种写法可混用、合并去空（编号变量在前、按数字大小升序排列，旧式 `API_KEY` 的值追加其后）。由 `core/config.js` 新增的 `collectKeys()` 统一收集。

### Changed

- **配置模板与文档同步**：三个 `cc-*-bridge/.env.example` 模板默认改为 `API_KEY_1` / `API_KEY_2` 编号写法（顶部字段说明、配置块、旧式写法兼容提示一并更新）；中英文 README 的「多 KEY 容灾」特性段与章节、配置示例、`ANTHROPIC_API_KEY` 提取脚本（改为 `grep -E '^API_KEY' … | head -1`，兼容编号变量与老式逗号串）一并更新。
- **validate 缺失提示**：未配任何 KEY 时，缺失项提示由 `API_KEY` 改为 `API_KEY_1 (or legacy API_KEY)`，指明推荐写法。

### 向后兼容

- 旧式 `API_KEY=k1,k2`（逗号分隔）仍完全支持，已有配置无需改动。

## [2.1.0] - 2026-07-25

新增「单上游多对模型映射」（MODEL_MAP），替代原单对 SPOOF_MODEL / TARGET_MODEL；配置模板按上游下沉到各 `cc-<name>-bridge/` 子目录。

### Added

- **MODEL_MAP 多对模型映射**：`MODEL_MAP` 支持逗号分隔的多对 `spoof->target`（如 `claude-opus-4-8->glm-5.2,claude-haiku-4-5->glm-5.2`），同一上游可把多个 Claude 白名单模型路由到真实模型——例如 opus 做主力、haiku 做轻量任务，两对都指向 glm-5.2。第一对约定为「主力对」，决定 `cc-bridge <upstream> claude` 启动 claude 时的默认模型。由 `core/config.js` 的 `parseModelMap()` 解析、`resolvePairs()` 派生路由对（供 server 与 daemon 共用）。旧的数字后缀多 pair（v2.0.0 移除的 `API_BASE_2` / `SPOOF_MODEL_2`）以显式、可读的 MODEL_MAP 形式回归。

### Changed

- **请求路由支持多对**：`core/server.js` 在 pairs 里查 `obj.model`——命中某对的 spoof 改写为该对 target、命中某对的 target 原样直传、都不命中返回 400（错误信息列出所有合法模型，绝不静默改写）。`modelUsage` 注入用所有出现过的 spoof / target 名作 key，确保多对时 CLI 取到哪个名都能命中真实上下文窗口。
- **配置模板按上游下沉**：`.env.example` 从仓库根目录移到各上游子目录 `cc-<name>-bridge/.env.example`；`core/config.js` 的 `templatePath(upstream)` 按 adapter 注册表定位对应模板，`ensureConfig` 首次生成 `~/.cc-bridge/<upstream>.env` 时复制该上游模板（找不到则写占位注释）。
- **向后兼容**：旧式单对写法 `SPOOF_MODEL` / `TARGET_MODEL` 仍完全兼容（等价于 MODEL_MAP 只写一对），已有配置无需改动。
- **banner 多对展示**：daemon 与 server 启动 banner 由 `resolvePairs(cfg, adapter)` 统一派生，展示多对 `spoof → target`（`|` 分隔）。

## [2.0.0] - 2026-07-24

重大重构：项目从「多上游模型代理（claude-proxy）」演化为「Claude Code 上游桥接框架（CC-BRIDGE）」。框架与上游适配器分层：通用逻辑在 `core/`，每个上游一个 `<name>-bridge/adapter.js`，先实现 GLM（z.ai GLM-5.2），预留 Kimi / Qwen。这是破坏性变更（breaking change），版本号升至 2.0.0。

### Added

- **CC-BRIDGE 框架 + adapter 架构**：新增 `core/`（server / adapter / config / daemon / claude / util）承载与上游无关的通用逻辑，上游专属逻辑（请求体适配、effort 映射、模型上限表）由各 `<name>-bridge/adapter.js` 实现统一接口（`name` / `displayName` / `defaultTarget` / `defaultSpoof` / `forceMaxEffort` / `modelMaxTokens` / `adaptRequestBody(obj, ctx)`）。新增上游只需加一个 adapter 文件 + 注册表（`core/adapter.js`）一行，框架、CLI、daemon 无需改动。
- **GLM adapter（glm-bridge/adapter.js）**：对接 z.ai GLM-5.2，移植原 z.ai 请求体适配（thinking 归一化、剥离 context_management / cache_control / Anthropic 专有 system 段、max_tokens 钳制、tools 尾部 cache_control）。
- **强制 GLM-5.2 始终 max 思考**：GLM adapter 设 `forceMaxEffort: true`，每条请求都强制 `reasoning_effort = max` + `output_config.effort = max` + `thinking.type = enabled`（三条保险），不受 Claude Code 的 `/effort` 档位影响。
- **多 API_KEY 容灾**：`API_KEY` 支持逗号分隔配置多个（推荐至少 2 个，共用同一 `API_BASE`）。某 KEY 返回 `401`/`403`（失效 / 欠费）时，桥熔断该 KEY 60 秒并立即切换下一个 KEY；瞬态错误（`429`/`5xx`/网络）先同 KEY 退避重试（`[200, 500]` ms）至多 2 次、用尽再换。所有 KEY 试遍才返回错误。URL 不变，只轮换 KEY。实现：`core/server.js` 的 `pickNextKey()` / `send()` + `KEY_BLOCK_SECONDS` 熔断表。
- **CLI `[upstream] <command>`**：`cc-bridge [upstream] <command>`，upstream 省略时默认 `glm`，可显式 `cc-bridge glm start` / `cc-bridge kimi start`（未实现上游会报错）。
- **按上游隔离的配置 / pid / 日志**：每个上游独立配置 `~/.cc-bridge/<upstream>.env`、pid 文件 `<upstream>.pid`、日志 `<upstream>.log`，多个上游可作为 daemon 并存（各用不同 `PROXY_PORT`）。
- **预留上游目录**：`kimi-bridge/`、`qwen-bridge/`（含 README 占位 + 扩展指南），`core/adapter.js` 注册表里 `implemented: false`。

### Changed

- **改名 cc-bridge**：CLI 命令、npm 包名、配置目录（`~/.cc-bridge/`）、环境变量（`$CC_BRIDGE_UPSTREAM` / `$CC_BRIDGE_CONFIG`）、日志前缀（`[bridge]`）全部由 `claude-proxy` 改为 `cc-bridge`。旧 `~/.claude-proxy/.env` 不再读取，需迁移到 `~/.cc-bridge/glm.env`。
- **目录结构调整**：`lib/` → `core/`（公共框架）；上游专属逻辑移入 `glm-bridge/`；新增 `kimi-bridge/`、`qwen-bridge/` 预留目录。
- **GitHub 仓库 rename**：`xhqing/claude-proxy` → `xhqing/CC-BRIDGE`。

### Removed

- `lib/openai-bridge.js`（OpenAI 格式互转层）与 `FORMAT` 配置项。
- 多 pair 路由（`API_BASE_2` / `SPOOF_MODEL_2` 数字后缀、`spoofToPair` / `targetToPair` 路由表）。
- SiliconFlow / MiMo 专用适配分支（已随多上游移除）。

### Migration（从 1.x 升级）

1. 卸载旧 `claude-proxy`，安装新版（`npm install -g cc-bridge-<版本>.tgz`）。
2. 迁移配置：把旧 `~/.claude-proxy/.env` 复制为 `~/.cc-bridge/glm.env`（或 `cc-bridge glm config --import <旧路径>`），把单条 `API_KEY` 改成逗号分隔的两条 z.ai KEY。
3. 删除所有 `_2` / `_3` 后缀的多 pair 配置和 `FORMAT` 行（不再支持）。
4. 命令由 `claude-proxy ...` 改为 `cc-bridge ...`（默认上游 glm，等价于 `cc-bridge glm ...`）。

## [1.1.1] - 2026-07-10

### Added

- **`claude-proxy --version` 命令**：支持 `version` / `-v` / `--version` 三种写法查询版本，从 `package.json` 读取版本号输出（如 `claude-proxy 1.1.1`），并补进 `help` 文本。便于在正式安装（非 `npm link`）环境下确认运行版本。

## [1.1.0] - 2026-07-10

针对「分类器间歇中断」故障（`claude-opus-4-8` 直连 `api.z.ai` 的链路抖动，被无 fallback 的单点路由放大为整体不可用）做可用性提升与可观测性改进。

### Added

- **同 pair 瞬态自动重试**：上游遇瞬态错误（`ENOTFOUND` / `ETIMEDOUT` / `ECONNRESET` / `EPIPE` / `socket hang up` / `timeout`，或 `429` / `5xx`）时，在同一 pair 上按 `UPSTREAM_RETRY_DELAYS = [200, 500]` 指数退避重试至多 2 次（共 3 次尝试），吸收毫秒级短抖动，降低分类器等短请求撞上断连窗口导致 `temporarily unavailable` 的概率。重试严格卡在「拿到首个上游响应之前」（尚未向客户端写响应头），一旦开始流式写回就不再切换，避免半截流。实现：`lib/server.js` 的 `isTransient()` / `handleUpstreamResponse()` / `attempt()`。非瞬态错误（`4xx` 业务错误）不重试，按原逻辑返回。注：跨 pair fallback（z.ai → SiliconFlow GLM-5.2）本次未实现，仍为后续治本项。
- **proxy.log 时间戳**：每行日志加 ISO 时间戳前缀（如 `[proxy 2026-07-10T02:08:14.123Z] POST /v1/messages ...`），便于把运行日志与实时故障逐请求对齐定位。

### Changed

- **dump 目录迁移**：`PROXY_DUMP=1` 写出的请求体 dump 从项目目录 `dumps/` 改为 `~/.claude-proxy/dumps/`（与 `proxy.log` / pid 同处），不再污染项目目录；路径由 `path.dirname(cfg.configPath)` 派生，兼容 `$CLAUDE_PROXY_CONFIG` 覆盖。同步更新 `README` / `README.zh-CN`，并在 `.gitignore` 增加 `dumps/`。

## [1.0.0] - 2026-07-07

首个正式版本。

### Added

- **透明 effort 解锁代理**：本地代理（默认 `127.0.0.1:8787`），通过给 Claude Code 喂白名单伪模型 ID（如 `claude-opus-4-8`），绕过客户端 effort 闸门，让第三方模型网关也能用 `/effort xhigh`。消息结构 / 工具调用 / SSE 事件 / `output_config.effort` 全部原样透传，只改写 `body.model`。
- **多上游 / 多模型对**：支持同时配置多对 `SPOOF_MODEL` ↔ `TARGET_MODEL`（数字后缀 `_2`、`_3`…），按 Claude Code 选择的伪 ID 路由到对应上游；**未知模型 HTTP 400 拒绝**，绝不静默改写到默认对。
- **双格式支持**：Anthropic 原生（`/v1/messages` 透传）与 OpenAI 兼容（`/v1/chat/completions`，由 `lib/openai-bridge.js` 做请求 / 响应 / 流式 SSE 格式互转，含 `reasoning_content` → `thinking` 块）。
- **请求体改写**（`rewriteBody`）：`thinking.type` 归一化为 `enabled`、按 effort 等级映射 `reasoning_effort`、剥离 `context_management` / `cache_control` / Anthropic 专有 system 段、`max_tokens` 钳到目标模型上限、tools 尾部打 `cache_control` 触发上游 context caching、SiliconFlow 强制 `thinking_budget` 上限、MiMo 强制 `reasoning_effort=high`。
- **modelUsage 注入**：把配置的 `contextWindow` / `maxOutputTokens` 注入响应的 `message_delta`（双 key：spoof + target），让 Claude Code webview 显示正确的上下文窗口。
- **后台 daemon 管理**：`claude-proxy daemon / stop / restart / status / logs`，detached 子进程 + pid 文件 + 日志文件。
- **用户级配置**：`~/.claude-proxy/.env`（gitignored，绝不打包进 npm 包），`claude-proxy config` 用 `$EDITOR` 编辑 / `--import` 从项目 `.env` 迁移 / `show` 脱敏打印 / `path` 打印路径。
- **一键启动**：`claude-proxy claude [args]` 启动代理 + 通过它启动 `claude` 并自动设好环境变量，退出自动清理代理。

### Fixed

- **流式 SSE 响应的 UTF-8 多字节字符处理**：原先对单个 chunk 做 `chunk.toString('utf-8')`，当中文（3 字节 / 字）被切在两个 chunk 边界时会解码失败产生 U+FFFD（??）乱码；改用 `TextDecoder('utf-8')` 的 stream 模式（`decoder.decode(chunk, { stream: true })`，`upRes.on('end')` 时 `decoder.decode()` flush 剩余字节），跨 chunk 字节自动接续，不再损坏。修复点：`lib/server.js` 流式 SSE 拦截段（注入 modelUsage 那条路径）+ `lib/openai-bridge.js` 的 `createStreamConverter.feed`。
