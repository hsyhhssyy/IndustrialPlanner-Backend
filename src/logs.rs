use std::{
    collections::VecDeque,
    io::{self, Write},
    sync::Mutex,
};

use axum::{
    extract::{Query, State},
    http::{StatusCode, header},
    response::IntoResponse,
};
use serde::Deserialize;

use crate::api::ApiState;

/// 内存环形日志缓冲区，保留最近 N 行日志。
pub(crate) struct LogBuffer {
    inner: Mutex<VecDeque<String>>,
    capacity: usize,
}

impl LogBuffer {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(VecDeque::with_capacity(capacity)),
            capacity,
        }
    }

    fn push(&self, line: String) {
        let mut buffer = self.inner.lock().unwrap();
        if buffer.len() >= self.capacity {
            buffer.pop_front();
        }
        buffer.push_back(line);
    }

    /// 返回最近的日志行，按时间升序。
    pub(crate) fn recent(&self, max_lines: usize) -> Vec<String> {
        let buffer = self.inner.lock().unwrap();
        let skip = buffer.len().saturating_sub(max_lines);
        buffer.iter().skip(skip).cloned().collect()
    }
}

// ── MakeWriter：同时写入 stdout 和环形缓冲区 ──

/// 实现 `tracing_subscriber::fmt::MakeWriter`，将日志 tee 到 stdout + 缓冲区。
#[derive(Clone)]
pub(crate) struct LogCapture {
    buffer: std::sync::Arc<LogBuffer>,
}

impl LogCapture {
    pub(crate) fn new(buffer: std::sync::Arc<LogBuffer>) -> Self {
        Self { buffer }
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogCapture {
    type Writer = CaptureWriter;

    fn make_writer(&'a self) -> Self::Writer {
        CaptureWriter {
            buffer: self.buffer.clone(),
            pending: String::new(),
        }
    }
}

pub(crate) struct CaptureWriter {
    buffer: std::sync::Arc<LogBuffer>,
    pending: String,
}

impl Write for CaptureWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // 先写 stdout，确保 kubectl logs 仍可正常读取
        let written = io::stdout().write(buf)?;
        let text = String::from_utf8_lossy(&buf[..written]);
        self.pending.push_str(&text);
        // 按行 flush 到缓冲区
        while let Some(pos) = self.pending.find('\n') {
            let line = self.pending[..pos].to_owned();
            self.pending = self.pending[pos + 1..].to_owned();
            self.buffer.push(line);
        }
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        io::stdout().flush()?;
        if !self.pending.is_empty() {
            self.buffer.push(std::mem::take(&mut self.pending));
        }
        Ok(())
    }
}

// ── HTTP handler ──

#[derive(Deserialize)]
pub(crate) struct LogsQuery {
    #[serde(default = "default_lines")]
    lines: usize,
}

const fn default_lines() -> usize {
    100
}

/// GET /logs?lines=200
///
/// 仅在非 production 环境返回日志；production 返回 404 以隐藏端点。
pub(crate) async fn get_logs(
    State(state): State<ApiState>,
    Query(params): Query<LogsQuery>,
) -> impl IntoResponse {
    if state.environment.as_ref() == "production" {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }

    let max_lines = params.lines.clamp(1, 1000);
    let lines = state.log_buffer.recent(max_lines);
    let body = lines.join("\n");

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        body,
    )
        .into_response()
}
