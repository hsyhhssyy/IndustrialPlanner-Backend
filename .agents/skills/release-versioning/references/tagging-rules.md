# 后端版本、标签与部署规则

## 风险模型

`.github/workflows/deploy.yml` 监听版本 tag push：

- 正式 tag 部署 stable，并执行远程 D1 migration。
- Beta/Dev tag 部署 beta，并执行对应 Beta migration。

本地创建 tag 不会触发部署；推送 tag 会触发外部 Cloudflare 状态变更。两者必须分别获得明确授权。

## Tag 格式

- 正式版：`vA.B.C.D`，例如 `v0.1.1.2`。
- Beta：`vA.B.C.D-betaN`。
- Dev：`vA.B.C.D-devN`。
- 新 tag 使用小写 `beta` / `dev`；Workflow 对历史大小写形式兼容，不代表应继续制造混合命名。

用户未指定版本时：

1. 读取 `git tag --sort=-v:refname`。
2. 找到最新正式 tag。
3. 候选版本以该正式版最后一个数字段递增。
4. 同一候选版本已有 Beta/Dev 时只递增后缀序号，不再递增四段基础版本。
5. 把候选值告知用户；版本选择不明确时不得自行发布。

## 通用前置检查

1. 工作区与 `.docs` submodule 必须干净。
2. 使用 `full-check` Skill 完成 `pnpm lint`、`pnpm typecheck`、`pnpm test`。
3. 确认目标 tag 不存在于本地和远端。
4. 确认用户授权的是：
   - 仅创建本地 tag；或
   - 创建并推送 tag，从而触发对应 Cloudflare 部署。
5. 不直接执行 `wrangler deploy`、远程 migration 或 Workflow dispatch；tag 发布流程由现有 GitHub Actions 承担。

## 正式版 Changelog

正式 tag 前检查 `public/changelog/` 是否存在同版本日志，且 `index.json` 已登记。

若缺失：

1. 使用 `changelog-writing` Skill 生成文件和索引。
2. 发布授权不等于源码提交授权。
3. 只有用户另行授权 `commit-all.sh` 的递归提交与自动推送影响范围后，才使用 `project-commit` Skill 提交。
4. 未获得提交授权时停止发布，不得在工作区带着未提交 changelog 创建 tag。

Beta/Dev 默认不要求独立 changelog，除非用户明确要求。

## 推送与结果

- 仅获得本地打标授权时，不执行任何 push。
- 获得 tag 推送授权时，只推送已确认的精确 tag，不使用 `git push --tags`。
- 推送后报告它会触发的环境和 Workflow，但不要把“tag 已推送”描述为“部署已成功”。
- 用户要求确认部署结果时，另行读取 GitHub Actions 状态；失败时不得直接重试远程 migration 或部署。
