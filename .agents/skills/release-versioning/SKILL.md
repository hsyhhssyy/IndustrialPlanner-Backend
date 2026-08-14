---
name: release-versioning
description: 仅当用户明确要求发布后端 release、创建或推送正式版、Beta、Dev 版本标签时使用；仅讨论版本号、查看历史标签、普通提交或直接部署 Worker 时不得使用。
---

# 后端版本发布

## 能做什么

- 按 [版本、标签与部署规则](references/tagging-rules.md) 检查版本号、changelog、完整测试和工作区状态，并执行用户明确授权的本地打标或远端发布。

## 不能做什么

- 不得把创建 tag、推送 tag、Cloudflare 部署、远程 migration 和源码提交视为同一个授权。
- 不得绕过 GitHub Actions 直接部署，也不得跳过 changelog、检查或干净工作区前置条件。
