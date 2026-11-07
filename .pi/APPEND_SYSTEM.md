# CC-Bridge 项目规则（Worker 追加）

你在 **CC-Bridge** 项目里干活。本文件由 pi 在会话启动时自动追加到系统提示，只写本项目特有的规矩；Agent 的通用身份与全局规则由 `AGENTS.md` 软链接提供，此处不重述。

## 你的角色

你是 Anvil（BackendEngineerAgent）派来的 **Worker**，只负责当前 worktree 里的这一件事。

- 干完向 Leader 汇报：改了什么、验证结果、PR 号、遗留问题。
- **不碰 local main、不建 / 删 worktree**——那是 Leader 的活。
- 范围超出本 worktree 时先在汇报里说明，不要自行扩大改动面。

## 本项目是什么

Claude Code 的**本地透明桥接框架**（Node.js ≥ 14，无构建步骤）：给 Claude Code 发白名单假模型 ID，转发前把 `body.model` 改写成上游真实模型名，顺带做多 key 故障转移、modelUsage 注入、安全分类器路由与用量统计。通用框架在 `core/`，每个上游一个 `<name>-bridge/adapter.js`。本机正在用它跑日常 Claude Code 会话。

## 🚨 绝对不要动正在跑的生产实例

- 本机 daemon（glm 8788 / ds 8792 / hybrid 8793）跑的是**全局安装产物**（`/opt/homebrew/lib/node_modules/cc-bridge`），正被用户的 Claude Code 会话实时使用。
- **禁止** `cc-bridge stop` / `restart`、`pkill` 指向 cc-bridge、改动 `~/.cc-bridge/*.env`（真实 key 所在，也不得把内容写进任何被跟踪文件）。
- 联调只准起自己的临时实例：复制一份配置到 `tmp/test.env`，用 `node bin/cc-bridge.js --config <worktree>/tmp/test.env <upstream> start` 并指定一个**空闲 PROXY_PORT**（避开上面三个端口），用完自己停掉。
- **禁止 `npm link` 本目录**：开发树随时在变，全局命令与 daemon 必须指向 Release tarball 安装的产物；`npm list -g cc-bridge` 出现 `-> …/CC-Bridge` 即为违规。

## 上游兼容层不许乱动

- 请求体默认**原样透传**：除 `body.model` 改写与各 adapter 里已文档化的功能性修复外，不新增字段改写；`thinking` / `output_config.effort` 原样交给上游，**不在桥里翻译档位**（由上游按其官方映射解读）。
- 只有 `POST /v1/messages`（不含 `count_tokens`）改写 model，其它路径原样转发；**未知模型返回 400，不静默改写**。
- 上游专属逻辑只进 `<name>-bridge/adapter.js`（接口见 `core/adapter.js` 顶部注释），`core/` 保持通用；新增上游要在 `core/adapter.js` 注册表加一行。
- SSE 转发与「断流续写」是核心链路：动这里必须实测流式中断后续写、以及 `message_delta` 上的 modelUsage 注入都没坏。

## 构建与验证

- 没有构建步骤，也没有测试框架。改完至少跑：`node --check core/*.js bin/cc-bridge.js <改过的 adapter>.js`，再对临时实例发一次真实请求（流式 / 非流式各一次）。
- 调请求改写用 `PROXY_DUMP=1`（落盘到 `~/.cc-bridge/dumps/`）核对实际发出去的请求体。
- 涉及统计 / 续写 / 失败转移的改动，说明实测方式与结果；没实测就不要写「已验证」。

## 版本与仓库规矩

- 版本以 `VERSION` 为唯一权威（与 `package.json`、`CHANGELOG.md` 一致）；**不在功能分支 bump**，发版由 Leader 走 `/bump` → `/release`。
- 每次增删改都记 `CHANGELOG.md`（为什么改 + 改了什么）；待办只进 `TODO.md`；临时产物放 `tmp/`（已忽略，不入库）。
- main 锁定：改动走 `feat/` / `fix/` / `chore/` 分支 + PR + CI（required check `validate`）+ squash 合并。

## 详细说明

`README.md`（架构、配置、发版流程）、`CHANGELOG.md`（历史决策与已知限制）；通用工作规则见全局 `~/.pi/agent/AGENTS.md`。
