# Select only the native dialog that names this run's generated window.
param([Parameter(Mandatory=$true)][string]$Title)
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony' -or $Title -notmatch '^HarmonyWAN-[0-9]+$') { throw 'Owned diagnostic window required' }
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$deadline=[DateTime]::UtcNow.AddSeconds(45)
while ([DateTime]::UtcNow -lt $deadline) {
 $dialog=[Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,('Harmony '+[char]0x2014+' autorizar captura')))
 if ($dialog) {
  $text=$dialog.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
  $names=@($text|ForEach-Object {$_.Current.Name})
  if (-not ($names|Where-Object {$_ -like "*$Title*"})) { throw 'Consent dialog does not name the owned fixture' }
  $button=$dialog.FindFirst([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,'1'))
  if (-not $button) { throw 'Owned confirmation button missing' }
  $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
  'Confirmed only the native dialog for the generated test window';exit 0
 }
 Start-Sleep -Milliseconds 200
}
throw 'Owned native consent dialog did not appear'
