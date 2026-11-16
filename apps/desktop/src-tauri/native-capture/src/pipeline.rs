//! One reusable Rust frame and one acknowledged SharedBuffer lease. No pixels,
//! OS clocks, threads or WebView APIs belong to this scheduling state machine.
use crate::{byte_len, Profile};
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProfileEpoch {
    profile: Profile,
    revision: u64,
}
impl ProfileEpoch {
    pub fn new(profile: Profile) -> Result<Self, String> {
        Ok(Self {
            profile: profile.validate()?,
            revision: 1,
        })
    }
    pub fn settings(self) -> Profile {
        self.profile
    }
    pub fn replace(&mut self, profile: Profile) -> Result<(), String> {
        let profile = profile.validate()?;
        let revision = self
            .revision
            .checked_add(1)
            .ok_or("A captura atingiu seu limite de revisões.")?;
        *self = Self { profile, revision };
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct FrameLease {
    pending: AtomicU64,
    scheduled: AtomicU64,
    copied: AtomicU64,
    actual_sent_ns: AtomicU64,
}
impl FrameLease {
    pub fn pixels_available(&self) -> bool {
        self.copied.load(Ordering::Acquire) == self.scheduled.load(Ordering::Acquire)
    }
    pub fn pending_sequence(&self) -> u64 {
        self.pending.load(Ordering::Acquire)
    }
    pub fn waiting(&self) -> bool {
        self.pending_sequence() != 0 || !self.pixels_available()
    }
    fn reserve(&self, sequence: u64) -> bool {
        if sequence == 0
            || !self.pixels_available()
            || self
                .pending
                .compare_exchange(0, sequence, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return false;
        }
        self.scheduled.store(sequence, Ordering::Release);
        true
    }
    /// UI calls only after its last Vec read, unlock and metadata send finish.
    /// `sent_at` uses the same monotonic producer-start origin as reservations.
    pub fn finish_copy(&self, sequence: u64, sent_at: Duration) -> bool {
        if sequence == 0 || self.scheduled.load(Ordering::Acquire) != sequence {
            return false;
        }
        self.actual_sent_ns.store(
            u64::try_from(sent_at.as_nanos()).unwrap_or(u64::MAX),
            Ordering::Relaxed,
        );
        self.copied.store(sequence, Ordering::Release);
        true
    }
    fn actual_sent_at(&self, sequence: u64) -> Option<Duration> {
        // Acquire the matching copy-ready publication before reading its time.
        // The sole worker cannot reserve a new sequence during this read.
        (sequence != 0
            && self.copied.load(Ordering::Acquire) == sequence
            && self.scheduled.load(Ordering::Acquire) == sequence)
            .then(|| Duration::from_nanos(self.actual_sent_ns.load(Ordering::Relaxed)))
    }
    pub fn ack(&self, sequence: u64) -> bool {
        sequence != 0
            && self
                .pending
                .compare_exchange(sequence, 0, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }
}

#[derive(Clone, Copy, Debug)]
struct Prepared {
    width: u32,
    height: u32,
    captured_at: Duration,
    epoch: ProfileEpoch,
}
#[derive(Clone, Copy, Debug)]
pub struct PostedFrame {
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub captured_at: Duration,
    pub fps: Option<f64>,
}
#[derive(Default)]
pub struct FramePipeline {
    prepared: Option<Prepared>,
    last_capture: Option<Duration>,
    last_reservation: Option<Duration>,
    sequence: u64,
    rate_start: Option<Duration>,
    rate_count: u64,
    fps: Option<f64>,
}
impl FramePipeline {
    fn last_send_or_reservation(&self, lease: &FrameLease) -> Option<Duration> {
        self.last_reservation.map(|reserved| {
            lease
                .actual_sent_at(self.sequence)
                .map_or(reserved, |sent| sent.max(reserved))
        })
    }
    fn discard_invalid(&mut self, now: Duration, epoch: ProfileEpoch, lease: &FrameLease) {
        // Keep one stale slot while ACK is blocked. Refreshing it every period
        // would turn backpressure into continuous discarded GPU readbacks.
        if self.prepared.is_some_and(|frame| {
            frame.epoch != epoch
                || now < frame.captured_at
                || (!lease.waiting() && now - frame.captured_at > epoch.settings().period())
        }) {
            self.prepared = None;
        }
    }
    pub fn can_capture(
        &mut self,
        now: Duration,
        epoch: ProfileEpoch,
        lease: &FrameLease,
        source_open: bool,
        stopped: bool,
    ) -> bool {
        self.discard_invalid(now, epoch, lease);
        !stopped
            && source_open
            && !self.expired(now, lease)
            && self.prepared.is_none()
            && lease.pixels_available()
            && self
                .last_capture
                .is_none_or(|at| now >= at + epoch.settings().period())
    }
    /// Call only after a successful readback into the reusable Vec. Empty pool
    /// polls do not consume the period (otherwise an event boundary halves FPS).
    pub fn captured(
        &mut self,
        started: Duration,
        finished: Duration,
        width: u32,
        height: u32,
        epoch: ProfileEpoch,
        lease: &FrameLease,
    ) -> Result<(), String> {
        byte_len(width, height)?;
        if !self.can_capture(started, epoch, lease, true, false)
            || finished < started
            || (epoch.settings().height != 0 && height > epoch.settings().height)
        {
            return Err("Estado do quadro preparado inválido.".into());
        }
        self.last_capture = Some(started);
        self.prepared = Some(Prepared {
            width,
            height,
            captured_at: finished,
            epoch,
        });
        Ok(())
    }
    /// Caller holds the same profile mutex used by profile commands throughout
    /// this validation/reservation. A later change sees an already committed
    /// in-flight lease, exactly as before prefetch; it never fabricates an ACK.
    pub fn reserve_post(
        &mut self,
        now: Duration,
        epoch: ProfileEpoch,
        lease: &FrameLease,
        source_open: bool,
        stopped: bool,
    ) -> Result<Option<PostedFrame>, String> {
        self.discard_invalid(now, epoch, lease);
        if stopped || !source_open {
            self.prepared = None;
            return Ok(None);
        }
        if self.expired(now, lease) {
            return Err("A prévia da captura deixou de responder.".into());
        }
        let Some(frame) = self.prepared else {
            return Ok(None);
        };
        if let Some(reserved) = self.last_reservation {
            let Some(sent) = lease.actual_sent_at(self.sequence) else {
                return Ok(None);
            };
            if now < reserved.max(sent) + epoch.settings().period() {
                return Ok(None);
            }
        }
        let sequence = self
            .sequence
            .checked_add(1)
            .ok_or("A captura atingiu seu limite de quadros.")?;
        if !lease.reserve(sequence) {
            return Ok(None);
        }
        self.prepared = None;
        self.sequence = sequence;
        self.last_reservation = Some(now);
        if let Some(at) = self.rate_start {
            self.rate_count += 1;
            let elapsed = now - at;
            if elapsed >= Duration::from_secs(1) {
                self.fps = Some(self.rate_count as f64 / elapsed.as_secs_f64());
                self.rate_count = 0;
                self.rate_start = Some(now);
            }
        } else {
            self.rate_start = Some(now);
        }
        Ok(Some(PostedFrame {
            sequence,
            width: frame.width,
            height: frame.height,
            captured_at: frame.captured_at,
            fps: self.fps,
        }))
    }
    /// Reservation time includes a queued UI callback and the JS ACK roundtrip.
    /// Preparing/dropping frames never refreshes this five-second deadline.
    pub fn expired(&self, now: Duration, lease: &FrameLease) -> bool {
        self.last_reservation.is_some_and(|at| {
            (lease.waiting() && now.saturating_sub(at) > Duration::from_secs(5))
                || lease
                    .actual_sent_at(self.sequence)
                    .is_some_and(|sent| sent.saturating_sub(at) > Duration::from_secs(5))
        })
    }
    pub fn wait(&self, now: Duration, epoch: ProfileEpoch, lease: &FrameLease) -> Duration {
        if lease.waiting() {
            return Duration::from_micros(500);
        }
        let deadline = if self.prepared.is_some() {
            self.last_send_or_reservation(lease)
        } else {
            self.last_capture
        };
        deadline.map_or(Duration::from_millis(1), |at| {
            (at + epoch.settings().period())
                .saturating_sub(now)
                .max(Duration::from_micros(500))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> ProfileEpoch {
        ProfileEpoch::new(Profile {
            height: 1440,
            fps: 60,
        })
        .unwrap()
    }
    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }
    fn frame(p: &mut FramePipeline, lease: &FrameLease, at: u64, epoch: ProfileEpoch) {
        p.captured(ms(at), ms(at + 4), 2560, 1440, epoch, lease)
            .unwrap();
    }
    #[test]
    fn ack_before_ui_copy_cannot_free_the_vec_or_bypass_the_queued_watchdog() {
        let (mut p, lease, epoch) = (FramePipeline::default(), FrameLease::default(), profile());
        frame(&mut p, &lease, 0, epoch);
        let a = p
            .reserve_post(ms(4), epoch, &lease, true, false)
            .unwrap()
            .unwrap();
        assert!(lease.ack(a.sequence));
        assert!(!lease.pixels_available());
        assert!(!p.can_capture(ms(20), epoch, &lease, true, false));
        assert!(p.expired(ms(5005), &lease));
        assert!(lease.finish_copy(a.sequence, ms(5005)));
        assert_eq!(lease.actual_sent_at(a.sequence), Some(ms(5005)));
        assert!(!p.can_capture(ms(5005), epoch, &lease, true, false));
        assert!(p.expired(ms(5005), &lease));
        assert!(p
            .reserve_post(ms(5005), epoch, &lease, true, false)
            .is_err());
    }
    #[test]
    fn wrong_ack_and_copy_do_not_release_one_shared_lease_or_allow_a_second_prepared_frame() {
        let (mut p, lease, epoch) = (FramePipeline::default(), FrameLease::default(), profile());
        frame(&mut p, &lease, 0, epoch);
        let a = p
            .reserve_post(ms(4), epoch, &lease, true, false)
            .unwrap()
            .unwrap();
        assert!(!lease.ack(a.sequence + 1));
        assert!(!lease.ack(0));
        assert!(!lease.finish_copy(a.sequence + 1, ms(9999)));
        assert_eq!(lease.actual_sent_at(a.sequence), None);
        assert!(lease.finish_copy(a.sequence, ms(4)));
        assert_eq!(lease.actual_sent_at(a.sequence), Some(ms(4)));
        frame(&mut p, &lease, 17, epoch);
        assert!(!p.can_capture(ms(24), epoch, &lease, true, false));
        assert!(p
            .reserve_post(ms(25), epoch, &lease, true, false)
            .unwrap()
            .is_none());
        assert!(lease.ack(a.sequence));
        let b = p
            .reserve_post(ms(25), epoch, &lease, true, false)
            .unwrap()
            .unwrap();
        assert_eq!(b.sequence, a.sequence + 1);
        assert_eq!(b.captured_at, ms(21));
        assert!(!lease.ack(a.sequence));
        assert!(!lease.finish_copy(a.sequence, ms(4)));
        assert_eq!(lease.pending_sequence(), b.sequence);
    }
    #[test]
    fn ui_and_js_delays_share_the_original_five_second_watchdog() {
        let (mut p, lease, epoch) = (FramePipeline::default(), FrameLease::default(), profile());
        frame(&mut p, &lease, 0, epoch);
        let a = p
            .reserve_post(ms(4), epoch, &lease, true, false)
            .unwrap()
            .unwrap();
        lease.finish_copy(a.sequence, ms(4));
        frame(&mut p, &lease, 17, epoch);
        assert!(!p.expired(ms(5004), &lease));
        assert!(p.expired(ms(5005), &lease));
        assert_eq!(lease.actual_sent_at(a.sequence), Some(ms(4)));
    }
    #[test]
    fn profile_aba_discards_only_unposted_pixels_and_never_clears_an_ack() {
        let (mut p, lease, mut epoch) =
            (FramePipeline::default(), FrameLease::default(), profile());
        frame(&mut p, &lease, 0, epoch);
        let a = p
            .reserve_post(ms(4), epoch, &lease, true, false)
            .unwrap()
            .unwrap();
        lease.finish_copy(a.sequence, ms(4));
        frame(&mut p, &lease, 17, epoch);
        epoch
            .replace(Profile {
                height: 720,
                fps: 30,
            })
            .unwrap();
        epoch
            .replace(Profile {
                height: 1440,
                fps: 60,
            })
            .unwrap();
        assert!(p
            .reserve_post(ms(25), epoch, &lease, true, false)
            .unwrap()
            .is_none());
        assert_eq!(lease.pending_sequence(), a.sequence);
        assert!(!p.can_capture(ms(25), epoch, &lease, true, false));
        assert!(lease.ack(a.sequence));
        assert!(p.can_capture(ms(34), epoch, &lease, true, false));
    }
    #[test]
    fn stale_prepared_frame_is_dropped_without_replaying_an_old_queue() {
        let (mut p, lease, epoch) = (FramePipeline::default(), FrameLease::default(), profile());
        frame(&mut p, &lease, 0, epoch);
        let a = p
            .reserve_post(ms(4), epoch, &lease, true, false)
            .unwrap()
            .unwrap();
        lease.finish_copy(a.sequence, ms(4));
        frame(&mut p, &lease, 17, epoch);
        assert!(!p.can_capture(ms(40), epoch, &lease, true, false));
        assert!(!p.can_capture(ms(4000), epoch, &lease, true, false));
        lease.ack(a.sequence);
        assert!(p
            .reserve_post(ms(4000), epoch, &lease, true, false)
            .unwrap()
            .is_none());
        assert_eq!(lease.pending_sequence(), 0);
        assert!(p.can_capture(ms(4000), epoch, &lease, true, false));
        frame(&mut p, &lease, 4000, epoch);
        let next = p
            .reserve_post(ms(4004), epoch, &lease, true, false)
            .unwrap()
            .unwrap();
        assert_eq!(next.sequence, 2);
        assert_eq!(next.captured_at, ms(4004));
    }
    #[test]
    fn resize_metadata_and_source_stop_are_checked_before_commit() {
        let (mut p, lease, epoch) = (FramePipeline::default(), FrameLease::default(), profile());
        p.captured(ms(0), ms(4), 1280, 720, epoch, &lease).unwrap();
        let a = p
            .reserve_post(ms(4), epoch, &lease, true, false)
            .unwrap()
            .unwrap();
        assert_eq!((a.width, a.height), (1280, 720));
        lease.finish_copy(a.sequence, ms(4));
        frame(&mut p, &lease, 17, epoch);
        assert!(p
            .reserve_post(ms(21), epoch, &lease, false, false)
            .unwrap()
            .is_none());
        assert_eq!(lease.pending_sequence(), a.sequence);
        assert!(!p.can_capture(ms(40), epoch, &lease, false, false));
        assert!(!p.can_capture(ms(40), epoch, &lease, true, true));
        lease.ack(a.sequence);
        frame(&mut p, &lease, 40, epoch);
        assert!(p
            .reserve_post(ms(44), epoch, &lease, true, true)
            .unwrap()
            .is_none());
        assert_eq!(lease.pending_sequence(), 0);
    }
    #[test]
    fn delayed_ack_cannot_burst_posts_or_change_the_capture_timestamp() {
        let (mut p, lease, epoch) = (FramePipeline::default(), FrameLease::default(), profile());
        frame(&mut p, &lease, 0, epoch);
        let a = p
            .reserve_post(ms(4), epoch, &lease, true, false)
            .unwrap()
            .unwrap();
        lease.finish_copy(a.sequence, ms(4));
        frame(&mut p, &lease, 17, epoch);
        lease.ack(a.sequence);
        let b = p
            .reserve_post(ms(30), epoch, &lease, true, false)
            .unwrap()
            .unwrap();
        assert_eq!(b.captured_at, ms(21));
        lease.finish_copy(b.sequence, ms(30));
        frame(&mut p, &lease, 34, epoch);
        lease.ack(b.sequence);
        assert!(p
            .reserve_post(ms(38), epoch, &lease, true, false)
            .unwrap()
            .is_none());
        let c = p
            .reserve_post(ms(47), epoch, &lease, true, false)
            .unwrap()
            .unwrap();
        assert_eq!(c.captured_at, ms(38));
        assert_eq!(c.sequence, 3);
    }
    #[test]
    fn queued_ui_send_sets_the_next_post_deadline_without_blocking_prefetch() {
        let (mut p, lease, epoch) = (FramePipeline::default(), FrameLease::default(), profile());
        frame(&mut p, &lease, 0, epoch);
        let a = p
            .reserve_post(ms(4), epoch, &lease, true, false)
            .unwrap()
            .unwrap();
        // Native UI metadata A is sent only at 100 ms, well after reservation.
        lease.finish_copy(a.sequence, ms(100));
        lease.ack(a.sequence);
        p.captured(ms(101), ms(105), 2560, 1440, epoch, &lease)
            .unwrap();
        assert!(p
            .reserve_post(ms(105), epoch, &lease, true, false)
            .unwrap()
            .is_none());
        let earliest = ms(100) + epoch.settings().period();
        assert_eq!(p.wait(ms(105), epoch, &lease), earliest - ms(105));
        assert!(p
            .reserve_post(
                earliest - Duration::from_nanos(1),
                epoch,
                &lease,
                true,
                false
            )
            .unwrap()
            .is_none());
        let b = p
            .reserve_post(earliest, epoch, &lease, true, false)
            .unwrap()
            .unwrap();
        assert_eq!(b.captured_at, ms(105));
        assert_eq!(b.sequence, 2);
        lease.finish_copy(b.sequence, ms(5000));
        assert!(!p.expired(earliest + Duration::from_secs(5), &lease));
        assert!(p.expired(
            earliest + Duration::from_secs(5) + Duration::from_nanos(1),
            &lease
        ));
    }
    #[test]
    fn a_slower_profile_preserves_the_previous_capture_and_post_deadlines() {
        let (mut p, lease, mut epoch) =
            (FramePipeline::default(), FrameLease::default(), profile());
        frame(&mut p, &lease, 0, epoch);
        let a = p
            .reserve_post(ms(4), epoch, &lease, true, false)
            .unwrap()
            .unwrap();
        lease.finish_copy(a.sequence, ms(4));
        lease.ack(a.sequence);
        epoch
            .replace(Profile {
                height: 720,
                fps: 15,
            })
            .unwrap();
        assert!(!p.can_capture(ms(17), epoch, &lease, true, false));
        assert!(p.can_capture(ms(67), epoch, &lease, true, false));
        p.captured(ms(67), ms(68), 1280, 720, epoch, &lease)
            .unwrap();
        assert!(p
            .reserve_post(ms(68), epoch, &lease, true, false)
            .unwrap()
            .is_none());
        let b = p
            .reserve_post(ms(71), epoch, &lease, true, false)
            .unwrap()
            .unwrap();
        assert_eq!((b.width, b.height), (1280, 720));
        assert_eq!(b.captured_at, ms(68));
    }
    #[test]
    fn capture_and_post_are_both_paced_without_bursts_or_fps_rounding() {
        for fps in [15, 24, 30, 60] {
            let epoch = ProfileEpoch::new(Profile { height: 1440, fps }).unwrap();
            let (mut p, lease) = (FramePipeline::default(), FrameLease::default());
            let period = epoch.settings().period();
            let mut last = None;
            for n in 0..150 {
                let start = period * n;
                assert!(p.can_capture(start, epoch, &lease, true, false));
                p.captured(start, start + ms(1), 2560, 1440, epoch, &lease)
                    .unwrap();
                let now = start + ms(1);
                let frame = p
                    .reserve_post(now, epoch, &lease, true, false)
                    .unwrap()
                    .unwrap();
                if let Some(at) = last {
                    assert!(now - at >= period);
                }
                if let Some(measured) = frame.fps {
                    assert!(measured <= f64::from(fps));
                }
                last = Some(now);
                lease.finish_copy(frame.sequence, now);
                lease.ack(frame.sequence);
                assert!(!p.can_capture(
                    start + period - Duration::from_nanos(1),
                    epoch,
                    &lease,
                    true,
                    false
                ));
            }
        }
    }
}
