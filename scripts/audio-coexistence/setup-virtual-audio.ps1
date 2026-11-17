#requires -Version 7.0
# CI fixture only; never shipped or run on a user's PC. No test signing,
# certificate-store edits, Secure Boot changes or kernel-policy overrides.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Owned disposable Windows runner required' }
$directory = Join-Path $env:RUNNER_TEMP 'harmony-audio-driver'
if (Test-Path $directory) { throw 'Fresh driver directory required' }
New-Item -ItemType Directory -Path $directory | Out-Null
$archive = Join-Path $directory 'driver.zip'
Invoke-WebRequest 'https://github.com/VirtualDrivers/Virtual-Audio-Driver/releases/download/25.7.14/Virtual.Audio.Driver.Signed.-.25.7.14.zip' -OutFile $archive
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'dd10560994de65a7e587fb8b93c0d7e9838292d9c3566a0976c2786d727292bd') { throw 'Pinned driver archive differs' }
Expand-Archive $archive -DestinationPath (Join-Path $directory 'unpacked')
$package = Join-Path $directory 'unpacked\Virtual Audio Driver'
$catalog = Get-AuthenticodeSignature (Join-Path $package 'virtualaudiodriver.cat')
if ($catalog.Status -ne 'Valid') { throw "Driver catalog signature is not valid: $($catalog.Status)" }
Write-Host ("Catalog valid; signer: " + $catalog.SignerCertificate.Subject)
$before = @(Get-PnpDevice -Class Media,AudioEndpoint,Bluetooth -ErrorAction SilentlyContinue | Select-Object Class,FriendlyName,Status,InstanceId)
if ($before | Where-Object { $_.InstanceId -like '*VirtualAudioDriver*' }) { throw 'Existing virtual audio driver refused' }
Set-Service AudioEndpointBuilder -StartupType Automatic
Start-Service AudioEndpointBuilder
Set-Service Audiosrv -StartupType Automatic
Start-Service Audiosrv
# Add the exact root-enumerated hardware ID through the documented SetupAPI.
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class HarmonyAudioRoot {
 [StructLayout(LayoutKind.Sequential)] public struct Info { public int Size; public Guid ClassGuid; public uint DevInst; public UIntPtr Reserved; }
 [DllImport("setupapi.dll",SetLastError=true)] static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid guid,IntPtr hwnd);
 [DllImport("setupapi.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetupDiCreateDeviceInfo(IntPtr set,string name,ref Guid guid,string description,IntPtr hwnd,uint flags,ref Info info);
 [DllImport("setupapi.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetupDiSetDeviceRegistryProperty(IntPtr set,ref Info info,uint property,byte[] data,uint size);
 [DllImport("setupapi.dll",SetLastError=true)] static extern bool SetupDiCallClassInstaller(uint installFunction,IntPtr set,ref Info info);
 [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
 static void Check(bool ok){if(!ok)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
 public static void Create(){
  Guid guid=new Guid("4d36e96c-e325-11ce-bfc1-08002be10318");IntPtr set=SetupDiCreateDeviceInfoList(ref guid,IntPtr.Zero);
  if(set==new IntPtr(-1))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  try{Info info=new Info{Size=Marshal.SizeOf(typeof(Info))};Check(SetupDiCreateDeviceInfo(set,"HarmonyVirtualAudio",ref guid,"Harmony disposable audio fixture",IntPtr.Zero,1,ref info));
   byte[] id=Encoding.Unicode.GetBytes("ROOT\\VirtualAudioDriver\0\0");Check(SetupDiSetDeviceRegistryProperty(set,ref info,1,id,(uint)id.Length));
   Check(SetupDiCallClassInstaller(0x19,set,ref info));
  }finally{SetupDiDestroyDeviceInfoList(set);}
 }
}
'@
[HarmonyAudioRoot]::Create()
New-Item -ItemType Directory -Force .local/qa-audio-coexistence | Out-Null
$arguments = '/add-driver "' + (Join-Path $package 'VirtualAudioDriver.inf') + '" /install'
$installer = Start-Process pnputil.exe -ArgumentList $arguments -PassThru -RedirectStandardOutput .local/qa-audio-coexistence/pnp-out.txt -RedirectStandardError .local/qa-audio-coexistence/pnp-error.txt
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class HarmonyDriverClick {
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
 public static void Click(int window,int x,int y){SetForegroundWindow(new IntPtr(window));SetCursorPos(x,y);mouse_event(2,0,0,0,UIntPtr.Zero);mouse_event(4,0,0,0,UIntPtr.Zero);}
}
'@
$deadline = [DateTime]::UtcNow.AddSeconds(100)
$observed = @()
$approvedDialog = $false
try {
  while (-not $installer.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    if ($approvedDialog) { Start-Sleep -Milliseconds 500; continue }
    $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
    foreach ($window in $windows) {
      $nodes = $window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
      $names = @($window.Current.Name) + @($nodes | ForEach-Object { $_.Current.Name })
      $text = $names -join ' '
      if ($text -match 'Virtual Audio Driver|MikeTheTech|Windows Security') { $observed += $text.Substring(0,[Math]::Min(1600,$text.Length)); $observed += (@{window=$window.Current.Name; controls=@($nodes | Where-Object { $_.Current.Name -match 'Install|SignPath' } | ForEach-Object { @{name=$_.Current.Name; type=$_.Current.ControlType.ProgrammaticName} })} | ConvertTo-Json -Depth 4 -Compress) }
      # Only approve our exact pinned, already verified driver, without checking
      # any Always trust option or altering a driver-signing policy.
      if ($window.Current.Name -ceq 'Windows Security' -and $text.Contains('Would you like to install this device software?') -and $text.Contains('SignPath Foundation')) {
        foreach ($node in $nodes) {
          if ($node.Current.ControlType -eq [Windows.Automation.ControlType]::CheckBox -and $node.Current.Name.Contains('Always trust software')) {
            $toggle = [Windows.Automation.TogglePattern]$node.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
            if ($toggle.Current.ToggleState -eq [Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
          }
        }
        foreach ($node in $nodes) {
          if ($node.Current.ControlType -in @([Windows.Automation.ControlType]::Button,[Windows.Automation.ControlType]::Pane) -and $node.Current.Name.Replace('&','').Trim() -ceq 'Install') {
            $pattern = $null
            if ($node.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { $pattern.Invoke() }
            else {
              # This Windows prompt exposes Install as a Pane, as observed in
              # the retained UIA tree. Click only its freshly read rectangle.
              $rect = $node.Current.BoundingRectangle
              if ($rect.IsEmpty -or $rect.Width -lt 10 -or $rect.Height -lt 10) { throw 'Invalid observed Install rectangle' }
              [HarmonyDriverClick]::Click($window.Current.NativeWindowHandle,[int]($rect.X+$rect.Width/2),[int]($rect.Y+$rect.Height/2))
            }
            Write-Host 'Approved the exact signed virtual driver installation dialog'
            $approvedDialog = $true
            break
          }
        }
      }
      if ($approvedDialog) { break }
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $installer.HasExited) { throw 'Pinned driver installer exceeded 100 seconds' }
  if ($installer.ExitCode -notin @(0,3010)) { throw "Signed fixture driver install failed: $($installer.ExitCode)" }
} finally {
  if (-not $installer.HasExited) { Stop-Process -Id $installer.Id -Force }
  $observed | Select-Object -Unique | Set-Content -Encoding utf8NoBOM .local/qa-audio-coexistence/installer-ui.txt
  Get-Content "$env:windir/INF/setupapi.dev.log" -Tail 90 -ErrorAction SilentlyContinue | Set-Content -Encoding utf8NoBOM .local/qa-audio-coexistence/setup-api-tail.txt
}
& pnputil.exe /scan-devices
Start-Sleep -Seconds 3
$after = @(Get-PnpDevice -Class Media,AudioEndpoint,Bluetooth -ErrorAction SilentlyContinue | Select-Object Class,FriendlyName,Status,InstanceId)
$bad = @($after | Where-Object { $_.FriendlyName -like '*Virtual*MTT*' -and $_.Status -ne 'OK' })
$report = [ordered]@{ driver='VirtualDrivers/Virtual-Audio-Driver 25.7.14'; archive_sha256='dd10560994de65a7e587fb8b93c0d7e9838292d9c3566a0976c2786d727292bd'; catalog_status=$catalog.Status.ToString(); signer=$catalog.SignerCertificate.Subject; os_build=[Environment]::OSVersion.Version.ToString(); before=$before; after=$after; physical_wired='NOT_RUN'; physical_bluetooth='NOT_RUN'; test_signing_changed=$false }
New-Item -ItemType Directory -Force .local/qa-audio-coexistence | Out-Null
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8NoBOM .local/qa-audio-coexistence/driver.json
if ($bad.Count) { throw 'The virtual driver did not start under normal Windows driver policy' }
