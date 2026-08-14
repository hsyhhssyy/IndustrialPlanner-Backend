---
name: full-check
description: 用户要求完整代码质量检查，或要求测试但未明确指定单一测试集时使用；用户明确指定单一测试集、仅需编写测试或只需分析已有结果时不得使用。
---

# 后端完整代码质量检查

## 能做什么

- 按 [完整检查执行规范](references/execution.md) 执行 pnpm workspace 的 lint、TypeScript 类型检查和全量测试。
- 按 [检查报告格式](references/report-format.md) 汇总结果、失败测试和未验证边界。

## 不能做什么

- 不得自行缩小检查范围、连接 Cloudflare 远程资源或把未执行的检查报告为通过。
- 不得根据检查结果擅自修改业务代码、测试、配置或 migration。
