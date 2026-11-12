use crate::{
    AppState,
    auth::{Auth, hash},
    db,
    error::{ApiResult, db_error},
};
use async_trait::async_trait;
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use harmony_application::{ChatService, ConversationRepository};
use harmony_domain::permissions as p;
use harmony_domain::{self as domain, Error, Message, SendMessage};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;
#[derive(Clone)]
pub struct PgConversations(pub PgPool);
#[async_trait]
impl ConversationRepository for PgConversations {
    async fn commit_message(
        &self,
        actor: Uuid,
        channel: Uuid,
        b: SendMessage,
    ) -> domain::Result<Message> {
        let mut tx = self.0.begin().await.map_err(db_error)?;
        lock_channel(&mut tx, channel).await?;
        db::tx_require_permission(
            &mut tx,
            channel,
            actor,
            p::SEND
                | if b.attachment_ids.is_empty() {
                    0
                } else {
                    p::ATTACH
                },
        )
        .await?;
        let mut attachments = b.attachment_ids.clone();
        attachments.sort();
        let request_hash =
            hash(&json!({"content":b.content,"attachments":attachments}).to_string());
        if let Some(row)=sqlx::query("SELECT id,request_hash FROM messages WHERE channel_id=$1 AND author_id=$2 AND client_nonce=$3").bind(channel).bind(actor).bind(b.client_nonce).fetch_optional(&mut *tx).await.map_err(db_error)?{if row.get::<String,_>("request_hash")!=request_hash{return Err(Error::Conflict("Chave de idempotência reutilizada com outro conteúdo".into()))}let id=row.get("id");tx.commit().await.map_err(db_error)?;return db::message(&self.0,id,actor).await}
        let id = Uuid::now_v7();
        let seq = next_seq(&mut tx, channel).await?;
        for aid in &attachments {
            let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM uploads WHERE id=$1 AND user_id=$2 AND channel_id=$3 AND status='ready' AND message_id IS NULL)").bind(aid).bind(actor).bind(channel).fetch_one(&mut *tx).await.map_err(db_error)?;
            if !valid {
                return Err(Error::Invalid(
                    "Anexo indisponível ou sem autorização".into(),
                ));
            }
        }
        sqlx::query("INSERT INTO messages(id,channel_id,author_id,client_nonce,content,seq,change_seq,request_hash) VALUES($1,$2,$3,$4,$5,$6,$6,$7)").bind(id).bind(channel).bind(actor).bind(b.client_nonce).bind(b.content).bind(seq).bind(request_hash).execute(&mut *tx).await.map_err(db_error)?;
        for aid in attachments {
            let n =
                sqlx::query("UPDATE uploads SET message_id=$1 WHERE id=$2 AND message_id IS NULL")
                    .bind(id)
                    .bind(aid)
                    .execute(&mut *tx)
                    .await
                    .map_err(db_error)?
                    .rows_affected();
            if n != 1 {
                return Err(Error::Conflict(
                    "Anexo já associado a outra mensagem".into(),
                ));
            }
        }
        event(&mut tx, channel, "message.created", id, seq).await?;
        tx.commit().await.map_err(db_error)?;
        db::message(&self.0, id, actor).await
    }
}
async fn lock_channel(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> domain::Result<()> {
    sqlx::query("SELECT id FROM channels WHERE id=$1 FOR NO KEY UPDATE")
        .bind(id)
        .fetch_one(&mut **tx)
        .await
        .map_err(db_error)?;
    Ok(())
}
async fn next_seq(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> domain::Result<i64> {
    sqlx::query_scalar("UPDATE channels SET last_seq=last_seq+1 WHERE id=$1 RETURNING last_seq")
        .bind(id)
        .fetch_one(&mut **tx)
        .await
        .map_err(db_error)
}
async fn event(
    tx: &mut Transaction<'_, Postgres>,
    channel: Uuid,
    kind: &str,
    id: Uuid,
    seq: i64,
) -> domain::Result<()> {
    sqlx::query("INSERT INTO outbox(channel_id,event) VALUES($1,$2)").bind(channel).bind(json!({"type":kind,"channel_id":channel,"message_id":id,"seq":seq.to_string(),"version":1})).execute(&mut **tx).await.map_err(db_error)?;
    Ok(())
}
pub async fn send(
    State(s): State<AppState>,
    a: Auth,
    Path(cid): Path<Uuid>,
    Json(b): Json<SendMessage>,
) -> ApiResult<Json<Message>> {
    s.limit(&format!("messages:{}", a.user.id), 60, 60)?;
    Ok(Json(
        ChatService(PgConversations(s.pool))
            .send(a.user.id, cid, b)
            .await?,
    ))
}
#[derive(Deserialize)]
pub struct History {
    before_seq: Option<String>,
    after_seq: Option<String>,
    limit: Option<i64>,
}
pub async fn history(
    State(s): State<AppState>,
    a: Auth,
    Path(cid): Path<Uuid>,
    Query(q): Query<History>,
) -> ApiResult<Json<Value>> {
    db::channel_access(&s.pool, cid, a.user.id).await?;
    if q.before_seq.is_some() && q.after_seq.is_some() {
        return Err(Error::Invalid("Use somente before_seq ou after_seq".into()).into());
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let before = q
        .before_seq
        .as_deref()
        .map(domain::sequence)
        .transpose()?
        .unwrap_or(i64::MAX);
    let after = q.after_seq.as_deref().map(domain::sequence).transpose()?;
    let mut tx = s.pool.begin().await?;
    let cursor: i64 = sqlx::query_scalar("SELECT last_seq FROM channels WHERE id=$1 FOR SHARE")
        .bind(cid)
        .fetch_one(&mut *tx)
        .await?;
    let rows = if let Some(after) = after {
        sqlx::query("SELECT id,change_seq FROM messages WHERE channel_id=$1 AND change_seq>$2 ORDER BY change_seq LIMIT $3").bind(cid).bind(after).bind(limit+1).fetch_all(&mut *tx).await?
    } else {
        sqlx::query("SELECT id,change_seq FROM messages WHERE channel_id=$1 AND seq<$2 ORDER BY seq DESC LIMIT $3").bind(cid).bind(before).bind(limit+1).fetch_all(&mut *tx).await?
    };
    let has_more = rows.len() > limit as usize;
    let rows = rows.into_iter().take(limit as usize).collect::<Vec<_>>();
    let next_cursor = if after.is_some() && has_more {
        rows.last()
            .map(|r| r.get::<i64, _>("change_seq"))
            .unwrap_or(cursor)
    } else {
        cursor
    };
    let mut ids = rows
        .into_iter()
        .map(|r| r.get::<Uuid, _>("id"))
        .collect::<Vec<_>>();
    if after.is_none() {
        ids.reverse()
    }
    tx.commit().await?;
    let mut items = vec![];
    for id in ids {
        items.push(db::message(&s.pool, id, a.user.id).await?)
    }
    Ok(Json(
        json!({"items":items,"has_more":has_more,"cursor":next_cursor.to_string()}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edit {
    content: String,
}
async fn authorize_mutation(s: &AppState, a: &Auth, id: Uuid, allow_mod: bool) -> ApiResult<Uuid> {
    let row = sqlx::query("SELECT channel_id,author_id FROM messages WHERE id=$1")
        .bind(id)
        .fetch_one(&s.pool)
        .await?;
    let cid = row.get("channel_id");
    db::channel_access(&s.pool, cid, a.user.id).await?;
    if row.get::<Uuid, _>("author_id") != a.user.id {
        let gid: Option<Uuid> = sqlx::query_scalar("SELECT guild_id FROM channels WHERE id=$1")
            .bind(cid)
            .fetch_one(&s.pool)
            .await?;
        if !allow_mod
            || match gid {
                Some(g) => {
                    !domain::can_manage(db::member_role(&s.pool, g, a.user.id).await?.as_deref())
                }
                None => true,
            }
        {
            return Err(Error::Forbidden.into());
        }
    }
    Ok(cid)
}
pub async fn edit(
    State(s): State<AppState>,
    a: Auth,
    Path(id): Path<Uuid>,
    Json(b): Json<Edit>,
) -> ApiResult<Json<Message>> {
    let cid = authorize_mutation(&s, &a, id, false).await?;
    if b.content.trim().is_empty() || b.content.chars().count() > 4000 {
        return Err(Error::Invalid("Conteúdo deve ter de1 a4000 caracteres".into()).into());
    }
    let mut tx = s.pool.begin().await?;
    lock_channel(&mut tx, cid).await?;
    db::tx_require_permission(&mut tx, cid, a.user.id, p::SEND).await?;
    let seq = next_seq(&mut tx, cid).await?;
    let n = sqlx::query(
        "UPDATE messages SET content=$1,edited_at=now(),change_seq=$2 WHERE id=$3 AND NOT deleted",
    )
    .bind(b.content)
    .bind(seq)
    .bind(id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(Error::NotFound.into());
    }
    event(&mut tx, cid, "message.updated", id, seq).await?;
    tx.commit().await?;
    Ok(Json(db::message(&s.pool, id, a.user.id).await?))
}
pub async fn delete(
    State(s): State<AppState>,
    a: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let cid = authorize_mutation(&s, &a, id, true).await?;
    let mut tx = s.pool.begin().await?;
    lock_channel(&mut tx, cid).await?;
    db::tx_access(&mut tx, cid, a.user.id).await?;
    let owner: Uuid = sqlx::query_scalar("SELECT author_id FROM messages WHERE id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if owner != a.user.id {
        let role: Option<String> = sqlx::query_scalar("SELECT gm.role FROM guild_members gm JOIN channels c ON c.guild_id=gm.guild_id WHERE c.id=$1 AND gm.user_id=$2")
            .bind(cid).bind(a.user.id).fetch_optional(&mut *tx).await?;
        if !domain::can_manage(role.as_deref()) {
            return Err(Error::Forbidden.into());
        }
    }

    let deleted: bool = sqlx::query_scalar("SELECT deleted FROM messages WHERE id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if !deleted {
        let seq = next_seq(&mut tx, cid).await?;
        sqlx::query(
            "UPDATE messages SET content='',deleted=true,edited_at=now(),change_seq=$1 WHERE id=$2",
        )
        .bind(seq)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        event(&mut tx, cid, "message.deleted", id, seq).await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn add_reaction(
    State(s): State<AppState>,
    a: Auth,
    Path((id, emoji)): Path<(Uuid, String)>,
) -> ApiResult<StatusCode> {
    reaction(s, a, id, emoji, true).await
}
pub async fn remove_reaction(
    State(s): State<AppState>,
    a: Auth,
    Path((id, emoji)): Path<(Uuid, String)>,
) -> ApiResult<StatusCode> {
    reaction(s, a, id, emoji, false).await
}
async fn reaction(
    s: AppState,
    a: Auth,
    id: Uuid,
    emoji: String,
    add: bool,
) -> ApiResult<StatusCode> {
    if emoji.is_empty() || emoji.chars().count() > 16 || emoji.chars().any(char::is_control) {
        return Err(Error::Invalid("Reação inválida".into()).into());
    }
    let cid: Uuid =
        sqlx::query_scalar("SELECT channel_id FROM messages WHERE id=$1 AND NOT deleted")
            .bind(id)
            .fetch_one(&s.pool)
            .await?;
    let mut tx = s.pool.begin().await?;
    lock_channel(&mut tx, cid).await?;
    db::tx_require_permission(&mut tx, cid, a.user.id, p::REACT).await?;
    let changed = if add {
        sqlx::query("INSERT INTO reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(id).bind(a.user.id).bind(&emoji).execute(&mut *tx).await?.rows_affected()
    } else {
        sqlx::query("DELETE FROM reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3")
            .bind(id)
            .bind(a.user.id)
            .bind(&emoji)
            .execute(&mut *tx)
            .await?
            .rows_affected()
    };
    if changed > 0 {
        let seq = next_seq(&mut tx, cid).await?;
        sqlx::query("UPDATE messages SET change_seq=$1 WHERE id=$2")
            .bind(seq)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        event(&mut tx, cid, "reaction.updated", id, seq).await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Read {
    seq: String,
}
pub async fn mark_read(
    State(s): State<AppState>,
    a: Auth,
    Path(cid): Path<Uuid>,
    Json(b): Json<Read>,
) -> ApiResult<StatusCode> {
    db::channel_access(&s.pool, cid, a.user.id).await?;
    let seq = domain::sequence(&b.seq)?;
    let last: i64 = sqlx::query_scalar("SELECT last_seq FROM channels WHERE id=$1")
        .bind(cid)
        .fetch_one(&s.pool)
        .await?;
    if seq > last {
        return Err(Error::Invalid("Leitura além do último evento".into()).into());
    }
    sqlx::query("INSERT INTO channel_reads(channel_id,user_id,seq) VALUES($1,$2,$3) ON CONFLICT(channel_id,user_id) DO UPDATE SET seq=GREATEST(channel_reads.seq,EXCLUDED.seq)").bind(cid).bind(a.user.id).bind(seq).execute(&s.pool).await?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
pub struct Search {
    q: String,
    channel_id: Option<Uuid>,
}
pub async fn search(
    State(s): State<AppState>,
    a: Auth,
    Query(q): Query<Search>,
) -> ApiResult<Json<Value>> {
    if q.q.trim().is_empty() || q.q.len() > 200 {
        return Err(Error::Invalid("Busca deve ter de1 a200 bytes".into()).into());
    }
    let ids:Vec<Uuid>=sqlx::query_scalar("SELECT m.id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE NOT m.deleted AND ($1::uuid IS NULL OR m.channel_id=$1) AND to_tsvector('simple',m.content) @@ plainto_tsquery('simple',$2) AND (EXISTS(SELECT 1 FROM guild_members gm WHERE gm.guild_id=c.guild_id AND gm.user_id=$3) OR EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.user_id=$3)) AND (harmony_channel_permissions(c.id,$3) & 1)=1 ORDER BY m.created_at DESC LIMIT 50").bind(q.channel_id).bind(q.q).bind(a.user.id).fetch_all(&s.pool).await?;
    let mut items = vec![];
    for id in ids {
        items.push(db::message(&s.pool, id, a.user.id).await?)
    }
    Ok(Json(json!({"items":items})))
}
pub async fn dispatch_outbox(s: AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(100));
    loop {
        interval.tick().await;
        let rows = sqlx::query(
            "SELECT id,event FROM outbox WHERE delivered_at IS NULL ORDER BY id LIMIT 100",
        )
        .fetch_all(&s.pool)
        .await;
        let Ok(rows) = rows else { continue };
        for row in rows {
            let event: Value = row.get("event");
            s.events.send(event).ok();
            let _ = sqlx::query("UPDATE outbox SET delivered_at=now() WHERE id=$1")
                .bind(row.get::<i64, _>("id"))
                .execute(&s.pool)
                .await;
        }
    }
}
