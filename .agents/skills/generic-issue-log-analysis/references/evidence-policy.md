# 后端 Issue 证据规则

## 证据优先级

优先使用最接近根因且可复核的材料：

1. 与本次复现请求 ID、时间戳和版本匹配的 Worker/Cloudflare 日志。
2. D1 constraint、migration、R2/KV 操作或 Service Binding 返回的直接错误。
3. 当前公开代码、测试、`wrangler.toml` 和 Workflow。
4. HTTP 状态码、响应体和客户端错误。
5. issue 评论或维护者判断。

低层直接证据与上层表象冲突时，先解释冲突，不机械选择其中一个。

## 各层证据

### Gateway 与 HTTP

适合确认路由、方法、CORS、JWT、body 上限、状态码、响应头、`x-request-id` 和目标 Worker。浏览器网络错误通常只是表象，不能单独证明业务根因。

### Worker 业务逻辑

适合确认请求解析、领域不变量、revision/epoch、幂等、租约、错误映射和响应序列化。必须区分 HTTP 层校验与 service/model 业务规则。

### D1

适合确认 migration 版本、表和列、唯一约束、事务、租约、CAS、幂等记录与持久化状态。只凭应用日志写着“成功”不能证明事务已经提交。

### R2

适合确认对象存在性、大小、hash、固定 key、预签名请求和 D1/R2 active source 切换。输出中对对象 key 和用户标识脱敏。

### KV

适合确认 TTL、会话、限流或短期协调。KV 是最终一致且可丢失状态，不能单独证明 D1/R2 的持久化正确性。

### Service Binding

适合确认 Gateway 到下游 Worker 或 Worker 间调用的请求透传、绑定配置、内部端点和错误传播。不要把公网请求和 Service Binding 调用混为一条路径。

### GitHub Actions 与部署

适合确认 tag、环境选择、migration、Worker 部署步骤和失败位置。tag 已推送不等于部署成功；单个 Worker 部署成功也不等于整个 job 完成。

## 结论门槛

- **已证实**：存在与复现版本和请求对应的直接证据，并能由代码或存储语义解释。
- **高概率**：多项证据一致，但缺少关键日志、对应版本代码或存储现场。
- **证据不足**：只有用户描述、截图表象或不匹配的日志。

如果日志显示请求最终成功，必须明确写“本次证据未复现用户描述的问题”，再说明潜在脆弱点，不能硬凑失败根因。

## 安全

- 不输出 Authorization、Cookie、JWT、HMAC、Cloudflare token、R2 secret 或 `.dev.vars` 内容。
- 用户 ID、邮箱、IP、space ID、对象 key 和 hash 只保留定位所需的脱敏片段。
- 不执行远程查询、数据修复、migration、部署或状态变更来验证 issue。

## 代码链接

引用具体实现时使用远端 GitHub blob 链接：

`https://github.com/hsyhhssyy/IndustrialPlanner-Backend/blob/<commit>/<path>#Lx-Ly`

`<commit>` 使用本次实际分析的当前 `HEAD`。未经授权不得为构造链接读取其他 tag 或 branch。
