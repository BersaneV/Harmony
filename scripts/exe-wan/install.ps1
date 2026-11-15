#requires -Version 7.0
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony' -or -not $env:RUNNER_TEMP) { throw 'Disposable personal Windows GitHub runner required' }
foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Harmony','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Harmony')) {
  if (Test-Path $key) { throw 'Existing installation refused' }
}
$root = Join-Path $env:RUNNER_TEMP ('harmony-exe-wan-' + [guid]::NewGuid().ToString('N'))
if ($root -match '[\s"\r\n]') { throw 'Simple private temporary path required' }
$null = New-Item -ItemType Directory -Path $root
$releaseVersion = if ($env:HARMONY_EXE_RELEASE) { $env:HARMONY_EXE_RELEASE } else { '0.4.1' }
if ($releaseVersion -notmatch '^0\.4\.[0-9]{1,3}$') { throw 'Unsupported test release' }
$manifest = Get-Content (Join-Path $PSScriptRoot "releases/$releaseVersion.json") -Raw | ConvertFrom-Json
if ($manifest.version -cne $releaseVersion -or $manifest.installer_url -cne "https://github.com/BersaneV/Harmony/releases/download/v$releaseVersion/Harmony_${releaseVersion}_x64-setup.exe" -or $manifest.installer_sha256 -notmatch '^[a-f0-9]{64}$' -or $manifest.main_sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid owned release manifest' }
$installer = Join-Path $root "Harmony_${releaseVersion}_x64-setup.exe"
Invoke-WebRequest -Uri $manifest.installer_url -OutFile $installer -TimeoutSec 120 -MaximumRetryCount 2
$digest = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($digest -cne $manifest.installer_sha256) { throw 'Published installer hash mismatch' }
$install = Join-Path $root 'installed'
$process = Start-Process -FilePath $installer -ArgumentList "/S /D=$install" -PassThru
if (-not $process.WaitForExit(300000)) { $process.Kill($true); throw 'NSIS timeout' }
if ($process.ExitCode -ne 0) { throw 'NSIS failed' }
$apps = @(Get-ChildItem $install -Filter '*.exe' -File | Where-Object Name -ine 'uninstall.exe')
if ($apps.Count -ne 1) { throw 'One installed application required' }
$exe = $apps[0].FullName
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion
if ($version -notin @($releaseVersion,"$releaseVersion.0")) { throw 'Wrong installed ProductVersion' }
if ((Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.main_sha256) { throw 'Installed main binary hash mismatch' }
"HARMONY_EXE_ROOT=$root" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
"HARMONY_EXE_PATH=$exe" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
[ordered]@{kind='exe_install';installer_sha256=$digest;main_sha256=(Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant();version=$version;main_name=$apps[0].Name;machine=$env:RUNNER_NAME} | ConvertTo-Json -Compress | Write-Output
