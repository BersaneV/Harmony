# Real browser-controlled picker, restricted to the owned EXE/process family.
param([Parameter(Mandatory=$true)][int]$OwnerPid)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Owned Windows VM required' }
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class HarmonyPickerClick {
 [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")]static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")]static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
 public static void Click(int h,int x,int y){SetForegroundWindow(new IntPtr(h));SetCursorPos(x,y);mouse_event(2,0,0,0,UIntPtr.Zero);mouse_event(4,0,0,0,UIntPtr.Zero);}
}
'@
function Activate($element,$window) {
  $pattern=$null
  if ($element.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) { $pattern.Select();return }
  if ($element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { $pattern.Invoke();return }
  $r=$element.Current.BoundingRectangle
  if ($r.IsEmpty -or $r.Width -lt 4 -or $r.Height -lt 4) { throw 'Invalid observed picker control rectangle' }
  [HarmonyPickerClick]::Click($window.Current.NativeWindowHandle,[int]($r.X+$r.Width/2),[int]($r.Y+$r.Height/2))
}
$end=[DateTime]::UtcNow.AddSeconds(30);$observed=@()
while ([DateTime]::UtcNow -lt $end) {
  $processes=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)
  $family=[Collections.Generic.HashSet[int]]::new();$null=$family.Add($OwnerPid)
  do {$added=$false;foreach($p in $processes){if($family.Contains([int]$p.ParentProcessId) -and $family.Add([int]$p.ProcessId)){$added=$true}}}while($added)
  $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
  foreach($window in $windows) {
    if (-not $family.Contains($window.Current.ProcessId)) { continue }
    $nodes=@($window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition))
    $text=(@($window.Current.Name)+@($nodes | ForEach-Object{$_.Current.Name})) -join ' '
    $observed+=@{window=$window.Current.Name;text=$text.Substring(0,[Math]::Min(3500,$text.Length))}
    $share=@($nodes | Where-Object { $_.Current.Name -in @('Share','Compartilhar') -and $_.Current.IsEnabled })
    if (-not $share.Count) { continue }
    $tabs=@($nodes | Where-Object { $_.Current.Name -match '^(Entire screen|Entire Screen|Your Entire Screen|Tela inteira)$' -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::TabItem })
    if ($tabs.Count) { Activate $tabs[0] $window;Start-Sleep -Milliseconds 150 }
    $nodes=@($window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition))
    $screens=@($nodes | Where-Object { $_.Current.Name -match '^(Screen ?1|Entire screen|Your Entire Screen|Tela ?1)$' -and $_.Current.ControlType -in @([Windows.Automation.ControlType]::ListItem,[Windows.Automation.ControlType]::RadioButton,[Windows.Automation.ControlType]::Button) })
    if ($screens.Count) { Activate $screens[0] $window;Start-Sleep -Milliseconds 150 }
    $nodes=@($window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition))
    $audio=@($nodes | Where-Object { $_.Current.Name -match '(?i)(share.*audio|compartilhar.*[áa]udio)' -and $_.Current.ControlType -eq [Windows.Automation.ControlType]::CheckBox })
    if (-not $audio.Count) { continue }
    $toggle=[Windows.Automation.TogglePattern]$audio[0].GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
    if ($toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
    if ($toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::On) { throw 'System audio checkbox not enabled' }
    $share=@($nodes | Where-Object { $_.Current.Name -in @('Share','Compartilhar') -and $_.Current.IsEnabled })
    if (-not $share.Count) { continue }
    $result=@{status='SELECTED';window=$window.Current.Name;system_audio=$audio[0].Current.Name;system_audio_checked=$true;scope='Only the disposable VM desktop'}
    Activate $share[0] $window
    $result | ConvertTo-Json -Compress
    exit 0
  }
  Start-Sleep -Milliseconds 250
}
$observed | Select-Object -Last 5 | ConvertTo-Json -Depth 4 -Compress
throw 'Owned system-audio screen picker could not be completed'
