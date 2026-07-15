//! 用户资产目录、内容引用和数量配额能力。
//!
//! 本模块拥有蓝图、基地、配置项、工具箱工作内容等资产的统一身份、归属、类型、
//! 当前版本和删除状态。内容同步协议由 sync 模块拥有。

pub(crate) mod catalog;
pub(crate) mod quota;
pub(crate) mod storage;
