//! Durable media adapter. Original uploads are immutable; all publication is fenced
//! by the persisted attempt id, and every object key is recorded before publication.
mod config;
mod parser;
mod queue;
mod sandbox;
pub use config::Config;
pub use parser::check_sandbox;
pub use queue::Worker;
#[derive(Debug, Clone, thiserror::Error)]
#[error("{code}")]
pub struct Failure {
    pub code: &'static str,
    pub retry: bool,
}
pub type Result<T> = std::result::Result<T, Failure>;
impl Failure {
    pub fn permanent(code: &'static str) -> Self {
        Self { code, retry: false }
    }
    pub fn transient(code: &'static str) -> Self {
        Self { code, retry: true }
    }
}
impl From<sqlx::Error> for Failure {
    fn from(_: sqlx::Error) -> Self {
        Self::transient("database_unavailable")
    }
}
impl From<std::io::Error> for Failure {
    fn from(_: std::io::Error) -> Self {
        Self::transient("local_io")
    }
}
