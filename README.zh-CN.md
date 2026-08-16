<div align="center">
  <img src="assets/logo.svg" alt="CC-Bridge" width="640">
</div>

# CC-Bridge —— Claude Code 上游桥接框架

> [English](README.md)

<div align="center">

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Built with Claude Code](https://img.shields.io/badge/Built%20with-Claude%20Code-19C37D)
![Type: Project](https://img.shields.io/badge/Type-Project-lightgrey)

</div>

一个本地透明桥接框架，让 **Claude Code 访问第三方模型上游**（GLM / Kimi / Qwen ……）。每个上游在独立的 `<name>-bridge/` 目录下有一个 adapter 模块，共享同一套框架（`core/`）。**思考等级直接在 cc-bridge 的配置文件中配置**（`MODEL_THINKING`，见[按模型配思考等级](#按模型配思考等级glm--deepseek)）——Claude Code 的 `/effort` 选任何等级都不影响实际上游模型的思考等级；同时支持**多 API_KEY 容灾**。

> **当前已实现：** `glm`（GLM-5.3，z.ai 国际版 / 智谱 bigmodel.cn 国内版）、`ds`（DeepSeek-V4）、`mimo`（小米 MiMo）。`kimi` / `qwen` 为预留占位——见[添加新上游](#添加新上游)。

安装一次后，在**任意目录**下用一条命令即可启动：`cc-bridge`。

## 可用上游

| 上游 | 状态 | adapter | 目标模型 |
|------|------|---------|----------|
| `glm` | ✅ 已实现 | [glm-bridge/](glm-bridge/) | GLM-5.3（z.ai / 智谱 bigmodel.cn） |
| `ds` | ✅ 已实现 | [ds-bridge/](ds-bridge/) | DeepSeek-V4（pro / flash） |
| `mimo` | ✅ 已实现 | [mimo-bridge/](mimo-bridge/) | 小米 MiMo-V2.5-Pro |
| `kimi` | 🚧 预留 | [kimi-bridge/](kimi-bridge/) | — |
| `qwen` | 🚧 预留 | [qwen-bridge/](qwen-bridge/) | — |

## 它能做什么

- **框架 + 按上游分 adapter。** 所有与上游无关的通用逻辑（HTTP 服务、多 KEY 容灾、model 改写、modelUsage 注入、daemon）都在 [`core/`](core/)；每个上游的专属逻辑（请求体适配、思考等级映射、模型上限表）在各自的 `<name>-bridge/adapter.js`。新增上游只需加一个文件 + 注册表一行。
- **思考等级配置文件配置。** 每个 target 模型通过 `~/.cc-bridge/<upstream>.env` 里的 `MODEL_THINKING` 钉死一个思考等级（如 `max` / `high` / `none`，未列出的模型走 `MODEL_THINKING_DEFAULT`，默认 `max`）。思考等级由桥接配置决定，**Claude Code 的 `/effort` 选任何等级都不影响实际上游模型的思考等级**。（见[按模型配思考等级](#按模型配思考等级glm--deepseek)。）
- **多 KEY 容灾。** 把多个 KEY 各自成行配成编号变量（`API_KEY_1=…`、`API_KEY_2=…`…，每行一个，方便单独注释账号来源、或整行注释掉禁用某 KEY；旧式逗号分隔 `API_KEY=k1,k2` 仍兼容）。某 KEY 返回 `401`/`403`（被拒 / 额度用尽）时，桥把它熔断 60 秒并立即切换下一个 KEY；瞬态错误（`429`/`5xx`/网络）先在同 KEY 重试、用尽再换。KEY 按 `API_KEY_n_PRIORITY` 优先级从高到低使用（不配则按编号顺序），主力 KEY 熔断才落备用、到期自动回切。URL 始终不变，只轮换 KEY。（见[多 KEY 容灾](#多-key-容灾)。）
- **按上游隔离。** 每个上游有独立配置（`~/.cc-bridge/<upstream>.env`）、pid 文件、日志文件，多个上游可作为 daemon 并存（用不同 `PROXY_PORT`）。
- **零运行时依赖。** 仅用 Node ≥ 14 内置模块。

## 工作原理

```
                              ┌── KEY #1 ──┐
Claude Code ──POST /v1/messages──▶  cc-bridge (127.0.0.1:8787)
  model = <伪模型 ID>               · 改写 body.model → 真实模型      ├── KEY #2 ──┤  上游 · 目标模型
                                    · adapter.adaptRequestBody(body)  │  (容灾切换) │
                                    · 遇 401/403 → 切换下一个 KEY    └────────────┘
                                    · 向响应注入 modelUsage
```

上游由 `<upstream>` 参数选定（默认 `ds`）。桥加载 `core/adapter.js` → 对应上游的 `adapter.js`，对每条转发的请求应用该 adapter 的 `adaptRequestBody`。

## 前置条件

- **Node.js ≥ 14** 和 **npm**，在 PATH 中可用。
  - Homebrew 用户：如果 `which node` 没输出，说明 keg 没链接。运行 `brew link --overwrite node@22`，并确保 `/opt/homebrew/bin` 在 PATH 中。

## 安装

CC-Bridge 以构建好的 tarball 发布在 GitHub Release（仓库为公开，可用 `gh` 或 `curl` 下载）：

```bash
gh release download v2.0.0 --pattern 'cc-bridge-2.0.0.tgz' --dir /tmp --clobber
npm install -g /tmp/cc-bridge-2.0.0.tgz
```

> 权限不足？用 `sudo npm install -g …`，或者一次性设一个用户可写的前缀（`npm config set prefix ~/.local`，确保 `~/.local/bin` 在 PATH 中）后再不带 sudo 运行。

安装后，`cc-bridge` 就在 PATH 中，任意目录可用。安装过程会自动在 `~/.cc-bridge/` 下准备好默认上游的 `ds.env`（内容即 `ds.env.example` 的副本），填好 API key 即可直接 `cc-bridge start`；若该文件已存在则原样保留、不会覆盖。

## 配置

每个上游的配置位于 `~/.cc-bridge/<upstream>.env`（用户级，任意工作目录都能找到）。GLM：

```bash
cc-bridge glm config        # 用 $EDITOR 打开 ~/.cc-bridge/glm.env（首次运行从模板生成）
cc-bridge glm config show   # 打印当前值（API_KEY 脱敏）
cc-bridge glm config path   # 打印配置文件路径
cc-bridge glm config --import /path/to/.env   # 迁移已有 .env
```

```ini
# ~/.cc-bridge/glm.env  — GLM（z.ai 国际版 + 智谱 bigmodel.cn 国内版）
# 多端点：每个 KEY 绑定各自的端点；KEY 轮换天然跨端点容灾（z.ai 的 KEY 失效
# 自动切到智谱的 KEY）。
API_BASES=zai->https://api.z.ai/api/anthropic,cn->https://open.bigmodel.cn/api/anthropic
# 每个 KEY 单独一行——可在上方注释账号来源，整行注释掉即禁用该 KEY。
# 旧式逗号分隔 API_KEY=k1,k2 仍兼容；单端点写 API_BASE=URL 也完全兼容。
# KEY_NAME  = 用量统计的展示名（cc-bridge stats 按 key-name 分类）；同一配置内
#             不能重复；KEY 本身不显示、不落盘。
# KEY_BASE  = 该 KEY 用上面 API_BASES 里的哪个端点（不配则用第一个）。
# KEY_PRIORITY = 优先级（非负整数，越大越先用）：高优先级 KEY 先用，它熔断 / 失效后
#             才轮到低优先级 KEY（同优先级按编号顺序）。全部不配则按编号顺序（旧行为）。
# 账号 A（z.ai Coding Plan，主力）
API_KEY_1=your_zai_key_1
API_KEY_1_NAME=zai-work
API_KEY_1_BASE=zai
API_KEY_1_PRIORITY=10
# 账号 B（智谱 bigmodel.cn，备用）
API_KEY_2=your_zhipu_key_2
API_KEY_2_NAME=zhipu-cn
API_KEY_2_BASE=cn
# MODEL_MAP：spoof->target 映射对（逗号分隔）。opus 是 Claude Code 主力模型、haiku 是
# 轻量模型——两对都指向 glm-5.3。第一对是「主力对」（启动 claude 时的默认模型）。
# 旧式单对 SPOOF_MODEL / TARGET_MODEL 仍向后兼容。
MODEL_MAP=claude-opus-4-8->glm-5.3,claude-haiku-4-5->glm-5.3
PROXY_PORT=8787
PROXY_LOG=1                             # 0 关闭每请求日志
```

> **路由：** `MODEL_MAP` 把一个或多个 spoof ID 映射到真实模型（`spoof->target` 对）。传入的 `model` 命中某对 spoof 时改写为该对的 target；已是某对 target 时原样透传。其余一律**被 HTTP 400 拒绝**，绝不静默改写。旧式单对 `SPOOF_MODEL` / `TARGET_MODEL` 仍向后兼容（等价于一对）。

## 用法

```bash
cc-bridge start           # 默认上游（ds），后台（detached）
cc-bridge daemon          # start 的别名（后台）
cc-bridge claude [args]   # 启动桥接 + 启动指向它的 claude
cc-bridge stop            # 停止后台服务
cc-bridge restart         # 重启后台服务（stop + start）
cc-bridge status          # 查看运行状态
cc-bridge stats           # 用量统计：所有上游合并呈现（按 KEY 名 + 按模型）
cc-bridge <upstream> stats  # 用量统计：单上游明细
cc-bridge logs            # 查看桥接日志（Ctrl-C 退出）
cc-bridge health          # 探测 /health
cc-bridge set default upstream [name]  # 查看 / 设置默认上游
cc-bridge help            # 完整帮助

cc-bridge glm start       # 显式指定上游
cc-bridge kimi start      # 预留上游 → 提示「未实现」

cc-bridge set default upstream glm  # 把 glm 设为裸命令的默认上游
cc-bridge set default upstream      # 查看当前默认上游
cc-bridge set default upstream --reset  # 恢复内置默认（ds）
```

> **默认上游：**不带 `<upstream>` 的命令（`cc-bridge start`、`cc-bridge restart` …）作用于默认上游。内置默认是 `ds`；`set default upstream` 把你的选择持久化到 `~/.cc-bridge/default-upstream`（只接受已实现的上游），之后所有裸命令都跟随它。`--reset` 清除该文件、恢复内置默认。

`cc-bridge claude` 只为那次 `claude` 进程导出桥接环境变量，并在退出时清理桥接：

```bash
cc-bridge claude -p "hello"
cc-bridge claude -- -p "hello"   # 也接受 "--" 分隔符
```

### 让 claude 持久使用桥接

`cc-bridge`（start / daemon）只在后台运行服务——你平常的 `claude` 不会自动用它。任选其一：

- **单次会话：** `cc-bridge claude`（自动处理环境变量 + 清理）。
- **手动（服务已运行时）：**
  ```bash
  export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
  export ANTHROPIC_API_KEY="$(grep -E '^API_KEY' ~/.cc-bridge/glm.env | head -1 | cut -d= -f2- | cut -d, -f1 | tr -d '\"')"
  export ANTHROPIC_MODEL=claude-opus-4-8
  claude
  ```
  （桥接会轮换自己配置的 KEY；这里的 `ANTHROPIC_API_KEY` 只需非空，让 claude CLI 肯发请求。）
- **持久：** 在 `~/.claude/settings.json` 的 `env` 块里设置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL`。（此时 `claude` 只在桥接运行时才能用。）

思考等级在 `~/.cc-bridge/<upstream>.env` 的 `MODEL_THINKING` 里配置（见[按模型配思考等级](#按模型配思考等级glm--deepseek)）——不需要在 `claude` 里设置 `/effort`，`/effort` 选任何等级都不影响实际上游模型的思考等级。桥接会记录每个请求，包括当前用的 KEY：

```
[bridge 2026-07-24T03:00:00.000Z] POST /v1/messages  model=claude-opus-4-8 → glm-5.3  effort=xhigh  stream=true  key=#1/2
[bridge …]   ← 200  812ms  ct=text/event-stream  key=#1
```

（日志里的 `effort` 字段只记录客户端传来的档位、仅供诊断——实际思考等级由 `MODEL_THINKING` 配置钉死。）

## 多 KEY 容灾

把多个 KEY 各自成行配成编号变量（`API_KEY_1=…`、`API_KEY_2=…`、`API_KEY_3=…`，每行一个；旧式逗号分隔 `API_KEY=k1,k2,k3` 也兼容），共用同一个 `API_BASE`。桥按下列规则决定是否轮换 KEY：

| 上游信号                                   | 桥接的动作                                                        |
|--------------------------------------------|-------------------------------------------------------------------|
| `401` / `403`（KEY 失效 / 额度用尽）       | 熔断此 KEY 60 秒，**立即**切换到下一个 KEY 重试                    |
| `429` / `5xx` / 网络瞬态错误               | 先在**同一** KEY 上重试（至多 2 次，200 ms / 500 ms 退避）；仍失败再切换到下一个 KEY |
| `400` / `404`（非瞬态业务错误）            | 原样返回客户端——换 KEY 无济于事                                    |
| 所有 KEY 都试遍仍失败                      | 把最后的错误返回客户端（401/403 → `authentication_error`，其余 → `api_error`） |

- **熔断是软优化，不是硬约束。** 被 `401`/`403` 判死的 KEY 会被跳过 60 秒，避免每条请求都先撞一次已知坏 KEY。60 秒后重新尝试。若所有 KEY 恰好都在熔断期，仍会挑一个相对可用的试。
- **瞬态错误不熔断 KEY。** `5xx` 或网络抖动是网关问题，不是 KEY 的错——不连累无辜 KEY。
- **KEY 优先级。** 每个 KEY 可配 `API_KEY_n_PRIORITY`（非负整数）。KEY 按优先级从高到低依次使用；同优先级按编号顺序，未配视为 0。这样轮换顺序就成了「主力 / 备用」关系：最高优先级的 KEY 承接全部流量，直到它熔断才落到备用 KEY；熔断 60 秒到期后自动回切主力。全部不配 `PRIORITY` 则保持纯编号顺序（旧行为）。
- **重试有界。** 每条请求最多尝试 `KEY 数 ×（1 + 2 次重试）` 次，容灾总会终止。

## 按模型配思考等级（GLM / DeepSeek）

每个 target 模型通过上游配置里的 `MODEL_THINKING` 钉死一个思考等级（如 `~/.cc-bridge/glm.env` 里 `MODEL_THINKING=glm-5.3->max,glm-4.6->none`，或 `~/.cc-bridge/ds.env` 里 `MODEL_THINKING=deepseek-v4-flash->max`），取值 `max` / `high` / `none`（`none` = 不思考）。⚠️ `none` 只在 GLM 等认「不思考」的上游可用；DeepSeek `/anthropic` 端点的 `output_config.effort` 枚举不认 `none`，配了请求会 400（2026-08-10 实测），只能配 `max` / `high`。每条请求 adapter 按 target 模型查等级，对称写入三个字段——`thinking.type`（`enabled`/`disabled`）、`reasoning_effort`、`output_config.effort`——从而钉死等级：Claude Code 的 `/effort` 选任何等级都不影响实际上游模型的思考等级。未列出的模型走 `MODEL_THINKING_DEFAULT`（默认 `max`，由 adapter 的 `defaultThinking` 设定）。

## 添加新上游

CC-Bridge 就是为扩展而设计的。新增一个上游（如 `kimi`）：

1. **创建 adapter** `kimi-bridge/adapter.js`，实现 adapter 接口（见 [glm-bridge/adapter.js](glm-bridge/adapter.js) 和 [core/adapter.js](core/adapter.js) 的注释）：
   - `name`、`displayName`、`defaultTarget`、`defaultSpoof`
   - `defaultThinking`（默认思考等级：`max` / `high` / `none`）
   - `modelMaxTokens`（`{ 模型ID: 最大输出token }`）
   - `adaptRequestBody(obj, ctx)`——为该上游适配 Anthropic 请求体；`ctx = { target }`
2. **注册** 在 [core/adapter.js](core/adapter.js) 里把 `kimi` 的 `implemented` 改为 `true`。
3. **文档** 写 `kimi-bridge/README.md`，按需补配置模板。

完成——框架、CLI、多 KEY 容灾、daemon 全部无需改动即可工作。用户随后用 `cc-bridge kimi start`、编辑 `~/.cc-bridge/kimi.env` 等。

## 文件

| 路径                      | 用途                                              |
|---------------------------|---------------------------------------------------|
| `bin/cc-bridge.js`        | CLI 入口——`[upstream] <command>` 分发             |
| `core/server.js`          | 桥接服务器：model 改写、多 KEY 容灾、modelUsage 注入 |
| `core/adapter.js`         | 上游注册表 + adapter 加载器                        |
| `core/config.js`          | 按上游的配置查找 / 编辑 / 导入 / 展示              |
| `core/daemon.js`          | 后台进程管理（按上游的 pid + 日志）                |
| `core/claude.js`          | 启动桥接 + 通过它启动 `claude`                    |
| `core/util.js`            | 端口清理 / health 探测 / 就绪等待                 |
| `glm-bridge/adapter.js`   | GLM（z.ai / 智谱 bigmodel.cn）adapter——请求体适配、按模型配思考等级、模型上限表 |
| `ds-bridge/adapter.js`    | DeepSeek（DeepSeek-V4）adapter——请求体适配、按模型配思考等级 |
| `mimo-bridge/adapter.js`  | MiMo（小米 MiMo-V2.5-Pro）adapter——请求体适配、按模型配思考开关 |
| `kimi-bridge/`、`qwen-bridge/` | 预留占位（adapter + README）                |
| `<name>-bridge/<name>.env.example` | 按上游的配置模板（GLM / DeepSeek / MiMo 已填；Kimi/Qwen 预留）  |
| `~/.cc-bridge/<upstream>.env` | 真实配置（你的，gitignored，绝不打包）        |
| `~/.cc-bridge/default-upstream` | 用户设置的默认上游（`set default upstream` 生成；不存在 = 内置默认 `ds`） |

## 注意 / 限制

- 上游必须接受 `output_config.effort` / `reasoning_effort`，`MODEL_THINKING` 配置的思考等级才会生效。
- 只有 `POST /v1/messages`（不含 `/v1/messages/count_tokens`）的 `model` 会被改写。其他路径原样转发。
- **未知模型会被 HTTP 400 拒绝，绝不静默改写。**
- `package.json` 的 `files` 排除了 `.env`；真实密钥绝不打包进全局安装。
- 思考等级由桥接按 `MODEL_THINKING` 配置写入请求体钉死，Claude Code 的 `/effort` 选任何等级都不影响实际上游模型的思考等级；模型对思考参数实际怎么执行，取决于上游。

## 版本管理

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。当前版本见 [VERSION](VERSION)；所有变更记录在 [CHANGELOG.md](CHANGELOG.md)。

## 开发

本目录是**开发工作区**——你编辑、推送到 git 的源码。最终用户安装发布版的构建 tarball。流程：在此编辑 → 测试 → bump 版本 → 发布 → 安装使用。

```bash
git clone <repo> && cd CC-Bridge
node --check core/*.js bin/cc-bridge.js glm-bridge/adapter.js   # 改完做语法检查
cc-bridge glm start                                             # 从源码后台运行
```

### 发布新版本

1. 更新 `VERSION` 与 `package.json` 的 `version`（保持一致）。
2. 在 `CHANGELOG.md` 顶部加 `## [X.Y.Z] - YYYY-MM-DD` 条目。
3. `git commit -a -m "release vX.Y.Z"` 后 `git tag vX.Y.Z`。
4. `npm pack` → 把 `cc-bridge-<版本>.tgz` 上传到 GitHub Release。
5. 在目标机器上从 Release 安装（见[安装](#安装)）。

## 版权与署名

CC-Bridge 基于 **MIT 许可证** 开源——见 [LICENSE.md](LICENSE.md)。

版权所有 (c) 2026 **All Contributors**。

**署名方式：** 如果 CC-Bridge 对你有帮助，欢迎致谢（非强制）。请在任何副本或衍生项目中保留版权声明与许可证文件，并注明来源：https://github.com/xhqing/CC-Bridge。
