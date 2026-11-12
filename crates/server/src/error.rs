use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use harmony_domain::Error;
use serde_json::json;
#[derive(Debug)]
pub struct ApiError(pub Error);
pub type ApiResult<T> = std::result::Result<T, ApiError>;
impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        Self(e)
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        Self(db_error(e))
    }
}
pub fn db_error(e: sqlx::Error) -> Error {
    if let sqlx::Error::Database(ref d) = e {
        if d.is_unique_violation() {
            return Error::Conflict("Recurso já existe".into());
        }
        if d.is_foreign_key_violation() {
            return Error::NotFound;
        }
    }
    if matches!(e, sqlx::Error::RowNotFound) {
        return Error::NotFound;
    }
    tracing::error!(error=%e,"database operation failed");
    Error::Internal
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = match self.0 {
            Error::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid_input"),
            Error::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Error::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            Error::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Error::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            Error::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
            Error::RateLimited => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            Error::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        };
        (
            status,
            Json(json!({"error":{"code":code,"message":self.0.to_string()}})),
        )
            .into_response()
    }
}
