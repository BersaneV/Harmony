//! Private, bounded object storage shared by the API and the media worker.
//! Logical keys never become filesystem paths. Local operations are relative to
//! an already-open directory, with no-follow opens and atomic publication.
use futures_util::{StreamExt, stream::BoxStream};
use s3::{Bucket, Region, creds::Credentials};
use sha2::{Digest, Sha256};
use std::{env, io, path::PathBuf, sync::Arc};
use tokio::io::AsyncWriteExt;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use uuid::Uuid;

mod local;
use local::Local;

#[derive(Clone)]
pub struct StorageConfig {
    pub backend: String,
    pub directory: PathBuf,
    pub endpoint: Option<String>,
    pub region: String,
    pub bucket: String,
    pub access: Option<String>,
    pub secret: Option<String>,
}
impl StorageConfig {
    pub fn from_env() -> io::Result<Self> {
        let value = Self {
            backend: env::var("HARMONY_STORAGE_BACKEND").unwrap_or("local".into()),
            directory: env::var_os("HARMONY_STORAGE_DIR")
                .map(PathBuf::from)
                .unwrap_or("./data/files".into()),
            endpoint: env::var("S3_ENDPOINT").ok(),
            region: env::var("S3_REGION").unwrap_or("us-east-1".into()),
            bucket: env::var("S3_BUCKET").unwrap_or("harmony".into()),
            access: env::var("S3_ACCESS_KEY").ok(),
            secret: env::var("S3_SECRET_KEY").ok(),
        };
        if !matches!(value.backend.as_str(), "local" | "s3") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "HARMONY_STORAGE_BACKEND must be local or s3",
            ));
        }
        Ok(value)
    }
}
pub struct Store {
    local: Arc<Local>,
    remote: Option<Box<Bucket>>,
    http: reqwest::Client,
}
fn remote_error() -> io::Error {
    io::Error::other("object storage unavailable")
}
pub fn object_filename(key: &str) -> io::Result<String> {
    if key.is_empty()
        || key.len() > 512
        || key.split('/').any(|p| {
            p.is_empty()
                || p == "."
                || p == ".."
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        })
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid object key",
        ));
    }
    Ok(hex::encode(Sha256::digest(key.as_bytes())))
}
impl Store {
    pub fn new(config: &StorageConfig) -> io::Result<Self> {
        let local = Arc::new(Local::new(&config.directory)?);
        let remote = if config.backend == "s3" {
            if config.access.is_none() || config.secret.is_none() {
                return Err(remote_error());
            }
            let creds = Credentials::new(
                config.access.as_deref(),
                config.secret.as_deref(),
                None,
                None,
                None,
            )
            .map_err(|_| remote_error())?;
            let mut bucket = Bucket::new(
                &config.bucket,
                Region::Custom {
                    region: config.region.clone(),
                    endpoint: config.endpoint.clone().ok_or_else(remote_error)?,
                },
                creds,
            )
            .map_err(|_| remote_error())?
            .with_path_style();
            bucket.set_request_timeout(Some(std::time::Duration::from_secs(20)));
            Some(bucket)
        } else if config.backend == "local" {
            None
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid storage backend",
            ));
        };
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(10))
            .read_timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|_| remote_error())?;
        Ok(Self {
            local,
            remote,
            http,
        })
    }
    pub async fn stream_range(
        &self,
        key: &str,
        start: u64,
        end: u64,
    ) -> io::Result<BoxStream<'static, io::Result<Vec<u8>>>> {
        let name = object_filename(key)?;
        let size = self.size(key).await?;
        if end < start || end >= size {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "range exceeds object",
            ));
        }
        let length = end - start + 1;
        if let Some(remote) = &self.remote {
            let url = remote
                .presign_get(key, 60, None)
                .await
                .map_err(|_| remote_error())?;
            let response = self
                .http
                .get(url)
                .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
                .send()
                .await
                .map_err(|_| remote_error())?;
            if !(response.status().as_u16() == 206
                || (response.status().as_u16() == 200 && start == 0 && end == size - 1))
                || response.content_length() != Some(length)
            {
                return Err(remote_error());
            }
            let stream = futures_util::stream::try_unfold(
                (response.bytes_stream(), length),
                |(mut stream, remaining)| async move {
                    match stream.next().await {
                        Some(Ok(bytes)) if bytes.len() as u64 <= remaining => {
                            let next = remaining - bytes.len() as u64;
                            Ok(Some((bytes.to_vec(), (stream, next))))
                        }
                        None if remaining == 0 => Ok(None),
                        _ => Err(remote_error()),
                    }
                },
            );
            return Ok(stream.boxed());
        }
        let mut file = tokio::fs::File::from_std(self.local.open(&name)?);
        file.seek(std::io::SeekFrom::Start(start)).await?;
        let stream =
            futures_util::stream::try_unfold((file, length), |(mut file, remaining)| async move {
                if remaining == 0 {
                    return Ok::<_, io::Error>(None);
                }
                let mut bytes = vec![0u8; remaining.min(64 * 1024) as usize];
                file.read_exact(&mut bytes).await?;
                let next = remaining - bytes.len() as u64;
                Ok(Some((bytes, (file, next))))
            });
        Ok(stream.boxed())
    }
    pub async fn size(&self, key: &str) -> io::Result<u64> {
        let name = object_filename(key)?;
        if let Some(remote) = &self.remote {
            let (head, status) = remote.head_object(key).await.map_err(|_| remote_error())?;
            if status != 200 {
                return Err(io::Error::new(io::ErrorKind::NotFound, "object missing"));
            }
            return head
                .content_length
                .and_then(|n| u64::try_from(n).ok())
                .ok_or_else(remote_error);
        }
        let local = self.local.clone();
        tokio::task::spawn_blocking(move || local.open(&name)?.metadata().map(|m| m.len()))
            .await
            .map_err(|_| remote_error())?
    }
    pub async fn read_range(
        &self,
        key: &str,
        start: u64,
        end: u64,
        limit: u64,
    ) -> io::Result<Vec<u8>> {
        let name = object_filename(key)?;
        if end < start || end - start >= limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "range exceeds limit",
            ));
        }
        let size = self.size(key).await?;
        if end >= size {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "range exceeds object",
            ));
        }
        if let Some(remote) = &self.remote {
            let response = remote
                .get_object_range(key, start, Some(end))
                .await
                .map_err(|_| remote_error())?;
            let bytes = response.as_slice();
            if !matches!(response.status_code(), 200 | 206) || bytes.len() as u64 != end - start + 1
            {
                return Err(remote_error());
            }
            return Ok(bytes.to_vec());
        }
        let local = self.local.clone();
        tokio::task::spawn_blocking(move || {
            use std::io::{Read, Seek, SeekFrom};
            let mut file = local.open(&name)?;
            file.seek(SeekFrom::Start(start))?;
            let mut bytes = vec![0u8; (end - start + 1) as usize];
            file.read_exact(&mut bytes)?;
            Ok(bytes)
        })
        .await
        .map_err(|_| remote_error())?
    }
    pub async fn read(&self, key: &str, limit: u64) -> io::Result<Vec<u8>> {
        let size = self.size(key).await?;
        if size > limit || size == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "object exceeds limit",
            ));
        }
        self.read_range(key, 0, size - 1, limit).await
    }
    pub async fn stage(&self, limit: u64) -> io::Result<StagedObject> {
        let name = format!(".stage-{}", Uuid::now_v7());
        let file = self.local.create(&name)?;
        Ok(StagedObject {
            local: self.local.clone(),
            name,
            file: Some(tokio::fs::File::from_std(file)),
            size: 0,
            limit,
        })
    }
    pub async fn publish(
        &self,
        mut staged: StagedObject,
        key: &str,
        content_type: &str,
    ) -> io::Result<()> {
        let name = object_filename(key)?;
        if !Arc::ptr_eq(&self.local, &staged.local) {
            return Err(io::Error::other("foreign staging object"));
        }
        let mut file = staged.file.take().ok_or_else(remote_error)?;
        file.flush().await?;
        if staged.size > staged.limit || file.metadata().await?.len() != staged.size {
            return Err(io::Error::other("invalid staged object"));
        }
        file.sync_all().await?;
        drop(file);
        if let Some(remote) = &self.remote {
            let mut file = tokio::fs::File::from_std(self.local.open(&staged.name)?);
            if file.metadata().await?.len() != staged.size {
                return Err(io::Error::other("staged size changed"));
            }
            let result = remote
                .put_object_stream_with_content_type(&mut file, key, content_type)
                .await
                .map_err(|_| remote_error())?;
            if !matches!(result.status_code(), 200 | 201) {
                return Err(remote_error());
            }
        } else {
            self.local.publish(&staged.name, &name)?;
        }
        Ok(())
    }
    pub async fn put(&self, key: &str, bytes: &[u8], content_type: &str) -> io::Result<()> {
        let mut staged = self.stage(bytes.len() as u64).await?;
        staged.write(bytes).await?;
        self.publish(staged, key, content_type).await
    }
    pub async fn copy(
        &self,
        from: &str,
        to: &str,
        expected: u64,
        content_type: &str,
    ) -> io::Result<()> {
        if self.size(from).await? != expected {
            return Err(io::Error::other("source size changed"));
        }
        if let Some(remote) = &self.remote {
            object_filename(to)?;
            if remote
                .copy_object_internal(from, to)
                .await
                .map_err(|_| remote_error())?
                != 200
                || self.size(to).await? != expected
            {
                return Err(remote_error());
            }
            return Ok(());
        }
        let mut staged = self.stage(expected).await?;
        let mut stream = self
            .stream_range(from, 0, expected.checked_sub(1).ok_or_else(remote_error)?)
            .await?;
        while let Some(bytes) = stream.next().await {
            staged.write(&bytes?).await?;
        }
        self.publish(staged, to, content_type).await
    }
    pub async fn delete(&self, key: &str) -> io::Result<()> {
        let name = object_filename(key)?;
        if let Some(remote) = &self.remote {
            let result = remote
                .delete_object(key)
                .await
                .map_err(|_| remote_error())?;
            return if matches!(result.status_code(), 200 | 204 | 404) {
                Ok(())
            } else {
                Err(remote_error())
            };
        }
        self.local.remove(&name)
    }
    /// Only abandoned staging files older than the maximum HTTP request lifetime
    /// are removed. Published object filenames are never collected by this path.
    pub async fn cleanup_staging(&self) -> io::Result<()> {
        let local = self.local.clone();
        tokio::task::spawn_blocking(move || local.cleanup_staging())
            .await
            .map_err(|_| remote_error())?
    }
}
pub struct StagedObject {
    local: Arc<Local>,
    name: String,
    file: Option<tokio::fs::File>,
    size: u64,
    limit: u64,
}
impl StagedObject {
    pub fn size(&self) -> u64 {
        self.size
    }
    pub async fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.size = self
            .size
            .checked_add(bytes.len() as u64)
            .ok_or_else(remote_error)?;
        if self.size > self.limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "upload exceeds reservation",
            ));
        }
        self.file
            .as_mut()
            .ok_or_else(remote_error)?
            .write_all(bytes)
            .await
    }
}
impl Drop for StagedObject {
    fn drop(&mut self) {
        let _ = self.local.remove(&self.name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store(path: &std::path::Path) -> Store {
        Store::new(&StorageConfig {
            backend: "local".into(),
            directory: path.into(),
            endpoint: None,
            region: "unused".into(),
            bucket: "unused".into(),
            access: None,
            secret: None,
        })
        .unwrap()
    }
    #[test]
    fn keys_cannot_be_paths() {
        for key in [
            "",
            "../secrets",
            "/etc/passwd",
            "a//b",
            "a/./b",
            "a/../b",
            "a\\b",
            "a\0b",
            "a?token=1",
        ] {
            assert!(object_filename(key).is_err(), "{key:?}");
        }
        let filename = object_filename("objects/0123/original").unwrap();
        assert_eq!(filename.len(), 64);
        assert!(filename.bytes().all(|b| b.is_ascii_hexdigit()));
    }
    #[tokio::test]
    async fn atomic_copy_keeps_original_immutable() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        store
            .put("pending/user/id", b"original", "text/plain")
            .await
            .unwrap();
        store
            .copy("pending/user/id", "objects/id/original", 8, "text/plain")
            .await
            .unwrap();
        store
            .put("pending/user/id", b"replaced", "text/plain")
            .await
            .unwrap();
        assert_eq!(
            store.read("objects/id/original", 8).await.unwrap(),
            b"original"
        );
        assert_eq!(
            store
                .read_range("objects/id/original", 2, 4, 3)
                .await
                .unwrap(),
            b"igi"
        );
        assert!(
            store
                .read_range("objects/id/original", 2, 5, 3)
                .await
                .is_err()
        );
        assert!(store.read("objects/id/original", 7).await.is_err());
        assert!(
            store
                .copy("pending/user/id", "objects/other/original", 9, "text/plain")
                .await
                .is_err()
        );
        store.delete("objects/id/original").await.unwrap();
        store.delete("objects/id/original").await.unwrap();
        assert!(store.size("objects/id/original").await.is_err());
    }
    #[tokio::test]
    async fn bounded_staging_is_private_and_removed_after_abort() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let mut staged = store.stage(4).await.unwrap();
        staged.write(b"1234").await.unwrap();
        assert!(staged.write(b"5").await.is_err());
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        drop(staged);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
    #[tokio::test]
    async fn rejects_symlinks_hardlinks_and_nonfiles() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outer = tempfile::tempdir().unwrap();
        let secret = outer.path().join("secret");
        std::fs::write(&secret, b"private").unwrap();
        let store = store(dir.path());
        let target = dir
            .path()
            .join(object_filename("objects/id/original").unwrap());
        symlink(&secret, &target).unwrap();
        assert!(store.read("objects/id/original", 100).await.is_err());
        store
            .put("objects/id/original", b"safe", "text/plain")
            .await
            .unwrap();
        assert_eq!(std::fs::read(&secret).unwrap(), b"private");
        assert_eq!(
            store.read("objects/id/original", 100).await.unwrap(),
            b"safe"
        );
        store.delete("objects/id/original").await.unwrap();
        std::fs::hard_link(&secret, &target).unwrap();
        assert!(store.size("objects/id/original").await.is_err());
        store.delete("objects/id/original").await.unwrap();
        std::fs::create_dir(&target).unwrap();
        assert!(store.read("objects/id/original", 100).await.is_err());
    }
    #[test]
    fn rejects_symlink_root() {
        let dir = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(dir.path(), dir.path().join("alias")).unwrap();
        assert!(Local::new(&dir.path().join("alias")).is_err());
    }
    #[tokio::test]
    async fn separate_instances_share_published_objects() {
        let dir = tempfile::tempdir().unwrap();
        let api = store(dir.path());
        let worker = store(dir.path());
        api.put("objects/id/original", b"original", "text/plain")
            .await
            .unwrap();
        assert_eq!(
            worker.read("objects/id/original", 100).await.unwrap(),
            b"original"
        );
        worker
            .put("derived/id/attempt/thumbnail", b"preview", "image/jpeg")
            .await
            .unwrap();
        assert_eq!(
            api.read("derived/id/attempt/thumbnail", 100).await.unwrap(),
            b"preview"
        );
        api.cleanup_staging().await.unwrap();
        api.cleanup_staging().await.unwrap();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }
}
