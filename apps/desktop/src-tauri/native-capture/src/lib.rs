//! Windows capture adapter. Pixels stay local; publication belongs to the call engine.
use std::time::Duration;
pub mod pipeline;

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
        Duration::from_nanos(1_000_000_000_u64.div_ceil(u64::from(self.fps)))
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
pub use win::{Capture, FramePacer, ProducerWake, Source};

/// Numeric-only diagnostics compiled out of ordinary capture builds. No image
/// storage, publication, environment switch or runtime IPC belongs here.
#[cfg(feature = "capture-diagnostics")]
#[cfg_attr(not(windows), allow(dead_code))] // Native adapter call sites exist only on Windows.
pub mod diagnostics {
    use std::{
        cell::{Cell, RefCell},
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };

    const BUCKET_NS: u64 = 100_000;
    const BUCKETS: usize = 257;
    pub const STAGES: usize = 13;
    #[derive(Clone, Copy, Debug)]
    #[repr(usize)]
    pub enum Stage {
        FrameSuccess,
        FrameNone,
        FrameError,
        WgcRead,
        PoolDrain,
        CopyResourceCpu,
        MapWall,
        BufferPrepare,
        RowCopy,
        Unmap,
        TimestampGetter,
        NotificationAge,
        SourceTimeDelta,
    }
    const NAMES: [&str; STAGES] = [
        "frame_success_wall",
        "frame_none_wall",
        "frame_error_wall",
        "wgc_read_all_wall",
        "pool_drain_wall",
        "copy_resource_cpu_call",
        "map_wall",
        "destination_prepare_wall",
        "row_copy_wall",
        "unmap_wall",
        "timestamp_getter_wall",
        "latest_notice_age_at_read",
        "nonnegative_source_time_delta",
    ];
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct QuantileRange {
        pub lower_ns: u64,
        pub upper_ns: Option<u64>,
    }
    #[derive(Clone, Copy, Debug)]
    pub struct MetricSummary {
        pub count: u64,
        pub total_ns: u128,
        pub min_ns: Option<u64>,
        pub max_ns: Option<u64>,
        pub p50: Option<QuantileRange>,
        pub p95: Option<QuantileRange>,
    }
    impl MetricSummary {
        pub fn mean_ms(&self) -> Option<f64> {
            (self.count != 0).then(|| self.total_ns as f64 / self.count as f64 / 1_000_000.)
        }
        pub fn json(&self) -> String {
            fn value(n: Option<u64>) -> String {
                n.map_or_else(|| "null".into(), |v| (v as f64 / 1_000_000.).to_string())
            }
            fn range(q: Option<QuantileRange>) -> String {
                q.map_or_else(
                    || "null".into(),
                    |q| {
                        format!(
                            "{{\"lower_ms\":{},\"upper_ms\":{}}}",
                            value(Some(q.lower_ns)),
                            value(q.upper_ns)
                        )
                    },
                )
            }
            format!("{{\"count\":{},\"mean_ms\":{},\"min_ms\":{},\"max_ms\":{},\"p50_range\":{},\"p95_range\":{}}}",self.count,self.mean_ms().map_or_else(||"null".into(),|v|v.to_string()),value(self.min_ns),value(self.max_ns),range(self.p50),range(self.p95))
        }
    }
    pub struct Histogram {
        counts: [u64; BUCKETS],
        count: u64,
        total_ns: u128,
        min_ns: Option<u64>,
        max_ns: Option<u64>,
    }
    impl Default for Histogram {
        fn default() -> Self {
            Self {
                counts: [0; BUCKETS],
                count: 0,
                total_ns: 0,
                min_ns: None,
                max_ns: None,
            }
        }
    }
    impl Histogram {
        pub fn record(&mut self, value: Duration) {
            let ns = u64::try_from(value.as_nanos()).unwrap_or(u64::MAX);
            let bucket = (ns / BUCKET_NS).min((BUCKETS - 1) as u64) as usize;
            self.counts[bucket] = self.counts[bucket].saturating_add(1);
            self.count = self.count.saturating_add(1);
            self.total_ns = self.total_ns.saturating_add(u128::from(ns));
            self.min_ns = Some(self.min_ns.map_or(ns, |v| v.min(ns)));
            self.max_ns = Some(self.max_ns.map_or(ns, |v| v.max(ns)));
        }
        fn percentile(&self, percentile: u64) -> Option<QuantileRange> {
            if self.count == 0 {
                return None;
            }
            let rank = (u128::from(self.count) * u128::from(percentile)).div_ceil(100);
            let mut count = 0_u128;
            for (i, n) in self.counts.iter().enumerate() {
                count += u128::from(*n);
                if count >= rank {
                    return Some(QuantileRange {
                        lower_ns: i as u64 * BUCKET_NS,
                        upper_ns: (i + 1 < BUCKETS).then_some((i as u64 + 1) * BUCKET_NS),
                    });
                }
            }
            None
        }
        pub fn summary(&self) -> MetricSummary {
            MetricSummary {
                count: self.count,
                total_ns: self.total_ns,
                min_ns: self.min_ns,
                max_ns: self.max_ns,
                p50: self.percentile(50),
                p95: self.percentile(95),
            }
        }
    }
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    #[repr(usize)]
    pub enum TimeKind {
        Missing,
        First,
        Advanced,
        Repeated,
        Backwards,
        Overflow,
    }
    #[derive(Clone, Copy, Debug)]
    pub struct FrameObservation {
        pub ordinal: u64,
        pub time_kind: TimeKind,
        pub delta_ns: Option<i64>,
    }
    #[derive(Default)]
    struct Measurements {
        metrics: [Histogram; STAGES],
        attempts: u64,
        none: [u64; 3],
        drain_calls: u64,
        drained_frames: u64,
        maximum_drained: u64,
        frames: u64,
        timestamp_counts: [u64; 6],
        previous_timestamp: Option<i64>,
        last_frame: Option<FrameObservation>,
        notice_baseline: u64,
        window_start_ns: u64,
    }
    pub struct Snapshot {
        pub enabled: bool,
        pub d3d_driver_type: u8,
        pub metrics: [MetricSummary; STAGES],
        pub attempts: u64,
        pub none: [u64; 3],
        pub drain_calls: u64,
        pub drained_frames: u64,
        pub maximum_drained: u64,
        pub frames: u64,
        pub timestamp_counts: [u64; 6],
        pub notices: u64,
    }
    impl Snapshot {
        pub fn json(&self) -> String {
            let metrics = self
                .metrics
                .iter()
                .zip(NAMES)
                .map(|(m, n)| format!("\"{n}\":{}", m.json()))
                .collect::<Vec<_>>()
                .join(",");
            format!("{{\"enabled\":{},\"d3d_driver_type\":{},\"attempts\":{},\"none\":{{\"no_notice\":{},\"nullable_pool\":{},\"resize\":{}}},\"drain_calls\":{},\"newer_frames_drained\":{},\"maximum_newer_frames_drained\":{},\"successful_wgc_frames\":{},\"source_time\":{{\"missing_or_error\":{},\"first\":{},\"advanced\":{},\"repeated\":{},\"backwards\":{},\"delta_overflow\":{}}},\"completed_notice_records\":{},\"histogram_bucket_ms\":0.1,\"histogram_overflow_from_ms\":25.6,\"metrics\":{{{metrics}}}}}",self.enabled,self.d3d_driver_type,self.attempts,self.none[0],self.none[1],self.none[2],self.drain_calls,self.drained_frames,self.maximum_drained,self.frames,self.timestamp_counts[0],self.timestamp_counts[1],self.timestamp_counts[2],self.timestamp_counts[3],self.timestamp_counts[4],self.timestamp_counts[5],self.notices)
        }
    }
    pub(crate) struct Arrivals {
        origin: Instant,
        enabled: AtomicBool,
        count: AtomicU64,
        last_ns_plus_one: AtomicU64,
    }
    impl Arrivals {
        pub(crate) fn notify(&self) {
            if self.enabled.load(Ordering::Relaxed) {
                self.last_ns_plus_one
                    .fetch_max(self.now_ns().saturating_add(1), Ordering::Release);
                self.count.fetch_add(1, Ordering::Release);
            }
        }
        fn now_ns(&self) -> u64 {
            u64::try_from(self.origin.elapsed().as_nanos()).unwrap_or(u64::MAX - 1)
        }
    }
    /// Called only by the capture thread; the callback owns just `Arrivals`.
    pub struct Recorder {
        enabled: Cell<bool>,
        driver_type: Cell<u8>,
        values: RefCell<Measurements>,
        arrivals: Arc<Arrivals>,
    }
    impl Default for Recorder {
        fn default() -> Self {
            Self::new()
        }
    }
    impl Recorder {
        pub fn new() -> Self {
            Self {
                enabled: Cell::new(false),
                driver_type: Cell::new(0),
                values: RefCell::new(Measurements::default()),
                arrivals: Arc::new(Arrivals {
                    origin: Instant::now(),
                    enabled: AtomicBool::new(false),
                    count: AtomicU64::new(0),
                    last_ns_plus_one: AtomicU64::new(0),
                }),
            }
        }
        pub(crate) fn set_driver_type(&self, driver_type: u8) {
            self.driver_type.set(driver_type);
        }
        pub fn set_enabled(&self, enabled: bool) {
            self.enabled.set(enabled);
            self.arrivals.enabled.store(enabled, Ordering::Release);
        }
        pub fn enabled(&self) -> bool {
            self.enabled.get()
        }
        pub fn reset_window(&self) {
            *self.values.borrow_mut() = Measurements {
                notice_baseline: self.arrivals.count.load(Ordering::Acquire),
                window_start_ns: self.arrivals.now_ns(),
                ..Measurements::default()
            };
        }
        pub(crate) fn arrivals(&self) -> Arc<Arrivals> {
            self.arrivals.clone()
        }
        pub fn record(&self, stage: Stage, duration: Duration) {
            if self.enabled() {
                self.values.borrow_mut().metrics[stage as usize].record(duration);
            }
        }
        pub(crate) fn span(&self, stage: Stage) -> Span<'_> {
            Span {
                recorder: self,
                stage,
                start: self.enabled().then(Instant::now),
            }
        }
        pub(crate) fn frame_span(&self) -> Span<'_> {
            self.span(Stage::FrameError)
        }
        pub(crate) fn begin_attempt(&self) {
            if self.enabled() {
                let mut v = self.values.borrow_mut();
                v.attempts += 1;
                v.last_frame = None;
            }
        }
        pub(crate) fn none(&self, reason: usize) {
            if self.enabled() {
                self.values.borrow_mut().none[reason] += 1;
            }
        }
        pub(crate) fn drain(&self, newer: u64) {
            if self.enabled() {
                let mut v = self.values.borrow_mut();
                v.drain_calls += 1;
                v.drained_frames += newer;
                v.maximum_drained = v.maximum_drained.max(newer);
            }
        }
        pub(crate) fn notice_age(&self) {
            if !self.enabled() {
                return;
            }
            let stamp = self.arrivals.last_ns_plus_one.load(Ordering::Acquire);
            let now = self.arrivals.now_ns();
            let (start, baseline) = {
                let values = self.values.borrow();
                (values.window_start_ns, values.notice_baseline)
            };
            if self.arrivals.count.load(Ordering::Acquire) <= baseline {
                return;
            }
            if let Some(at) = stamp.checked_sub(1).filter(|at| *at >= start && *at <= now) {
                self.record(Stage::NotificationAge, Duration::from_nanos(now - at));
            }
        }
        pub fn observe_frame(&self, timestamp: Option<i64>) {
            if !self.enabled() {
                return;
            }
            let mut v = self.values.borrow_mut();
            let (kind, delta) = match (v.previous_timestamp, timestamp) {
                (_, None) => (TimeKind::Missing, None),
                (None, Some(_)) => (TimeKind::First, None),
                (Some(a), Some(b)) => match i64::try_from((i128::from(b) - i128::from(a)) * 100) {
                    Ok(n) => (
                        if n == 0 {
                            TimeKind::Repeated
                        } else if n > 0 {
                            TimeKind::Advanced
                        } else {
                            TimeKind::Backwards
                        },
                        Some(n),
                    ),
                    Err(_) => (TimeKind::Overflow, None),
                },
            };
            v.previous_timestamp = if kind == TimeKind::Overflow {
                None
            } else {
                timestamp
            };
            v.frames += 1;
            v.timestamp_counts[kind as usize] += 1;
            if let Some(n) = delta.filter(|n| *n >= 0) {
                v.metrics[Stage::SourceTimeDelta as usize].record(Duration::from_nanos(n as u64));
            }
            v.last_frame = Some(FrameObservation {
                ordinal: v.frames,
                time_kind: kind,
                delta_ns: delta,
            });
        }
        pub fn last_frame(&self) -> Option<FrameObservation> {
            self.enabled()
                .then(|| self.values.borrow().last_frame)
                .flatten()
        }
        pub fn snapshot(&self) -> Snapshot {
            let v = self.values.borrow();
            Snapshot {
                enabled: self.enabled(),
                d3d_driver_type: self.driver_type.get(),
                metrics: std::array::from_fn(|i| v.metrics[i].summary()),
                attempts: v.attempts,
                none: v.none,
                drain_calls: v.drain_calls,
                drained_frames: v.drained_frames,
                maximum_drained: v.maximum_drained,
                frames: v.frames,
                timestamp_counts: v.timestamp_counts,
                notices: self
                    .arrivals
                    .count
                    .load(Ordering::Acquire)
                    .saturating_sub(v.notice_baseline),
            }
        }
    }
    pub(crate) struct Span<'a> {
        recorder: &'a Recorder,
        stage: Stage,
        start: Option<Instant>,
    }
    impl Span<'_> {
        pub(crate) fn outcome(&mut self, stage: Stage) {
            self.stage = stage;
        }
    }
    impl Drop for Span<'_> {
        fn drop(&mut self) {
            if let Some(start) = self.start {
                self.recorder.record(self.stage, start.elapsed());
            }
        }
    }
}

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

