// CPU 时间测量工具（用于开发阶段验证 10ms 约束）
// 
// 原理：Worker 内无法直接读取 CPU 时间，但可以在测试中用
// performance.now() 测量端到端延迟作为近似指标。
// 
// Cloudflare Workers 免费计划 CPU 时间 10ms 只计 CPU 执行时间，
// 不包括 I/O 等待（D1/KV/R2 的 IO 不计入 CPU 时间）。
// 因此本地 wall time > 10ms 不一定意味着线上会超，但 wall time < 10ms 一定安全。

export interface TimingResult {
  wallTimeMs: number;
  label: string;
  passed: boolean;
}

// 用 Miniflare dispatchFetch 测量单个请求的 wall time
export async function measureRequest(
  label: string,
  fetchFn: () => Promise<Response>,
  maxMs = 10,
): Promise<TimingResult> {
  const start = performance.now();
  const response = await fetchFn();
  const end = performance.now();
  const wallTimeMs = Math.round((end - start) * 100) / 100;

  return {
    wallTimeMs,
    label,
    passed: wallTimeMs <= maxMs,
  };
}

// 批量测量并生成报告
export function formatTimingReport(results: TimingResult[]): string {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed);

  const lines = [
    `=== CPU 时间测量报告 ===`,
    `通过: ${passed}/${total}`,
    ``,
  ];

  for (const r of results) {
    const icon = r.passed ? "✅" : "❌";
    lines.push(`${icon} ${r.wallTimeMs.toFixed(2)}ms — ${r.label}`);
  }

  if (failed.length > 0) {
    lines.push(``);
    lines.push(`⚠️  以下请求超过 10ms 预算:`);
    for (const r of failed) {
      lines.push(`   - ${r.label}: ${r.wallTimeMs.toFixed(2)}ms`);
    }
  }

  return lines.join("\n");
}
