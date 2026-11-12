use crate::{AppState, auth::Auth, db, error::ApiResult};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use harmony_domain::{self as domain, Error, permissions};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row, Sqlite, Transaction};
use uuid::Uuid;
async fn manager(tx: &mut Transaction<'_, Sqlite>, gid: Uuid, uid: Uuid) -> ApiResult<()> {
    db::tx_acl_lock(tx, gid, true).await?;
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM guild_members WHERE guild_id=$1 AND user_id=$2")
            .bind(gid)
            .bind(uid)
            .fetch_optional(&mut **tx)
            .await?;
    if domain::can_manage(role.as_deref()) {
        Ok(())
    } else {
        Err(Error::Forbidden.into())
    }
}
fn role(row: sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":row.get::<Uuid,_>("id"),"guild_id":row.get::<Uuid,_>("guild_id"),"name":row.get::<String,_>("name"),"permissions":row.get::<i64,_>("permissions").to_string()})
}
fn changed(s: &AppState, gid: Uuid) {
    s.events
        .send(json!({"type":"permissions.updated","guild_id":gid}))
        .ok();
}
pub async fn roles(
    State(s): State<AppState>,
    a: Auth,
    Path(gid): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    if db::member_role(&s.pool, gid, a.user.id).await?.is_none() {
        return Err(Error::Forbidden.into());
    }
    let items = sqlx::query("SELECT * FROM guild_roles WHERE guild_id=$1 ORDER BY name,id")
        .bind(gid)
        .fetch_all(&s.pool)
        .await?
        .into_iter()
        .map(role)
        .collect::<Vec<_>>();
    Ok(Json(json!({"items":items})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleBody {
    name: String,
    permissions: String,
}
pub async fn create_role(
    State(s): State<AppState>,
    a: Auth,
    Path(gid): Path<Uuid>,
    Json(b): Json<RoleBody>,
) -> ApiResult<Json<Value>> {
    let name = domain::name(&b.name)?;
    let mask = permissions::parse(&b.permissions)?;
    let mut tx = s.pool.begin_with("BEGIN IMMEDIATE").await?;
    manager(&mut tx, gid, a.user.id).await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM guild_roles WHERE guild_id=$1")
        .bind(gid)
        .fetch_one(&mut *tx)
        .await?;
    if count >= 50 {
        return Err(Error::Conflict("Limite de50 cargos por comunidade".into()).into());
    }
    let id = Uuid::now_v7();
    let row = sqlx::query(
        "INSERT INTO guild_roles(id,guild_id,name,permissions) VALUES($1,$2,$3,$4) RETURNING *",
    )
    .bind(id)
    .bind(gid)
    .bind(name)
    .bind(mask)
    .fetch_one(&mut *tx)
    .await?;
    db::audit(&mut tx, a.user.id, "role.create", Some(id)).await?;
    tx.commit().await?;
    changed(&s, gid);
    Ok(Json(role(row)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateRole {
    name: Option<String>,
    permissions: Option<String>,
}
pub async fn update_role(
    State(s): State<AppState>,
    a: Auth,
    Path(id): Path<Uuid>,
    Json(b): Json<UpdateRole>,
) -> ApiResult<Json<Value>> {
    let name = b.name.map(|v| domain::name(&v)).transpose()?;
    let mask = b.permissions.map(|v| permissions::parse(&v)).transpose()?;
    let gid: Uuid = sqlx::query_scalar("SELECT guild_id FROM guild_roles WHERE id=$1")
        .bind(id)
        .fetch_one(&s.pool)
        .await?;
    let mut tx = s.pool.begin_with("BEGIN IMMEDIATE").await?;
    manager(&mut tx, gid, a.user.id).await?;
    let row=sqlx::query("UPDATE guild_roles SET name=COALESCE($1,name),permissions=COALESCE($2,permissions) WHERE id=$3 AND guild_id=$4 RETURNING *")
        .bind(name).bind(mask).bind(id).bind(gid).fetch_one(&mut *tx).await?;
    db::audit(&mut tx, a.user.id, "role.update", Some(id)).await?;
    tx.commit().await?;
    changed(&s, gid);
    Ok(Json(role(row)))
}
pub async fn delete_role(
    State(s): State<AppState>,
    a: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let gid: Uuid = sqlx::query_scalar("SELECT guild_id FROM guild_roles WHERE id=$1")
        .bind(id)
        .fetch_one(&s.pool)
        .await?;
    let mut tx = s.pool.begin_with("BEGIN IMMEDIATE").await?;
    manager(&mut tx, gid, a.user.id).await?;
    sqlx::query("DELETE FROM guild_roles WHERE id=$1 AND guild_id=$2")
        .bind(id)
        .bind(gid)
        .execute(&mut *tx)
        .await?;
    db::audit(&mut tx, a.user.id, "role.delete", Some(id)).await?;
    tx.commit().await?;
    changed(&s, gid);
    Ok(StatusCode::NO_CONTENT)
}
pub async fn assign_role(
    State(s): State<AppState>,
    a: Auth,
    Path((gid, uid, rid)): Path<(Uuid, Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    assign(s, a, gid, uid, rid, true).await
}
pub async fn unassign_role(
    State(s): State<AppState>,
    a: Auth,
    Path((gid, uid, rid)): Path<(Uuid, Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    assign(s, a, gid, uid, rid, false).await
}
async fn assign(
    s: AppState,
    a: Auth,
    gid: Uuid,
    uid: Uuid,
    rid: Uuid,
    add: bool,
) -> ApiResult<StatusCode> {
    let mut tx = s.pool.begin_with("BEGIN IMMEDIATE").await?;
    manager(&mut tx, gid, a.user.id).await?;
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM guild_members WHERE guild_id=$1 AND user_id=$2) AND EXISTS(SELECT 1 FROM guild_roles WHERE id=$3 AND guild_id=$1)")
        .bind(gid).bind(uid).bind(rid).fetch_one(&mut *tx).await?;
    if !valid {
        return Err(Error::NotFound.into());
    }
    if add {
        sqlx::query("INSERT INTO guild_member_roles(guild_id,user_id,role_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(gid).bind(uid).bind(rid).execute(&mut *tx).await?;
    } else {
        sqlx::query(
            "DELETE FROM guild_member_roles WHERE guild_id=$1 AND user_id=$2 AND role_id=$3",
        )
        .bind(gid)
        .bind(uid)
        .bind(rid)
        .execute(&mut *tx)
        .await?;
    }
    db::audit(
        &mut tx,
        a.user.id,
        if add { "role.assign" } else { "role.unassign" },
        Some(uid),
    )
    .await?;
    tx.commit().await?;
    changed(&s, gid);
    Ok(StatusCode::NO_CONTENT)
}
pub async fn overrides(
    State(s): State<AppState>,
    a: Auth,
    Path(cid): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let gid: Option<Uuid> = sqlx::query_scalar("SELECT guild_id FROM channels WHERE id=$1")
        .bind(cid)
        .fetch_one(&s.pool)
        .await?;
    let gid = gid.ok_or(Error::Forbidden)?;
    if !domain::can_manage(db::member_role(&s.pool, gid, a.user.id).await?.as_deref()) {
        return Err(Error::Forbidden.into());
    }
    let items=sqlx::query("SELECT role_id,allow,deny FROM channel_permissions WHERE channel_id=$1 ORDER BY role_id NULLS FIRST").bind(cid).fetch_all(&s.pool).await?.into_iter().map(|r|json!({"role_id":r.get::<Option<Uuid>,_>("role_id"),"allow":r.get::<i64,_>("allow").to_string(),"deny":r.get::<i64,_>("deny").to_string()})).collect::<Vec<_>>();
    Ok(Json(json!({"items":items})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Override {
    role_id: Option<Uuid>,
    allow: String,
    deny: String,
}
pub async fn set_override(
    State(s): State<AppState>,
    a: Auth,
    Path(cid): Path<Uuid>,
    Json(b): Json<Override>,
) -> ApiResult<StatusCode> {
    let allow = permissions::parse(&b.allow)?;
    let deny = permissions::parse(&b.deny)?;
    if allow & deny != 0 {
        return Err(Error::Invalid(
            "Uma permissão não pode ser permitida e negada no mesmo override".into(),
        )
        .into());
    }
    let gid: Option<Uuid> = sqlx::query_scalar("SELECT guild_id FROM channels WHERE id=$1")
        .bind(cid)
        .fetch_one(&s.pool)
        .await?;
    let gid = gid.ok_or(Error::Forbidden)?;
    let mut tx = s.pool.begin_with("BEGIN IMMEDIATE").await?;
    manager(&mut tx, gid, a.user.id).await?;
    if let Some(rid) = b.role_id {
        let valid: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM guild_roles WHERE id=$1 AND guild_id=$2)",
        )
        .bind(rid)
        .bind(gid)
        .fetch_one(&mut *tx)
        .await?;
        if !valid {
            return Err(Error::NotFound.into());
        }
    }
    if allow == 0 && deny == 0 {
        sqlx::query("DELETE FROM channel_permissions WHERE channel_id=$1 AND role_id IS $2")
            .bind(cid)
            .bind(b.role_id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("INSERT INTO channel_permissions(channel_id,guild_id,role_id,allow,deny) VALUES($1,$2,$3,$4,$5) ON CONFLICT(channel_id,role_key) DO UPDATE SET allow=EXCLUDED.allow,deny=EXCLUDED.deny")
        .bind(cid).bind(gid).bind(b.role_id).bind(allow).bind(deny).execute(&mut *tx).await?;
    }
    db::audit(&mut tx, a.user.id, "channel.permissions", Some(cid)).await?;
    tx.commit().await?;
    changed(&s, gid);
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[sqlx::test(migrations = "../../migrations-sqlite")]
    #[ignore = "integration test (SQLite)"]
    async fn database_permission_algebra_and_cross_guild_constraints(pool: sqlx::SqlitePool) {
        let owner = Uuid::now_v7();
        let member = Uuid::now_v7();
        let gid = Uuid::now_v7();
        let cid = Uuid::now_v7();
        let rid = Uuid::now_v7();
        for uid in [owner, member] {
            sqlx::query("INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,'Test','unused')").bind(uid).bind(uid.to_string()).execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO guilds(id,name,owner_id) VALUES($1,'Test',$2)")
            .bind(gid)
            .bind(owner)
            .execute(&pool)
            .await
            .unwrap();
        for (uid, role) in [(owner, "owner"), (member, "member")] {
            sqlx::query("INSERT INTO guild_members(guild_id,user_id,role) VALUES($1,$2,$3)")
                .bind(gid)
                .bind(uid)
                .bind(role)
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO channels(id,guild_id,name,kind) VALUES($1,$2,'Test','text')")
            .bind(cid)
            .bind(gid)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO guild_roles(id,guild_id,name,permissions) VALUES($1,$2,'Role',63)",
        )
        .bind(rid)
        .bind(gid)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO guild_member_roles(guild_id,user_id,role_id) VALUES($1,$2,$3)")
            .bind(gid)
            .bind(member)
            .bind(rid)
            .execute(&pool)
            .await
            .unwrap();
        for deny in [0, 2, 4, 8, 16, 32, 1, 63] {
            sqlx::query("INSERT INTO channel_permissions(channel_id,guild_id,allow,deny) VALUES($1,$2,0,$3) ON CONFLICT(channel_id,role_key) DO UPDATE SET deny=EXCLUDED.deny").bind(cid).bind(gid).bind(deny).execute(&pool).await.unwrap();
            assert_eq!(
                db::permissions(&pool, cid, member).await.unwrap(),
                permissions::effective(false, 63, (0, deny), &[])
            );
            assert_eq!(db::permissions(&pool, cid, owner).await.unwrap(), 63);
        }
        sqlx::query("INSERT INTO channel_permissions(channel_id,guild_id,role_id,allow,deny) VALUES($1,$2,$3,3,0)").bind(cid).bind(gid).bind(rid).execute(&pool).await.unwrap();
        assert_eq!(db::permissions(&pool, cid, member).await.unwrap(), 3);
        let other = Uuid::now_v7();
        sqlx::query("INSERT INTO guilds(id,name,owner_id) VALUES($1,'Other',$2)")
            .bind(other)
            .bind(owner)
            .execute(&pool)
            .await
            .unwrap();
        let invalid=sqlx::query("INSERT INTO channel_permissions(channel_id,guild_id,role_id,allow,deny) VALUES($1,$2,$3,1,0)").bind(cid).bind(other).bind(rid).execute(&pool).await;
        assert!(
            invalid.is_err(),
            "Composite FK must reject cross-guild channel and role"
        );
    }
}
