import { describe, expect, it, vi } from "vitest";
import {
  createNativeScreenTrack,
  NativeBufferRouter,
  type NativeCaptureEnvironment,
  type NativeFrame,
  type NativeSharedBufferEvent,
} from "./native-screen";
import {
  applyCaptureConstraints,
  getCaptureSettings,
  releaseCaptureTrack,
} from "./capture-track";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Track extends EventTarget {
  kind = "video";
  readyState = "live";
  enabled = true;
  getSettings = () => ({});
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
}
function fixture() {
  const track = new Track();
  const started = deferred<{
    id: string;
    source_handle: number;
    source_title: string;
    width: number;
    height: number;
    backend: string;
  }>();
  let frame!: (frame: NativeFrame) => void;
  let shared: ((event: NativeSharedBufferEvent) => void) | undefined;
  const writer = {
    write: vi.fn(async (_frame: { close(): void }) => {}),
    abort: vi.fn(async () => {}),
  };
  const env: NativeCaptureEnvironment = {
    nonce: () => "client",
    start: vi.fn((_key, _client, _profile, listener) => {
      frame = listener;
      return started.promise;
    }),
    profile: vi.fn(async (): Promise<[number, number]> => [1280, 720]),
    ack: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    listen: (_client, listener) => {
      shared = listener;
      return () => {
        shared = undefined;
      };
    },
    releaseBuffer: vi.fn(),
    generator: () => ({ track: track as unknown as MediaStreamTrack, writer }),
    frame: vi.fn(() => ({ close: vi.fn() })),
    observe: vi.fn(),
  };
  const meta = (sequence = 1): NativeFrame => ({
    id: "run",
    sequence,
    allocation: 1,
    width: 2,
    height: 2,
    timestamp_us: sequence * 16666,
    fps: 59.8,
    error: null,
  });
  const buffer = (allocation = 1, client = "client") => {
    const pixels = new ArrayBuffer(16);
    const getBuffer = vi.fn(() => pixels);
    shared?.({
      additionalData: { harmony_native_capture: client, allocation },
      getBuffer,
    });
    return { pixels, getBuffer };
  };
  const begin = (signal?: AbortSignal) =>
    createNativeScreenTrack("key", { height: 1440, fps: 60 }, { signal }, env);
  const ready = () =>
    started.resolve({
      id: "run",
      source_handle: 42,
      source_title: "Janela",
      width: 2560,
      height: 1440,
      backend: "native-wgc",
    });
  return {
    env,
    track,
    writer,
    begin,
    ready,
    frame: (value = meta()) => frame(value),
    meta,
    buffer,
    started,
    listening: () => !!shared,
  };
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("adaptador nativo de captura", () => {
  it("aceita quadro antes de start resolver e só ACK depois de consumir/copiar pixels", async () => {
    const f = fixture(),
      write = deferred();
    f.writer.write.mockImplementation(() => write.promise);
    const pending = f.begin();
    const { pixels } = f.buffer();
    f.frame();
    await flush();
    expect(f.env.frame).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({
        format: "BGRX",
        codedWidth: 2,
        codedHeight: 2,
      }),
    );
    expect(vi.mocked(f.env.frame).mock.calls[0][0].buffer).toBe(pixels);
    expect(f.env.ack).not.toHaveBeenCalled();
    f.ready();
    const track = await pending;
    expect(getCaptureSettings(track)).toMatchObject({
      width: 2560,
      height: 1440,
    });
    write.resolve();
    await flush();
    expect(getCaptureSettings(track)).toMatchObject({
      width: 2,
      height: 2,
      frameRate: 59.8,
    });
    expect(f.env.ack).toHaveBeenCalledWith("run", 1);
    expect(
      vi.mocked(f.env.frame).mock.results[0].value.close,
    ).toHaveBeenCalledOnce();
    expect(f.env.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        track,
        label: "native-window:42",
        backend: "native-wgc",
      }),
    );
    releaseCaptureTrack(track);
  });

  it("espera o buffer quando os metadados chegam primeiro e ignora outros clientes", async () => {
    const f = fixture(),
      pending = f.begin();
    f.frame();
    const other = f.buffer(1, "another-client");
    expect(other.getBuffer).not.toHaveBeenCalled();
    expect(f.writer.write).not.toHaveBeenCalled();
    f.buffer();
    f.ready();
    const track = await pending;
    await flush();
    expect(f.writer.write).toHaveBeenCalledOnce();
    releaseCaptureTrack(track);
  });

  it("cancelamento pendente libera buffers e encerra uma resposta tardia", async () => {
    const f = fixture(),
      controller = new AbortController();
    const pending = f.begin(controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    f.buffer();
    controller.abort();
    expect(f.env.stop).toHaveBeenCalledWith("client");
    f.ready();
    await rejection;
    await flush();
    expect(f.env.stop).toHaveBeenCalledWith("run");
    expect(f.env.releaseBuffer).toHaveBeenCalledOnce();
    expect(f.writer.abort).toHaveBeenCalledOnce();
    expect(f.listening()).toBe(false);
    expect(f.env.observe).not.toHaveBeenCalled();
    expect(f.track.stop).toHaveBeenCalledOnce();
  });

  it("libera cada buffer na troca/stop e descarta quadros tardios sem novo ACK", async () => {
    const f = fixture(),
      pending = f.begin();
    const first = f.buffer();
    f.ready();
    const track = await pending;
    const second = f.buffer(2);
    expect(f.env.releaseBuffer).toHaveBeenCalledWith(first.pixels);
    releaseCaptureTrack(track);
    releaseCaptureTrack(track);
    f.frame({ ...f.meta(), allocation: 2 });
    await flush();
    expect(f.env.releaseBuffer).toHaveBeenCalledWith(second.pixels);
    expect(f.env.releaseBuffer).toHaveBeenCalledTimes(2);
    expect(f.env.stop).toHaveBeenCalledOnce();
    expect(f.writer.write).not.toHaveBeenCalled();
    expect(f.env.ack).not.toHaveBeenCalled();
    expect(f.listening()).toBe(false);
  });

  it("revogação/falha encerra a track e avisa o dono pelo evento ended", async () => {
    const f = fixture(),
      pending = f.begin();
    f.ready();
    const track = await pending,
      ended = vi.fn();
    track.addEventListener("ended", ended);
    f.frame({ ...f.meta(), error: "A janela foi fechada." });
    await flush();
    expect(track.readyState).toBe("ended");
    expect(ended).toHaveBeenCalledOnce();
    expect(f.env.stop).toHaveBeenCalledOnce();
    expect(f.listening()).toBe(false);
  });

  it("falha ao escrever libera a cópia e encerra a captura sem ACK", async () => {
    const f = fixture(),
      pending = f.begin();
    f.ready();
    const track = await pending;
    f.writer.write.mockRejectedValueOnce(new Error("decoder"));
    f.buffer();
    f.frame();
    await flush();
    expect(track.readyState).toBe("ended");
    expect(
      vi.mocked(f.env.frame).mock.results[0].value.close,
    ).toHaveBeenCalledOnce();
    expect(f.env.ack).not.toHaveBeenCalled();
    expect(f.env.stop).toHaveBeenCalledOnce();
  });

  it("atualiza limites nativamente e expõe as dimensões retornadas, sem usar settings vazios", async () => {
    const f = fixture(),
      pending = f.begin();
    f.ready();
    const track = await pending;
    let applied = false;
    const changing = applyCaptureConstraints(track, {
      height: { max: 720 },
      width: { max: 1280 },
      frameRate: { max: 30 },
    }).then(() => {
      applied = true;
    });
    await flush();
    expect(f.env.profile).toHaveBeenCalledWith("run", { height: 720, fps: 30 });
    expect(applied).toBe(false);
    f.buffer();
    f.frame();
    await changing;
    expect(track.getSettings()).toEqual({});
    expect(getCaptureSettings(track)).toMatchObject({ width: 2, height: 2 });
    releaseCaptureTrack(track);
  });

  it("aceita o próximo quadro antes da resposta de ACK sem quebrar o backpressure", async () => {
    const f = fixture(),
      pending = f.begin(),
      ack = deferred();
    vi.mocked(f.env.ack).mockImplementationOnce(() => ack.promise);
    f.ready();
    const track = await pending;
    f.buffer();
    f.frame();
    await flush();
    f.frame(f.meta(2));
    await flush();
    expect(f.writer.write).toHaveBeenCalledTimes(2);
    expect(track.readyState).toBe("live");
    ack.resolve();
    releaseCaptureTrack(track);
  });

  it("falha de start encerra recursos locais e não anuncia uma captura", async () => {
    const f = fixture(),
      pending = f.begin();
    const rejection = expect(pending).rejects.toThrow("Permissão negada");
    f.buffer();
    f.started.reject(new Error("Permissão negada"));
    await rejection;
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.env.releaseBuffer).toHaveBeenCalledOnce();
    expect(f.env.observe).not.toHaveBeenCalled();
    expect(f.listening()).toBe(false);
  });

  it("roteia preview/publicação por nonce e libera buffers órfãos tardios", () => {
    let receive!: (event: NativeSharedBufferEvent) => void;
    const webview = {
      addEventListener: (_name: string, listener: typeof receive) => {
        receive = listener;
      },
      removeEventListener: vi.fn(),
      releaseBuffer: vi.fn(),
    };
    const router = new NativeBufferRouter(webview);
    const preview = vi.fn(),
      published = vi.fn();
    const cancel = router.listen("preview", preview);
    router.listen("published", published);
    const pixels = new ArrayBuffer(16);
    const event = {
      additionalData: { harmony_native_capture: "preview", allocation: 1 },
      getBuffer: vi.fn(() => pixels),
    };
    receive(event);
    expect(preview).toHaveBeenCalledWith(event);
    expect(published).not.toHaveBeenCalled();
    expect(webview.releaseBuffer).not.toHaveBeenCalled();
    cancel();
    receive(event);
    expect(webview.releaseBuffer).toHaveBeenCalledWith(pixels);
    receive({
      ...event,
      additionalData: { harmony_native_capture: "published", allocation: 1 },
    });
    expect(published).toHaveBeenCalledOnce();
    expect(webview.releaseBuffer).toHaveBeenCalledOnce();
  });

  it("mantém uma janela estática se o quadro atual já respeita o perfil", async () => {
    const f = fixture(),
      pending = f.begin();
    f.ready();
    const track = await pending;
    f.buffer();
    f.frame();
    await flush();
    await applyCaptureConstraints(track, {
      height: { max: 720 },
      frameRate: { max: 30 },
    });
    expect(getCaptureSettings(track)).toMatchObject({ width: 2, height: 2 });
    releaseCaptureTrack(track);
  });

  it("revogação durante alteração do perfil rejeita a espera e libera os recursos", async () => {
    const controller = new AbortController(),
      capture = fixture(),
      starting = capture.begin(controller.signal);
    capture.ready();
    const track = await starting;
    const changing = applyCaptureConstraints(track, {
      height: { max: 720 },
      frameRate: { max: 30 },
    });
    const rejection = expect(changing).rejects.toMatchObject({
      name: "AbortError",
    });
    await flush();
    controller.abort();
    await rejection;
    expect(capture.track.readyState).toBe("ended");
    expect(capture.env.stop).toHaveBeenCalledOnce();
    expect(capture.writer.abort).toHaveBeenCalledOnce();
    expect(capture.listening()).toBe(false);
  });
});
