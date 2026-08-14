# 后端测试处理规则

## 测试真相层

创建新测试前完整读取 `.docs/common/测试/测试架构设计通则.md`。测试命令以当前根和 package `package.json` 为准，不沿用前端、Rust 或已归档架构命令。

## 测试失败

以下失败不得直接修改断言或测试逻辑来“修绿”：

- 断言与实际结果不一致。
- 未捕获异常、超时或 Miniflare/原生依赖异常。
- D1 migration、唯一约束、R2/KV 或 Service Binding 行为失败。

先区分：

1. **测试漂移**：已获授权的接口或行为变化后，旧期望不再成立。
2. **实现回归**：生产实现偏离仍有效的行为。
3. **环境失败**：Miniflare、`better-sqlite3`、workerd 或配置未准备好。

向用户报告失败用例、验证意图、证据和初步分类。只有测试漂移已由明确需求或更新后的合约证实时，才可同步修改期望；不能根据当前实现反向改写测试。

## 随实现同步修改

用户明确要求改变某个 Worker 的公开行为时，可同步修改对应测试，但必须说明：

- 哪个接口或业务规则发生变化。
- 哪些测试文件随之更新。
- 每个测试验证的真实语义。
- 是否仍有 Miniflare、D1、R2、KV 或 Service Binding 未验证边界。

## 测试分层

### 纯逻辑与合约

- 与被测文件同目录使用 `*.test.ts`。
- 覆盖解析、校验、JWT、CORS、错误格式、状态转换和纯算法。
- 不访问真实网络或 Cloudflare 资源。

### HTTP

- 使用 Miniflare/Workers 测试能力调用实际 fetch handler。
- 覆盖方法、路径、状态码、响应体、响应头、CORS、body 边界和前端实际 JSON 合约。

### D1

- 使用本地 D1 并执行真实 migration。
- 覆盖事务、唯一约束、CAS、幂等、租约、并发冲突和回滚。

### KV

- 使用本地 KV 模拟验证 TTL、过期、限流和允许的降级语义。
- 不把 KV 当作持久化真相层。

### R2

- 使用本地 R2 模拟验证对象存在性、大小、hash、上传/下载和 D1/R2 状态切换。

### Service Binding

- 使用多 Worker 本地环境验证 Gateway 路由、JWT 透传、内部端点和跨 Worker 错误传播。

## 禁止事项

- 禁止浏览器、Playwright、DOM 和视觉测试。
- 禁止连接 Cloudflare Beta/Production D1、KV、R2 或 Worker。
- 禁止 mock 掉事务、唯一约束、TTL、对象存储或跨 Worker 调用后声称集成语义已验证。
- 禁止向生产代码加入测试专用分支。
- 禁止在错误输出中记录 token、secret、邮箱、完整用户数据或 R2 key。
- 禁止静默跳过失败测试。

## 执行命令

用户明确指定单个 Worker 时：

```bash
pnpm --filter @industrial/<worker> test
```

用户明确指定测试文件或用例时，根据目标 package 的 Vitest 配置运行精确目标，并在报告中写出实际命令。不得把单项结果描述为全量结果。

用户未指定单项而要求测试或完整验证时，停止使用本 Skill，改用 `full-check`。

## 临时数据

- 所有 fixture 由测试显式创建。
- Miniflare 实例间隔离 D1/KV/R2 状态。
- 一次性日志和诊断文件只放 `.temp/.trash/`，结束后清理。
- 环境缺失时报告未验证边界和所需依赖，不伪造通过。
