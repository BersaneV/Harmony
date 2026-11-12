use crate::error::db_error;
use harmony_domain::{Channel, Error, Message, Result, User};
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use uuid::Uuid;
pub fn user_row(row: &sqlx::sqlite::SqliteRow) -> User {
    User {
        id: row.get("id"),
        username: row.get("username"),
        display_name: row.get("display_name"),
        is_admin: row.get("is_admin"),
        disabled: row.get("disabled"),
        preferences: row.get("preferences"),
        created_at: row.get("created_at"),
    }
}
pub async fn user(pool: &SqlitePool, id: Uuid) -> Result<User> {
    let row = sqlx::query("SELECT * FROM public_users WHERE id=$1")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(db_error)?;
    Ok(user_row(&row))
}
pub async fn member_role(pool: &SqlitePool, guild: Uuid, user: Uuid) -> Result<Option<String>> {
    sqlx::query_scalar("SELECT role FROM guild_members WHERE guild_id=$1 AND user_id=$2")
        .bind(guild)
        .bind(user)
        .fetch_optional(pool)
        .await
        .map_err(db_error)
}
pub async fn permissions(pool: &SqlitePool, channel: Uuid, user: Uuid) -> Result<i64> {
    sqlx::query_scalar("SELECT COALESCE((SELECT permissions FROM effective_channel_permissions ep WHERE ep.channel_id=$1 AND ep.user_id=$2),0)")
        .bind(channel)
        .bind(user)
        .fetch_one(pool)
        .await
        .map_err(db_error)
}
pub async fn require_permission(
    pool: &SqlitePool,
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
pub async fn channel_access(pool: &SqlitePool, channel: Uuid, user: Uuid) -> Result<()> {
    require_permission(pool, channel, user, harmony_domain::permissions::VIEW).await
}
/// The caller holds SQLite's cross-process writer lock via BEGIN IMMEDIATE.
/// ACL updates and the mutation authorized here therefore cannot interleave.
pub async fn tx_acl_lock(
    _tx: &mut Transaction<'_, Sqlite>,
    _guild: Uuid,
    _exclusive: bool,
) -> Result<()> {
    Ok(())
}
pub async fn tx_require_permission(
    tx: &mut Transaction<'_, Sqlite>,
    channel: Uuid,
    user: Uuid,
    required: i64,
) -> Result<()> {
    tx_access(tx, channel, user).await?;
    let effective: i64 = sqlx::query_scalar("SELECT COALESCE((SELECT permissions FROM effective_channel_permissions ep WHERE ep.channel_id=$1 AND ep.user_id=$2),0)")
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
pub async fn tx_access(tx: &mut Transaction<'_, Sqlite>, channel: Uuid, user: Uuid) -> Result<()> {
    let guild: Option<Uuid> = sqlx::query_scalar("SELECT guild_id FROM channels WHERE id=$1")
        .bind(channel)
        .fetch_one(&mut **tx)
        .await
        .map_err(db_error)?;
    if let Some(gid) = guild {
        tx_acl_lock(tx, gid, false).await?;
    }
    let member: Option<Uuid> = if let Some(gid) = guild {
        sqlx::query_scalar("SELECT user_id FROM guild_members WHERE guild_id=$1 AND user_id=$2")
            .bind(gid)
            .bind(user)
            .fetch_optional(&mut **tx)
            .await
            .map_err(db_error)?
    } else {
        sqlx::query_scalar("SELECT user_id FROM channel_members WHERE channel_id=$1 AND user_id=$2")
            .bind(channel)
            .bind(user)
            .fetch_optional(&mut **tx)
            .await
            .map_err(db_error)?
    };
    if member.is_none() {
        return Err(Error::Forbidden);
    }
    let effective: i64 = sqlx::query_scalar("SELECT COALESCE((SELECT permissions FROM effective_channel_permissions ep WHERE ep.channel_id=$1 AND ep.user_id=$2),0)")
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
pub fn channel(row: sqlx::sqlite::SqliteRow) -> Channel {
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
pub async fn message(pool: &SqlitePool, id: Uuid, viewer: Uuid) -> Result<Message> {
    let row = sqlx::query("SELECT m.* FROM messages m WHERE m.id=$1")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(db_error)?;
    let deleted: bool = row.get("deleted");
    let reactions = if deleted {
        vec![]
    } else {
        sqlx::query("SELECT emoji,COUNT(*) AS count,max(user_id=$2) AS me FROM reactions WHERE message_id=$1 GROUP BY emoji ORDER BY emoji").bind(id).bind(viewer).fetch_all(pool).await.map_err(db_error)?.into_iter().map(|r|harmony_domain::Reaction{emoji:r.get("emoji"),count:r.get("count"),me:r.get("me")}).collect()
    };
    let attachments = if deleted {
        vec![]
    } else {
        sqlx::query("SELECT u.id,u.name,u.content_type,u.size,j.status AS media_status FROM uploads u LEFT JOIN media_jobs j ON j.upload_id=u.id WHERE u.message_id=$1 AND u.status='ready' ORDER BY u.created_at,u.id").bind(id).fetch_all(pool).await.map_err(db_error)?.into_iter().map(|r|harmony_domain::Attachment{media_status:r.get("media_status"),id:r.get("id"),name:r.get("name"),content_type:r.get("content_type"),size:r.get("size")}).collect()
    };
    Ok(Message {
        id,
        channel_id: row.get("channel_id"),
        author: user(pool, row.get("author_id")).await?,
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
    tx: &mut Transaction<'_, Sqlite>,
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
