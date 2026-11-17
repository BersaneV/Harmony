using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;
using System.Diagnostics;
using System.Text.Json;

if (!OperatingSystem.IsWindows() || Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true"
    || Environment.GetEnvironmentVariable("GITHUB_REPOSITORY") != "BersaneV/Harmony"
    || Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted")
    throw new InvalidOperationException("Owned disposable GitHub Windows VM required");

void Emit(object value) => Console.WriteLine(JsonSerializer.Serialize(value));
using var devices = new MMDeviceEnumerator();
string? Default(DataFlow flow, Role role) {
    try { using var d = devices.GetDefaultAudioEndpoint(flow, role); return d.ID; }
    catch { return null; }
}
if (args.Length == 0 || args[0] == "inventory") {
    var items = devices.EnumerateAudioEndPoints(DataFlow.All, DeviceState.All)
        .Select(d => new { id = d.ID, name = d.FriendlyName, flow = d.DataFlow.ToString(), state = d.State.ToString() }).ToArray();
    Emit(new { kind = "audio_inventory", devices = items,
        defaults = Enum.GetValues<Role>().Select(r => new { role = r.ToString(), render = Default(DataFlow.Render,r), capture = Default(DataFlow.Capture,r) }),
        physical_wired = "NOT_RUN", physical_bluetooth = "NOT_RUN" });
    return;
}

using var endpoint = devices.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
if (!endpoint.FriendlyName.Contains("Virtual Audio", StringComparison.OrdinalIgnoreCase))
    throw new InvalidOperationException("Only our disposable virtual output is allowed");
var seconds = args.Length > 1 ? int.Parse(args[1]) : 60;
if (seconds is < 1 or > 900) throw new ArgumentOutOfRangeException(nameof(seconds));
if (args[0] == "play") {
    using var player = new WasapiOut(endpoint, AudioClientShareMode.Shared, true, 50);
    var signal = new SignalGenerator(48000, 2) { Frequency = 440, Gain = 0.15, Type = SignalGeneratorType.Sin };
    player.Init(signal.ToWaveProvider()); player.Play();
    Emit(new { kind = "external_player", pid = Environment.ProcessId, endpoint = endpoint.ID, frequency = 440, amplitude = 0.15, shared_mode = true });
    await Task.Delay(TimeSpan.FromSeconds(seconds)); player.Stop(); return;
}
if (args[0] != "meter") throw new ArgumentException("inventory, play or meter required");
using var capture = new WasapiLoopbackCapture(endpoint);
var format = capture.WaveFormat;
if (format.BitsPerSample != 32) throw new InvalidOperationException("Expected the WASAPI floating-point loopback mix");
var buffer = new List<float>(); var clock = Stopwatch.StartNew(); var gate = new object();
capture.DataAvailable += (_, e) => {
    lock (gate) {
        for (int offset = 0; offset < e.BytesRecorded; offset += format.BlockAlign) {
            double sample = 0;
            for (int c=0;c<format.Channels;c++) sample += BitConverter.ToSingle(e.Buffer,offset+c*4);
            buffer.Add((float)(sample/format.Channels));
        }
    }
};
Exception? failure = null; capture.RecordingStopped += (_,e) => failure=e.Exception;
capture.StartRecording();
Emit(new { kind="loopback_start", pid=Environment.ProcessId, endpoint=endpoint.ID, sample_rate=format.SampleRate, channels=format.Channels, bits=format.BitsPerSample, encoding=format.Encoding.ToString() });
for (int i=0;i<seconds;i++) {
    await Task.Delay(1000); float[] samples;
    lock(gate) { samples=buffer.ToArray(); buffer.Clear(); }
    if (failure is not null) throw failure;
    double Amplitude(double frequency) {
        if(samples.Length==0)return 0;
        double re=0,im=0;
        for(int n=0;n<samples.Length;n++){double p=2*Math.PI*frequency*n/format.SampleRate;re+=samples[n]*Math.Cos(p);im+=samples[n]*Math.Sin(p);}
        return 2*Math.Sqrt(re*re+im*im)/samples.Length;
    }
    Emit(new { kind="loopback_interval", at_ms=clock.Elapsed.TotalMilliseconds, samples=samples.Length,
        rms=samples.Length==0?0:Math.Sqrt(samples.Sum(x=>(double)x*x)/samples.Length),
        external_440=Amplitude(440), voice_880=Amplitude(880), test_660=Amplitude(660), clipping_samples=samples.Count(x=>Math.Abs(x)>=0.999) });
}
capture.StopRecording();
