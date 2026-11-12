use crate::{Failure, Result};
use std::{env, path::PathBuf};
#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub storage: harmony_storage::StorageConfig,
    pub quota: i64,
    pub temp: PathBuf,
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub timeout: u64,
    pub lease: i64,
    pub input_limit: u64,
    pub output_limit: u64,
    pub pixels: u64,
    pub memory: u64,
}
fn required(name: &str) -> Result<String> {
    env::var(name).map_err(|_| Failure::permanent("configuration_missing"))
}
fn number(name: &str, default: u64, min: u64, max: u64) -> Result<u64> {
    let n = match env::var(name) {
        Ok(v) => v
            .parse()
            .map_err(|_| Failure::permanent("configuration_invalid"))?,
        Err(_) => default,
    };
    if !(min..=max).contains(&n) {
        return Err(Failure::permanent("configuration_invalid"));
    }
    Ok(n)
}
fn executable(name: &str, default: &str) -> Result<PathBuf> {
    let p = PathBuf::from(env::var(name).unwrap_or(default.into()));
    p.canonicalize()
        .map_err(|_| Failure::permanent("executable_missing"))
}
impl Config {
    pub fn from_env() -> Result<Self> {
        let timeout = number("WORKER_TIMEOUT_SECONDS", 30, 1, 120)?;
        let lease = number("WORKER_LEASE_SECONDS", 120, 30, 600)?;
        if lease < timeout + 30 {
            return Err(Failure::permanent("lease_too_short"));
        }
        Ok(Self {
            database_url: required("DATABASE_URL")?,
            storage: harmony_storage::StorageConfig::from_env()
                .map_err(|_| Failure::permanent("storage_configuration"))?,
            quota: number(
                "HARMONY_STORAGE_QUOTA_BYTES",
                1073741824,
                1,
                i64::MAX as u64,
            )? as i64,
            temp: PathBuf::from(env::var("WORKER_TEMP_DIR").unwrap_or("/tmp/harmony-media".into())),
            ffmpeg: executable("FFMPEG_PATH", "/usr/bin/ffmpeg")?,
            ffprobe: executable("FFPROBE_PATH", "/usr/bin/ffprobe")?,
            timeout,
            lease: lease as i64,
            input_limit: number(
                "WORKER_MAX_INPUT_BYTES",
                25 * 1024 * 1024,
                1,
                100 * 1024 * 1024,
            )?,
            output_limit: number(
                "WORKER_MAX_OUTPUT_BYTES",
                32 * 1024 * 1024,
                64 * 1024,
                128 * 1024 * 1024,
            )?,
            pixels: number("WORKER_MAX_PIXELS", 16777216, 1, 33554432)?,
            memory: number(
                "WORKER_MEMORY_BYTES",
                512 * 1024 * 1024,
                128 * 1024 * 1024,
                2 * 1024 * 1024 * 1024,
            )?,
        })
    }
}
