#!/usr/bin/env python3
"""Local RTC ACL regression using official SDK peers and synthetic audio/video.

Use an isolated venv with livekit==1.2.1 and livekit-api==1.2.2, then run via
scripts/with-env.py. Only loopback services are accepted. Creates disposable
users/community, revokes/restores PUBLISH and revokes CONNECT during a call.
No microphone, screen, camera or speakers are used. This is not Windows or
public TURN certification. Dependencies remain optional for unittest discovery.
"""
import array
import asyncio
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import logging
import math
import os
from pathlib import Path
import platform
import secrets
import sys
import time
from urllib.parse import urlsplit

logging.basicConfig(level=logging.CRITICAL)
logging.getLogger("livekit").setLevel(logging.CRITICAL)
ROOT = Path(__file__).resolve().parents[1]
REPORT = {"status": "RUNNING", "stage": "configuration", "checks": [], "scope": "local synthetic SDK peers; no device capture, Windows or public TURN validation"}
REPORT["started_at_utc"] = datetime.now(timezone.utc).isoformat()
REPORT["test_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def check(value, label):
    if not value:
        raise AssertionError(label)
    REPORT["checks"].append(label)


async def until(predicate, label, seconds=20):
    end = time.monotonic() + seconds
    while not predicate() and time.monotonic() < end:
        await asyncio.sleep(0.05)
    check(predicate(), label)


async def main():
    # Standalone integration dependencies stay optional for unittest discovery.
    import aiohttp
    from livekit import api, rtc

    origin = os.environ.get("HARMONY_TEST_URL", "http://127.0.0.1:8080").rstrip("/")
    gateway = os.environ.get("HARMONY_MEDIA_GATEWAY", "http://127.0.0.1:18082").rstrip("/")
    lk_origin = os.environ.get("LIVEKIT_API_URL", "http://127.0.0.1:7880")
    for url in (origin, gateway, lk_origin):
        check(urlsplit(url).hostname in ("127.0.0.1", "localhost", "::1"), "service restricted to loopback")
    needed = ("HARMONY_BOOTSTRAP_USERNAME", "HARMONY_BOOTSTRAP_PASSWORD", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET")
    check(all(os.environ.get(name) for name in needed), "required credentials supplied in memory")
    REPORT["platform"] = f"{platform.system()} {platform.machine()}"
    REPORT["sdk"] = {name: importlib.metadata.version(name) for name in ("livekit", "livekit-api")}
    publisher, receiver, retry = rtc.Room(), rtc.Room(), rtc.Room()
    control = api.LiveKitAPI(url=lk_origin, api_key=os.environ["LIVEKIT_API_KEY"], api_secret=os.environ["LIVEKIT_API_SECRET"])
    tasks, streams = [], []
    counts = {"audio_frames": 0, "video_frames": 0, "audio_peak": 0}
    colors = set()
    dimensions = set()
    disconnected = asyncio.Event()
    peer_left = asyncio.Event()
    publisher.on("disconnected", lambda reason: disconnected.set())
    receiver.on("participant_disconnected", lambda participant: peer_left.set())

    async def receive_audio(track):
        stream = rtc.AudioStream(track, sample_rate=48000, num_channels=1)
        streams.append(stream)
        async for event in stream:
            counts["audio_frames"] += 1
            counts["audio_peak"] = max(counts["audio_peak"], max((abs(value) for value in event.frame.data), default=0))

    async def receive_video(track):
        stream = rtc.VideoStream(track)
        streams.append(stream)
        async for event in stream:
            counts["video_frames"] += 1
            dimensions.add((event.frame.width, event.frame.height))
            rgba = event.frame.convert(rtc.VideoBufferType.RGBA)
            colors.add(tuple(rgba.data[:3]))

    @receiver.on("track_subscribed")
    def subscribed(track, publication, participant):
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            tasks.append(asyncio.create_task(receive_audio(track)))
        elif track.kind == rtc.TrackKind.KIND_VIDEO:
            tasks.append(asyncio.create_task(receive_video(track)))

    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as http:
            async def post(path, body, token=None):
                headers = {"Authorization": "Bearer " + token} if token else {}
                async with http.post(origin + "/api" + path, json=body, headers=headers) as response:
                    if response.status not in (200, 201, 204):
                        raise RuntimeError(f"Harmony HTTP {response.status}")
                    return await response.json() if response.status != 204 else None

            REPORT["stage"] = "create disposable peers"
            admin = await post("/auth/login", {"username": os.environ["HARMONY_BOOTSTRAP_USERNAME"], "password": os.environ["HARMONY_BOOTSTRAP_PASSWORD"]})
            invite = await post("/admin/invites", {"max_uses": 2, "expires_hours": 1}, admin["access_token"])
            users = []
            suffix = secrets.token_hex(4)
            for index in range(2):
                users.append(await post("/auth/register", {"username": f"rtc_{suffix}_{index}", "display_name": "Synthetic RTC test", "password": secrets.token_urlsafe(24), "invite_token": invite["token"]}))
            first, second = users
            guild = await post("/guilds", {"name": "Synthetic ACL RTC integration"}, second["access_token"])
            invite = await post(f"/guilds/{guild['id']}/invites", {"max_uses": 1, "expires_hours": 1}, second["access_token"])
            await post("/invites/accept", {"token": invite["token"]}, first["access_token"])
            channel = await post(f"/guilds/{guild['id']}/channels", {"name": "Synthetic media", "kind": "voice"}, second["access_token"])
            media = [await post(f"/channels/{channel['id']}/media-token", {}, user["access_token"]) for user in users]
            issued = time.monotonic()
            websocket = gateway.replace("http://", "ws://", 1).replace("https://", "wss://", 1)
            REPORT["stage"] = "connect real RTC peers"
            await asyncio.wait_for(receiver.connect(websocket, media[1]["token"]), 25)
            await asyncio.wait_for(publisher.connect(websocket, media[0]["token"]), 25)
            check(publisher.isconnected() and receiver.isconnected(), "two SDK peers RTC connected through Caddy")
            members = await control.room.list_participants(api.ListParticipantsRequest(room=media[0]["room"]))
            check(len(members.participants) == 2, "LiveKit lists both participants")

            REPORT["stage"] = "publish and receive synthetic media"
            audio_source = rtc.AudioSource(48000, 1)
            # Align synthetic dimensions to codec blocks; 90px can become 88px.
            video_source = rtc.VideoSource(160, 96)
            audio_track = rtc.LocalAudioTrack.create_audio_track("synthetic-sine", audio_source)
            video_track = rtc.LocalVideoTrack.create_video_track("synthetic-color", video_source)
            await publisher.local_participant.publish_track(audio_track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
            await publisher.local_participant.publish_track(video_track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_SCREENSHARE, simulcast=False,
                video_codec=rtc.VideoCodec.VP8, video_encoding=rtc.VideoEncoding(max_framerate=15, max_bitrate=200000)))

            async def send_audio():
                offset = 0
                while not disconnected.is_set():
                    samples = array.array("h", (int(6000 * math.sin(2 * math.pi * 440 * (offset + i) / 48000)) for i in range(480)))
                    await audio_source.capture_frame(rtc.AudioFrame(samples.tobytes(), 48000, 1, 480))
                    offset += 480
                    await asyncio.sleep(0.01)

            async def send_video():
                index = 0
                while not disconnected.is_set():
                    pixel = bytes((64 + index % 128, 64, 160, 255))
                    video_source.capture_frame(rtc.VideoFrame(160, 96, rtc.VideoBufferType.RGBA, pixel * 160 * 96))
                    index += 5
                    await asyncio.sleep(1 / 15)

            tasks.extend([asyncio.create_task(send_audio()), asyncio.create_task(send_video())])
            await until(lambda: counts["audio_frames"] >= 50 and counts["video_frames"] >= 10, "receiver obtains audio and video frames")
            check(counts["audio_peak"] > 100, "received audio is non-silent synthetic tone")
            REPORT["decoded_video_observed"] = {"dimensions": sorted(dimensions), "distinct_colors": len(colors)}
            check(len(colors) >= 2 and dimensions == {(160, 96)}, "received video changes color at expected dimensions")
            REPORT["received_before_acl"] = dict(counts)
            REPORT["video"] = {"dimensions": [160, 96], "requested_fps": 15, "requested_max_bitrate": 200000, "codec": "VP8"}

            async def override(deny):
                async with http.put(origin + f"/api/channels/{channel['id']}/permissions", json={"role_id": None, "allow": "0", "deny": str(deny)}, headers={"Authorization": "Bearer " + second["access_token"]}) as response:
                    check(response.status == 204, "owner updates channel override")

            async def wait_publish(expected):
                until_at = time.monotonic() + 15
                while time.monotonic() < until_at:
                    response = await control.room.list_participants(api.ListParticipantsRequest(room=media[0]["room"]))
                    current = next((p for p in response.participants if p.identity == publisher.local_participant.identity), None)
                    if current and current.permission.can_publish == expected:
                        check(True, "LiveKit canPublish reflects ACL " + str(expected))
                        return
                    await asyncio.sleep(0.2)
                check(False, "LiveKit canPublish update timeout")

            REPORT["stage"] = "revoke PUBLISH mid-call"
            await override(32)
            await wait_publish(False)
            check(publisher.isconnected() and receiver.isconnected(), "PUBLISH revocation preserves RTC connections")
            await asyncio.sleep(1)
            paused = counts["audio_frames"], counts["video_frames"]
            await asyncio.sleep(1)
            check(paused == (counts["audio_frames"], counts["video_frames"]), "PUBLISH revocation stops delivered audio/video")
            REPORT["stage"] = "restore PUBLISH mid-call"
            await override(0)
            await wait_publish(True)
            audio_track = rtc.LocalAudioTrack.create_audio_track("synthetic-sine-restored", audio_source)
            video_track = rtc.LocalVideoTrack.create_video_track("synthetic-color-restored", video_source)
            await publisher.local_participant.publish_track(audio_track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
            await publisher.local_participant.publish_track(video_track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_SCREENSHARE, simulcast=False, video_codec=rtc.VideoCodec.VP8, video_encoding=rtc.VideoEncoding(max_framerate=15,max_bitrate=200000)))
            await until(lambda: counts["audio_frames"] >= paused[0]+20 and counts["video_frames"] >= paused[1]+5, "PUBLISH restoration permits fresh audio/video tracks")
            REPORT["stage"] = "revoke CONNECT mid-call"
            reset_at = time.monotonic()
            await override(16)
            await until(disconnected.is_set, "CONNECT revocation disconnects active publisher SDK")
            await until(peer_left.is_set, "receiver observes publisher departure")
            REPORT["connect_revocation_disconnect_seconds"] = round(time.monotonic() - reset_at, 3)
            members = await control.room.list_participants(api.ListParticipantsRequest(room=media[0]["room"]))
            check(len(members.participants) == 1 and members.participants[0].identity == receiver.local_participant.identity,
                  "LiveKit retains only receiver after CONNECT revocation")
            check(receiver.isconnected(), "receiver remains RTC connected")
            await asyncio.sleep(1)
            after = counts["audio_frames"], counts["video_frames"]
            await asyncio.sleep(1)
            check(after == (counts["audio_frames"], counts["video_frames"]), "decoded media stops after publisher removal")
            check(time.monotonic() - issued < 60, "old-token rejection checked before original expiry")
            async with http.get(gateway + "/rtc/validate", params={"access_token": media[0]["token"]}) as response:
                check(response.status in (401, 403), "Caddy rejects still-unexpired revoked token")
            REPORT["stage"] = "reject revoked SDK reconnect"
            rejected = False
            try:
                await asyncio.wait_for(retry.connect(websocket, media[0]["token"]), 12)
            except rtc.ConnectError:
                rejected = True
            check(rejected and not retry.isconnected(), "official SDK cannot reconnect with revoked token")
            REPORT["status"], REPORT["stage"] = "PASS", "complete"
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for stream in streams:
            await stream.aclose()
        await asyncio.gather(*(room.disconnect() for room in (publisher, receiver, retry)), return_exceptions=True)
        await control.aclose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        # Avoid printing an SDK exception containing credentials or a token URL.
        REPORT["status"], REPORT["error_type"] = "FAIL", type(error).__name__
    output = ROOT / ".local/qa-media"
    output.mkdir(parents=True, exist_ok=True)
    (output / "acl-result.json").write_text(json.dumps(REPORT, indent=2) + "\n")
    print(json.dumps(REPORT, indent=2))
    sys.exit(0 if REPORT["status"] == "PASS" else 1)
