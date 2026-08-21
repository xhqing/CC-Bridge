# TODO Archive

已完成 / 已更新的待办条目归档于此（从 TODO.md 移入，不删除，供回溯）。

## 功能 / 机制

- ✅**已完成** **T1** GLM 上游支持多个 BASE_URL：适配国际版（z.ai）与国内版（智谱 open.bigmodel.cn）两套端点，可同时配置、按可用性选择。→ 2.9.1 实现：`API_BASES` 多端点 + `API_KEY_n_BASE` 端点绑定 + KEY 轮换跨端点容灾（`core/config.js` / `core/server.js` / `glm.env.example`）。（记录：2026-08-15 20:51）（完成：2026-08-15 21:38）

- ✅**已完成** **T2** `cc-bridge stats` 用量按 API KEY 分类展示：不显示 KEY 本身，配置文件给每个 KEY 配 `API_KEY_n_NAME`，统计表按 key-name 分类；所有已注册 key-name 不允许重复（重复即配置错误，启动校验拦截）。→ 2.9.1 实现：`validateKeyAttrs` 查重 + server 落盘新增 `keys` 维度（KEY 本体不落盘）+ stats 展示 by key 表。（记录：2026-08-15 20:51）（完成：2026-08-15 21:38）

- ✅**已完成** **T3** `cc-bridge stats` 合并展示所有上游：不按 upstream 区分，把最近用过的上游（如 ds 与 glm）的用量一起呈现出来（聚合各 `stats-<upstream>.json`）；用 key-name 区分即可区分上游与账号。→ 2.9.1 实现：裸 `stats` 聚合全部快照（by key 合并同名 + by upstream/model 带前缀），显式 `<upstream> stats` 仍看单上游明细。（记录：2026-08-15 20:51）（完成：2026-08-15 21:38）

