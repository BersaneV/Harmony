#requires -Version 7.0
# Diagnostic on a disposable runner only. Never alters the user's computer.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony' -or -not $env:HARMONY_EXE_ROOT) { throw 'Owned disposable Windows runner required' }
$installer = Join-Path $env:HARMONY_EXE_ROOT 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe'
Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/?linkid=2124701' -OutFile $installer -TimeoutSec 180 -MaximumRetryCount 2
$signature = Get-AuthenticodeSignature -FilePath $installer
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') { throw 'Valid Microsoft Authenticode signature required' }
$process = Start-Process -FilePath $installer -ArgumentList '/silent /install' -PassThru
if (-not $process.WaitForExit(300000)) { $process.Kill($true); throw 'WebView2 installation timed out' }
if ($process.ExitCode -ne 0) { throw "WebView2 installer failed: $($process.ExitCode)" }
[ordered]@{kind='runtime_install';sha256=(Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant();signer=$signature.SignerCertificate.Subject;installer_version=[Diagnostics.FileVersionInfo]::GetVersionInfo($installer).ProductVersion;exit_code=$process.ExitCode} | ConvertTo-Json -Compress | Write-Output
