//! Windows capture adapter. Pixels stay local; publication belongs to the call engine.
use std::time::Duration;

pub const MAX_BYTES: usize = 64 * 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Profile {
    pub height: u32,
    pub fps: u32,
}
impl Profile {
    pub fn validate(self) -> Result<Self, String> {
        if ![0, 144, 240, 360, 480, 720, 1080, 1440, 2160].contains(&self.height)
            || ![15, 24, 30, 60].contains(&self.fps)
        {
            return Err("Perfil de captura inválido.".into());
        }
        Ok(self)
    }
    pub fn period(self) -> Duration {
        Duration::from_secs_f64(1.0 / f64::from(self.fps))
    }
    pub fn size(self, width: u32, height: u32) -> Result<(u32, u32), String> {
        self.validate()?;
        byte_len(width, height)?;
        if self.height == 0 || height <= self.height {
            return Ok((width, height));
        }
        let h = self.height;
        let w = (u64::from(width) * u64::from(h) / u64::from(height)) as u32;
        byte_len(w, h)?;
        Ok((w, h))
    }
}
pub fn byte_len(width: u32, height: u32) -> Result<usize, String> {
    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err("Dimensões de captura não suportadas.".into());
    }
    let n = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
        .filter(|n| *n <= MAX_BYTES)
        .ok_or("A captura ultrapassa o limite de memória.")?;
    Ok(n)
}
#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::{Capture, Source};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_are_checked_before_allocation() {
        for (w, h) in [(0, 1080), (1920, 0), (9000, 100), (8192, 8192)] {
            assert!(byte_len(w, h).is_err());
        }
        assert_eq!(byte_len(2560, 1440).unwrap(), 14_745_600);
    }
    #[test]
    fn capture_never_upscales_and_preserves_source_aspect() {
        let p = Profile {
            height: 1440,
            fps: 60,
        };
        assert_eq!(p.size(1920, 1080).unwrap(), (1920, 1080));
        assert_eq!(p.size(3840, 2160).unwrap(), (2560, 1440));
        assert_eq!(p.size(3000, 2000).unwrap(), (2160, 1440));
    }
    #[test]
    fn invalid_profiles_cannot_start_a_producer() {
        assert!(Profile {
            height: 1080,
            fps: 0
        }
        .validate()
        .is_err());
        assert!(Profile {
            height: 1000,
            fps: 60
        }
        .validate()
        .is_err());
        assert_eq!(
            Profile {
                height: 1080,
                fps: 60
            }
            .period()
            .as_micros(),
            16666
        );
    }
}
