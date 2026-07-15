//! 用户资产的数据同步能力。
//!
//! 本模块拥有 revision 条件写入、幂等请求、冲突响应和客户端冲突决策协议。
//! 服务端检测到 revision 冲突时必须拒绝写入，不执行自动合并。

pub(crate) mod conflict;
pub(crate) mod protocol;
