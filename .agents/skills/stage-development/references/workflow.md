# 后端 Stage 开发流程

## 1. 确认 Stage

1. 在当前 `.docs` submodule 中查找 `stageN` 目录，按数字而不是字符串排序。
2. 用户已指定 Stage 或需求编号时，以用户范围为准。
3. 用户只说“最新 Stage”时，读取最高编号 Stage 的 `README.md` 和 `requirements-index.md`，确认它是否仍为活动状态。
4. 最新 Stage 已标记 `done`、目标与用户请求不一致或没有可执行需求时，触发 Failfast，不擅自重新打开。

不得读取其他 branch、worktree 或历史 tag 来寻找“更新”的 Stage。

## 2. 建立当前真相

至少读取：

- Stage `README.md`。
- `requirements-index.md`。
- 当前目标对应的需求正文。
- 与任务相关的 `faq.md`、`bugs.md` 和执行记录。
- 需求直接引用的活动架构文档。

同时检查当前代码、测试和 migration。文档与实现冲突时列出证据并先收敛，不默认为任一方正确。

## 3. 开始前汇报

在继续实现前简要说明：

- 当前 Stage 目标和状态。
- 本次 session 的明确边界。
- 主业务 Worker 和涉及的数据/协议边界。
- 下一步从哪个未完成项开始。
- 已发现的文档与实现冲突或外部环境风险。

## 4. Search-First 与方案

对新增能力、接口、migration、跨 Worker 调用或共享抽象执行仓库内 Search-First，并明确选择 Adopt、Extend / Wrap、Compose 或 Build。

修改代码前完整阅读 `.docs/common/项目模块隔离开原则发规范.md`，选定唯一主业务 Worker。需要修改两个无直接依赖关系的业务 Worker 时，先说明原因并获得授权。

## 5. 按明确步骤闭环

每个步骤应有独立目标和可验证结果：

1. 更新需求文档中的当前口径或执行状态。
2. 修改代码、类型、migration 和调用方。
3. 使用 `test-writing` Skill 创建或同步测试。
4. 执行与该步骤范围对应的验证；需要全量验收时使用 `full-check` Skill。
5. 使用 `doc-writing` Skill回写完成内容、测试证据、未验证边界和下一步。

文档与代码属于同一交付，但不要求在开发中始终可编译；步骤结束时必须恢复到该步骤声明的可验证状态。

## 6. 文档路由

- 单需求状态、方案和时间线写入对应需求正文。
- 跨需求复用规则写入 `faq.md`。
- 暂未归属或跨需求 Bug 写入 `bugs.md`，并回链相关需求。
- Stage 总体目标、优先级或完成状态变化时同步 `README.md` 与 `requirements-index.md`。

`.docs` 是独立 submodule；不得把根仓库状态误当作文档仓库状态。

## 7. Git 与外部环境

- 未获明确授权时不提交、不推送、不打 tag、不部署。
- 用户授权按步骤提交时，每个已完成步骤的文档与代码一起提交，并使用 `project-commit` Skill。
- `commit-all.sh` 会递归提交和自动推送，授权不足时必须停止。
- Beta/Production 调试、远程 migration、R2/KV 写入和部署必须分别获得明确授权。

## 8. 交接

最终说明：

- 本次完成的步骤。
- 修改的 Stage/需求文档和代码模块。
- 验证结果。
- 未完成、阻塞或未验证事项。
- 下一步最合理的起点。
