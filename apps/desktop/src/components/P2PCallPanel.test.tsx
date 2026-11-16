import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CallPeerSnapshot, CallSnapshot } from "../lib/call";
import type { Channel } from "../lib/types";
import P2PCallPanel from "./P2PCallPanel";

const fixture = vi.hoisted(() => ({
  snapshot: undefined as CallSnapshot | undefined,
}));
vi.mock("../lib/call", () => ({
  P2PCall: class {
    get snapshot() {
      return fixture.snapshot!;
    }
  },
}));
vi.mock("../lib/api", () => ({ api: vi.fn(), errorMessage: String }));
const track = {
  kind: "video",
  readyState: "live",
  enabled: true,
  getSettings: () => ({ width: 2560, height: 1440, frameRate: 60 }),
} as unknown as MediaStreamTrack;
const peer = (): CallPeerSnapshot => ({
  peer_id: "remote",
  user_id: "other",
  display_name: "Participante",
  can_publish: true,
  screen_sfu: true,
  media: { microphone: true, camera: false, screen: true, screen_audio: false },
  connection: "connected",
  tracks: { screen: track },
  receiveHeight: 0,
  screenTransport: "sfu",
  screenIceRttMs: 41,
  error: "",
  stats: {
    iceRttMs: 9,
    route: "direct",
    sent: {},
    received: {
      screen: {
        bitrate: 3_000_000,
        width: 2560,
        height: 1440,
        fps: 57.7,
        audioLevel: null,
        packetsLost: 0,
        jitterMs: 1,
      },
    },
  },
});
function render() {
  return renderToStaticMarkup(
    <P2PCallPanel
      channel={
        {
          id: "channel",
          name: "Chamada",
          effective_permissions: "63",
        } as Channel
      }
      expanded
      onClose={() => {}}
      onExpand={() => {}}
      canModerate={false}
    />,
  );
}
beforeEach(() => {
  fixture.snapshot = {
    state: "connected",
    reason: "",
    self: { ...peer(), peer_id: "local" },
    participants: [peer()],
    localTracks: { screen: track },
    maxVideoBitrate: 32_000_000,
    maxParticipants: 8,
    profile: {
      height: 1440,
      fps: 60,
      bitrate: 16,
      content: "motion",
      audio: false,
    },
    screenUpload: {
      connections: { sfu: 1, p2p: 0 },
      bitrate: 3_000_000,
      maxBitrate: 16_000_000,
      partial: false,
      maxBitratePartial: false,
    },
  };
});
describe("screen transport telemetry in the existing call panel", () => {
  it("renders real SFU resolution/FPS/bitrate, distinct video and voice RTT, and one upstream budget", () => {
    fixture.snapshot!.participants = Array.from({ length: 7 }, (_, index) => ({
      ...peer(),
      peer_id: `peer-${index}`,
    }));
    const html = render();
    expect(html).toContain("2560×1440 · 58 FPS · 3.00 Mb/s");
    expect(html).toContain("Vídeo: 41 ms · Voz: 9 ms");
    expect(html).toContain(
      "Upload de vídeo medido: 3.00 Mb/s · teto dos envios: 16.0 Mb/s · 1 envio compartilhado + 0 diretos",
    );
    expect(html).not.toMatch(/SFU|P2P|ICE|RTT/);
    expect(html).not.toContain("112.0");
    expect(html).not.toContain("Aguardando mídia");
  });
  it("shows unavailable SFU samples without substituting voice RTT or claiming media is waiting", () => {
    const remote = fixture.snapshot!.participants[0];
    remote.stats.received = {};
    remote.screenIceRttMs = null;
    const html = render();
    expect(html).toContain("Vídeo ativo · estatísticas indisponíveis");
    expect(html).toContain("Vídeo: indisponível · Voz: 9 ms");
    expect(html).not.toContain("Aguardando mídia");
  });
  it("labels incomplete upload and cap sums while retaining the independent P2P fallback route", () => {
    fixture.snapshot!.screenUpload = {
      connections: { sfu: 1, p2p: 1 },
      bitrate: 3_500_000,
      maxBitrate: 16_000_000,
      partial: true,
      maxBitratePartial: true,
    };
    const remote = fixture.snapshot!.participants[0];
    remote.screenTransport = "p2p";
    remote.screenIceRttMs = 9;
    const html = render();
    expect(html).toContain(
      "3.50 Mb/s (parcial) · teto dos envios: 16.0 Mb/s (parcial) · 1 envio compartilhado + 1 direto",
    );
    expect(html).toContain("Vídeo: 9 ms · Voz: 9 ms");
    expect(html).not.toContain("Vídeo: 41 ms");
  });
});
