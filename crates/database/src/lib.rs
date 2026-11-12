//! Embedded database adapter shared by API and the isolated media worker.
//! Multi-step mutations must begin with `BEGIN IMMEDIATE`: SQLite's writer lock
//! replaces the previous PostgreSQL row/advisory locks across both processes.
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use std::{str::FromStr, time::Duration};
// A process retains a shared maintenance lease for every opened database.
// Offline backup/restore takes an exclusive flock on the same file. Keeping the
// lease until process exit also covers pooled connections and in-flight tasks.
static LEASES: std::sync::Mutex<
    Option<std::collections::BTreeMap<std::path::PathBuf, std::fs::File>>,
> = std::sync::Mutex::new(None);
fn maintenance_lease(database: &std::path::Path) -> Result<(), sqlx::Error> {
    let absolute = if database.is_absolute() {
        database.to_path_buf()
    } else {
        std::env::current_dir()?.join(database)
    };
    let mut name = absolute.as_os_str().to_os_string();
    name.push(".lock");
    let name = std::path::PathBuf::from(name);
    let mut leases = LEASES
        .lock()
        .map_err(|_| sqlx::Error::Protocol("database maintenance lock failed".into()))?;
    let leases = leases.get_or_insert_with(Default::default);
    if let std::collections::btree_map::Entry::Vacant(entry) = leases.entry(name.clone()) {
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(&name)?;
        lock.try_lock_shared().map_err(|_| {
            sqlx::Error::Protocol("database is locked for offline maintenance".into())
        })?;
        entry.insert(lock);
    }
    Ok(())
}

pub async fn connect(url: &str, max_connections: u32) -> Result<SqlitePool, sqlx::Error> {
    if !url.starts_with("sqlite:") {
        return Err(sqlx::Error::Protocol("Harmony exige DATABASE_URL=sqlite:...; importe PostgreSQL com scripts/migrate-postgres-to-sqlite.py antes de iniciar".into()));
    }
    let mut options = SqliteConnectOptions::from_str(url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .busy_timeout(Duration::from_secs(15));
    let filename = options.get_filename().to_path_buf();
    if filename != std::path::Path::new(":memory:") {
        if let Some(parent) = filename.parent().filter(|p| !p.as_os_str().is_empty()) {
            tokio::fs::create_dir_all(parent).await?;
        }
        // SQLite and offline tools must lock the same canonical path even when
        // an operator passes a symlink, '..', or a relative DATABASE_URL.
        let filename = match tokio::fs::canonicalize(&filename).await {
            Ok(path) => path,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let parent = filename
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or_else(|| std::path::Path::new("."));
                let parent = tokio::fs::canonicalize(parent).await?;
                let name = filename
                    .file_name()
                    .ok_or_else(|| sqlx::Error::Protocol("invalid database filename".into()))?;
                parent.join(name)
            }
            Err(e) => return Err(e.into()),
        };
        maintenance_lease(&filename)?;
        let mut file = std::fs::OpenOptions::new();
        file.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            file.mode(0o600);
        }
        match file.open(&filename) {
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e.into()),
        }
        options = options.filename(filename);
    }
    SqlitePoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(20))
        .connect_with(options)
        .await
}

pub async fn migrate(pool: &SqlitePool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!("../../migrations-sqlite").run(pool).await?;
    loop {
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        let rows =
            sqlx::query("SELECT id,content FROM messages WHERE search_index_version=0 LIMIT 200")
                .fetch_all(&mut *tx)
                .await?;
        if rows.is_empty() {
            tx.commit().await?;
            break;
        }
        for row in rows {
            let content: String = row.get("content");
            let lexemes =
                harmony_search::encoded(&content).map_err(|e| sqlx::Error::Protocol(e.into()))?;
            sqlx::query("UPDATE messages SET search_lexemes=$1,search_index_version=1 WHERE id=$2")
                .bind(lexemes)
                .bind(row.get::<uuid::Uuid, _>("id"))
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
    }
    Ok(())
}
