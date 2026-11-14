#!/usr/bin/env python3
"""Print whitelisted capacity diagnostics in short public CI log records."""
import json
from pathlib import Path
import sys


def select(value, keys):
    return {key: value[key] for key in keys if key in value}


def emit(kind, value):
    record = json.dumps({"kind": kind, **value}, separators=(",", ":"))
    if len(record.encode()) > 4000:
        raise ValueError("Capacity diagnostic record exceeds the public log budget")
    print(record, flush=True)


def main():
    path = Path(sys.argv[1])
    if not path.is_file():
        emit("capacity_report", {"status": "NOT_RUN", "report_present": False})
        return
    result = json.loads(path.read_text())
    emit("capacity_report", {**select(result, (
        "status", "functional_status", "quality_status", "moderation_status", "error",
    )), "requested": select(result.get("requested") or {}, (
        "seconds", "settling_seconds", "height", "width", "fps", "minimum_average_fps", "bitrate_per_viewer",
        "minimum_nonconcealed_audio_wall_ratio", "maximum_audio_concealment_ratio", "minimum_audio_rms",
    ))})
    stability = result.get("stability") or {}
    emit("stability", select(stability, (
        "duration_seconds", "directed_voice_streams", "pairwise_connections", "spectators",
        "source_average_draw_fps", "native_source_average_preview_fps",
        "min_audio_playback_advance_ratio", "min_nonconcealed_audio_wall_ratio",
        "max_audio_concealment_ratio", "min_audio_rms", "audio_interval_failures",
        "zero_size_intervals", "frozen_intervals",
    )))
    for viewer in stability.get("viewers", []):
        emit("viewer", select(viewer, (
            "receiver", "average_fps", "average_received_fps", "dropped_frames",
            "measurement_seconds", "final_width", "final_height",
        )))
    startup = result.get("startup") or {}
    if startup:
        startup_audio = [a for i in startup.get("intervals", []) for a in i.get("audio", [])]
        emit("startup", {**select(startup, ("state", "requested_seconds", "duration_seconds", "boundary_ready")),
                         "audio_stream_samples": len(startup_audio),
                         "outside_steady_budget_samples": sum(not a.get("within_steady_budget") for a in startup_audio),
                         "minimum_nonconcealed_wall_ratio": min((a["nonconcealed_wall_ratio"] for a in startup_audio if a.get("nonconcealed_wall_ratio") is not None), default=None),
                         "maximum_concealment_ratio": max((a["concealment_ratio"] for a in startup_audio if a.get("concealment_ratio") is not None), default=None),
                         "minimum_rms": min((a["rms"] for a in startup_audio if a.get("rms") is not None), default=None)})
        for receiver in range(1, 8):
            screens = [{"elapsed_seconds": i["elapsed_seconds"], **s}
                       for i in startup.get("intervals", []) for s in i.get("screens", []) if s.get("receiver") == receiver]
            exact = [s for s in screens if s.get("width") == result["requested"]["width"] and s.get("height") == result["requested"]["height"]]
            emit("startup_viewer", {"receiver": receiver, "observed_intervals": len(screens), "exact_size_intervals": len(exact),
                                    "first_exact_elapsed_seconds": exact[0]["elapsed_seconds"] if exact else None,
                                    "first_size": select(screens[0], ("width", "height")) if screens else None,
                                    "final_size": select(screens[-1], ("width", "height")) if screens else None,
                                    "minimum_fps": min((s["fps"] for s in screens), default=None)})
    phases = [("steady", result.get("intervals", []), "pass")]
    if startup:
        phases.insert(0, ("startup", startup.get("intervals", []), "within_steady_budget"))
    for phase, intervals, budget_key in phases:
        for receiver in range(8):
            failures = [
                {"elapsed_seconds": interval.get("elapsed_seconds"), **select(audio, (
                    "receiver", "sender", "source", "wall_seconds", "stats_seconds", "duration_seconds", "samples",
                    "concealed_samples", "duration_wall_ratio", "concealment_ratio", "nonconcealed_wall_ratio",
                    "rms", "bytes_received", "packets_received", "pass", "within_steady_budget",
                ))}
                for interval in intervals for audio in interval.get("audio", [])
                if audio.get("receiver") == receiver and not audio.get(budget_key)
            ]
            # First failures expose startup; the worst exposes later starvation.
            selected = failures[:3]
            if failures:
                worst = min(failures, key=lambda a: a.get("nonconcealed_wall_ratio") or 0)
                if worst not in selected:
                    selected.append(worst)
            failed_times = sorted({a["elapsed_seconds"] for a in failures})
            observed = sum(a.get("receiver") == receiver for i in intervals for a in i.get("audio", []))
            emit("audio_intervals", {"phase": phase, "receiver": receiver, "observed_stream_samples": observed, "failed_stream_samples": len(failures),
                                     "failed_measurement_intervals": len(failed_times),
                                     "failed_elapsed_seconds": failed_times[:12], "elapsed_list_truncated": len(failed_times) > 12,
                                     "examples": selected})
    for action in result.get("moderation", []):
        emit("moderation", select(action, ("name", "elapsed_ms")))
    clients = (result.get("samples") or [{}])[-1].get("clients", []) or result.get("failure") or []
    for index, client in enumerate(clients):
        if not isinstance(client, dict):
            emit("client", {"client": index, "loaded": False})
            continue
        clocks = client.get("audioClocks") or {}
        emit("client", {"client": index, "state": (client.get("snapshot") or {}).get("state"),
                        "audio_clocks": {side: select(clocks.get(side) or {}, ("currentTime", "state", "sampleRate")) for side in ("sender", "analyser")},
                        "source_settings": select(client.get("sourceSettings") or {}, ("width", "height", "frameRate", "aspectRatio")),
                        "source_preview": select(client.get("sourcePreview") or {}, ("frames", "time", "width", "height")),
                        "setup": [select(s, ("stage", "at")) for s in client.get("setup", [])[-3:]],
                        "capture_errors": [select(e, ("kind", "phase", "name")) for e in client.get("captureErrors", [])[-3:]]})
        for peer in client.get("rtp", []):
            # No identifiers, SDP, candidates, addresses, tokens or raw logs.
            for stream in peer.get("rtp", []):
                if stream.get("source") == "screen" and stream.get("direction") == "outbound":
                    emit("screen_encoder", {"client": index, **select(stream, (
                        "codec_mime_type", "framesEncoded", "frameWidth", "frameHeight", "framesPerSecond",
                        "totalEncodeTime", "qualityLimitationReason",
                    )), "quality_limitation_seconds": select(stream.get("qualityLimitationDurations") or {}, ("bandwidth", "cpu", "none", "other")),
                        "media_source": select(stream.get("media_source") or {}, ("kind", "timestamp", "width", "height", "frames", "framesPerSecond"))})
    emit("cleanup", {"clients": [select(c, ("browser", "capture_stopped", "context_disposed")) for c in result.get("cleanup", [])],
                     "profiles_removed": all(h.get("profile_removed") for h in result.get("host_cleanup", [])),
                     "generated_video_removed": result.get("native_media_removed"),
                     "generated_audio_removed": result.get("native_audio_removed")})


if __name__ == "__main__":
    main()
