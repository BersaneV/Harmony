use crate::{
    AppState,
    auth::{Auth, consume_invite, hash, random_token},
    db,
    error::ApiResult,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use chrono::{Duration, Utc};
use harmony_domain::{self as domain, Error, Guild};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Name {
    pub name: String,
}
pub async fn guilds(State(s): State<AppState>, a: Auth) -> ApiResult<Json<Value>> {
    let items=sqlx::query("SELECT g.* FROM guilds g JOIN guild_members m ON m.guild_id=g.id WHERE m.user_id=$1 ORDER BY g.created_at,g.id").bind(a.user.id).fetch_all(&s.pool).await?.into_iter().map(|r|Guild{id:r.get("id"),name:r.get("name"),owner_id:r.get("owner_id")}).collect::<Vec<_>>();
    Ok(Json(json!({"items":items})))
}
pub async fn create_guild(
    State(s): State<AppState>,
    a: Auth,
    Json(b): Json<Name>,
) -> ApiResult<Json<Guild>> {
    s.limit(&format!("guild:{}", a.user.id), 10, 3600)?;
    let guild = Guild {
        id: Uuid::now_v7(),
        name: domain::name(&b.name)?,
        owner_id: a.user.id,
    };
    let mut tx = s.pool.begin().await?;
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(a.user.id)
        .execute(&mut *tx)
        .await?;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM guilds WHERE owner_id=$1")
        .bind(a.user.id)
        .fetch_one(&mut *tx)
        .await?;
    if n >= 20 {
        return Err(Error::Conflict("Limite de20 comunidades por conta".into()).into());
    }
    sqlx::query("INSERT INTO guilds(id,name,owner_id) VALUES($1,$2,$3)")
        .bind(guild.id)
        .bind(&guild.name)
        .bind(a.user.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO guild_members(guild_id,user_id,role) VALUES($1,$2,'owner')")
        .bind(guild.id)
        .bind(a.user.id)
        .execute(&mut *tx)
        .await?;
    for (name, kind) in [("geral", "text"), ("Sala de voz", "voice")] {
        sqlx::query("INSERT INTO channels(id,guild_id,name,kind) VALUES($1,$2,$3,$4)")
            .bind(Uuid::now_v7())
            .bind(guild.id)
            .bind(name)
            .bind(kind)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(guild))
}
pub async fn members(
    State(s): State<AppState>,
    a: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    if db::member_role(&s.pool, id, a.user.id).await?.is_none() {
        return Err(Error::Forbidden.into());
    }
    let items=sqlx::query("SELECT to_jsonb(u)||jsonb_build_object('role',m.role,'role_ids',COALESCE((SELECT jsonb_agg(mr.role_id ORDER BY mr.role_id) FROM guild_member_roles mr WHERE mr.guild_id=m.guild_id AND mr.user_id=m.user_id),'[]'::jsonb)) AS data FROM guild_members m JOIN public_users u ON u.id=m.user_id WHERE guild_id=$1 ORDER BY u.username").bind(id).fetch_all(&s.pool).await?.into_iter().map(|r|r.get::<Value,_>("data")).collect::<Vec<_>>();
    Ok(Json(json!({"items":items})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Role {
    role: String,
}
pub async fn update_member(
    State(s): State<AppState>,
    a: Auth,
    Path((gid, uid)): Path<(Uuid, Uuid)>,
    Json(b): Json<Role>,
) -> ApiResult<StatusCode> {
    if !matches!(b.role.as_str(), "admin" | "member") {
        return Err(Error::Invalid("Cargo inválido".into()).into());
    }
    let mut tx = s.pool.begin().await?;
    let owner: Uuid = sqlx::query_scalar("SELECT owner_id FROM guilds WHERE id=$1 FOR UPDATE")
        .bind(gid)
        .fetch_one(&mut *tx)
        .await?;
    if owner != a.user.id || uid == owner {
        return Err(Error::Forbidden.into());
    }
    let result = sqlx::query("UPDATE guild_members SET role=$1 WHERE guild_id=$2 AND user_id=$3")
        .bind(b.role)
        .bind(gid)
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    if result.rows_affected() == 0 {
        return Err(Error::NotFound.into());
    }
    db::audit(&mut tx, a.user.id, "member.role", Some(uid)).await?;
    tx.commit().await?;
    s.events.send(json!({"type":"resync"})).ok();
    Ok(StatusCode::NO_CONTENT)
}
pub async fn remove_member(
    State(s): State<AppState>,
    a: Auth,
    Path((gid, uid)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    let mut tx = s.pool.begin().await?;
    let owner: Uuid = sqlx::query_scalar("SELECT owner_id FROM guilds WHERE id=$1 FOR UPDATE")
        .bind(gid)
        .fetch_one(&mut *tx)
        .await?;
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM guild_members WHERE guild_id=$1 AND user_id=$2")
            .bind(gid)
            .bind(a.user.id)
            .fetch_optional(&mut *tx)
            .await?;
    let target: Option<String> =
        sqlx::query_scalar("SELECT role FROM guild_members WHERE guild_id=$1 AND user_id=$2")
            .bind(gid)
            .bind(uid)
            .fetch_optional(&mut *tx)
            .await?;
    if uid == owner
        || !(a.user.id == uid
            || (domain::can_manage(role.as_deref())
                && (owner == a.user.id || target.as_deref() == Some("member"))))
    {
        return Err(Error::Forbidden.into());
    }
    sqlx::query("DELETE FROM guild_members WHERE guild_id=$1 AND user_id=$2")
        .bind(gid)
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    db::audit(&mut tx, a.user.id, "member.remove", Some(uid)).await?;
    tx.commit().await?;
    s.events.send(json!({"type":"resync"})).ok();
    crate::media::revoke_guild_user(&s, gid, uid).await;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn channels(
    State(s): State<AppState>,
    a: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    if db::member_role(&s.pool, id, a.user.id).await?.is_none() {
        return Err(Error::Forbidden.into());
    }
    let items=sqlx::query("SELECT c.*,harmony_channel_permissions(c.id,$2) AS effective_permissions,COALESCE(r.seq,0) AS read_seq FROM channels c LEFT JOIN channel_reads r ON r.channel_id=c.id AND r.user_id=$2 WHERE c.guild_id=$1 AND (harmony_channel_permissions(c.id,$2) & 1)=1 ORDER BY c.created_at,c.id").bind(id).bind(a.user.id).fetch_all(&s.pool).await?.into_iter().map(db::channel).collect::<Vec<_>>();
    Ok(Json(json!({"items":items})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewChannel {
    name: String,
    kind: String,
}
pub async fn create_channel(
    State(s): State<AppState>,
    a: Auth,
    Path(id): Path<Uuid>,
    Json(b): Json<NewChannel>,
) -> ApiResult<Json<Value>> {
    if !domain::can_manage(db::member_role(&s.pool, id, a.user.id).await?.as_deref()) {
        return Err(Error::Forbidden.into());
    }
    if !matches!(b.kind.as_str(), "text" | "voice") {
        return Err(Error::Invalid("Tipo de canal inválido".into()).into());
    }
    let name = domain::name(&b.name)?;
    let mut tx = s.pool.begin().await?;
    sqlx::query("SELECT id FROM guilds WHERE id=$1 FOR UPDATE")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM guild_members WHERE guild_id=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(id)
    .bind(a.user.id)
    .fetch_optional(&mut *tx)
    .await?;
    if !domain::can_manage(role.as_deref()) {
        return Err(Error::Forbidden.into());
    }
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM channels WHERE guild_id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if n >= 100 {
        return Err(Error::Conflict("Limite de100 canais por comunidade".into()).into());
    }
    let row =
        sqlx::query("INSERT INTO channels(id,guild_id,name,kind) VALUES($1,$2,$3,$4) RETURNING *")
            .bind(Uuid::now_v7())
            .bind(id)
            .bind(name)
            .bind(b.kind)
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;
    Ok(Json(json!(db::channel(row))))
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Invite {
    pub expires_hours: Option<i64>,
    pub max_uses: Option<i32>,
}
pub async fn issue_invite(
    s: &AppState,
    actor: Uuid,
    guild: Option<Uuid>,
    b: Invite,
) -> ApiResult<Json<Value>> {
    let hours = b.expires_hours.unwrap_or(24);
    let uses = b.max_uses.unwrap_or(1);
    if !(1..=168).contains(&hours) || !(1..=100).contains(&uses) {
        return Err(Error::Invalid("Convite aceita1–168 horas e1–100 usos".into()).into());
    }
    let mut tx = s.pool.begin().await?;
    if let Some(gid) = guild {
        let role: Option<String> = sqlx::query_scalar(
            "SELECT role FROM guild_members WHERE guild_id=$1 AND user_id=$2 FOR SHARE",
        )
        .bind(gid)
        .bind(actor)
        .fetch_optional(&mut *tx)
        .await?;
        if !domain::can_manage(role.as_deref()) {
            return Err(Error::Forbidden.into());
        }
    }
    let token = random_token();
    let expires = Utc::now() + Duration::hours(hours);
    sqlx::query(
        "INSERT INTO invites(hash,guild_id,created_by,expires_at,max_uses) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(hash(&token))
    .bind(guild)
    .bind(actor)
    .bind(expires)
    .bind(uses)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"token":token,"expires_at":expires})))
}
pub async fn guild_invite(
    State(s): State<AppState>,
    a: Auth,
    Path(id): Path<Uuid>,
    Json(b): Json<Invite>,
) -> ApiResult<Json<Value>> {
    if !domain::can_manage(db::member_role(&s.pool, id, a.user.id).await?.as_deref()) {
        return Err(Error::Forbidden.into());
    }
    issue_invite(&s, a.user.id, Some(id), b).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Token {
    token: String,
}
pub async fn accept_invite(
    State(s): State<AppState>,
    a: Auth,
    Json(b): Json<Token>,
) -> ApiResult<Json<Value>> {
    let mut tx = s.pool.begin().await?;
    let gid = consume_invite(&mut tx, &b.token)
        .await?
        .ok_or_else(|| Error::Invalid("Este convite é apenas para cadastro".into()))?;
    sqlx::query("INSERT INTO guild_members(guild_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING").bind(gid).bind(a.user.id).execute(&mut *tx).await?;
    let row = sqlx::query("SELECT id,name,owner_id FROM guilds WHERE id=$1")
        .bind(gid)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!(Guild {
        id: row.get("id"),
        name: row.get("name"),
        owner_id: row.get("owner_id")
    })))
}
#[derive(Deserialize)]
pub struct Search {
    pub q: String,
}
pub async fn users_search(
    State(s): State<AppState>,
    _a: Auth,
    Query(b): Query<Search>,
) -> ApiResult<Json<Value>> {
    let q = b.q.trim();
    if q.len() < 2 || q.len() > 80 {
        return Ok(Json(json!({"items":[]})));
    }
    let items=sqlx::query("SELECT id,username,display_name FROM users WHERE NOT disabled AND starts_with(username,$1) ORDER BY username LIMIT 20").bind(q.to_ascii_lowercase()).fetch_all(&s.pool).await?.into_iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"username":r.get::<String,_>("username"),"display_name":r.get::<String,_>("display_name")})).collect::<Vec<_>>();
    Ok(Json(json!({"items":items})))
}
pub async fn friends(State(s): State<AppState>, a: Auth) -> ApiResult<Json<Value>> {
    let items=sqlx::query("SELECT f.*,to_jsonb(u) AS other_user FROM friends f JOIN public_users u ON u.id=CASE WHEN f.requester_id=$1 THEN f.addressee_id ELSE f.requester_id END WHERE f.requester_id=$1 OR f.addressee_id=$1 ORDER BY f.created_at").bind(a.user.id).fetch_all(&s.pool).await?.into_iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"user":r.get::<Value,_>("other_user"),"status":r.get::<String,_>("status"),"incoming":r.get::<Uuid,_>("addressee_id")==a.user.id})).collect::<Vec<_>>();
    Ok(Json(json!({"items":items})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Friend {
    username: String,
}
pub async fn add_friend(
    State(s): State<AppState>,
    a: Auth,
    Json(b): Json<Friend>,
) -> ApiResult<Json<Value>> {
    s.limit(&format!("friend:{}", a.user.id), 30, 3600)?;
    let username = domain::username(&b.username)?;
    let uid: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE username=$1 AND NOT disabled")
        .bind(username)
        .fetch_one(&s.pool)
        .await?;
    if uid == a.user.id {
        return Err(Error::Invalid("Não é possível adicionar a própria conta".into()).into());
    }
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO friends(id,requester_id,addressee_id,status) VALUES($1,$2,$3,'pending')",
    )
    .bind(id)
    .bind(a.user.id)
    .bind(uid)
    .execute(&s.pool)
    .await?;
    Ok(Json(
        json!({"id":id,"user":db::user(&s.pool,uid).await?,"status":"pending","incoming":false}),
    ))
}
pub async fn accept_friend(
    State(s): State<AppState>,
    a: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let n = sqlx::query("UPDATE friends SET status='accepted' WHERE id=$1 AND addressee_id=$2")
        .bind(id)
        .bind(a.user.id)
        .execute(&s.pool)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(Error::NotFound.into());
    }
    Ok(StatusCode::NO_CONTENT)
}
pub async fn remove_friend(
    State(s): State<AppState>,
    a: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    sqlx::query("DELETE FROM friends WHERE id=$1 AND (requester_id=$2 OR addressee_id=$2)")
        .bind(id)
        .bind(a.user.id)
        .execute(&s.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn conversations(State(s): State<AppState>, a: Auth) -> ApiResult<Json<Value>> {
    let rows=sqlx::query("SELECT c.*,COALESCE(r.seq,0) AS read_seq FROM channels c JOIN channel_members m ON m.channel_id=c.id LEFT JOIN channel_reads r ON r.channel_id=c.id AND r.user_id=$1 WHERE m.user_id=$1 ORDER BY c.created_at,c.id").bind(a.user.id).fetch_all(&s.pool).await?;
    let mut items = vec![];
    for r in rows {
        let mut channel = db::channel(r);
        channel.participants = Some(participants(&s, channel.id).await?);
        items.push(channel);
    }
    Ok(Json(json!({"items":items})))
}
async fn participants(s: &AppState, id: Uuid) -> ApiResult<Vec<domain::User>> {
    let values:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(u) FROM public_users u JOIN channel_members m ON m.user_id=u.id WHERE m.channel_id=$1 ORDER BY u.username").bind(id).fetch_all(&s.pool).await?;
    values
        .into_iter()
        .map(|v| serde_json::from_value(v).map_err(|_| Error::Internal.into()))
        .collect()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Conversation {
    user_ids: Vec<Uuid>,
    name: Option<String>,
}
pub async fn create_conversation(
    State(s): State<AppState>,
    a: Auth,
    Json(b): Json<Conversation>,
) -> ApiResult<Json<Value>> {
    let mut ids = b.user_ids;
    ids.sort();
    ids.dedup();
    if ids.is_empty() || ids.len() > 9 || ids.contains(&a.user.id) {
        return Err(Error::Invalid("Selecione de1 a9 amigos diferentes".into()).into());
    }
    let mut tx = s.pool.begin().await?;
    let mut all = ids.clone();
    all.push(a.user.id);
    all.sort();
    for uid in &all {
        sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
            .bind(uid)
            .execute(&mut *tx)
            .await?;
    }
    for uid in &ids {
        let friend:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM friends WHERE status='accepted' AND ((requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1)))").bind(a.user.id).bind(uid).fetch_one(&mut *tx).await?;
        if !friend {
            return Err(Error::Forbidden.into());
        }
    }
    if ids.len() == 1 {
        let existing:Option<Uuid>=sqlx::query_scalar("SELECT c.id FROM channels c JOIN channel_members a ON a.channel_id=c.id AND a.user_id=$1 JOIN channel_members b ON b.channel_id=c.id AND b.user_id=$2 WHERE c.kind='dm' LIMIT 1").bind(a.user.id).bind(ids[0]).fetch_optional(&mut *tx).await?;
        if let Some(id) = existing {
            tx.commit().await?;
            let mut c = db::channel(
                sqlx::query("SELECT * FROM channels WHERE id=$1")
                    .bind(id)
                    .fetch_one(&s.pool)
                    .await?,
            );
            c.participants = Some(participants(&s, id).await?);
            return Ok(Json(json!(c)));
        }
    }
    let id = Uuid::now_v7();
    let kind = if ids.len() == 1 { "dm" } else { "group" };
    let name = domain::name(b.name.as_deref().unwrap_or(if kind == "dm" {
        "Conversa direta"
    } else {
        "Conversa em grupo"
    }))?;
    let row = sqlx::query("INSERT INTO channels(id,name,kind) VALUES($1,$2,$3) RETURNING *")
        .bind(id)
        .bind(name)
        .bind(kind)
        .fetch_one(&mut *tx)
        .await?;
    for uid in all {
        sqlx::query("INSERT INTO channel_members(channel_id,user_id) VALUES($1,$2)")
            .bind(id)
            .bind(uid)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    let mut c = db::channel(row);
    c.participants = Some(participants(&s, id).await?);
    Ok(Json(json!(c)))
}
