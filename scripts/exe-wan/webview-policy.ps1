#requires -Version 7.0
param([Parameter(Mandatory=$true)][string]$ExePath,[string]$Profile,[string]$BrowserArguments,[switch]$Remove)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony') { throw 'Owned disposable Windows runner required' }
$exe = [IO.Path]::GetFullPath($ExePath)
if (-not $exe.StartsWith([IO.Path]::GetFullPath($env:RUNNER_TEMP) + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Owned temporary EXE required' }
$name = [IO.Path]::GetFileName($exe)
# GitHub Windows runners may be elevated. Microsoft documents that only HKLM
# overrides are honored by elevated WebView2 hosts. Scope every value to our EXE.
foreach ($setting in @('AdditionalBrowserArguments','UserDataFolder')) {
  $key = 'HKLM:\Software\Policies\Microsoft\Edge\WebView2\' + $setting
  if ($Remove) { Remove-ItemProperty -LiteralPath $key -Name $name -ErrorAction SilentlyContinue; continue }
  $existing = Get-ItemProperty -LiteralPath $key -Name $name -ErrorAction SilentlyContinue
  if ($null -ne $existing) { throw 'Existing WebView override refused' }
  if (-not (Test-Path $key)) { $null = New-Item -Path $key -Force }
  $value = if ($setting -eq 'AdditionalBrowserArguments') {$BrowserArguments} else {$Profile}
  $null = New-ItemProperty -LiteralPath $key -Name $name -Value $value -PropertyType String
}
