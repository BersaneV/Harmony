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
    pub storage: harmony_storage::StorageConfig,
    pub public_api_url: String,
    pub web_dir: Option<std::path::PathBuf>,
    pub p2p_enabled: bool,
    pub p2p_stun_urls: Vec<String>,
    pub media_transport: String,
    pub call_stun_urls: Vec<String>,
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
        let public_api_url =
            env::var("HARMONY_PUBLIC_API_URL").unwrap_or("http://127.0.0.1:8080".into());
        let public_url = url::Url::parse(&public_api_url)?;
        if !matches!(public_url.scheme(), "http" | "https")
            || public_url.host_str().is_none()
            || !public_url.username().is_empty()
            || public_url.password().is_some()
            || public_url.query().is_some()
            || public_url.fragment().is_some()
            || !matches!(public_url.path(), "" | "/")
        {
            return Err(
                "HARMONY_PUBLIC_API_URL deve ser uma origem HTTP(S), sem caminho ou credenciais"
                    .into(),
            );
        }
        let p2p_stun_urls: Vec<String> = env::var("HARMONY_P2P_STUN_URLS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect();
        if p2p_stun_urls.len() > 4
            || p2p_stun_urls.iter().any(|s| {
                !(s.starts_with("stun:") || s.starts_with("stuns:"))
                    || s.len() > 255
                    || s.contains('@')
                    || s.contains('/')
                    || s.contains('?')
                    || s.contains('#')
                    || s.chars().any(char::is_whitespace)
            })
        {
            return Err("HARMONY_P2P_STUN_URLS aceita até quatro URLs STUN sem credenciais".into());
        }
        let p2p_enabled = match env::var("HARMONY_P2P_DIAGNOSTICS").as_deref() {
            Ok("true") => true,
            Ok("false") | Err(_) => false,
            _ => return Err("HARMONY_P2P_DIAGNOSTICS deve ser true ou false".into()),
        };
        let media_transport = env::var("HARMONY_MEDIA_TRANSPORT").unwrap_or("p2p".into());
        if !matches!(media_transport.as_str(), "p2p" | "livekit") {
            return Err("HARMONY_MEDIA_TRANSPORT deve ser p2p ou livekit".into());
        }
        let call_stun_urls: Vec<String> = env::var("HARMONY_CALL_STUN_URLS")
            .unwrap_or("stun:stun.l.google.com:19302".into())
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(String::from)
            .collect();
        if call_stun_urls.len() > 4
            || call_stun_urls.iter().any(|s| {
                !(s.starts_with("stun:") || s.starts_with("stuns:"))
                    || s.len() > 255
                    || s.contains(['@', '/', '?', '#'])
                    || s.chars().any(char::is_whitespace)
                    || s.split_once(':').is_none_or(|(_, host)| host.is_empty())
            })
        {
            return Err(
                "HARMONY_CALL_STUN_URLS aceita até quatro URLs STUN sem credenciais".into(),
            );
        }
        let max_room_participants = number("HARMONY_MAX_ROOM_PARTICIPANTS", 12)?;
        let max_bitrate = number("HARMONY_MAX_VIDEO_BITRATE", 32_000_000)?;
        call_limits(&media_transport, max_room_participants, max_bitrate)?;
        Ok(Self {
            database_url: env::var("DATABASE_URL").unwrap_or("sqlite:./data/harmony.db".into()),
            storage: harmony_storage::StorageConfig::from_env()?,
            public_api_url: public_api_url.trim_end_matches('/').to_string(),
            web_dir: env::var_os("HARMONY_WEB_DIR").map(std::path::PathBuf::from),
            p2p_enabled,
            p2p_stun_urls,
            media_transport,
            call_stun_urls,
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
            max_bitrate: max_bitrate as u64,
            max_room_participants,
        })
    }
}
fn call_limits(
    transport: &str,
    participants: i64,
    bitrate: i64,
) -> Result<(), Box<dyn std::error::Error>> {
    if transport == "p2p" {
        if !(2..=12).contains(&participants) {
            return Err("Chamadas P2P exigem limite entre 2 e 12 participantes por canal".into());
        }
        if !(500_000..=32_000_000).contains(&bitrate) {
            return Err("Chamadas P2P exigem bitrate máximo entre 500000 e 32000000".into());
        }
    }
    Ok(())
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
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn p2p_configuration_matches_the_client_admission_limits() {
        for participants in [2, 12] {
            for bitrate in [500_000, 32_000_000] {
                assert!(call_limits("p2p", participants, bitrate).is_ok());
            }
        }
        for participants in [0, 1, 13] {
            assert!(call_limits("p2p", participants, 1_000_000).is_err());
        }
        for bitrate in [0, 499_999, 32_000_001] {
            assert!(call_limits("p2p", 2, bitrate).is_err());
        }
        assert!(call_limits("livekit", 1, 64_000_000).is_ok());
    }
}
