# Select only the native dialog that names this run's generated window.
param([Parameter(Mandatory=$true)][string]$Title)
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony' -or $Title -notmatch '^HarmonyWAN-[0-9]+$') { throw 'Owned diagnostic window required' }
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @'
using System;using System.Runtime.InteropServices;
public class HarmonyNativeConsent {
 [DllImport("user32.dll")]public static extern IntPtr GetDlgItem(IntPtr dialog,int id);
 [DllImport("user32.dll")]public static extern IntPtr SendMessage(IntPtr window,uint message,IntPtr w,IntPtr l);
 [DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr window);
}
'@
$deadline=[DateTime]::UtcNow.AddSeconds(45)
while ([DateTime]::UtcNow -lt $deadline) {
 $dialog=[Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,('Harmony '+[char]0x2014+' autorizar captura')))
 if ($dialog) {
  $text=$dialog.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
  $names=@($text|ForEach-Object {$_.Current.Name})
  if (-not ($names|Where-Object {$_ -like "*$Title*"})) { throw 'Consent dialog does not name the owned fixture' }
  $handle=[IntPtr]$dialog.Current.NativeWindowHandle
  $button=[HarmonyNativeConsent]::GetDlgItem($handle,1)
  if ($button -eq [IntPtr]::Zero) {
   $text|ForEach-Object {[ordered]@{name=$_.Current.Name;type=$_.Current.ControlType.ProgrammaticName;id=$_.Current.AutomationId;handle=$_.Current.NativeWindowHandle}}|ConvertTo-Json -Compress
   throw 'Owned native IDOK button missing'
  }
  $null=[HarmonyNativeConsent]::SetForegroundWindow($handle)
  $null=[HarmonyNativeConsent]::SendMessage($button,0xF5,[IntPtr]::Zero,[IntPtr]::Zero)
  'Confirmed only the native dialog for the generated test window';exit 0
 }
 Start-Sleep -Milliseconds 200
}
throw 'Owned native consent dialog did not appear'