#[cfg(all(test, feature = "capture-diagnostics"))]
mod diagnostic_tests {
    use super::diagnostics::{Histogram, Recorder, Stage, TimeKind};
    use std::time::Duration;

    #[test]
    fn absent_and_tail_measurements_are_distinct_and_storage_is_bounded() {
        let mut h = Histogram::default();
        assert_eq!(h.summary().count, 0);
        assert_eq!(h.summary().mean_ms(), None);
        assert_eq!(h.summary().p95, None);
        h.record(Duration::ZERO);
        h.record(Duration::from_micros(150));
        h.record(Duration::from_secs(1));
        let s = h.summary();
        assert_eq!(s.count, 3);
        assert_eq!(s.min_ns, Some(0));
        assert_eq!(s.max_ns, Some(1_000_000_000));
        assert_eq!(s.p95.unwrap().upper_ns, None);
        assert!(std::mem::size_of::<Histogram>() < 4096);
        assert!(s.mean_ms().unwrap() > 333.);
    }

    #[test]
    fn disabled_collection_and_window_reset_never_invent_measurements() {
        let d = Recorder::new();
        d.record(Stage::MapWall, Duration::from_millis(2));
        d.observe_frame(Some(100));
        assert_eq!(d.snapshot().frames, 0);
        assert_eq!(d.snapshot().metrics[Stage::MapWall as usize].count, 0);
        assert!(d.last_frame().is_none());
        d.set_enabled(true);
        d.reset_window();
        d.record(Stage::MapWall, Duration::from_millis(2));
        d.observe_frame(Some(100));
        assert_eq!(d.snapshot().frames, 1);
        assert_eq!(d.last_frame().unwrap().time_kind, TimeKind::First);
        d.reset_window();
        assert_eq!(d.snapshot().frames, 0);
        assert_eq!(d.snapshot().metrics[Stage::MapWall as usize].count, 0);
        d.observe_frame(Some(100));
        assert_eq!(d.last_frame().unwrap().time_kind, TimeKind::First);
        d.set_enabled(false);
        d.observe_frame(Some(200));
        assert_eq!(d.snapshot().frames, 1);
    }

