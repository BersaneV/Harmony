export type ScreenEncodingSender = Pick<
  RTCRtpSender,
  "getParameters" | "setParameters"
>;

export type ScreenEncoderTweakResult =
  "applied" | "already-applied" | "unsupported" | "ineligible" | "stale";

// The pinned DOM typing does not yet expose these standardized encoding fields.
type ScreenEncoding = RTCRtpEncodingParameters & {
  codec?: Pick<RTCRtpCodecParameters, "mimeType" | "clockRate" | "sdpFmtpLine">;
  scalabilityMode?: string;
};
type ScreenParameters = Omit<RTCRtpSendParameters, "encodings"> & {
  encodings: ScreenEncoding[];
};
const attempts = new WeakMap<
  ScreenEncodingSender,
  { fingerprint: string; unsupported: boolean }
>();

function isVp8(parameters: ScreenParameters): boolean {
  return (
    parameters.encodings.length > 0 &&
    parameters.encodings.every(
      ({ codec }) =>
        codec?.mimeType.toLowerCase() === "video/vp8" &&
        codec.clockRate === 90_000,
    )
  );
}

function fingerprint(parameters: ScreenParameters): string {
  // transactionId changes on reads; caps change during ordinary product use.
  // Neither is evidence that an unsupported optional mode became available.
  return JSON.stringify({
    codecs: parameters.codecs,
    encodings: parameters.encodings.map(({ rid, codec, scalabilityMode }) => ({
      rid,
      codec,
      scalabilityMode,
    })),
  });
}

/** Optional encoder configuration, not a measurement of FPS or encoder cost.
 * Call on the sender's existing serialized negotiation/media queue, after codec
 * selection, separately from required bitrate/FPS/scale operations. `current`
 * must check the operation generation, publication permission and track identity.
 */
export async function tryScreenVp8L1T1(
  sender: ScreenEncodingSender,
  current: () => boolean,
): Promise<ScreenEncoderTweakResult> {
  if (!current()) return "stale";
  let parameters: ScreenParameters;
  try {
    parameters = sender.getParameters() as ScreenParameters;
  } catch {
    return current() ? "unsupported" : "stale";
  }
  if (!current()) return "stale";
  if (!isVp8(parameters)) {
    attempts.delete(sender);
    return "ineligible";
  }
  const before = fingerprint(parameters);
  if (
    parameters.encodings.every(
      ({ scalabilityMode }) => scalabilityMode === "L1T1",
    )
  ) {
    attempts.set(sender, { fingerprint: before, unsupported: false });
    return "already-applied";
  }
  const previous = attempts.get(sender);
  if (previous?.unsupported && previous.fingerprint === before)
    return "unsupported";

  // Preserve the native transaction, codec list and every product cap exactly.
  for (const encoding of parameters.encodings)
    encoding.scalabilityMode = "L1T1";
  if (!current()) return "stale";
  try {
    await sender.setParameters(parameters);
  } catch {
    if (!current()) return "stale";
    attempts.set(sender, { fingerprint: before, unsupported: true });
    return "unsupported";
  }
  if (!current()) return "stale";
  let applied: ScreenParameters;
  try {
    applied = sender.getParameters() as ScreenParameters;
  } catch {
    if (!current()) return "stale";
    attempts.set(sender, { fingerprint: before, unsupported: true });
    return "unsupported";
  }
  if (!current()) return "stale";
  if (!isVp8(applied)) {
    attempts.delete(sender);
    return "ineligible";
  }
  const confirmed = applied.encodings.every(
    ({ scalabilityMode }) => scalabilityMode === "L1T1",
  );
  attempts.set(sender, {
    fingerprint: fingerprint(applied),
    unsupported: !confirmed,
  });
  return confirmed ? "applied" : "unsupported";
}
