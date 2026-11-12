use harmony_database::{connect, migrate};
use sqlx::Row;
use uuid::Uuid;

fn url() -> String {
    format!(
        "sqlite:{}",
        std::env::temp_dir()
            .join(format!("harmony-db-{}.sqlite", Uuid::now_v7()))
            .display()
    )
}

#[tokio::test]
async fn fixed_sqlite_wal_foreign_keys_and_reopen_preserve_data() {
    let database = url();
    let pool = connect(&database, 4).await.unwrap();
    migrate(&pool).await.unwrap();
    let version: String = sqlx::query_scalar("SELECT sqlite_version()")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        version, "3.51.3",
        "Pinned SQLite includes the upstream WAL-reset correction"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "wal"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("PRAGMA synchronous")
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO users(id,username,display_name,password_hash,preferences) VALUES($1,'preserved','Test','hash',$2)")
        .bind(id).bind(serde_json::json!({"theme":{"accent":"#123456"}})).execute(&pool).await.unwrap();
    let orphan=sqlx::query("INSERT INTO sessions(id,user_id,refresh_hash,expires_at) VALUES($1,$2,'hash','2030-01-01T00:00:00Z')")
        .bind(Uuid::now_v7()).bind(Uuid::now_v7()).execute(&pool).await;
    assert!(orphan.is_err());
    pool.close().await;
    let reopened = connect(&database, 4).await.unwrap();
    migrate(&reopened).await.unwrap();
    let row =
        sqlx::query("SELECT id,password_hash,preferences FROM users WHERE username='preserved'")
            .fetch_one(&reopened)
            .await
            .unwrap();
    assert_eq!(row.get::<Uuid, _>("id"), id);
    assert_eq!(row.get::<String, _>("password_hash"), "hash");
    assert_eq!(
        row.get::<serde_json::Value, _>("preferences"),
        serde_json::json!({"theme":{"accent":"#123456"}})
    );
    reopened.close().await;
}

#[tokio::test]
async fn independent_pools_serialize_writer_reservations_without_lost_updates() {
    let database = url();
    let left = connect(&database, 4).await.unwrap();
    migrate(&left).await.unwrap();
    let right = connect(&database, 4).await.unwrap();
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO users(id,username,display_name,password_hash) VALUES($1,'concurrent','Test','hash')").bind(id).execute(&left).await.unwrap();
    let mut jobs = Vec::new();
    for i in 0..24 {
        let pool = if i % 2 == 0 {
            left.clone()
        } else {
            right.clone()
        };
        jobs.push(tokio::spawn(async move {
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
            let n: i64 = sqlx::query_scalar("SELECT auth_version FROM users WHERE id=$1")
                .bind(id)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            tokio::task::yield_now().await;
            sqlx::query("UPDATE users SET auth_version=$1 WHERE id=$2")
                .bind(n + 1)
                .bind(id)
                .execute(&mut *tx)
                .await
                .unwrap();
            tx.commit().await.unwrap();
        }));
    }
    for job in jobs {
        job.await.unwrap();
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT auth_version FROM users WHERE id=$1")
            .bind(id)
            .fetch_one(&left)
            .await
            .unwrap(),
        25
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
            .fetch_one(&left)
            .await
            .unwrap(),
        "ok"
    );
    left.close().await;
    right.close().await;
}

#[tokio::test]
async fn sqlite_search_results_match_postgres_plain_query_oracle() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../search/tests/fixtures/postgres-simple.json"
    ))
    .unwrap();
    let pool = connect(&url(), 2).await.unwrap();
    sqlx::query("CREATE VIRTUAL TABLE comparison USING fts5(lexemes,tokenize='ascii')")
        .execute(&pool)
        .await
        .unwrap();
    for (id, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
        sqlx::query("INSERT INTO comparison(rowid,lexemes) VALUES($1,$2)")
            .bind(id as i64)
            .bind(harmony_search::encoded(case["input"].as_str().unwrap()).unwrap())
            .execute(&pool)
            .await
            .unwrap();
    }
    for query in fixture["queries"].as_array().unwrap() {
        let text = query["query"].as_str().unwrap();
        let expected: Vec<i64> = serde_json::from_value(query["matches"].clone()).unwrap();
        let actual: Vec<i64> = sqlx::query_scalar(
            "SELECT rowid FROM comparison WHERE comparison MATCH $1 ORDER BY rowid",
        )
        .bind(harmony_search::query(text).unwrap())
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(actual, expected, "query={text:?}");
    }
    pool.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn canonical_aliases_share_maintenance_lock_with_python_backup() {
    use std::{
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
    };
    let directory = std::env::temp_dir().join(format!("harmony-lock-{}", Uuid::now_v7()));
    std::fs::create_dir(&directory).unwrap();
    let actual = directory.join("actual.db");
    let alias = directory.join("alias.db");
    std::fs::File::create(&actual).unwrap();
    std::os::unix::fs::symlink(&actual, &alias).unwrap();
    // A Python backup holding an exclusive lease must block a Rust API opening
    // the database through a different filename alias.
    let mut exclusive = Command::new("python3").args(["-c",
        "import fcntl,sys; f=open(sys.argv[1]+'.lock','a+b'); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print('locked',flush=True); sys.stdin.read()"])
        .arg(&actual).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let mut ready = String::new();
    BufReader::new(exclusive.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert_eq!(ready.trim(), "locked");
    assert!(
        connect(&format!("sqlite:{}", alias.display()), 1)
            .await
            .is_err()
    );
    exclusive.stdin.take().unwrap().write_all(b"").unwrap();
    assert!(exclusive.wait().unwrap().success());
    // Conversely, a runtime shared lease via the symlink excludes maintenance
    // via the canonical path, including after the pool closes until process exit.
    let pool = connect(&format!("sqlite:{}", alias.display()), 1)
        .await
        .unwrap();
    migrate(&pool).await.unwrap();
    pool.close().await;
    let check = Command::new("python3").args(["-c",
        "import fcntl,sys; f=open(sys.argv[1]+'.lock','a+b')\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(0)\nsys.exit(1)"])
        .arg(&actual).status().unwrap();
    assert!(
        check.success(),
        "canonical database lease must exclude Python maintenance"
    );
    assert!(!directory.join("alias.db.lock").exists());
}
