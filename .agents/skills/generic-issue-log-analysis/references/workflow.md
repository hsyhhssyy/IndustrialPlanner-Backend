# 后端公开 Issue 分析流程

## 1. 规范化输入

- `#123` 默认指当前 `IndustrialPlanner-Backend` 仓库。
- 完整 GitHub URL 以 URL 指向的仓库和编号为准。
- 无编号的模糊描述先定位公开 issue；找不到时说明缺失，不臆造。

## 2. 获取公开现场

读取 issue 正文、全部相关评论和公开附件，提取：

- 后端版本、tag、commit、部署环境与发生时间。
- API 方法、路径、状态码、错误码与请求 ID。
- 预期行为、实际行为和稳定复现步骤。
- Worker、客户端版本、Cloudflare 区域或运行环境。
- 维护者结论及其证据。

评论中的判断只作为线索，仍需用附件和当前代码验证。

## 3. 处理附件

- 日志包、trace、JSON 导出或其他二进制附件先下载到 `.temp/.trash/issue-logs/issue-<number>/`。
- 解压后先列目录，再选择与结论直接相关的文件。
- 优先最新且与复现时间、请求 ID 对应的样本。
- 不把整份长日志或完整用户数据放进上下文或回复。
- 任务完成后清理本次创建的临时目录。

## 4. 建立时间线

用以下稳定锚点关联一次请求：

- 时间戳、`x-request-id`、trace ID。
- Worker 名称、API 路径、HTTP 方法。
- space、batch、revision、epoch、对象 hash 的脱敏形式。
- tag、commit 或 GitHub Actions run。

按客户端请求 → Gateway → 目标 Worker → repository/binding → D1/R2/KV → 响应的顺序还原，不用无关时段的相似错误拼凑因果。

## 5. 回溯当前公开代码

依次检查：

1. `README.md`、`package.json`、`wrangler.toml`、公开 migration 和 Workflow。
2. Gateway 路由、JWT、CORS 和转发。
3. 目标 Worker 的 HTTP、service、model、repository。
4. `packages/shared` 中的公开合约与错误响应。
5. 当前测试是否覆盖该行为。

公开 issue 分析不得使用 `.docs/` submodule、`.dev.vars`、`.temp/deploy-config.json` 或其他私有资料补强结论。

## 6. 区分版本

- 默认只分析当前检出版本。
- issue 当时版本与当前代码不一致时，明确区分“issue 现场”和“当前主线”。
- 未经单独授权不得读取历史 tag、其他 branch 或 worktree。
- 无法读取对应历史版本时，不得声称问题已在某版本存在或修复；只能说明当前代码是否仍有同类风险。

## 7. 判断与输出

按 [证据规则](evidence-policy.md) 划分：

- 已证实根因。
- 高概率怀疑点。
- 证据不足的待确认项。
- 当前主线仍存在、可能已修复或无法判断。

然后按 [输出格式](output-format.md) 提供修复方向或最低成本补证动作。用户只要求分析时不得修改代码、配置、数据库或部署。
