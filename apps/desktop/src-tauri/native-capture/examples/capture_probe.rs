#[cfg(not(windows))]
fn main() {
    panic!("Disposable Windows runner required");
}

#[cfg(windows)]
fn main() {
    use harmony_native_capture::{Capture, Profile, Source};
    use std::{
        env, thread,
        time::{Duration, Instant},
    };
    assert_eq!(
        env::var("GITHUB_REPOSITORY").as_deref(),
        Ok("BersaneV/Harmony")
    );
    assert_eq!(
        env::var("RUNNER_ENVIRONMENT").as_deref(),
        Ok("github-hosted")
    );
    let title = env::var("HARMONY_OWNED_WINDOW").unwrap();
    assert!(title.starts_with("HarmonyWAN-") && title[11..].bytes().all(|c| c.is_ascii_digit()));
    let height = env::var("HARMONY_CAPTURE_HEIGHT").unwrap().parse().unwrap();
    assert!([1080, 1440].contains(&height));
    let ready_deadline = Instant::now() + Duration::from_secs(30);
    let source = loop {
        if let Some(source) = Source::list().into_iter().find(|s| s.title == title) {
            break source;
        }
        assert!(
            Instant::now() < ready_deadline,
            "Owned native window required"
        );
        thread::sleep(Duration::from_millis(100));
    };
    let handle = source.handle();
    let profile = Profile { height, fps: 60 };
    let mut capture = Capture::new(source, profile, 0, || true).unwrap();
    let mut frame = Vec::new();
    let start = Instant::now();
    let settle = start + Duration::from_secs(5);
    let end = settle + Duration::from_secs(10);
    let mut deadline = start;
    let mut frames = 0;
    let mut changed = 0;
    let mut previous = None;
    let mut sizes = std::collections::BTreeSet::new();
    let mut durations = Vec::new();
    while Instant::now() < end {
        let begin = Instant::now();
        let Some((w, h)) = capture.frame(&mut frame).unwrap() else {
            thread::sleep(Duration::from_millis(1));
            continue;
        };
        let duration = begin.elapsed().as_secs_f64() * 1000.;
        if begin >= settle {
            frames += 1;
            durations.push(duration);
            sizes.insert((w, h));
            let marker = [frame[0], frame[1], frame[2]];
            if Some(marker) != previous {
                changed += 1;
            }
            previous = Some(marker);
        }
        deadline += profile.period();
        let now = Instant::now();
        if deadline > now {
            thread::sleep(deadline - now);
        } else {
            deadline = now;
        }
    }
    let elapsed = Instant::now().duration_since(settle).as_secs_f64();
    durations.sort_by(f64::total_cmp);
    let backend = capture.backend();
    let capture_fps = frames as f64 / elapsed;
    let distinct_fps = changed as f64 / elapsed;
    let size = sizes.iter().next().copied().unwrap();
    let expected = (height * 16 / 9, height);
    let mut colored = 0;
    for y in 0..90 {
        for x in 0..160 {
            let i = (((y * size.1 / 90) * size.0 + x * size.0 / 160) * 4) as usize;
            let (b, g, r) = (frame[i] as i32, frame[i + 1] as i32, frame[i + 2] as i32);
            if (b - g).abs() + (g - r).abs() > 20 {
                colored += 1;
            }
        }
    }
    let ok = capture_fps >= 54.
        && distinct_fps >= 54.
        && sizes.len() == 1
        && size == expected
        && colored > 13680;
    println!("HARMONY_NATIVE_CAPTURE_PROBE {{\"status\":\"{}\",\"backend\":\"{}\",\"owned_window_handle\":{},\"width\":{},\"height\":{},\"capture_fps\":{},\"distinct_marker_fps\":{},\"frames\":{},\"colored_pixels_of_14400\":{},\"capture_ms_p50\":{},\"capture_ms_p95\":{}}}",if ok{"PASS"}else{"FAIL"},backend,handle,size.0,size.1,capture_fps,distinct_fps,frames,colored,durations[durations.len()/2],durations[durations.len()*95/100]);
    if !ok {
        std::process::exit(1);
    }
}
