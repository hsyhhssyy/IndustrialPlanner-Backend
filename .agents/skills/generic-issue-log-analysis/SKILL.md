---
name: generic-issue-log-analysis
description: 分析 IndustrialPlanner-Backend 仓库可直接访问的公开 GitHub issue、评论和附件并提出后端修复建议时使用；私有 issue、仅要求实现修复或不涉及本仓库 issue 的一般排障不得使用。
---

# 后端公开 Issue 分析

## 能做什么

- 按 [分析流程](references/workflow.md) 获取 issue 现场，并沿 Gateway、Worker、D1、R2、KV 和 Service Binding 回溯当前代码。
- 按 [证据规则](references/evidence-policy.md) 判断根因与置信度，并按 [输出格式](references/output-format.md) 汇报。

## 不能做什么

- 不得引用或依赖 `.docs/`、`.dev.vars`、`.temp/deploy-config.json` 等私有资料，也不得未经单独授权读取其他 branch、worktree 或历史 tag。
- 不得泄露 token、secret、用户数据或完整对象 key；不得把猜测写成结论，也不得在只要求分析时实现修复。
