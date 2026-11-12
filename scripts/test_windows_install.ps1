#requires -Version 7.0
<#
Smoke test for the locally built NSIS package on a disposable GitHub Windows runner.
Never launches Harmony. Tests install, PE ProductVersion and silent removal only.
NSIS: https://nsis.sourceforge.io/Docs/Chapter3.html sections 3.2.1/3.2.2.
Tauri template: https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi
/D= and _?= are LAST, absolute and deliberately unquoted, including spaces.
The /R flag that launches the application is deliberately absent.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [string]$Output = '.local/qa-updater/windows-install.json'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony' -or -not $env:RUNNER_TEMP -or -not $env:GITHUB_WORKSPACE) {
    throw 'This test runs only on a disposable Windows GitHub runner for BersaneV/Harmony.'
}
$installer = (Resolve-Path -LiteralPath $Path).Path
$bundle = [IO.Path]::GetFullPath((Join-Path $env:GITHUB_WORKSPACE 'apps/desktop/src-tauri/target/release/bundle/nsis'))
if ([IO.Path]::GetDirectoryName($installer) -ine $bundle -or [IO.Path]::GetFileName($installer) -cne "Harmony_${Version}_x64-setup.exe") {
    throw 'The installer must be the expected artifact from this checkout build.'
}
$uninstallKeys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Harmony',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Harmony',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Harmony'
)
foreach ($key in $uninstallKeys) {
    if (Test-Path -LiteralPath $key) { throw 'Refusing to alter an existing Harmony installation.' }
}
$installDirectory = Join-Path ([IO.Path]::GetFullPath($env:RUNNER_TEMP)) ('harmony-install-smoke-' + [guid]::NewGuid().ToString('N'))
if ($installDirectory.Contains('"') -or $installDirectory.Contains("`n") -or $installDirectory.Contains("`r")) {
    throw 'Invalid temporary path for NSIS arguments.'
}
if (Test-Path -LiteralPath $installDirectory) { throw 'The disposable install directory already exists.' }
$null = New-Item -ItemType Directory -Path $installDirectory
$uninstaller = Join-Path $installDirectory 'uninstall.exe'
$mainExecutable = $null
$uninstalled = $false
$checks = [Collections.Generic.List[object]]::new()
function Record-Check([string]$Name, [bool]$Passed) {
    $checks.Add([ordered]@{ name = $Name; passed = $Passed })
    if (-not $Passed) { throw "FAIL $Name" }
    Write-Host "PASS $Name"
}
function Run-Installer([string]$Executable, [string]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Executable
    $info.Arguments = $Arguments
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WorkingDirectory = $installDirectory
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw 'Unable to start the installer process.' }
        if (-not $process.WaitForExit(300000)) {
            $process.Kill($true)
            $process.WaitForExit()
            throw 'Installer exceeded the five-minute timeout.'
        }
        return $process.ExitCode
    } finally { $process.Dispose() }
}
try {
    $installerVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($installer).ProductVersion
    Record-Check 'setup ProductVersion matches expected release' ($installerVersion -ceq $Version -or $installerVersion -ceq "$Version.0")
    $exitCode = Run-Installer $installer "/S /D=$installDirectory"
    Record-Check 'silent installation exits successfully' ($exitCode -eq 0)
    Record-Check 'uninstaller is present in isolated directory' (Test-Path -LiteralPath $uninstaller -PathType Leaf)
    $executables = @(Get-ChildItem -LiteralPath $installDirectory -Filter '*.exe' -File | Where-Object { $_.Name -ine 'uninstall.exe' })
    Record-Check 'one main executable was installed' ($executables.Count -eq 1)
    $mainExecutable = $executables[0].FullName
    $installedVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($mainExecutable).ProductVersion
    Record-Check 'installed ProductVersion matches expected release' ($installedVersion -ceq $Version -or $installedVersion -ceq "$Version.0")
    $running = @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($mainExecutable)) -ErrorAction SilentlyContinue)
    Record-Check 'application was not launched by silent install' ($running.Count -eq 0)
    # _?= prevents the uninstaller from spawning a temporary copy, so waiting on
    # this process observes actual removal. It cannot delete its own running exe.
    $exitCode = Run-Installer $uninstaller "/S _?=$installDirectory"
    Record-Check 'silent uninstallation exits successfully' ($exitCode -eq 0)
    Record-Check 'main executable was removed by uninstaller' (-not (Test-Path -LiteralPath $mainExecutable))
    $remainingKeys = @($uninstallKeys | Where-Object { Test-Path -LiteralPath $_ })
    Record-Check 'uninstall registration was removed' ($remainingKeys.Count -eq 0)
    $uninstalled = $true
} finally {
    if (-not $uninstalled -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        try { $null = Run-Installer $uninstaller "/S _?=$installDirectory" } catch { Write-Warning 'Cleanup uninstaller failed; runner remains disposable.' }
    }
    # This only removes the exclusive directory created by this test. Cleanup is
    # not evidence of successful uninstall: the assertions above run first.
    if (Test-Path -LiteralPath $installDirectory) {
        $entry = Get-Item -LiteralPath $installDirectory
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing cleanup of a reparse point.' }
        Remove-Item -LiteralPath $installDirectory -Recurse -Force
    }
    $outputPath = [IO.Path]::GetFullPath($Output)
    $null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($outputPath)) -Force
    [ordered]@{
        scope = 'Windows NSIS silent installation/removal only; app not launched; no UI, updater replacement, media, or device validation'
        timestamp = [DateTimeOffset]::UtcNow.ToString('o')
        version = $Version
        artifact_sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
        commit = $env:GITHUB_SHA
        passed = $uninstalled
        checks = $checks
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $outputPath -Encoding utf8NoBOM
}
if (-not $uninstalled) { throw 'Windows installation smoke did not complete.' }
