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
pub async fn permissions(pool: &PgPool, channel: Uuid, user: Uuid) -> Result<i64> {
    sqlx::query_scalar("SELECT harmony_channel_permissions($1,$2)")
        .bind(channel)
        .bind(user)
        .fetch_one(pool)
        .await
        .map_err(db_error)
}
pub async fn require_permission(
    pool: &PgPool,
    channel: Uuid,
    user: Uuid,
    required: i64,
) -> Result<()> {
    let effective = permissions(pool, channel, user).await?;
    if effective & required == required {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}
pub async fn channel_access(pool: &PgPool, channel: Uuid, user: Uuid) -> Result<()> {
    require_permission(pool, channel, user, harmony_domain::permissions::VIEW).await
}
pub async fn tx_acl_lock(
    tx: &mut Transaction<'_, Postgres>,
    guild: Uuid,
    exclusive: bool,
) -> Result<()> {
    let query = if exclusive {
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text,674622903))"
    } else {
        "SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text,674622903))"
    };
    sqlx::query(query)
        .bind(guild.to_string())
        .execute(&mut **tx)
        .await
        .map_err(db_error)?;
    Ok(())
}
pub async fn tx_require_permission(
    tx: &mut Transaction<'_, Postgres>,
    channel: Uuid,
    user: Uuid,
    required: i64,
) -> Result<()> {
    tx_access(tx, channel, user).await?;
    let effective: i64 = sqlx::query_scalar("SELECT harmony_channel_permissions($1,$2)")
        .bind(channel)
        .bind(user)
        .fetch_one(&mut **tx)
        .await
        .map_err(db_error)?;
    if effective & required == required {
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
    if let Some(gid) = guild {
        tx_acl_lock(tx, gid, false).await?;
    }
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
    if member.is_none() {
        return Err(Error::Forbidden);
    }
    let effective: i64 = sqlx::query_scalar("SELECT harmony_channel_permissions($1,$2)")
        .bind(channel)
        .bind(user)
        .fetch_one(&mut **tx)
        .await
        .map_err(db_error)?;
    if effective & harmony_domain::permissions::VIEW != 0 {
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
        effective_permissions: row
            .try_get::<i64, _>("effective_permissions")
            .unwrap_or(harmony_domain::permissions::ALL)
            .to_string(),
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
        sqlx::query("SELECT u.id,u.name,u.content_type,u.size,j.status AS media_status FROM uploads u LEFT JOIN media_jobs j ON j.upload_id=u.id WHERE u.message_id=$1 AND u.status='ready' ORDER BY u.created_at,u.id").bind(id).fetch_all(pool).await.map_err(db_error)?.into_iter().map(|r|harmony_domain::Attachment{media_status:r.get("media_status"),id:r.get("id"),name:r.get("name"),content_type:r.get("content_type"),size:r.get("size")}).collect()
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
