//! One reusable Rust frame and one acknowledged SharedBuffer lease. Pixels and
//! WebView APIs stay in the adapter; all times share the producer's clock origin.
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
    sending: AtomicU64,
    sent: AtomicU64,
    actual_sent_ns: AtomicU64,
}
impl FrameLease {
    pub fn is_current(&self, sequence: u64) -> bool {
        sequence != 0 && self.scheduled.load(Ordering::Acquire) == sequence
    }
    pub fn pixels_available(&self) -> bool {
        self.copied.load(Ordering::Acquire) == self.scheduled.load(Ordering::Acquire)
    }
    fn send_complete(&self) -> bool {
        self.sent.load(Ordering::Acquire) == self.scheduled.load(Ordering::Acquire)
    }
    pub fn pending_sequence(&self) -> u64 {
        self.pending.load(Ordering::Acquire)
    }
    pub fn waiting(&self) -> bool {
        self.pending_sequence() != 0 || !self.pixels_available() || !self.send_complete()
    }
    fn reserve(&self, sequence: u64) -> bool {
        if sequence == 0
            || !self.pixels_available()
            || !self.send_complete()
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
    /// UI publishes only after its final Vec read/unlock and metadata handoff.
    /// This releases the Vec, never the still unpublished SharedBuffer lease.
    pub fn finish_copy(&self, sequence: u64) -> bool {
        if !self.is_current(sequence) || self.copied.load(Ordering::Acquire) == sequence {
            return false;
        }
        self.copied.store(sequence, Ordering::Release);
        true
    }
    /// Mark immediately before Channel::send. A legitimate ACK may arrive
    /// during that call; ACKs before this phase cannot acknowledge any metadata.
    pub fn begin_send(&self, sequence: u64) -> bool {
        self.is_current(sequence)
            && self.copied.load(Ordering::Acquire) == sequence
            && self
                .sending
                .compare_exchange(sequence - 1, sequence, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }
    pub fn finish_send(&self, sequence: u64, sent_at: Duration) -> bool {
        if !self.is_current(sequence)
            || self.sending.load(Ordering::Acquire) != sequence
            || self.sent.load(Ordering::Acquire) == sequence
        {
            return false;
        }
        self.actual_sent_ns.store(
            u64::try_from(sent_at.as_nanos()).unwrap_or(u64::MAX),
            Ordering::Relaxed,
        );
        self.sent.store(sequence, Ordering::Release);
        true
    }
    fn actual_sent_at(&self, sequence: u64) -> Option<Duration> {
        (sequence != 0
            && self.sent.load(Ordering::Acquire) == sequence
            && self.is_current(sequence))
        .then(|| Duration::from_nanos(self.actual_sent_ns.load(Ordering::Relaxed)))
    }
    pub fn ack(&self, sequence: u64) -> bool {
        sequence != 0
            && self.sending.load(Ordering::Acquire) == sequence
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
pub struct ReservedFrame {
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub captured_at: Duration,
}
#[derive(Clone, Copy, Debug)]
pub struct ReadySend {
    pub sequence: u64,
    pub fps: Option<f64>,
}
#[derive(Default)]
pub struct FramePipeline {
    prepared: Option<Prepared>,
    last_capture: Option<Duration>,
    last_reservation: Option<Duration>,
    sequence: u64,
    send_due: Option<Duration>,
    send_queued: bool,
    observed_sent: u64,
    rate_start: Option<Duration>,
    rate_count: u64,
    fps: Option<f64>,
}
impl FramePipeline {
    fn observe_sent(&mut self, lease: &FrameLease) {
        self.observe_confirmed_send(lease.actual_sent_at(self.sequence));
    }
    fn observe_confirmed_send(&mut self, sent: Option<Duration>) {
        if self.observed_sent == self.sequence {
            return;
        }
        let Some(sent) = sent else {
            return;
        };
        self.observed_sent = self.sequence;
        if let Some(at) = self.rate_start {
            self.rate_count += 1;
            let elapsed = sent.saturating_sub(at);
            if elapsed >= Duration::from_secs(1) {
                self.fps = Some(self.rate_count as f64 / elapsed.as_secs_f64());
                self.rate_start = Some(sent);
                self.rate_count = 0;
            }
        } else {
            self.rate_start = Some(sent);
        }
    }
    fn discard_invalid(&mut self, now: Duration, epoch: ProfileEpoch, lease: &FrameLease) {
        // Retain one stale slot under backpressure, without repeating GPU reads.
        if self.prepared.is_some_and(|f| {
            f.epoch != epoch
                || now < f.captured_at
                || (!lease.waiting() && now - f.captured_at > epoch.settings().period())
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
        !stopped && source_open && !self.expired(now, lease) && self.prepared.is_none()
            && lease.pixels_available()
            // A blocking GPU read must never delay an unpublished frame's due
            // send. It may overlap the lightweight callback only once queued.
            && (self.sequence == 0 || self.send_queued)
            && self.last_capture.is_none_or(|at| now >= at + epoch.settings().period())
    }
    /// Empty pool polls do not consume a successful capture period.
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
    /// Caller holds the profile-command mutex throughout epoch validation and
    /// reservation. This commits one in-flight frame, even before publication.
    pub fn reserve_copy(
        &mut self,
        now: Duration,
        epoch: ProfileEpoch,
        lease: &FrameLease,
        source_open: bool,
        stopped: bool,
    ) -> Result<Option<ReservedFrame>, String> {
        let previous_sent = lease.actual_sent_at(self.sequence);
        self.reserve_with_send_snapshot(now, epoch, lease, source_open, stopped, previous_sent)
    }
    fn reserve_with_send_snapshot(
        &mut self,
        now: Duration,
        epoch: ProfileEpoch,
        lease: &FrameLease,
        source_open: bool,
        stopped: bool,
        previous_sent: Option<Duration>,
    ) -> Result<Option<ReservedFrame>, String> {
        self.discard_invalid(now, epoch, lease);
        if stopped || !source_open {
            self.prepared = None;
            return Ok(None);
        }
        if self.expired(now, lease) {
            return Err("A prévia da captura deixou de responder.".into());
        }
        // The UI may finish Sending between this snapshot and lease.reserve.
        // A missing prior completion must force a retry, never due=now. Once
        // confirmed, its time is immutable until this sole worker reserves.
        if self.sequence != 0 && previous_sent.is_none() {
            return Ok(None);
        }
        self.observe_confirmed_send(previous_sent);
        let Some(frame) = self.prepared else {
            return Ok(None);
        };
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
        self.send_due = Some(previous_sent.map_or(now, |sent| sent + epoch.settings().period()));
        self.send_queued = false;
        Ok(Some(ReservedFrame {
            sequence,
            width: frame.width,
            height: frame.height,
            captured_at: frame.captured_at,
        }))
    }
    /// Pump before source-close/error handling and before any GPU readback.
    /// Once committed, an unpublished frame must reach its send/ACK or watchdog.
    pub fn queue_send(
        &mut self,
        now: Duration,
        lease: &FrameLease,
    ) -> Result<Option<ReadySend>, String> {
        self.observe_sent(lease);
        if self.expired(now, lease) {
            return Err("A prévia da captura deixou de responder.".into());
        }
        if self.send_queued
            || !lease.pixels_available()
            || self.send_due.is_none_or(|due| now < due)
        {
            return Ok(None);
        }
        self.send_queued = true;
        Ok(Some(ReadySend {
            sequence: self.sequence,
            fps: self.fps,
        }))
    }
    /// Reservation-origin watchdog covers UI copy queue, the due wait, metadata
    /// queue and JS ACK. Copy/send completion never renews those five seconds.
    pub fn expired(&self, now: Duration, lease: &FrameLease) -> bool {
        self.last_reservation.is_some_and(|at| {
            (lease.waiting() && now.saturating_sub(at) > Duration::from_secs(5))
                || lease
                    .actual_sent_at(self.sequence)
                    .is_some_and(|sent| sent.saturating_sub(at) > Duration::from_secs(5))
        })
    }
    pub fn wait(&self, now: Duration, epoch: ProfileEpoch, lease: &FrameLease) -> Duration {
        if self.sequence != 0 && !self.send_queued {
            return if lease.pixels_available() {
                self.send_due
                    .unwrap()
                    .saturating_sub(now)
                    .max(Duration::from_micros(500))
            } else {
                Duration::from_micros(500)
            };
        }
        if lease.waiting() || self.prepared.is_some() {
            return Duration::from_micros(500);
        }
        self.last_capture.map_or(Duration::from_millis(1), |at| {
            (at + epoch.settings().period())
                .saturating_sub(now)
                .max(Duration::from_micros(500))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }
    fn epoch() -> ProfileEpoch {
        ProfileEpoch::new(Profile {
            height: 1440,
            fps: 60,
        })
        .unwrap()
    }
    fn capture(p: &mut FramePipeline, l: &FrameLease, at: u64, e: ProfileEpoch) {
        p.captured(ms(at), ms(at + 4), 2560, 1440, e, l).unwrap();
    }
    fn reserve(p: &mut FramePipeline, l: &FrameLease, at: u64, e: ProfileEpoch) -> ReservedFrame {
        p.reserve_copy(ms(at), e, l, true, false).unwrap().unwrap()
    }
    fn copy(l: &FrameLease, f: ReservedFrame) {
        assert!(l.finish_copy(f.sequence));
    }
    fn send(p: &mut FramePipeline, l: &FrameLease, at: Duration) -> ReadySend {
        let s = p.queue_send(at, l).unwrap().unwrap();
        assert!(l.begin_send(s.sequence));
        assert!(l.finish_send(s.sequence, at));
        s
    }
    #[test]
    fn ack_before_copy_or_publication_is_ignored_and_cannot_free_either_buffer() {
        let (mut p, l, e) = (FramePipeline::default(), FrameLease::default(), epoch());
        capture(&mut p, &l, 0, e);
        let a = reserve(&mut p, &l, 4, e);
        assert!(!l.ack(a.sequence));
        assert!(!l.begin_send(a.sequence));
        assert!(!l.pixels_available());
        assert!(!p.can_capture(ms(20), e, &l, true, false));
        copy(&l, a);
        assert!(!l.ack(a.sequence));
        assert_eq!(l.pending_sequence(), a.sequence);
        assert!(l.waiting());
        assert!(!p.can_capture(ms(20), e, &l, true, false));
        assert!(!l.begin_send(a.sequence + 1));
        let a = send(&mut p, &l, ms(20));
        assert!(l.ack(a.sequence));
        assert!(!l.waiting());
    }
    #[test]
    fn ack_during_send_is_accepted_but_shared_waits_for_its_return() {
        let (mut p, l, e) = (FramePipeline::default(), FrameLease::default(), epoch());
        capture(&mut p, &l, 0, e);
        let a = reserve(&mut p, &l, 4, e);
        copy(&l, a);
        p.queue_send(ms(4), &l).unwrap().unwrap();
        assert!(l.begin_send(a.sequence));
        assert!(l.ack(a.sequence));
        assert!(l.waiting());
        assert!(!l.reserve(a.sequence + 1));
        capture(&mut p, &l, 17, e);
        assert!(p
            .reserve_copy(ms(21), e, &l, true, false)
            .unwrap()
            .is_none());
        assert!(l.finish_send(a.sequence, ms(22)));
        assert!(!l.waiting());
        let b = reserve(&mut p, &l, 22, e);
        assert_eq!(b.sequence, 2);
        assert!(!l.ack(a.sequence));
        assert!(!l.finish_copy(a.sequence));
        assert!(!l.finish_send(a.sequence, ms(9999)));
    }
    #[test]
    fn completion_after_the_send_snapshot_forces_retry_without_losing_fps_or_pacing() {
        let (mut p, l, e) = (FramePipeline::default(), FrameLease::default(), epoch());
        capture(&mut p, &l, 0, e);
        let a = reserve(&mut p, &l, 4, e);
        copy(&l, a);
        p.queue_send(ms(4), &l).unwrap().unwrap();
        assert!(l.begin_send(a.sequence));
        assert!(l.ack(a.sequence));
        capture(&mut p, &l, 17, e);
        let before_completion = l.actual_sent_at(a.sequence);
        assert_eq!(before_completion, None);
        assert!(l.finish_send(a.sequence, ms(21)));
        // Production's commit must reject the snapshot acquired while A was
        // still Sending, even though the lease is now otherwise reusable.
        assert!(p
            .reserve_with_send_snapshot(ms(21), e, &l, true, false, before_completion)
            .unwrap()
            .is_none());
        assert_eq!(p.rate_start, None);
        let b = reserve(&mut p, &l, 21, e);
        assert_eq!(p.rate_start, Some(ms(21)));
        assert_eq!(p.observed_sent, a.sequence);
        copy(&l, b);
        assert!(p.queue_send(ms(21), &l).unwrap().is_none());
        assert_eq!(
            send(&mut p, &l, ms(21) + e.settings().period()).sequence,
            b.sequence
        );
    }
    #[test]
    fn copy_is_early_and_actual_ui_metadata_sends_stay_one_period_apart() {
        let (mut p, l, e) = (FramePipeline::default(), FrameLease::default(), epoch());
        capture(&mut p, &l, 0, e);
        let a = reserve(&mut p, &l, 4, e);
        copy(&l, a);
        send(&mut p, &l, ms(100));
        l.ack(a.sequence);
        capture(&mut p, &l, 101, e);
        let b = reserve(&mut p, &l, 105, e);
        copy(&l, b);
        assert!(p.queue_send(ms(109), &l).unwrap().is_none());
        assert!(!l.ack(b.sequence));
        let due = ms(100) + e.settings().period();
        assert_eq!(p.wait(ms(109), e, &l), due - ms(109));
        assert!(p
            .queue_send(due - Duration::from_nanos(1), &l)
            .unwrap()
            .is_none());
        assert_eq!(send(&mut p, &l, due).sequence, b.sequence);
        assert_eq!(b.captured_at, ms(105));
    }
    #[test]
    fn no_blocking_readback_can_delay_a_copied_unpublished_frame() {
        let (mut p, l, e) = (FramePipeline::default(), FrameLease::default(), epoch());
        capture(&mut p, &l, 0, e);
        let a = reserve(&mut p, &l, 4, e);
        copy(&l, a);
        send(&mut p, &l, ms(100));
        l.ack(a.sequence);
        capture(&mut p, &l, 101, e);
        let b = reserve(&mut p, &l, 105, e);
        copy(&l, b);
        assert!(!p.can_capture(ms(118), e, &l, true, false));
        let due = ms(100) + e.settings().period();
        p.queue_send(due, &l).unwrap().unwrap();
        assert!(p.can_capture(ms(118), e, &l, true, false));
    }
    #[test]
    fn source_close_and_error_still_pump_the_committed_send_before_ack() {
        let (mut p, l, e) = (FramePipeline::default(), FrameLease::default(), epoch());
        capture(&mut p, &l, 0, e);
        let a = reserve(&mut p, &l, 4, e);
        copy(&l, a);
        assert!(p
            .reserve_copy(ms(5), e, &l, false, false)
            .unwrap()
            .is_none());
        assert!(!p.can_capture(ms(17), e, &l, false, false));
        let s = send(&mut p, &l, ms(17));
        assert_eq!(s.sequence, a.sequence);
        assert!(l.waiting());
        assert!(l.ack(a.sequence));
        assert!(!l.waiting());
        capture(&mut p, &l, 34, e);
        assert!(p
            .reserve_copy(ms(38), e, &l, false, false)
            .unwrap()
            .is_none());
        assert_eq!(l.pending_sequence(), 0);
    }
    #[test]
    fn watchdog_covers_ui_copy_due_wait_send_and_js_without_renewal() {
        for phase in 0..4 {
            let (mut p, l, e) = (FramePipeline::default(), FrameLease::default(), epoch());
            capture(&mut p, &l, 0, e);
            let a = reserve(&mut p, &l, 4, e);
            if phase >= 1 {
                copy(&l, a);
            }
            if phase >= 2 {
                p.queue_send(ms(4900), &l).unwrap().unwrap();
                assert!(l.begin_send(a.sequence));
            }
            if phase >= 3 {
                assert!(l.finish_send(a.sequence, ms(4900)));
            }
            assert!(!p.expired(ms(5004), &l));
            assert!(p.expired(ms(5005), &l));
            assert!(p.queue_send(ms(5005), &l).is_err());
        }
    }
    #[test]
    fn late_actual_send_cannot_resurrect_an_expired_lease_even_after_ack() {
        let (mut p, l, e) = (FramePipeline::default(), FrameLease::default(), epoch());
        capture(&mut p, &l, 0, e);
        let a = reserve(&mut p, &l, 4, e);
        copy(&l, a);
        p.queue_send(ms(4), &l).unwrap().unwrap();
        l.begin_send(a.sequence);
        assert!(l.ack(a.sequence));
        assert!(l.finish_send(a.sequence, ms(5005)));
        assert!(p.expired(ms(5005), &l));
        assert!(!p.can_capture(ms(5005), e, &l, true, false));
    }
    #[test]
    fn profile_aba_only_discards_unreserved_pixels_not_committed_frames() {
        let (mut p, l, mut e) = (FramePipeline::default(), FrameLease::default(), epoch());
        capture(&mut p, &l, 0, e);
        let a = reserve(&mut p, &l, 4, e);
        copy(&l, a);
        send(&mut p, &l, ms(4));
        capture(&mut p, &l, 17, e);
        e.replace(Profile {
            height: 720,
            fps: 30,
        })
        .unwrap();
        e.replace(Profile {
            height: 1440,
            fps: 60,
        })
        .unwrap();
        assert!(p
            .reserve_copy(ms(25), e, &l, true, false)
            .unwrap()
            .is_none());
        assert_eq!(l.pending_sequence(), a.sequence);
        l.ack(a.sequence);
        capture(&mut p, &l, 34, e);
        let b = reserve(&mut p, &l, 38, e);
        copy(&l, b);
        e.replace(Profile {
            height: 720,
            fps: 30,
        })
        .unwrap();
        assert_eq!(send(&mut p, &l, ms(38)).sequence, b.sequence);
        assert_eq!((b.width, b.height), (2560, 1440));
        assert_eq!(l.pending_sequence(), b.sequence);
    }
    #[test]
    fn long_backpressure_keeps_one_slot_then_discards_it_before_reserving() {
        let (mut p, l, e) = (FramePipeline::default(), FrameLease::default(), epoch());
        capture(&mut p, &l, 0, e);
        let a = reserve(&mut p, &l, 4, e);
        copy(&l, a);
        send(&mut p, &l, ms(4));
        capture(&mut p, &l, 17, e);
        assert!(!p.can_capture(ms(4000), e, &l, true, false));
        l.ack(a.sequence);
        assert!(p
            .reserve_copy(ms(4000), e, &l, true, false)
            .unwrap()
            .is_none());
        capture(&mut p, &l, 4000, e);
        let b = reserve(&mut p, &l, 4004, e);
        assert_eq!(b.sequence, 2);
        assert_eq!(b.captured_at, ms(4004));
    }
    #[test]
    fn geometry_stop_wrong_ids_and_duplicate_ui_callbacks_fail_closed() {
        let (mut p, l, e) = (FramePipeline::default(), FrameLease::default(), epoch());
        p.captured(ms(0), ms(4), 1280, 720, e, &l).unwrap();
        assert!(p.reserve_copy(ms(4), e, &l, true, true).unwrap().is_none());
        assert_eq!(l.pending_sequence(), 0);
        p.captured(ms(17), ms(21), 1280, 720, e, &l).unwrap();
        let a = reserve(&mut p, &l, 21, e);
        assert_eq!((a.width, a.height), (1280, 720));
        assert!(!l.finish_copy(0));
        assert!(!l.finish_copy(a.sequence + 1));
        copy(&l, a);
        assert!(!l.finish_copy(a.sequence));
        p.queue_send(ms(21), &l).unwrap().unwrap();
        assert!(p.queue_send(ms(21), &l).unwrap().is_none());
        assert!(l.begin_send(a.sequence));
        assert!(!l.begin_send(a.sequence));
        assert!(!l.ack(a.sequence + 1));
        assert!(!l.finish_send(a.sequence + 1, ms(9999)));
        assert!(l.finish_send(a.sequence, ms(21)));
        assert!(!l.finish_send(a.sequence, ms(9999)));
    }
    #[test]
    fn actual_send_pacing_has_no_copy_cost_tax_or_fps_rounding() {
        for fps in [15, 24, 30, 60] {
            let e = ProfileEpoch::new(Profile { height: 1440, fps }).unwrap();
            let period = e.settings().period();
            let (mut p, l) = (FramePipeline::default(), FrameLease::default());
            let mut previous = None;
            let mut measured = None;
            for n in 0..150 {
                let start = period * n;
                p.captured(start, start + ms(4), 2560, 1440, e, &l).unwrap();
                let f = p
                    .reserve_copy(start + ms(4), e, &l, true, false)
                    .unwrap()
                    .unwrap();
                copy(&l, f);
                // UI copy costs 4 ms, but it finishes BEFORE the due send.
                let sent = start + ms(8);
                let s = send(&mut p, &l, sent);
                if let Some(at) = previous {
                    assert_eq!(sent - at, period);
                }
                if let Some(rate) = s.fps {
                    assert!(rate <= f64::from(fps));
                    measured = Some(rate);
                }
                previous = Some(sent);
                l.ack(f.sequence);
                assert!(!p.can_capture(
                    start + period - Duration::from_nanos(1),
                    e,
                    &l,
                    true,
                    false
                ));
            }
            assert!(measured.unwrap() > f64::from(fps) - 0.001);
        }
    }
    #[test]
    fn captures_reservations_and_copies_do_not_inflate_the_real_send_counter() {
        let (mut p, l, e) = (FramePipeline::default(), FrameLease::default(), epoch());
        for n in 0..5 {
            let start = ms(n * 1000);
            p.captured(start, start + ms(4), 2560, 1440, e, &l).unwrap();
            let f = p
                .reserve_copy(start + ms(4), e, &l, true, false)
                .unwrap()
                .unwrap();
            copy(&l, f);
            let s = send(&mut p, &l, start + ms(if n % 2 == 0 { 100 } else { 900 }));
            if n == 2 {
                // Sends at100 and1900ms: the first measured interval is1.8s,
                // even though reservations/copies are exactly one second apart.
                assert_eq!(s.fps, Some(1.0 / 1.8));
            }
            if n == 4 {
                assert_eq!(s.fps, Some(1.0));
            }
            l.ack(f.sequence);
        }
    }
}
