//! 本地账户与身份认证能力。
//!
//! 本模块拥有账户、邮箱密码凭据、邮箱验证、密码找回和登录会话。
//! 它不依赖 OAuth、资产、同步、HTTP 或具体数据库实现。

pub(crate) mod account;
pub(crate) mod email_verification;
pub(crate) mod password;
pub(crate) mod password_recovery;
pub(crate) mod session;
