//! 预留的 OAuth 能力边界。
//!
//! 当前阶段不接入 Provider、不注册路由、不新增依赖，也不编写 Provider 集成测试。
//! 未来登录身份映射与第三方服务授权必须分开建模，避免把“可登录”错误等同于
//! “允许代表用户访问第三方服务”。

pub(crate) mod connection;
pub(crate) mod login;
pub(crate) mod provider;
