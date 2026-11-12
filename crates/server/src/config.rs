use std::env;
#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub bind: String,
    pub public_origin: String,
    pub jwt_secret: String,
    pub instance_name: String,
    pub livekit_url: Option<String>,
    pub livekit_api_url: Option<String>,
    pub livekit_key: Option<String>,
    pub livekit_secret: Option<String>,
    pub s3_endpoint: Option<String>,
    pub s3_public_endpoint: Option<String>,
    pub s3_region: String,
    pub s3_bucket: String,
    pub s3_access: Option<String>,
    pub s3_secret: Option<String>,
    pub max_upload: i64,
    pub storage_quota: i64,
    pub max_bitrate: u64,
    pub max_room_participants: i64,
}
impl Config {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let jwt_secret =
            env::var("HARMONY_JWT_SECRET").map_err(|_| "HARMONY_JWT_SECRET é obrigatório")?;
        if jwt_secret.len() < 32 || jwt_secret.starts_with("CHANGE_ME") {
            return Err("HARMONY_JWT_SECRET exige ao menos32 bytes aleatórios".into());
        }
        Ok(Self {
            database_url: env::var("DATABASE_URL")?,
            bind: env::var("HARMONY_BIND").unwrap_or("127.0.0.1:8080".into()),
            public_origin: env::var("HARMONY_PUBLIC_ORIGIN")
                .unwrap_or("http://localhost:5173".into()),
            jwt_secret,
            instance_name: env::var("HARMONY_INSTANCE_NAME").unwrap_or("Harmony".into()),
            livekit_url: env::var("LIVEKIT_URL").ok(),
            livekit_api_url: env::var("LIVEKIT_API_URL").ok(),
            livekit_key: env::var("LIVEKIT_API_KEY").ok(),
            livekit_secret: env::var("LIVEKIT_API_SECRET").ok(),
            s3_endpoint: env::var("S3_ENDPOINT").ok(),
            s3_public_endpoint: env::var("S3_PUBLIC_ENDPOINT").ok(),
            s3_region: env::var("S3_REGION").unwrap_or("us-east-1".into()),
            s3_bucket: env::var("S3_BUCKET").unwrap_or("harmony".into()),
            s3_access: env::var("S3_ACCESS_KEY").ok(),
            s3_secret: env::var("S3_SECRET_KEY").ok(),
            max_upload: number("HARMONY_MAX_UPLOAD_BYTES", 25 * 1024 * 1024)?,
            storage_quota: number("HARMONY_STORAGE_QUOTA_BYTES", 1024 * 1024 * 1024)?,
            max_bitrate: number("HARMONY_MAX_VIDEO_BITRATE", 32_000_000)? as u64,
            max_room_participants: number("HARMONY_MAX_ROOM_PARTICIPANTS", 12)?,
        })
    }
}
fn number(name: &str, default: i64) -> Result<i64, Box<dyn std::error::Error>> {
    let n = env::var(name)
        .map(|x| x.parse::<i64>())
        .unwrap_or(Ok(default))?;
    if n <= 0 {
        return Err(format!("{name} deve ser positivo").into());
    }
    Ok(n)
}
