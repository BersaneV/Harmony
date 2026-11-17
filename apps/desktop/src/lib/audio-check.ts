// Local, temporary audio only. No recording, networking or call publication.
export interface AudioCheckState {
  mode: "microphone" | "output" | null;
  level: number;
  message: string;
}
let active: AudioCheck | null = null;
let muteCall: (() => Promise<void> | void) | null = null;
export const stopAudioChecks = () => active?.stop();
export const microphoneCheckActive = () => active?.mode === "microphone";
export function registerAudioCheckMute(mute: () => Promise<void> | void) {
  muteCall = mute;
  return () => {
    if (muteCall === mute) muteCall = null;
  };
}
export function testTone(): Blob {
  const rate = 48000,
    length = rate,
    buffer = new ArrayBuffer(44 + length * 2),
    v = new DataView(buffer);
  const text = (at: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + length * 2, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const t = i / rate,
      envelope = Math.min(1, t / 0.02, (1 - t) / 0.08);
    v.setInt16(
      44 + i * 2,
      Math.sin(2 * Math.PI * 660 * t) * 0.16 * 32767 * Math.max(0, envelope),
      true,
    );
  }
  return new Blob([buffer], { type: "audio/wav" });
}
export class AudioCheck {
  mode: AudioCheckState["mode"] = null;
  private run = 0;
  private stream?: MediaStream;
  private context?: AudioContext;
  private monitor?: MediaStream;
  private audio?: HTMLAudioElement;
  private url?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private frame = 0;
  constructor(private changed: (state: AudioCheckState) => void) {}
  stop(message = "Teste encerrado.") {
    this.run++;
    clearTimeout(this.timer);
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.monitor?.getTracks().forEach((t) => t.stop());
    this.monitor = undefined;
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
      this.audio.removeAttribute("src");
      this.audio.load();
      this.audio = undefined;
    }
    if (this.context) {
      void this.context.close().catch(() => {});
      this.context = undefined;
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = undefined;
    }
    this.mode = null;
    if (active === this) active = null;
    this.changed({ mode: null, level: 0, message });
  }
  private begin(mode: "microphone" | "output") {
    active?.stop();
    this.stop("");
    active = this;
    this.mode = mode;
    this.changed({
      mode,
      level: 0,
      message:
        mode === "microphone"
          ? "Autorizando microfone…"
          : "Reproduzindo som de teste…",
    });
    return this.run;
  }
  private async output(device: string) {
    const element = new Audio();
    element.volume = 0.5;
    this.audio = element;
    if ("setSinkId" in element) await element.setSinkId(device || "default");
    else if (device && device !== "default") throw new Error("output");
    return element;
  }
  async sound(output: string) {
    const run = this.begin("output");
    try {
      const element = await this.output(output);
      if (run !== this.run) return;
      this.url = URL.createObjectURL(testTone());
      element.src = this.url;
      element.onended = () => {
        if (run === this.run)
          this.stop("O som de teste terminou. Você conseguiu ouvir?");
      };
      await element.play();
      if (run !== this.run) return;
      this.timer = setTimeout(() => this.stop(), 3000);
    } catch {
      if (run === this.run)
        this.stop(
          "Não foi possível tocar na saída escolhida. Confira o dispositivo e o volume.",
        );
    }
  }
  async microphone(input: string, output: string) {
    const run = this.begin("microphone");
    try {
      await muteCall?.();
      if (run !== this.run) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          ...(input ? { deviceId: { exact: input } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (run !== this.run) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      const context = new AudioContext();
      this.context = context;
      await context.resume();
      if (run !== this.run) return;
      const source = context.createMediaStreamSource(stream),
        analyser = context.createAnalyser(),
        destination = context.createMediaStreamDestination();
      this.monitor = destination.stream;
      stream.getAudioTracks()[0]?.addEventListener(
        "ended",
        () => {
          if (run === this.run) this.stop("O microfone foi desconectado.");
        },
        { once: true },
      );
      analyser.fftSize = 1024;
      source.connect(analyser);
      analyser.connect(destination);
      const element = await this.output(output);
      if (run !== this.run) return;
      element.srcObject = destination.stream;
      await element.play();
      if (run !== this.run) return;
      const values = new Float32Array(analyser.fftSize);
      const tick = () => {
        if (run !== this.run) return;
        analyser.getFloatTimeDomainData(values);
        const rms = Math.sqrt(
          values.reduce((n, v) => n + v * v, 0) / values.length,
        );
        this.changed({
          mode: "microphone",
          level: Math.min(100, Math.round(rms * 400)),
          message:
            "Fale para ver o nível e ouvir sua voz. Teste local de até 20 segundos.",
        });
        this.frame = requestAnimationFrame(tick);
      };
      tick();
      this.timer = setTimeout(
        () =>
          this.stop(
            "Teste encerrado. Religue o microfone da chamada quando quiser falar.",
          ),
        20000,
      );
    } catch (e) {
      if (run !== this.run) return;
      const name = e && typeof e === "object" && "name" in e ? e.name : "";
      this.stop(
        name === "NotAllowedError"
          ? "Permita o microfone no aplicativo e nas configurações de privacidade do Windows."
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "O microfone escolhido não está disponível. Selecione outro dispositivo."
            : "Não foi possível testar o microfone ou a saída escolhida. Confira os dispositivos e tente novamente.",
      );
    }
  }
}