    #[test]
    fn source_timestamps_classify_repeats_backwards_and_missing_without_values() {
        let d = Recorder::new();
        d.set_enabled(true);
        d.reset_window();
        for t in [
            None,
            Some(100),
            Some(100),
            Some(120),
            Some(110),
            None,
            Some(130),
        ] {
            d.observe_frame(t);
        }
        let s = d.snapshot();
        assert_eq!(s.frames, 7);
        assert_eq!(s.timestamp_counts, [2, 2, 1, 1, 1, 0]);
        assert_eq!(d.last_frame().unwrap().time_kind, TimeKind::First);
        assert_eq!(d.last_frame().unwrap().delta_ns, None);
        d.observe_frame(Some(140));
        assert_eq!(d.last_frame().unwrap().delta_ns, Some(1000));
        assert!(!d.snapshot().json().contains("absolute"));
        assert!(!d.snapshot().json().contains("last_timestamp"));
    }

    #[test]
    fn huge_time_discontinuity_is_numeric_overflow_not_a_capture_error() {
        let d = Recorder::new();
        d.set_enabled(true);
        d.reset_window();
        d.observe_frame(Some(i64::MIN));
        d.observe_frame(Some(i64::MAX));
        assert_eq!(d.last_frame().unwrap().time_kind, TimeKind::Overflow);
        assert_eq!(d.last_frame().unwrap().delta_ns, None);
        assert_eq!(
            d.snapshot().timestamp_counts[TimeKind::Overflow as usize],
            1
        );
    }

