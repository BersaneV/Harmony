use crate::error::db_error;
use harmony_domain::{Channel, Error, Message, Result, User};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;
pub async fn user(pool: &PgPool, id: Uuid) -> Result<User> {
    let value: serde_json::Value =
        sqlx::query_scalar("SELECT to_jsonb(u) FROM public_users u WHERE id=$1")
            .bind(id)
            .fetch_one(pool)
            .await
            .map_err(db_error)?;
    serde_json::from_value(value).map_err(|_| Error::Internal)
}
pub async fn member_role(pool: &PgPool, guild: Uuid, user: Uuid) -> Result<Option<String>> {
    sqlx::query_scalar("SELECT role FROM guild_members WHERE guild_id=$1 AND user_id=$2")
        .bind(guild)
        .bind(user)
        .fetch_optional(pool)
        .await
        .map_err(db_error)
}
pub async fn channel_access(pool: &PgPool, channel: Uuid, user: Uuid) -> Result<()> {
    let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM channels c WHERE c.id=$1 AND (EXISTS(SELECT 1 FROM guild_members g WHERE g.guild_id=c.guild_id AND g.user_id=$2) OR EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.user_id=$2)))").bind(channel).bind(user).fetch_one(pool).await.map_err(db_error)?;
    if allowed {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
pub async fn tx_access(
    tx: &mut Transaction<'_, Postgres>,
    channel: Uuid,
    user: Uuid,
) -> Result<()> {
    let guild: Option<Uuid> = sqlx::query_scalar("SELECT guild_id FROM channels WHERE id=$1")
        .bind(channel)
        .fetch_one(&mut **tx)
        .await
        .map_err(db_error)?;
    let member: Option<Uuid> = if let Some(gid) = guild {
        sqlx::query_scalar(
            "SELECT user_id FROM guild_members WHERE guild_id=$1 AND user_id=$2 FOR SHARE",
        )
        .bind(gid)
        .bind(user)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db_error)?
    } else {
        sqlx::query_scalar(
            "SELECT user_id FROM channel_members WHERE channel_id=$1 AND user_id=$2 FOR SHARE",
        )
        .bind(channel)
        .bind(user)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db_error)?
    };
    if member.is_some() {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
pub fn channel(row: sqlx::postgres::PgRow) -> Channel {
    Channel {
        id: row.get("id"),
        guild_id: row.get("guild_id"),
        name: row.get("name"),
        kind: row.get("kind"),
        last_seq: row.get::<i64, _>("last_seq").to_string(),
        participants: None,
        read_seq: row
            .try_get::<i64, _>("read_seq")
            .ok()
            .map(|s| s.to_string()),
    }
}
pub async fn message(pool: &PgPool, id: Uuid, viewer: Uuid) -> Result<Message> {
    let row=sqlx::query("SELECT m.*,to_jsonb(u) AS author FROM messages m JOIN public_users u ON u.id=m.author_id WHERE m.id=$1").bind(id).fetch_one(pool).await.map_err(db_error)?;
    let deleted: bool = row.get("deleted");
    let reactions = if deleted {
        vec![]
    } else {
        sqlx::query("SELECT emoji,COUNT(*) AS count,bool_or(user_id=$2) AS me FROM reactions WHERE message_id=$1 GROUP BY emoji ORDER BY emoji").bind(id).bind(viewer).fetch_all(pool).await.map_err(db_error)?.into_iter().map(|r|harmony_domain::Reaction{emoji:r.get("emoji"),count:r.get("count"),me:r.get("me")}).collect()
    };
    let attachments = if deleted {
        vec![]
    } else {
        sqlx::query("SELECT id,name,content_type,size FROM uploads WHERE message_id=$1 AND status='ready' ORDER BY created_at,id").bind(id).fetch_all(pool).await.map_err(db_error)?.into_iter().map(|r|harmony_domain::Attachment{id:r.get("id"),name:r.get("name"),content_type:r.get("content_type"),size:r.get("size")}).collect()
    };
    Ok(Message {
        id,
        channel_id: row.get("channel_id"),
        author: serde_json::from_value(row.get("author")).map_err(|_| Error::Internal)?,
        content: if deleted {
            String::new()
        } else {
            row.get("content")
        },
        seq: row.get::<i64, _>("seq").to_string(),
        event_seq: row.get::<i64, _>("change_seq").to_string(),
        client_nonce: row.get("client_nonce"),
        created_at: row.get("created_at"),
        edited_at: row.get("edited_at"),
        deleted,
        reactions,
        attachments,
    })
}
pub async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: Uuid,
    action: &str,
    target: Option<Uuid>,
) -> Result<()> {
    sqlx::query("INSERT INTO audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)")
        .bind(Uuid::now_v7())
        .bind(actor)
        .bind(action)
        .bind(target)
        .execute(&mut **tx)
        .await
        .map_err(db_error)?;
    Ok(())
}
