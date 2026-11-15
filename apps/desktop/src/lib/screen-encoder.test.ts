import { describe, expect, it } from "vitest";
import { tryScreenVp8L1T1, type ScreenEncodingSender } from "./screen-encoder";

type Encoding = RTCRtpEncodingParameters & {
  codec?: Pick<RTCRtpCodecParameters, "mimeType" | "clockRate" | "sdpFmtpLine">;
  scalabilityMode?: string;
};
type Parameters = RTCRtpSendParameters & { encodings: Encoding[] };

function parameters(codec = "video/VP8"): Parameters {
  return {
    transactionId: "native-transaction",
    codecs: [
      { mimeType: codec, clockRate: 90_000, payloadType: 96 },
      {
        mimeType: "video/rtx",
        clockRate: 90_000,
        payloadType: 97,
        sdpFmtpLine: "apt=96",
      },
    ],
    headerExtensions: [{ id: 3, uri: "urn:ietf:params:rtp-hdrext:sdes:mid" }],
    rtcp: { cname: "native-cname", reducedSize: true },
    degradationPreference: "maintain-resolution",
    encodings: [
      {
        active: true,
        rid: "screen",
        codec: { mimeType: codec, clockRate: 90_000 },
        maxBitrate: 16_000_000,
        maxFramerate: 60,
        scaleResolutionDownBy: 4,
        scalabilityMode: "L1T3",
      },
    ],
  };
}

class Sender implements ScreenEncodingSender {
  current = parameters();
  writes: Parameters[] = [];
  beforeSet?: () => Promise<void>;
  reject = false;
  ignore = false;
  reads = 0;
  getParameters(): RTCRtpSendParameters {
    ++this.reads;
    return structuredClone(this.current);
  }
  async setParameters(value: RTCRtpSendParameters): Promise<void> {
    this.writes.push(structuredClone(value) as Parameters);
    await this.beforeSet?.();
    if (this.reject)
      throw new DOMException("Unsupported encoding", "OperationError");
    if (!this.ignore) this.current = structuredClone(value) as Parameters;
  }
}