    #[test]
    fn notification_and_none_reasons_are_not_inferred_to_be_frame_counts() {
        let d = Recorder::new();
        let arrivals = d.arrivals();
        arrivals.notify();
        assert_eq!(d.snapshot().notices, 0);
        d.set_enabled(true);
        d.reset_window();
        arrivals.notify();
        d.notice_age();
        for reason in [0, 1, 2] {
            d.begin_attempt();
            d.none(reason);
        }
        d.drain(2);
        d.drain(0);
        let s = d.snapshot();
        assert_eq!(s.notices, 1);
        assert_eq!(s.metrics[Stage::NotificationAge as usize].count, 1);
        assert_eq!(s.attempts, 3);
        assert_eq!(s.none, [1, 1, 1]);
        assert_eq!(s.frames, 0);
        assert_eq!(s.drained_frames, 2);
        assert_eq!(s.maximum_drained, 2);
        d.reset_window();
        d.notice_age();
        assert_eq!(d.snapshot().notices, 0);
        assert_eq!(
            d.snapshot().metrics[Stage::NotificationAge as usize].count,
            0
        );
    }

    #[test]
    fn failed_and_empty_spans_keep_their_own_measurement_population() {
        let d = Recorder::new();
        d.set_enabled(true);
        d.reset_window();
        {
            let _error = d.frame_span();
        }
        {
            let mut empty = d.frame_span();
            empty.outcome(Stage::FrameNone);
        }
        {
            let mut success = d.frame_span();
            success.outcome(Stage::FrameSuccess);
        }
        let s = d.snapshot();
        assert_eq!(s.metrics[Stage::FrameError as usize].count, 1);
        assert_eq!(s.metrics[Stage::FrameNone as usize].count, 1);
        assert_eq!(s.metrics[Stage::FrameSuccess as usize].count, 1);
        assert_eq!(s.frames, 0);
    }
}
