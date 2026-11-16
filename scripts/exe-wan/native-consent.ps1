# Select only the native dialog that names this run's generated window.
param([Parameter(Mandatory=$true)][string]$Title)
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony' -or $Title -notmatch '^HarmonyWAN-[0-9]+$') { throw 'Owned diagnostic window required' }
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @'
using System;using System.Runtime.InteropServices;
public class HarmonyNativeConsent {
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindow(IntPtr cls,string title);
 [DllImport("user32.dll")]public static extern IntPtr GetDlgItem(IntPtr dialog,int id);
 [DllImport("user32.dll")]public static extern IntPtr SendMessage(IntPtr window,uint message,IntPtr w,IntPtr l);
 [DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")]public static extern bool IsWindowEnabled(IntPtr window);
 [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("kernel32.dll")]public static extern IntPtr OpenThread(uint access,bool inherit,uint id);
 [DllImport("kernel32.dll")]public static extern int GetThreadDescription(IntPtr thread,out IntPtr text);
 [DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")]public static extern IntPtr LocalFree(IntPtr handle);
}
'@
$deadline=[DateTime]::UtcNow.AddSeconds(45)
while ([DateTime]::UtcNow -lt $deadline) {
 $exactTitle='Harmony '+[char]0x2014+' autorizar captura'
 $handle=[HarmonyNativeConsent]::FindWindow([IntPtr]::Zero,$exactTitle)
 $dialog=if($handle -ne [IntPtr]::Zero){[Windows.Automation.AutomationElement]::FromHandle($handle)}else{$null}
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
$windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
$windows | Where-Object {$_.Current.Name -like '*Harmony*'} | ForEach-Object {[ordered]@{name=$_.Current.Name;handle=$_.Current.NativeWindowHandle;type=$_.Current.ControlType.ProgrammaticName}} | ConvertTo-Json -Compress
$main=[HarmonyNativeConsent]::FindWindow([IntPtr]::Zero,'Harmony')
if($main -ne [IntPtr]::Zero){
 [uint32]$ownerPid=0;$null=[HarmonyNativeConsent]::GetWindowThreadProcessId($main,[ref]$ownerPid)
 $names=@();foreach($thread in [Diagnostics.Process]::GetProcessById($ownerPid).Threads){
  $handle=[HarmonyNativeConsent]::OpenThread(0x0800,$false,[uint32]$thread.Id)
  if($handle -eq [IntPtr]::Zero){continue}
  try{$text=[IntPtr]::Zero;if([HarmonyNativeConsent]::GetThreadDescription($handle,[ref]$text) -eq 0){try{$name=[Runtime.InteropServices.Marshal]::PtrToStringUni($text);if($name){$names+=$name}}finally{if($text -ne [IntPtr]::Zero){$null=[HarmonyNativeConsent]::LocalFree($text)}}}}finally{$null=[HarmonyNativeConsent]::CloseHandle($handle)}
 }
 [ordered]@{main_enabled=[HarmonyNativeConsent]::IsWindowEnabled($main);thread_names=$names}|ConvertTo-Json -Compress
}
throw 'Owned native consent dialog did not appear'
