use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("Acesso negado")]
    Forbidden,
    #[error("Sessão inválida ou expirada")]
    Unauthorized,
    #[error("Recurso não encontrado")]
    NotFound,
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Unavailable(String),
    #[error("Muitas tentativas; aguarde e tente novamente")]
    RateLimited,
    #[error("Erro interno")]
    Internal,
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub is_admin: bool,
    pub disabled: bool,
    pub preferences: Value,
    pub created_at: DateTime<Utc>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Guild {
    pub id: Uuid,
    pub name: String,
    pub owner_id: Uuid,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub id: Uuid,
    pub guild_id: Option<Uuid>,
    pub name: String,
    pub kind: String,
    pub last_seq: String,
    pub effective_permissions: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub participants: Option<Vec<User>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_seq: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub id: Uuid,
    pub name: String,
    pub content_type: String,
    pub size: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reaction {
    pub emoji: String,
    pub count: i64,
    pub me: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub author: User,
    pub content: String,
    pub seq: String,
    pub event_seq: String,
    pub client_nonce: Uuid,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted: bool,
    pub reactions: Vec<Reaction>,
    pub attachments: Vec<Attachment>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SendMessage {
    pub client_nonce: Uuid,
    pub content: String,
    #[serde(default)]
    pub attachment_ids: Vec<Uuid>,
}

pub fn username(value: &str) -> Result<String> {
    let value = value.trim().to_ascii_lowercase();
    if !(3..=32).contains(&value.len())
        || !value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
    {
        return Err(Error::Invalid(
            "Usuário deve ter de 3 a 32 letras, números, _ ou -".into(),
        ));
    }
    Ok(value)
}
pub fn password(value: &str) -> Result<()> {
    if !(12..=128).contains(&value.chars().count()) || value.len() > 512 {
        return Err(Error::Invalid(
            "Senha deve ter entre 12 e 128 caracteres".into(),
        ));
    }
    Ok(())
}
pub fn name(value: &str) -> Result<String> {
    let v = value.trim();
    if v.is_empty() || v.chars().count() > 80 || v.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "Nome deve ter entre 1 e 80 caracteres sem controles".into(),
        ));
    }
    Ok(v.to_owned())
}
pub fn message(command: &SendMessage) -> Result<()> {
    if command.content.chars().count() > 4000
        || command.attachment_ids.len() > 10
        || (command.content.trim().is_empty() && command.attachment_ids.is_empty())
    {
        return Err(Error::Invalid(
            "Mensagem vazia ou acima do limite de 4000 caracteres/10 anexos".into(),
        ));
    }
    let mut ids = command.attachment_ids.clone();
    ids.sort();
    ids.dedup();
    if ids.len() != command.attachment_ids.len() {
        return Err(Error::Invalid("Anexo repetido".into()));
    }
    Ok(())
}
pub fn can_manage(role: Option<&str>) -> bool {
    matches!(role, Some("owner" | "admin"))
}
pub fn can_change_role(actor: Option<&str>, target: &str) -> bool {
    actor == Some("owner") && target != "owner"
}
pub fn sequence(value: &str) -> Result<i64> {
    value
        .parse::<i64>()
        .ok()
        .filter(|n| *n >= 0)
        .ok_or_else(|| Error::Invalid("Cursor inválido".into()))
}
pub fn preferences(value: &Value) -> Result<()> {
    if !value.is_object() || value.to_string().len() > 8192 {
        return Err(Error::Invalid(
            "Preferências inválidas ou grandes demais".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_canonical_and_bounded() {
        assert_eq!(username(" Alice_1 ").unwrap(), "alice_1");
        for u in ["ab", "a@b", "álice", "a b", "<script>"] {
            assert!(username(u).is_err());
        }
    }
    #[test]
    fn password_not_silently_truncated() {
        assert!(password("abcdefghijkl").is_ok());
        assert!(password("short").is_err());
        assert!(password(&"x".repeat(129)).is_err());
    }
    #[test]
    fn owner_hierarchy_is_not_global_admin_bypass() {
        assert!(!can_manage(None));
        assert!(can_manage(Some("admin")));
        assert!(!can_change_role(Some("admin"), "member"));
        assert!(!can_change_role(Some("owner"), "owner"));
        assert!(can_change_role(Some("owner"), "admin"));
    }
    #[test]
    fn cursor_preserves_bigint_precision() {
        assert_eq!(sequence("9007199254740993").unwrap(), 9007199254740993);
        assert!(sequence("-1").is_err());
        assert!(sequence("1.5").is_err());
    }
    #[test]
    fn send_rejects_empty_and_duplicate_attachments() {
        let mut c = SendMessage {
            client_nonce: Uuid::now_v7(),
            content: " ".into(),
            attachment_ids: vec![],
        };
        assert!(message(&c).is_err());
        let id = Uuid::now_v7();
        c.attachment_ids = vec![id];
        assert!(message(&c).is_ok());
        c.attachment_ids.push(id);
        assert!(message(&c).is_err());
    }
}

pub mod permissions {
    use super::{Error, Result};
    pub const VIEW: i64 = 1;
    pub const SEND: i64 = 2;
    pub const ATTACH: i64 = 4;
    pub const REACT: i64 = 8;
    pub const CONNECT: i64 = 16;
    pub const PUBLISH: i64 = 32;
    pub const ALL: i64 = 63;
    pub fn parse(value: &str) -> Result<i64> {
        value
            .parse::<i64>()
            .ok()
            .filter(|v| *v >= 0 && *v <= ALL)
            .ok_or_else(|| {
                Error::Invalid("Permissões devem ser uma máscara decimal entre0 e63".into())
            })
    }
    pub fn effective(
        bypass: bool,
        role_base: i64,
        everyone: (i64, i64),
        roles: &[(i64, i64)],
    ) -> i64 {
        if bypass {
            return ALL;
        }
        let base = ALL | role_base;
        let with_everyone = (base & !everyone.1) | everyone.0;
        let (allow, deny) = roles
            .iter()
            .fold((0, 0), |(a, d), (ra, rd)| (a | ra, d | rd));
        let result = ((with_everyone & !deny) | allow) & ALL;
        if result & VIEW == 0 { 0 } else { result }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn view_gates_all_capabilities() {
            assert_eq!(effective(false, 0, (0, VIEW), &[]), 0);
            assert_eq!(effective(false, ALL, (SEND | PUBLISH, VIEW), &[]), 0);
        }
        #[test]
        fn custom_channel_allow_wins_between_roles() {
            assert_eq!(
                effective(false, 0, (0, SEND | PUBLISH), &[(SEND, 0), (0, SEND)]),
                ALL & !PUBLISH
            );
        }
        #[test]
        fn admin_bypass_and_default_preserve_existing_rooms() {
            assert_eq!(effective(true, 0, (0, ALL), &[]), ALL);
            assert_eq!(effective(false, 0, (0, 0), &[]), ALL);
        }
        #[test]
        fn reject_unknown_and_negative_permission_bits() {
            for value in ["64", "128", "-1", "1.0", "9007199254740993"] {
                assert!(parse(value).is_err())
            }
            assert_eq!(parse("63").unwrap(), ALL);
        }
    }
}
