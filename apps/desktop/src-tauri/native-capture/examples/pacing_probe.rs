//! Isolated Windows diagnostic, not an application or eight-client capacity gate.
//! A matches the producer's start-relative cadence; B adapts capture_probe's
//! nominal cadence to the same positive-wait floor, isolating the anchor.
#[cfg(any(windows, test))]
mod measurements {
    use std::time::Duration;

    pub const MAX_OBSERVATIONS: usize = 32_768;
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Policy {
        StartRelative,
        Nominal,
    }
    impl Policy {
        pub fn name(self) -> &'static str {
            match self {
                Self::StartRelative => "start-relative",
                Self::Nominal => "nominal",
            }
        }
        pub fn wait(
            self,
            deadline: &mut Duration,
            started: Duration,
            finished: Duration,
            period: Duration,
        ) -> Option<Duration> {
            match self {
                Self::StartRelative => {
                    *deadline = started + period;
                    (*deadline > finished)
                        .then(|| (*deadline - finished).max(Duration::from_micros(500)))
                }
                Self::Nominal => {
                    *deadline += period;
                    if *deadline > finished {
                        Some((*deadline - finished).max(Duration::from_micros(500)))
                    } else {
                        // Match capture_probe: no accumulated missed slots.
                        *deadline = finished;
                        None
                    }
                }
            }
        }
    }
    #[derive(Default)]
    pub struct Series(Vec<f64>);
    impl Series {
        pub fn push(&mut self, value: f64) -> Result<(), &'static str> {
            if !value.is_finite() || self.0.len() == MAX_OBSERVATIONS {
                return Err("observation_limit_or_invalid_number");
            }
            self.0.push(value);
            Ok(())
        }
        pub fn percentile(&self, percentile: usize) -> Option<f64> {
            if self.0.is_empty() {
                return None;
            }
            let mut values = self.0.clone();
            values.sort_by(f64::total_cmp);
            Some(values[(values.len() * percentile).div_ceil(100).max(1) - 1])
        }
        pub fn json(&self) -> String {
            let number = |n: Option<f64>| n.map_or_else(|| "null".into(), |v| v.to_string());
            format!(
                "{{\"count\":{},\"min\":{},\"p50\":{},\"p95\":{},\"max\":{}}}",
                self.0.len(),
                number(self.0.iter().copied().min_by(f64::total_cmp)),
                number(self.percentile(50)),
                number(self.percentile(95)),
                number(self.0.iter().copied().max_by(f64::total_cmp))
            )
        }
    }
    #[derive(Default)]
    pub struct Waits {
        pub requested: Series,
        pub actual: Series,
        pub overshoot: Series,
        pub undershoots: u64,
    }
    impl Waits {
        pub fn record(
            &mut self,
            requested: Duration,
            actual: Duration,
        ) -> Result<(), &'static str> {
            self.requested.push(requested.as_secs_f64() * 1000.)?;
            self.actual.push(actual.as_secs_f64() * 1000.)?;
            self.overshoot
                .push(actual.saturating_sub(requested).as_secs_f64() * 1000.)?;
            self.undershoots += u64::from(actual < requested);
            Ok(())
        }
        pub fn json(&self) -> String {
            format!(
                "{{\"requested_ms\":{},\"actual_ms\":{},\"overshoot_ms\":{},\"undershoot_count\":{}}}",
                self.requested.json(), self.actual.json(), self.overshoot.json(), self.undershoots
            )
        }
    }
    pub fn quality(
        fps: f64,
        distinct_fps: f64,
        geometry_complete: bool,
        colored: Option<usize>,
    ) -> bool {
        fps.is_finite()
            && distinct_fps.is_finite()
            && fps >= 54.
            && distinct_fps >= 54.
            && geometry_complete
            && colored.is_some_and(|count| count > 13_680)
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        fn ms(n: u64) -> Duration {
            Duration::from_millis(n)
        }
        #[test]
        fn real_policies_have_distinct_anchor_and_floor_semantics() {
            let mut relative = Duration::ZERO;
            let mut nominal = Duration::ZERO;
            let period = Duration::from_nanos(16_666_667);
            assert_eq!(Policy::StartRelative.name(), "start-relative");
            assert_eq!(Policy::Nominal.name(), "nominal");
            Policy::StartRelative.wait(&mut relative, Duration::ZERO, ms(4), period);
            Policy::Nominal.wait(&mut nominal, Duration::ZERO, ms(4), period);
            // A real 2 ms late wake changes only the start-relative anchor.
            let start = period + ms(2);
            Policy::StartRelative.wait(&mut relative, start, start + ms(4), period);
            Policy::Nominal.wait(&mut nominal, start, start + ms(4), period);
            assert_eq!(relative, start + period);
            assert_eq!(nominal, period * 2);
            let almost_due = period - Duration::from_micros(1);
            assert_eq!(
                Policy::StartRelative.wait(&mut relative, Duration::ZERO, almost_due, period),
                Some(Duration::from_micros(500))
            );
            nominal = Duration::ZERO;
            assert_eq!(
                Policy::Nominal.wait(&mut nominal, Duration::ZERO, almost_due, period),
                Some(Duration::from_micros(500))
            );
            assert_eq!(
                Policy::StartRelative.wait(&mut relative, Duration::ZERO, period, period),
                None
            );
        }
        #[test]
        fn missed_nominal_slots_reanchor_without_a_catchup_queue() {
            let mut deadline = Duration::ZERO;
            assert_eq!(
                Policy::Nominal.wait(&mut deadline, ms(100), ms(110), ms(17)),
                None
            );
            assert_eq!(deadline, ms(110));
            assert_eq!(
                Policy::Nominal.wait(&mut deadline, ms(110), ms(114), ms(17)),
                Some(ms(13))
            );
            assert_eq!(deadline, ms(127));
        }
        #[test]
        fn missing_measurements_are_not_zero_or_pass_and_tail_is_retained() {
            let mut samples = Series::default();
            assert_eq!(samples.percentile(95), None);
            assert!(samples.json().contains("\"p95\":null"));
            for sample in [1., 2., 100.] {
                samples.push(sample).unwrap();
            }
            assert_eq!(samples.percentile(50), Some(2.));
            assert_eq!(samples.percentile(95), Some(100.));
            assert!(samples.push(f64::NAN).is_err());
            assert!(!quality(60., 60., true, None));
            assert!(!quality(60., 53.99, true, Some(14_400)));
            assert!(!quality(60., 60., false, Some(14_400)));
            assert!(quality(54., 54., true, Some(13_681)));
        }
        #[test]
        fn wait_underflow_is_visible_and_observation_storage_is_bounded() {
            let mut waits = Waits::default();
            waits.record(ms(2), ms(3)).unwrap();
            waits.record(ms(2), ms(1)).unwrap();
            assert_eq!(waits.undershoots, 1);
            assert_eq!(waits.overshoot.percentile(95), Some(1.));
            assert!(waits.json().contains("\"undershoot_count\":1"));
            let mut samples = Series::default();
            for _ in 0..MAX_OBSERVATIONS {
                samples.push(0.).unwrap();
            }
            assert!(samples.push(0.).is_err());
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("HARMONY_NATIVE_PACING_ERROR {{\"kind\":\"DIAGNOSTIC\",\"capacity_approval\":false,\"stage\":\"windows_required\"}}");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    match windows_probe::run() {
        Ok(true) => {}
        Ok(false) => std::process::exit(1),
        Err(stage) => {
            eprintln!("HARMONY_NATIVE_PACING_ERROR {{\"kind\":\"DIAGNOSTIC\",\"capacity_approval\":false,\"stage\":\"{stage}\"}}");
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
mod windows_probe {
    use super::measurements::{quality, Policy, Series, Waits};
    use harmony_native_capture::{Capture, FramePacer, Profile, Source};
    use std::{
        collections::BTreeSet,
        env, thread,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow},
    };

    struct Phase {
        fps: f64,
        distinct_fps: f64,
        passed: bool,
    }
    #[derive(Clone, Copy)]
    struct OwnedWindow {
        handle: usize,
        pid: u32,
    }
    fn owned(handle: usize, pid: u32) -> bool {
        let mut actual_pid = 0;
        unsafe {
            IsWindow(handle as HWND) != 0
                && GetWindowThreadProcessId(handle as HWND, &mut actual_pid) != 0
                && actual_pid == pid
        }
    }
    fn sleep(
        pacer: &FramePacer,
        requested: Duration,
        record: bool,
        waits: &mut Waits,
    ) -> Result<(), &'static str> {
        let started = Instant::now();
        pacer.sleep(requested);
        if record {
            waits.record(requested, started.elapsed())?;
        }
        Ok(())
    }
    fn phase(
        index: usize,
        policy: Policy,
        capture: &mut Capture,
        pixels: &mut Vec<u8>,
        pacer: &FramePacer,
        profile: Profile,
        window: OwnedWindow,
    ) -> Result<Phase, &'static str> {
        println!("HARMONY_NATIVE_PACING_BEGIN {{\"kind\":\"DIAGNOSTIC\",\"capacity_approval\":false,\"phase\":{index},\"policy\":\"{}\",\"stage\":\"settle_then_measure\"}}",policy.name());
        let origin = Instant::now();
        let settle = Duration::from_secs(5);
        let end = settle + Duration::from_secs(10);
        let mut deadline = Duration::ZERO;
        let (mut frames, mut distinct, mut empty_polls, mut short_intervals) =
            (0_u64, 0_u64, 0_u64, 0_u64);
        let (mut previous_marker, mut previous_start) = (None, None);
        let mut sizes = BTreeSet::new();
        let mut source_sizes = BTreeSet::new();
        let (mut capture_wall, mut empty_wall, mut intervals, mut cadence_waits, mut empty_waits) = (
            Series::default(),
            Series::default(),
            Series::default(),
            Waits::default(),
            Waits::default(),
        );
        while origin.elapsed() < end {
            if capture.is_closed() || !owned(window.handle, window.pid) {
                return Err("source_closed_or_changed");
            }
            let started = origin.elapsed();
            if started >= end {
                break;
            }
            let measured = started >= settle;
            let result = capture.frame(pixels).map_err(|_| "capture_frame")?;
            let finished = origin.elapsed();
            let Some((width, height)) = result else {
                if measured {
                    empty_polls += 1;
                    empty_wall.push((finished - started).as_secs_f64() * 1000.)?;
                }
                sleep(pacer, Duration::from_millis(1), measured, &mut empty_waits)?;
                continue;
            };
            if measured {
                capture_wall.push((finished - started).as_secs_f64() * 1000.)?;
                frames += 1;
                sizes.insert((width, height));
                source_sizes.insert(capture.source_dimensions());
                let marker = [pixels[0], pixels[1], pixels[2]];
                if Some(marker) != previous_marker {
                    distinct += 1;
                }
                previous_marker = Some(marker);
                if let Some(previous) = previous_start {
                    let interval = started - previous;
                    intervals.push(interval.as_secs_f64() * 1000.)?;
                    short_intervals += u64::from(interval < profile.period());
                }
                previous_start = Some(started);
            }
            if let Some(requested) =
                policy.wait(&mut deadline, started, origin.elapsed(), profile.period())
            {
                sleep(pacer, requested, measured, &mut cadence_waits)?;
            }
        }
        let elapsed = origin.elapsed().saturating_sub(settle).as_secs_f64();
        let expected = (profile.height * 16 / 9, profile.height);
        let geometry = sizes.len() == 1
            && sizes.contains(&expected)
            && source_sizes.len() == 1
            && source_sizes.contains(&expected);
        let colored = if frames > 0 && geometry {
            let (width, height) = expected;
            let mut colored = 0;
            for y in 0..90 {
                for x in 0..160 {
                    let i = (((y * height / 90) * width + x * width / 160) * 4) as usize;
                    let (b, g, r) = (
                        i32::from(pixels[i]),
                        i32::from(pixels[i + 1]),
                        i32::from(pixels[i + 2]),
                    );
                    if (b - g).abs() + (g - r).abs() > 20 {
                        colored += 1;
                    }
                }
            }
            Some(colored)
        } else {
            None
        };
        let fps = frames as f64 / elapsed;
        let distinct_fps = distinct as f64 / elapsed;
        let passed = quality(fps, distinct_fps, geometry, colored);
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
        println!("HARMONY_NATIVE_PACING_PHASE {{\"kind\":\"DIAGNOSTIC\",\"capacity_approval\":false,\"phase\":{index},\"policy\":\"{}\",\"quality_status\":\"{}\",\"quality_gate\":{{\"capture_fps\":54,\"distinct_marker_fps\":54,\"full_geometry\":true,\"colored_pixels_gt\":13680}},\"frames\":{frames},\"distinct_marker_frames\":{distinct},\"elapsed_seconds\":{elapsed},\"capture_fps\":{fps},\"distinct_marker_fps\":{distinct_fps},\"sizes\":[{dimensions}],\"source_sizes\":[{source_dimensions}],\"geometry_complete\":{geometry},\"colored_pixels_of_14400\":{},\"capture_frame_wall_ms\":{},\"capture_empty_poll_wall_ms\":{},\"capture_start_intervals_ms\":{},\"intervals_below_period\":{short_intervals},\"empty_polls\":{empty_polls},\"cadence_waits\":{},\"empty_poll_waits\":{},\"minimum_positive_cadence_wait_us\":500}}", policy.name(), if passed {"PASS"} else {"FAIL"}, colored.map_or_else(|| "null".into(), |n| n.to_string()), capture_wall.json(), empty_wall.json(), intervals.json(), cadence_waits.json(), empty_waits.json());
        Ok(Phase {
            fps,
            distinct_fps,
            passed,
        })
    }
    pub fn run() -> Result<bool, &'static str> {
        for (key, expected) in [
            ("GITHUB_ACTIONS", "true"),
            ("GITHUB_REPOSITORY", "BersaneV/Harmony"),
            ("RUNNER_ENVIRONMENT", "github-hosted"),
            ("GITHUB_REF", "refs/heads/main"),
        ] {
            if env::var(key).as_deref() != Ok(expected) {
                return Err("owned_runner_guard");
            }
        }
        let run = env::var("GITHUB_RUN_ID").map_err(|_| "run_id")?;
        if run.is_empty() || !run.bytes().all(|c| c.is_ascii_digit()) {
            return Err("run_id");
        }
        let title = env::var("HARMONY_OWNED_WINDOW").map_err(|_| "owned_window_title")?;
        if title != format!("HarmonyWAN-{run}") {
            return Err("owned_window_title");
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
            .ok_or("owned_window_handle")?;
        let pid = env::var("HARMONY_OWNED_PID")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|p| *p != 0)
            .ok_or("owned_window_pid")?;
        let source = Source::list()
            .into_iter()
            .find(|s| s.title == title && s.handle() == handle)
            .ok_or("owned_window_lookup")?;
        if !owned(handle, pid) {
            return Err("owned_window_pid");
        }
        let profile = Profile { height, fps: 60 };
        let mut capture = Capture::new(source, profile, 0, || owned(handle, pid))
            .map_err(|_| "capture_start_or_consent")?;
        if capture.source_title() != title
            || capture.source_dimensions() != (height * 16 / 9, height)
        {
            return Err("consented_source_geometry");
        }
        let logical = thread::available_parallelism()
            .map_err(|_| "available_parallelism")?
            .get();
        println!("HARMONY_NATIVE_PACING_CONTEXT {{\"kind\":\"DIAGNOSTIC\",\"capacity_approval\":false,\"height\":{height},\"fps\":60,\"backend\":\"{}\",\"owned_window_handle\":{handle},\"available_logical_processors\":{logical},\"settle_seconds\":5,\"measure_seconds\":10,\"order\":[\"A\",\"B\",\"B\",\"A\"],\"quantile\":\"nearest-rank\",\"scope\":\"One real capture/profile/pixel Vec/pacer, preview only; no SharedBuffer/JS/encoder/receiver. Both use a 500us positive-wait floor; B adapts the CLI floor to isolate the anchor. No product capacity claim.\"}}",capture.backend());
        let mut pixels = Vec::new();
        let pacer = FramePacer::new();
        let mut results = Vec::new();
        for (index, policy) in [
            Policy::StartRelative,
            Policy::Nominal,
            Policy::Nominal,
            Policy::StartRelative,
        ]
        .into_iter()
        .enumerate()
        {
            results.push(phase(
                index,
                policy,
                &mut capture,
                &mut pixels,
                &pacer,
                profile,
                OwnedWindow { handle, pid },
            )?);
        }
        println!("HARMONY_NATIVE_PACING_COMPLETE {{\"kind\":\"DIAGNOSTIC\",\"capacity_approval\":false,\"completion\":\"COMPLETE\",\"phases\":4,\"quality_status\":\"{}\",\"relative_capture_fps\":[{},{}],\"nominal_capture_fps\":[{},{}],\"relative_distinct_fps\":[{},{}],\"nominal_distinct_fps\":[{},{}]}}",if results.iter().all(|r|r.passed){"PASS"}else{"FAIL"},results[0].fps,results[3].fps,results[1].fps,results[2].fps,results[0].distinct_fps,results[3].distinct_fps,results[1].distinct_fps,results[2].distinct_fps);
        Ok(results.iter().all(|r| r.passed))
    }
}
