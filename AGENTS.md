# CC-Bridge

> BackendEngineerAgent（Anvil）名下的子项目 · 本项目规则本体

Claude Code 的本地透明桥接框架（Node.js，无构建步骤）：给 Claude Code 发白名单假模型 ID，转发前改写 `body.model`，顺带多 key 故障转移、modelUsage 注入、安全分类器路由与用量统计。

## 归谁负责

本项目由 **Anvil**（BackendEngineerAgent）负责维护。改动范围跨出本项目时，先向 Anvil 说明，不自行扩张改动面。

## 会话角色

角色看「cwd 是不是本项目主工作区的 main 分支」：

- **subLeader（本项目主工作区的 main 分支）**：只管本项目自身——local main 的 `git fetch` + `git merge --ff-only` 快进同步、从自身 main 建删任务 worktree、派 Worker、按全局工作流合并本项目的 PR、发本项目的版、回收 Worker；对上级 BackendEngineerAgent 与其它项目只读。
- **Worker（本项目的非 main 分支 worktree）**：只做当前 worktree 里的这一件事，干完向派它的 Leader 汇报——改了什么、验证结果、PR 号、遗留问题；**不碰 local main、不建删 worktree、不合并 PR、不发版**——建删 worktree 与 ff 同步 local main 是 subLeader（本项目主工作区 main 会话）的活，agentLeader（Anvil 主工作区）可代管。
- 上下文不够时向派单的 Leader 问，不要凭猜测改代码。
- 本项目的硬约束与验证要求写在 `.pi/APPEND_SYSTEM.md`（会话启动时自动加载），动代码前先看一遍。

## 项目规则在哪

| 内容 | 位置 |
|---|---|
| 本项目硬约束、验证要求、易踩的坑 | `.pi/APPEND_SYSTEM.md`（自动加载） |
| 开发 / 构建 / 发版全流程 | `DEVELOPMENT.md`、`README.md` / `README_cn.md` |
| 待办 | `TODO.md`（已处理进 `TODO-archive.md`） |
| 改动记录 | `CHANGELOG.md` |
| 团队通用规则（git 流程、敏感信息、会话角色（agentLeader / subLeader / Worker）等） | 全局 `~/.pi/agent/AGENTS.md` |
