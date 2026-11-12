use crate::{Config, Failure, Result, parser};
use harmony_storage::Store;
use sqlx::{Row, SqlitePool};
use std::{path::Path, time::Duration};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

pub struct Worker {
    pub pool: SqlitePool,
    config: Config,
    store: Store,
}
struct Job {
    upload: Uuid,
    attempt: Uuid,
    key: String,
    size: i64,
    mime: String,
}
impl Worker {
    pub async fn connect(config: Config) -> Result<Self> {
        let pool = harmony_database::connect(&config.database_url, 4).await?;
        sqlx::migrate!("../../migrations-sqlite")
            .run(&pool)
            .await
            .map_err(|_| Failure::permanent("migration_failed"))?;
        Self::new(pool, config)
    }
    pub fn new(pool: SqlitePool, config: Config) -> Result<Self> {
        let store =
            Store::new(&config.storage).map_err(|_| Failure::permanent("storage_configuration"))?;
        Ok(Self {
            pool,
            config,
            store,
        })
    }
    async fn claim(&self) -> Result<Option<Job>> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;

        let row=sqlx::query("SELECT j.upload_id,j.attempts,u.object_key,u.size,u.content_type FROM media_jobs j JOIN uploads u ON u.id=j.upload_id LEFT JOIN messages m ON m.id=u.message_id WHERE j.status='queued' AND julianday(j.available_at)<=julianday('now') AND j.attempts<3 AND u.status='ready' AND NOT COALESCE(m.deleted,false) ORDER BY j.available_at,j.upload_id LIMIT 1").fetch_optional(&mut *tx).await?;
        let Some(row) = row else { return Ok(None) };
        let upload: Uuid = row.get("upload_id");
        let used: i64 = sqlx::query_scalar("SELECT (SELECT used_bytes FROM harmony_storage_usage)")
            .fetch_one(&mut *tx)
            .await?;
        if (self.config.output_limit as i64) > self.config.quota.saturating_sub(used) {
            sqlx::query("UPDATE media_jobs SET error_code='quota_wait',available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE upload_id=$1").bind(upload).execute(&mut *tx).await?;
            tx.commit().await?;
            return Ok(None);
        }
        let attempt = Uuid::now_v7();
        sqlx::query("INSERT INTO media_attempts(id,upload_id,reserved_bytes,state) VALUES($1,$2,$3,'active')").bind(attempt).bind(upload).bind(self.config.output_limit as i64).execute(&mut *tx).await?;
        for (kind, content_type) in [("thumbnail", "image/jpeg"), ("faststart", "video/mp4")] {
            sqlx::query("INSERT INTO media_derivatives(attempt_id,kind,object_key,content_type) VALUES($1,$2,$3,$4)").bind(attempt).bind(kind).bind(format!("derived/{upload}/{attempt}/{kind}")).bind(content_type).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE media_jobs SET status='processing',attempts=attempts+1,attempt_id=$2,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now',($3) || ' seconds'),error_code=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE upload_id=$1").bind(upload).bind(attempt).bind(self.config.lease as f64).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(Some(Job {
            upload,
            attempt,
            key: row.get("object_key"),
            size: row.get("size"),
            mime: row.get("content_type"),
        }))
    }
    async fn heartbeat(&self, job: &Job) -> Result<()> {
        let rows=sqlx::query("UPDATE media_jobs SET lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now',($3) || ' seconds'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE upload_id=$1 AND attempt_id=$2 AND status='processing' AND julianday(lease_until)>julianday('now')").bind(job.upload).bind(job.attempt).bind(self.config.lease as f64).execute(&self.pool).await?.rows_affected();
        if rows != 1 {
            return Err(Failure::transient("lease_lost"));
        }
        Ok(())
    }
    pub async fn run_once(&self) -> Result<bool> {
        let Some(job) = self.claim().await? else {
            return Ok(false);
        };
        tracing::info!(upload_id=%job.upload,attempt_id=%job.attempt,"media claimed");
        let heartbeat = async {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                self.heartbeat(&job).await?;
            }
        };
        let result = tokio::select! {result=self.process(&job)=>result,result=heartbeat=>result};
        if let Err(error) = result {
            // An old worker cannot change the replacement attempt, even after a pause.
            sqlx::query("UPDATE media_jobs SET status=CASE WHEN $3 AND attempts<3 THEN 'queued' ELSE 'failed' END,error_code=$4,available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',(attempts*5) || ' seconds'),lease_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE upload_id=$1 AND attempt_id=$2 AND status='processing'").bind(job.upload).bind(job.attempt).bind(error.retry).bind(error.code).execute(&self.pool).await?;
            tracing::warn!(upload_id=%job.upload,code=error.code,"media processing failed");
        }
        Ok(true)
    }
    async fn download(&self, job: &Job, path: &Path) -> Result<()> {
        if job.size <= 0 || job.size as u64 > self.config.input_limit {
            return Err(Failure::permanent("input_limit"));
        }
        // Keys come only from immutable ready uploads, never client URLs.
        if job.key != format!("objects/{}/original", job.upload) {
            return Err(Failure::permanent("source_key_invalid"));
        }
        let bytes = self
            .store
            .read(&job.key, self.config.input_limit)
            .await
            .map_err(|_| Failure::transient("storage_unavailable"))?;
        if bytes.len() as u64 != job.size as u64 {
            return Err(Failure::transient("source_size_mismatch"));
        }
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .await?;
        file.write_all(&bytes).await?;
        file.flush().await?;
        Ok(())
    }
    async fn process(&self, job: &Job) -> Result<()> {
        let temp = tempfile::Builder::new()
            .prefix(&format!("attempt-{}-", job.attempt))
            .tempdir_in(&self.config.temp)?;
        let dir = temp.path().canonicalize()?;
        self.download(job, &dir.join("input")).await?;
        let parsed = parser::parse(&self.config, &dir, &job.mime).await?;
        let mut payloads = Vec::new();
        let mut dimensions = Vec::new();
        let mut total = 0u64;
        for product in &parsed.products {
            use std::os::unix::fs::OpenOptionsExt;
            let file = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&product.path)?;
            let meta = file.metadata()?;
            if !meta.is_file() || meta.len() == 0 {
                return Err(Failure::permanent("output_invalid"));
            }
            total = total.saturating_add(meta.len());
            if total > self.config.output_limit {
                return Err(Failure::permanent("output_limit"));
            }
            let mut reader = tokio::fs::File::from_std(file);
            let mut bytes = Vec::with_capacity(meta.len() as usize);
            use tokio::io::AsyncReadExt;
            (&mut reader)
                .take(self.config.output_limit + 1)
                .read_to_end(&mut bytes)
                .await?;
            if bytes.len() as u64 != meta.len() {
                return Err(Failure::permanent("output_invalid"));
            }
            if product.kind == "thumbnail"
                && !(bytes.starts_with(&[0xff, 0xd8, 0xff]) && bytes.ends_with(&[0xff, 0xd9]))
            {
                return Err(Failure::permanent("output_invalid"));
            }
            dimensions.push(if product.kind == "thumbnail" {
                let (w, h) = parser::jpeg_dimensions(&bytes)?;
                (Some(w), Some(h))
            } else {
                (product.width, product.height)
            });
            payloads.push(bytes);
        }
        // Lock order matches upload completion: quota -> job -> upload/message. The object
        // publication stays under the job lock so cleanup cannot race a stale in-flight write.
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;

        let active:Option<Uuid>=sqlx::query_scalar("SELECT upload_id FROM media_jobs WHERE upload_id=$1 AND attempt_id=$2 AND status='processing' AND julianday(lease_until)>julianday('now')").bind(job.upload).bind(job.attempt).fetch_optional(&mut *tx).await?;
        if active.is_none() {
            return Err(Failure::transient("lease_lost"));
        }
        let source = sqlx::query("SELECT status,message_id FROM uploads WHERE id=$1")
            .bind(job.upload)
            .fetch_one(&mut *tx)
            .await?;
        if source.get::<String, _>("status") != "ready" {
            return Err(Failure::permanent("source_deleted"));
        }
        if let Some(mid) = source.get::<Option<Uuid>, _>("message_id") {
            let deleted: bool = sqlx::query_scalar("SELECT deleted FROM messages WHERE id=$1")
                .bind(mid)
                .fetch_one(&mut *tx)
                .await?;
            if deleted {
                return Err(Failure::permanent("source_deleted"));
            }
        }
        for ((product, bytes), (width, height)) in
            parsed.products.iter().zip(&payloads).zip(dimensions)
        {
            let key: String = sqlx::query_scalar(
                "SELECT object_key FROM media_derivatives WHERE attempt_id=$1 AND kind=$2",
            )
            .bind(job.attempt)
            .bind(product.kind)
            .fetch_one(&mut *tx)
            .await?;
            self.store
                .put(&key, bytes, product.content_type)
                .await
                .map_err(|_| Failure::transient("storage_unavailable"))?;
            sqlx::query("UPDATE media_derivatives SET ready=true,size=$3,width=$4,height=$5 WHERE attempt_id=$1 AND kind=$2").bind(job.attempt).bind(product.kind).bind(bytes.len() as i64).bind(width).bind(height).execute(&mut *tx).await?;
        }
        // Planned but unused keys remain tracked until cleanup (size zero, not public).
        sqlx::query("UPDATE media_attempts SET reserved_bytes=0,state='published' WHERE id=$1")
            .bind(job.attempt)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE media_jobs SET status='ready',metadata=$3,lease_until=NULL,error_code=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE upload_id=$1 AND attempt_id=$2").bind(job.upload).bind(job.attempt).bind(parsed.metadata).execute(&mut *tx).await?;
        tx.commit().await?;
        tracing::info!(upload_id=%job.upload,bytes=total,"media published");
        Ok(())
    }
    pub async fn cleanup(&self) -> Result<()> {
        sqlx::query("UPDATE media_jobs AS j SET status='failed',error_code='source_deleted',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE j.attempt_id IS NULL AND j.status='queued' AND EXISTS (SELECT 1 FROM uploads u JOIN messages m ON m.id=u.message_id WHERE u.id=j.upload_id AND m.deleted)").execute(&self.pool).await?;
        for _ in 0..100 {
            let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;

            let row=sqlx::query("SELECT a.id,a.upload_id,j.attempt_id,j.status,j.attempts,COALESCE(m.deleted,false) AS deleted FROM media_attempts a JOIN media_jobs j ON j.upload_id=a.upload_id JOIN uploads u ON u.id=j.upload_id LEFT JOIN messages m ON m.id=u.message_id WHERE a.id IS NOT j.attempt_id OR j.status IN ('failed','unsupported','queued') OR (j.status='processing' AND julianday(j.lease_until)<julianday('now')) OR COALESCE(m.deleted,false) ORDER BY a.created_at LIMIT 1").fetch_optional(&mut *tx).await?;
            let Some(row) = row else { break };
            let attempt: Uuid = row.get("id");
            let upload: Uuid = row.get("upload_id");
            let keys: Vec<String> =
                sqlx::query_scalar("SELECT object_key FROM media_derivatives WHERE attempt_id=$1")
                    .bind(attempt)
                    .fetch_all(&mut *tx)
                    .await?;
            for key in keys {
                self.store
                    .delete(&key)
                    .await
                    .map_err(|_| Failure::transient("storage_unavailable"))?;
            }
            sqlx::query("DELETE FROM media_derivatives WHERE attempt_id=$1")
                .bind(attempt)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM media_attempts WHERE id=$1")
                .bind(attempt)
                .execute(&mut *tx)
                .await?;
            if row.get::<Option<Uuid>, _>("attempt_id") == Some(attempt) {
                let status: String = row.get("status");
                let deleted: bool = row.get("deleted");
                let next = if deleted {
                    "failed"
                } else if status == "processing" {
                    if row.get::<i32, _>("attempts") < 3 {
                        "queued"
                    } else {
                        "failed"
                    }
                } else {
                    &status
                };
                sqlx::query("UPDATE media_jobs SET attempt_id=NULL,lease_until=NULL,status=$2,error_code=CASE WHEN $3 THEN 'source_deleted' WHEN status='processing' THEN 'lease_expired' ELSE error_code END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE upload_id=$1").bind(upload).bind(next).bind(deleted).execute(&mut *tx).await?;
            }
            tx.commit().await?;
        }
        self.cleanup_temp().await?;
        Ok(())
    }
    async fn cleanup_temp(&self) -> Result<()> {
        let mut entries = tokio::fs::read_dir(&self.config.temp).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("attempt-") || !entry.file_type().await?.is_dir() {
                continue;
            }
            let age = entry
                .metadata()
                .await?
                .modified()?
                .elapsed()
                .unwrap_or_default();
            if age > Duration::from_secs(3600) {
                tokio::fs::remove_dir_all(entry.path()).await?;
            }
        }
        Ok(())
    }
}
