//! Local operator CLI. SQL is read from stdin, never exposed through the API.
use serde_json::{Value, json};
use sqlx::{Column, Row, TypeInfo, ValueRef};
use std::io::Read;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mode = std::env::args()
        .nth(1)
        .ok_or("use harmony-db migrate|query")?;
    let url = std::env::var("DATABASE_URL")?;
    let pool = harmony_database::connect(&url, 1).await?;
    match mode.as_str() {
        "migrate" => {
            harmony_database::migrate(&pool).await?;
            let version: String = sqlx::query_scalar("SELECT sqlite_version()")
                .fetch_one(&pool)
                .await?;
            println!("{}", json!({"status":"ok","sqlite_version":version}));
        }
        "query" => {
            let mut query = String::new();
            std::io::stdin().read_to_string(&mut query)?;
            // Intentional operator SQL console: local stdin is the complete SQL program;
            // no user-controlled value is interpolated and this is not an HTTP route.
            let rows = sqlx::query(sqlx::AssertSqlSafe(query.as_str()))
                .fetch_all(&pool)
                .await?;
            let mut result: Vec<Vec<Value>> = Vec::new();
            for row in rows {
                let mut cells = Vec::new();
                for column in row.columns() {
                    let n = column.ordinal();
                    let raw = row.try_get_raw(n)?;
                    let value = if raw.is_null() {
                        Value::Null
                    } else {
                        match raw.type_info().name() {
                            "INTEGER" | "INT" | "INT64" | "BOOLEAN" => {
                                json!(row.try_get::<i64, _>(n)?)
                            }
                            "REAL" => json!(row.try_get::<f64, _>(n)?),
                            "BLOB" => {
                                let bytes = row.try_get::<Vec<u8>, _>(n)?;
                                if bytes.len() == 16 {
                                    json!(uuid::Uuid::from_slice(&bytes)?)
                                } else {
                                    json!(bytes)
                                }
                            }
                            _ => json!(row.try_get::<String, _>(n)?),
                        }
                    };
                    cells.push(value);
                }
                result.push(cells);
            }
            println!("{}", json!(result));
        }
        _ => return Err("use harmony-db migrate|query".into()),
    }
    pool.close().await;
    Ok(())
}
