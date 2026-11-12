use crate::{Config, Failure, Result, sandbox};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt};

pub(crate) struct Product {
    pub kind: &'static str,
    pub content_type: &'static str,
    pub path: PathBuf,
    pub width: Option<i32>,
    pub height: Option<i32>,
}
pub(crate) struct Parsed {
    pub metadata: Value,
    pub products: Vec<Product>,
}
struct ProcessGroup(u32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // Also handles cancellation/lease loss.
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}
async fn capped(mut reader: impl AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            return Ok(out);
        }
        if out.len() + n > 65536 {
            return Err(Failure::permanent("parser_output_limit"));
        }
        out.extend_from_slice(&buf[..n]);
    }
}
#[cfg(target_os = "macos")]
fn rss(pid: u32) -> u64 {
    #[repr(C)]
    struct TaskInfo {
        u: [u64; 6],
        i: [i32; 12],
    }
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: libc::c_int,
            flavor: libc::c_int,
            arg: u64,
            buffer: *mut libc::c_void,
            size: libc::c_int,
        ) -> libc::c_int;
    }
    let mut info = TaskInfo {
        u: [0; 6],
        i: [0; 12],
    };
    let size = std::mem::size_of::<TaskInfo>() as i32;
    let result =
        unsafe { proc_pidinfo(pid as i32, 4, 0, (&mut info as *mut TaskInfo).cast(), size) };
    if result == size { info.u[1] } else { 0 }
}
async fn memory_monitor(pid: u32, memory: u64) -> Result<()> {
    #[cfg(target_os = "macos")]
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if rss(pid) > memory {
            return Err(Failure::permanent("parser_memory_limit"));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Linux enforces RLIMIT_AS in the child. Keep the select branch typed
        // without creating a polling timer or relying on never-type inference.
        let _ = (pid, memory);
        std::future::pending::<Result<()>>().await
    }
}
async fn run(config: &Config, executable: &Path, dir: &Path, args: &[String]) -> Result<Vec<u8>> {
    let mut cmd = sandbox::command(config, executable, dir)?;
    cmd.args(args);
    let mut child = cmd
        .spawn()
        .map_err(|_| Failure::permanent("sandbox_unavailable"))?;
    let pid = child
        .id()
        .ok_or_else(|| Failure::permanent("parser_start"))?;
    let guard = ProcessGroup(pid);
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Failure::permanent("parser_start"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| Failure::permanent("parser_start"))?;
    let memory = config.memory;
    let work = async {
        let monitor = memory_monitor(pid, memory);
        tokio::select! {
         results=async {tokio::try_join!(async{child.wait().await.map_err(Failure::from)},capped(stdout),capped(stderr))}=>{
          let (status,output,_)=results?;
          if !status.success(){return Err(Failure::permanent("invalid_media"))}Ok(output)
         },
         result=monitor=>{result?;Err(Failure::permanent("parser_memory_limit"))}
        }
    };
    let result = tokio::time::timeout(Duration::from_secs(config.timeout), work)
        .await
        .unwrap_or_else(|_| Err(Failure::transient("parser_timeout")));
    // Kill the process group even on normal exit so no escaped child keeps handles.
    drop(guard);
    let _ = child.wait().await;
    result
}
pub async fn check_sandbox(config: &Config) -> Result<()> {
    std::fs::create_dir_all(&config.temp)?;
    let temp = tempfile::Builder::new()
        .prefix("check-")
        .tempdir_in(&config.temp)?;
    let dir = temp.path().canonicalize()?;
    for exe in [&config.ffmpeg, &config.ffprobe] {
        run(config, exe, &dir, &["-version".into()]).await?;
    }
    Ok(())
}
fn input_args(config: &Config) -> Vec<String> {
    [
        "-v",
        "error",
        "-max_alloc",
        "67108864",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "png_pipe,jpeg_pipe,gif,webp_pipe,webp_anim,mov,matroska,webm,mp3,wav,ogg",
        "-probesize",
        "2097152",
        "-analyzeduration",
        "5000000",
        "-threads",
        "1",
        "-max_pixels",
        &config.pixels.to_string(),
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}
fn metadata(value: &Value, mime: &str, pixel_limit: u64) -> Result<Value> {
    let streams = value
        .get("streams")
        .and_then(Value::as_array)
        .ok_or_else(|| Failure::permanent("invalid_media"))?;
    if streams.len() > 16 {
        return Err(Failure::permanent("stream_limit"));
    }
    let video = streams.iter().find(|v| v["codec_type"] == "video");
    let audio = streams.iter().any(|v| v["codec_type"] == "audio");
    let kind = if mime.starts_with("image/") {
        if video.is_none() {
            return Err(Failure::permanent("invalid_media"));
        }
        "image"
    } else if mime.starts_with("video/") {
        if video.is_none() {
            return Err(Failure::permanent("invalid_media"));
        }
        "video"
    } else if audio {
        "audio"
    } else {
        return Err(Failure::permanent("invalid_media"));
    };
    for v in streams.iter().filter(|v| v["codec_type"] == "video") {
        let w = v["width"].as_u64().unwrap_or(0);
        let h = v["height"].as_u64().unwrap_or(0);
        if w == 0 || h == 0 || w.saturating_mul(h) > pixel_limit {
            return Err(Failure::permanent("pixel_limit"));
        }
    }
    let format = value["format"]["format_name"].as_str().unwrap_or("");
    let format = if format.contains("mov") || format.contains("mp4") {
        "mp4"
    } else if format.contains("matroska") || format.contains("webm") {
        "webm"
    } else if format == "png_pipe" {
        "png"
    } else if format == "jpeg_pipe" {
        "jpeg"
    } else if format == "gif" {
        "gif"
    } else if format.starts_with("webp") {
        "webp"
    } else if ["mp3", "wav", "ogg"].contains(&format) {
        format
    } else {
        return Err(Failure::permanent("unsupported_format"));
    };
    let mut out = json!({"kind":kind,"format":format,"has_audio":audio});
    if kind != "audio" {
        let v = video.expect("checked video");
        out["width"] = v["width"].clone();
        out["height"] = v["height"].clone();
    }
    if kind != "image"
        && let Some(d) = value["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|d| d.is_finite() && *d >= 0.0 && *d <= 86400.0)
    {
        out["duration_seconds"] = json!(d);
    }
    Ok(out)
}
pub(crate) async fn parse(config: &Config, dir: &Path, mime: &str) -> Result<Parsed> {
    let mut args = input_args(config);
    args.extend(
        [
            "-show_entries",
            "stream=codec_type,codec_name,width,height:format=format_name,duration",
            "-of",
            "json",
            "input",
        ]
        .map(str::to_owned),
    );
    let bytes = run(config, &config.ffprobe, dir, &args).await?;
    let probe: Value =
        serde_json::from_slice(&bytes).map_err(|_| Failure::permanent("invalid_media"))?;
    let metadata = metadata(&probe, mime, config.pixels)?;
    let audio = metadata["kind"] == "audio";
    let mut args = input_args(config);
    args.extend(
        [
            "-nostdin",
            "-y",
            "-filter_threads",
            "1",
            "-filter_complex_threads",
            "1",
            "-i",
            "input",
        ]
        .map(str::to_owned),
    );
    if audio {
        args.extend(["-filter_complex","[0:a:0]atrim=duration=30,asetpts=PTS-STARTPTS,showwavespic=s=640x160:colors=0x8b93ff[v]","-map","[v]"].map(str::to_owned));
    } else {
        args.extend(
            [
                "-map",
                "0:v:0",
                "-vf",
                "scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease",
            ]
            .map(str::to_owned),
        );
    }
    args.extend(
        [
            "-frames:v",
            "1",
            "-an",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-c:v",
            "mjpeg",
            "-q:v",
            "4",
            "-threads",
            "1",
            "-f",
            "image2",
            "thumbnail.jpg",
        ]
        .map(str::to_owned),
    );
    run(config, &config.ffmpeg, dir, &args).await?;
    let (w, h) = if audio {
        (640, 160)
    } else {
        let w = metadata["width"].as_f64().unwrap_or(1.0);
        let h = metadata["height"].as_f64().unwrap_or(1.0);
        let scale = (640.0 / w.max(h)).min(1.0);
        ((w * scale).round() as i32, (h * scale).round() as i32)
    };
    let mut products = vec![Product {
        kind: "thumbnail",
        content_type: "image/jpeg",
        path: dir.join("thumbnail.jpg"),
        width: Some(w),
        height: Some(h),
    }];
    let compatible = probe["streams"].as_array().is_some_and(|s| {
        s.iter()
            .filter(|s| matches!(s["codec_type"].as_str(), Some("video" | "audio")))
            .all(|s| {
                matches!(
                    s["codec_name"].as_str(),
                    Some("h264" | "hevc" | "av1" | "mpeg4" | "aac" | "mp3" | "alac")
                )
            })
    });
    if mime == "video/mp4" && metadata["format"] == "mp4" && compatible {
        let mut args = input_args(config);
        args.extend(
            [
                "-nostdin",
                "-y",
                "-i",
                "input",
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-c",
                "copy",
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                "faststart.mp4",
            ]
            .map(str::to_owned),
        );
        run(config, &config.ffmpeg, dir, &args).await?;
        products.push(Product {
            kind: "faststart",
            content_type: "video/mp4",
            path: dir.join("faststart.mp4"),
            width: metadata["width"].as_i64().map(|v| v as i32),
            height: metadata["height"].as_i64().map(|v| v as i32),
        });
    }
    Ok(Parsed { metadata, products })
}
// Read dimensions of our bounded JPEG output, rather than guessing rounding or
// ignoring rotation applied by FFmpeg. This never inspects arbitrary input JPEGs.
pub(crate) fn jpeg_dimensions(bytes: &[u8]) -> Result<(i32, i32)> {
    let invalid = || Failure::permanent("output_invalid");
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return Err(invalid());
    }
    let mut i = 2;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xff {
            return Err(invalid());
        }
        let marker = bytes[i + 1];
        i += 2;
        if marker == 0xff {
            i -= 1;
            continue;
        }
        let size = u16::from_be_bytes([bytes[i], bytes[i + 1]]) as usize;
        if size < 2 || i + size > bytes.len() {
            return Err(invalid());
        }
        if matches!(marker, 0xc0..=0xc3) {
            if size < 8 {
                return Err(invalid());
            }
            let h = u16::from_be_bytes([bytes[i + 3], bytes[i + 4]]) as i32;
            let w = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as i32;
            if !(1..=640).contains(&w) || !(1..=640).contains(&h) {
                return Err(invalid());
            }
            return Ok((w, h));
        }
        if marker == 0xda || marker == 0xd9 {
            break;
        }
        i += size;
    }
    Err(invalid())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_filters_tags_and_bounds_pixels() {
        let p = json!({"streams":[{"codec_type":"video","width":200,"height":100,"tags":{"GPS":"secret"}}],"format":{"format_name":"png_pipe","tags":{"author":"private"}}});
        let m = metadata(&p, "image/png", 20000).unwrap();
        assert_eq!(
            m,
            json!({"kind":"image","format":"png","width":200,"height":100,"has_audio":false})
        );
        assert_eq!(
            metadata(&p, "image/png", 19999).unwrap_err().code,
            "pixel_limit"
        );
    }
    #[tokio::test]
    async fn output_cap_rejects_oversized_json() {
        let data = vec![b' '; 65537];
        assert_eq!(
            capped(data.as_slice()).await.unwrap_err().code,
            "parser_output_limit"
        );
    }
}