describe("optional VP8 screen encoder tweak", () => {
  it("changes only the scalability mode and confirms native parameters", async () => {
    const sender = new Sender();
    const before = structuredClone(sender.current);
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("applied");
    const expected = structuredClone(before);
    expected.encodings[0].scalabilityMode = "L1T1";
    expect(sender.writes).toEqual([expected]);
    expect(sender.current).toEqual(expected);
    expect(sender.reads).toBe(2);
  });

  it("does not repeat a confirmed tweak, but reapplies it after native reset", async () => {
    const sender = new Sender();
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("applied");
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("already-applied");
    expect(sender.writes).toHaveLength(1);
    sender.current.encodings[0].scalabilityMode = "L1T3";
    sender.current.transactionId = "after-sdp";
    sender.current.encodings[0].maxBitrate = 2_000_000;
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("applied");
    expect(sender.writes).toHaveLength(2);
    expect(sender.writes[1].transactionId).toBe("after-sdp");
    expect(sender.writes[1].encodings[0].maxBitrate).toBe(2_000_000);
  });

  it.each(["video/H264", "video/VP9", "video/AV1"])(
    "does not touch the negotiated %s encoder",
    async (codec) => {
      const sender = new Sender();
      sender.current = parameters(codec);
      expect(await tryScreenVp8L1T1(sender, () => true)).toBe("ineligible");
      expect(sender.writes).toEqual([]);
    },
  );

  it("does not infer the selected codec from the negotiated codec list", async () => {
    const sender = new Sender();
    delete sender.current.encodings[0].codec;
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("ineligible");
    sender.current.encodings = [];
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("ineligible");
    expect(sender.writes).toEqual([]);
  });

  it("requires every encoding to confirm VP8", async () => {
    const sender = new Sender();
    sender.current.encodings.push({
      codec: { mimeType: "video/H264", clockRate: 90_000 },
    });
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("ineligible");
    expect(sender.writes).toEqual([]);
  });

  it("caches a rejected optional tweak without retrying on cap or transaction changes", async () => {
    const sender = new Sender();
    sender.reject = true;
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("unsupported");
    sender.current.transactionId = "next-read";
    sender.current.encodings[0].maxBitrate = 1_000_000;
    sender.current.encodings[0].scaleResolutionDownBy = 8;
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("unsupported");
    expect(sender.writes).toHaveLength(1);
    expect(sender.current.encodings[0].scalabilityMode).toBe("L1T3");
  });

  it("does not report success when the native implementation ignores the mode", async () => {
    const sender = new Sender();
    sender.ignore = true;
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("unsupported");
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("unsupported");
    expect(sender.writes).toHaveLength(1);
    // A native encoding reset invalidates the failed configuration fingerprint.
    delete sender.current.encodings[0].scalabilityMode;
    sender.ignore = false;
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("applied");
    expect(sender.writes).toHaveLength(2);
  });

  it("does not read or mutate a sender after the permission/generation expires", async () => {
    const sender = new Sender();
    expect(await tryScreenVp8L1T1(sender, () => false)).toBe("stale");
    expect(sender.reads).toBe(0);
    expect(sender.writes).toEqual([]);
  });

  it("discards stale completion without disabling the next valid attempt", async () => {
    const sender = new Sender();
    let current = true;
    sender.reject = true;
    sender.beforeSet = async () => {
      current = false;
    };
    expect(await tryScreenVp8L1T1(sender, () => current)).toBe("stale");
    expect(sender.reads).toBe(1);
    sender.beforeSet = undefined;
    sender.reject = false;
    current = true;
    expect(await tryScreenVp8L1T1(sender, () => current)).toBe("applied");
    expect(sender.writes).toHaveLength(2);
  });

  it("leaves a sender available for required cap updates after rejecting the optional tweak", async () => {
    const sender = new Sender();
    sender.reject = true;
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("unsupported");
    sender.reject = false;
    const caps = sender.getParameters() as Parameters;
    caps.encodings[0].maxBitrate = 500_000;
    caps.encodings[0].scaleResolutionDownBy = 8;
    await sender.setParameters(caps);
    expect(sender.current.encodings[0]).toMatchObject({
      maxBitrate: 500_000,
      scaleResolutionDownBy: 8,
      scalabilityMode: "L1T3",
    });
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("unsupported");
    expect(sender.writes).toHaveLength(2);
  });

  it("checks the guard again after reading native parameters", async () => {
    const sender = new Sender();
    let current = true;
    sender.getParameters = () => {
      current = false;
      return structuredClone(sender.current);
    };
    expect(await tryScreenVp8L1T1(sender, () => current)).toBe("stale");
    expect(sender.writes).toEqual([]);
  });

  it("does not confirm a successful native write after its operation becomes stale", async () => {
    const sender = new Sender();
    let current = true;
    sender.beforeSet = async () => {
      current = false;
    };
    expect(await tryScreenVp8L1T1(sender, () => current)).toBe("stale");
    expect(sender.reads).toBe(1);
    // An in-flight native write cannot be cancelled; the caller still owns
    // detaching the track on revocation. A fresh operation must read it again.
    sender.beforeSet = undefined;
    current = true;
    expect(await tryScreenVp8L1T1(sender, () => current)).toBe(
      "already-applied",
    );
    expect(sender.writes).toHaveLength(1);
  });

  it("keeps unsupported detection local to each sender", async () => {
    const unsupported = new Sender();
    unsupported.reject = true;
    expect(await tryScreenVp8L1T1(unsupported, () => true)).toBe("unsupported");
    const supported = new Sender();
    expect(await tryScreenVp8L1T1(supported, () => true)).toBe("applied");
    expect(supported.writes).toHaveLength(1);
  });

  it("reevaluates optional support after the native encoding was removed", async () => {
    const sender = new Sender();
    sender.reject = true;
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("unsupported");
    sender.current.encodings = [];
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("ineligible");
    sender.current = parameters();
    sender.reject = false;
    expect(await tryScreenVp8L1T1(sender, () => true)).toBe("applied");
    expect(sender.writes).toHaveLength(2);
  });
});
