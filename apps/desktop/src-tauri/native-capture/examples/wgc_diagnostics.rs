//! One real capture in control/instrument/control order. No bridge, encoder or
//! receiver is included, and no phase can approve eight-participant capacity.
#[cfg(any(windows, test))]
mod measurements {
    use harmony_native_capture::diagnostics::{FrameObservation, Histogram, TimeKind};
    use std::time::Duration;

    #[derive(Default)]
    pub struct Waits {
        requested: Histogram,
        actual: Histogram,
        overshoot: Histogram,
        undershoots: u64,
    }
    impl Waits {
        pub fn record(&mut self, requested: Duration, actual: Duration) {
            self.requested.record(requested);
            self.actual.record(actual);
            self.overshoot.record(actual.saturating_sub(requested));
            self.undershoots += u64::from(actual < requested);
        }
        pub fn json(&self) -> String {
            format!(
                "{{\"requested_ms\":{},\"actual_ms\":{},\"overshoot_ms\":{},\"undershoots\":{}}}",
                self.requested.summary().json(),
                self.actual.summary().json(),
                self.overshoot.summary().json(),
                self.undershoots
            )
        }
    }
    #[derive(Default)]
    pub struct MarkerIdentity {
        previous: Option<([u8; 3], u64)>,
        pub matched: [u64; 4],
        pub unpaired: u64,
    }
    impl MarkerIdentity {
        pub fn observe(&mut self, marker: [u8; 3], observation: Option<FrameObservation>) {
            let Some(o) = observation else {
                self.previous = None;
                self.unpaired += 1;
                return;
            };
            if let Some((previous, _)) = self
                .previous
                .filter(|(_, n)| n.checked_add(1) == Some(o.ordinal))
            {
                let same = marker == previous;
                match o.time_kind {
                    TimeKind::Advanced => self.matched[usize::from(!same)] += 1,
                    TimeKind::Repeated => self.matched[2 + usize::from(!same)] += 1,
                    _ => self.unpaired += 1,
                }
            } else {
                self.unpaired += 1;
            }
            self.previous = Some((marker, o.ordinal));
        }
        pub fn json(&self) -> String {
            format!("{{\"advanced_time_same_marker\":{},\"advanced_time_changed_marker\":{},\"repeated_time_same_marker\":{},\"repeated_time_changed_marker\":{},\"unpaired_missing_first_or_discontinuous\":{}}}",self.matched[0],self.matched[1],self.matched[2],self.matched[3],self.unpaired)
        }
    }
    pub fn next_deadline(previous: Duration, finished: Duration, period: Duration) -> Duration {
        (previous + period).max(finished)
    }
    pub fn quality(raw: f64, distinct: f64, geometry: bool, colored: Option<usize>) -> bool {
        raw.is_finite()
            && distinct.is_finite()
            && raw >= 54.
            && distinct >= 54.
            && geometry
            && colored.is_some_and(|n| n > 13_680)
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        fn o(ordinal: u64, time_kind: TimeKind) -> Option<FrameObservation> {
            Some(FrameObservation {
                ordinal,
                time_kind,
                delta_ns: None,
            })
        }
        #[test]
        fn timestamp_and_marker_are_joint_observations_not_duplicate_frame_inference() {
            let mut m = MarkerIdentity::default();
            m.observe([1, 2, 3], o(1, TimeKind::First));
            m.observe([1, 2, 3], o(2, TimeKind::Advanced));
            m.observe([1, 2, 4], o(3, TimeKind::Advanced));
            m.observe([1, 2, 4], o(4, TimeKind::Repeated));
            m.observe([1, 2, 5], o(5, TimeKind::Repeated));
            assert_eq!(m.matched, [1, 1, 1, 1]);
            m.observe([1, 2, 5], None);
            m.observe([1, 2, 5], o(9, TimeKind::Advanced));
            m.observe([1, 2, 5], o(10, TimeKind::Backwards));
            assert_eq!(m.matched, [1, 1, 1, 1]);
            assert_eq!(m.unpaired, 4);
            assert!(m.json().contains("\"advanced_time_same_marker\":1"));
            assert!(m
                .json()
                .contains("\"unpaired_missing_first_or_discontinuous\":4"));
        }
        #[test]
        fn nominal_schedule_reanchors_without_replaying_missed_slots() {
            let t = Duration::from_nanos(16_666_667);
            assert_eq!(next_deadline(t, t + Duration::from_millis(2), t), t * 2);
            assert_eq!(
                next_deadline(t, Duration::from_secs(1), t),
                Duration::from_secs(1)
            );
            assert!(!quality(60., 53.999, true, Some(14_400)));
            assert!(!quality(60., 60., false, Some(14_400)));
            assert!(!quality(60., 60., true, None));
            assert!(!quality(f64::NAN, 60., true, Some(14_400)));
            assert!(quality(54., 54., true, Some(13_681)));
            let mut waits = Waits::default();
            assert!(waits.json().contains("\"mean_ms\":null"));
            waits.record(Duration::from_millis(1), Duration::from_millis(2));
            waits.record(Duration::from_millis(1), Duration::ZERO);
            assert_eq!(waits.undershoots, 1);
            assert_eq!(waits.overshoot.summary().max_ns, Some(1_000_000));
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("HARMONY_WGC_DIAGNOSTIC_ERROR {{\"capacity_approval\":false,\"stage\":\"windows_required\"}}");
    std::process::exit(1);
}
#[cfg(windows)]
fn main() {
    match windows_probe::run() {
        Ok(true) => {}
        Ok(false) => std::process::exit(1),
        Err(stage) => {
            eprintln!("HARMONY_WGC_DIAGNOSTIC_ERROR {{\"capacity_approval\":false,\"stage\":\"{stage}\"}}");
            std::process::exit(1);
        }
    }
}
#[cfg(windows)]
mod windows_probe {
    use super::measurements::{next_deadline, quality, MarkerIdentity, Waits};
    use harmony_native_capture::{diagnostics::Histogram, Capture, FramePacer, Profile, Source};
    use std::{
        collections::BTreeSet,
        env, thread,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow},
    };
    #[derive(Clone, Copy)]
    struct OwnedWindow {
        handle: usize,
        pid: u32,
    }
    fn owned(w: OwnedWindow) -> bool {
        let mut pid = 0;
        unsafe {
            IsWindow(w.handle as HWND) != 0
                && GetWindowThreadProcessId(w.handle as HWND, &mut pid) != 0
                && pid == w.pid
        }
    }
    fn sleep(pacer: &FramePacer, requested: Duration, measured: bool, waits: &mut Waits) {
        let started = Instant::now();
        pacer.sleep(requested);
        if measured {
            waits.record(requested, started.elapsed());
        }
    }
    fn phase(
        index: usize,
        instrument: bool,
        capture: &mut Capture,
        pixels: &mut Vec<u8>,
        pacer: &FramePacer,
        profile: Profile,
        window: OwnedWindow,
    ) -> Result<bool, &'static str> {
        println!("HARMONY_WGC_DIAGNOSTIC_BEGIN {{\"kind\":\"DIAGNOSTIC\",\"capacity_approval\":false,\"phase\":{index},\"instrumentation_enabled\":{instrument}}}");
        capture.set_diagnostics_enabled(instrument);
        let origin = Instant::now();
        let mut measurement_start = None;
        let mut deadline = Duration::ZERO;
        let (mut frames, mut distinct, mut empty, mut short) = (0u64, 0u64, 0u64, 0u64);
        let (mut previous_marker, mut previous_start) = (None, None);
        let mut sizes = BTreeSet::new();
        let mut source_sizes = BTreeSet::new();
        let (mut intervals, mut cadence_waits, mut empty_waits) =
            (Histogram::default(), Waits::default(), Waits::default());
        let mut identity = MarkerIdentity::default();
        loop {
            if capture.is_closed() || !owned(window) {
                return Err("source_closed_or_changed");
            }
            let started = origin.elapsed();
            if measurement_start.is_none() && started >= Duration::from_secs(5) {
                capture.reset_diagnostics();
                measurement_start = Some(started);
            }
            if measurement_start.is_some_and(|start| started >= start + Duration::from_secs(10)) {
                break;
            }
            let measured = measurement_start.is_some();
            let result = capture.frame(pixels).map_err(|_| "capture_frame")?;
            let finished = origin.elapsed();
            let Some((width, height)) = result else {
                if measured {
                    empty += 1;
                }
                sleep(pacer, Duration::from_millis(1), measured, &mut empty_waits);
                continue;
            };
            if measured {
                frames += 1;
                sizes.insert((width, height));
                source_sizes.insert(capture.source_dimensions());
                let marker = [pixels[0], pixels[1], pixels[2]];
                if Some(marker) != previous_marker {
                    distinct += 1;
                }
                previous_marker = Some(marker);
                if instrument {
                    identity.observe(marker, capture.diagnostic_frame_observation());
                }
                if let Some(previous) = previous_start {
                    let d = started - previous;
                    intervals.record(d);
                    short += u64::from(d < profile.period());
                }
                previous_start = Some(started);
            }
            deadline = next_deadline(deadline, finished, profile.period());
            let now = origin.elapsed();
            if deadline > now {
                sleep(
                    pacer,
                    (deadline - now).max(Duration::from_micros(500)),
                    measured,
                    &mut cadence_waits,
                );
            }
        }
        let elapsed = origin
            .elapsed()
            .saturating_sub(measurement_start.ok_or("measurement_not_started")?)
            .as_secs_f64();
        let expected = (profile.height * 16 / 9, profile.height);
        let geometry = sizes.len() == 1
            && sizes.contains(&expected)
            && source_sizes.len() == 1
            && source_sizes.contains(&expected);
        let colored = if frames > 0 && geometry {
            let (w, h) = expected;
            let mut count = 0;
            for y in 0..90 {
                for x in 0..160 {
                    let i = (((y * h / 90) * w + x * w / 160) * 4) as usize;
                    let (b, g, r) = (
                        i32::from(pixels[i]),
                        i32::from(pixels[i + 1]),
                        i32::from(pixels[i + 2]),
                    );
                    if (b - g).abs() + (g - r).abs() > 20 {
                        count += 1;
                    }
                }
            }
            Some(count)
        } else {
            None
        };
        let raw = frames as f64 / elapsed;
        let changed = distinct as f64 / elapsed;
        let passed = quality(raw, changed, geometry, colored);
        let snapshot = capture.diagnostics_snapshot();
        if instrument && snapshot.frames != frames {
            return Err("diagnostic_frame_coverage");
        }
        capture.set_diagnostics_enabled(false);
        let dimensions = sizes
            .iter()
            .map(|(w, h)| format!("[{w},{h}]"))
            .collect::<Vec<_>>()
            .join(",");
        let source_dimensions = source_sizes
            .iter()
            .map(|(w, h)| format!("[{w},{h}]"))
            .collect::<Vec<_>>()
            .join(",");
        println!("HARMONY_WGC_DIAGNOSTIC_PHASE {{\"kind\":\"DIAGNOSTIC\",\"capacity_approval\":false,\"phase\":{index},\"instrumentation_enabled\":{instrument},\"quality_status\":\"{}\",\"quality_gate\":{{\"capture_fps\":54,\"distinct_marker_fps\":54,\"full_geometry\":true,\"colored_pixels_gt\":13680}},\"elapsed_seconds\":{elapsed},\"frames\":{frames},\"distinct_marker_frames\":{distinct},\"capture_fps\":{raw},\"distinct_marker_fps\":{changed},\"geometry_complete\":{geometry},\"sizes\":[{dimensions}],\"source_sizes\":[{source_dimensions}],\"colored_pixels_of_14400\":{},\"empty_polls\":{empty},\"capture_intervals_ms\":{},\"intervals_below_period\":{short},\"cadence_waits\":{},\"empty_poll_waits\":{},\"marker_identity\":{},\"core\":{}}}",if passed{"PASS"}else{"FAIL"},colored.map_or_else(||"null".into(),|v|v.to_string()),intervals.summary().json(),cadence_waits.json(),empty_waits.json(),identity.json(),snapshot.json());
        Ok(passed)
    }
    pub fn run() -> Result<bool, &'static str> {
        for (k, v) in [
            ("GITHUB_ACTIONS", "true"),
            ("GITHUB_REPOSITORY", "BersaneV/Harmony"),
            ("RUNNER_ENVIRONMENT", "github-hosted"),
            ("GITHUB_REF", "refs/heads/main"),
        ] {
            if env::var(k).as_deref() != Ok(v) {
                return Err("owned_runner_guard");
            }
        }
        let run = env::var("GITHUB_RUN_ID").map_err(|_| "run_id")?;
        if run.is_empty() || !run.bytes().all(|b| b.is_ascii_digit()) {
            return Err("run_id");
        }
        let title = env::var("HARMONY_OWNED_WINDOW").map_err(|_| "owned_title")?;
        if title != format!("HarmonyWAN-{run}") {
            return Err("owned_title");
        }
        let height = env::var("HARMONY_CAPTURE_HEIGHT")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|h| [1080, 1440].contains(h))
            .ok_or("profile")?;
        let handle = env::var("HARMONY_OWNED_HWND")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|h| *h != 0)
            .ok_or("owned_handle")?;
        let pid = env::var("HARMONY_OWNED_PID")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|p| *p != 0)
            .ok_or("owned_pid")?;
        let window = OwnedWindow { handle, pid };
        let source = Source::list()
            .into_iter()
            .find(|s| s.title == title && s.handle() == handle)
            .ok_or("owned_source")?;
        if !owned(window) {
            return Err("owned_pid");
        }
        let profile = Profile { height, fps: 60 };
        let mut capture = Capture::new(source, profile, 0, || owned(window))
            .map_err(|_| "capture_start_or_consent")?;
        if capture.source_title() != title
            || capture.source_dimensions() != (height * 16 / 9, height)
        {
            return Err("consented_geometry");
        }
        let cores = thread::available_parallelism()
            .map_err(|_| "logical_processors")?
            .get();
        println!("HARMONY_WGC_DIAGNOSTIC_CONTEXT {{\"kind\":\"DIAGNOSTIC\",\"capacity_approval\":false,\"height\":{height},\"fps\":60,\"available_logical_processors\":{cores},\"settle_seconds\":5,\"measure_seconds\":10,\"order\":[false,true,false],\"scope\":\"One Capture/Profile/Vec/FramePacer and consented source. Controls disable collection in the same feature-enabled binary, not a separate production binary. No SharedBuffer, JS, encoder, receiver or eight-client load. Map wall includes GPU wait and scheduling; not pure GPU time. Notice age is not linked 1:1 to frames. Source timestamps are classified and exported as deltas only. Marker equality is one pixel and repeats every256 fixture paints. D3D driver type0=unknown,1=hardware,2=WARP identifies API creation branch, not physical GPU execution. Histogram quantiles are bounds, not exact percentiles.\"}}");
        let mut pixels = Vec::new();
        let pacer = FramePacer::new();
        let mut passed = true;
        for (index, instrument) in [false, true, false].into_iter().enumerate() {
            let ok = phase(
                index,
                instrument,
                &mut capture,
                &mut pixels,
                &pacer,
                profile,
                window,
            )?;
            passed &= ok;
        }
        println!("HARMONY_WGC_DIAGNOSTIC_COMPLETE {{\"kind\":\"DIAGNOSTIC\",\"capacity_approval\":false,\"completion\":\"COMPLETE\",\"phases\":3,\"quality_status\":\"{}\"}}",if passed{"PASS"}else{"FAIL"});
        Ok(passed)
    }
}
