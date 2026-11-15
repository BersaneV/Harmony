param([Parameter(Mandatory=$true)][string]$Path,[int]$Index)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable runner required' }
if (-not ([IO.Path]::GetFullPath($Path)).StartsWith([IO.Path]::GetFullPath($env:RUNNER_TEMP)+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Private output required' }
Add-Type -AssemblyName System.Speech
$voice=[System.Speech.Synthesis.SpeechSynthesizer]::new()
$format=[System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(48000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
$voice.SetOutputToWaveFile($Path,$format)
$voice.Speak("Harmony network test. Participant number $Index. One, two, three, four, five, six, seven, eight. This is generated speech passing through the Windows application. We are measuring voice delivery over the internet. The quick brown fox jumps over the lazy dog. This is the end of the sample.")
$voice.Dispose()
