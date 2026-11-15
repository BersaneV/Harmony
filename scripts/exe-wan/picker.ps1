param([Parameter(Mandatory=$true)][string]$Title,[ValidateSet('inspect','select')][string]$Action='inspect',[string]$ScreenshotPath)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $Title -notmatch '^HarmonyWAN-[a-zA-Z0-9-]+$') { throw 'Owned disposable picker required' }
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms,System.Drawing
$root=[Windows.Automation.AutomationElement]::RootElement
if ($Action -eq 'inspect') {
  $rows=[Collections.Generic.List[object]]::new()
  $elements=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
  for($i=0;$i -lt [Math]::Min(500,$elements.Count);$i++) {
    try {$e=$elements[$i].Current; $rows.Add([ordered]@{name=$e.Name;type=$e.ControlType.ProgrammaticName;pid=$e.ProcessId;enabled=$e.IsEnabled;offscreen=$e.IsOffscreen;rect=@($e.BoundingRectangle.X,$e.BoundingRectangle.Y,$e.BoundingRectangle.Width,$e.BoundingRectangle.Height)})} catch {}
  }
  $rows | ConvertTo-Json -Depth 4 -Compress
  if ($ScreenshotPath) {
    if (-not ([IO.Path]::GetFullPath($ScreenshotPath)).StartsWith([IO.Path]::GetFullPath($env:RUNNER_TEMP)+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Private screenshot required' }
    $screen=[Windows.Forms.SystemInformation]::VirtualScreen;$bitmap=[Drawing.Bitmap]::new($screen.Width,$screen.Height);$graphics=[Drawing.Graphics]::FromImage($bitmap);$graphics.CopyFromScreen($screen.Left,$screen.Top,0,0,$bitmap.Size);$bitmap.Save($ScreenshotPath,[Drawing.Imaging.ImageFormat]::Png);$graphics.Dispose();$bitmap.Dispose()
  }
  exit 0
}
$matches=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$Title))
$target=$null
for($i=0;$i -lt $matches.Count;$i++) { $e=$matches[$i]; if ($e.Current.ControlType.ProgrammaticName -in @('ControlType.ListItem','ControlType.RadioButton','ControlType.Button','ControlType.TabItem')) {$target=$e;break} }
if ($null -eq $target) { throw 'Owned capture source is not present in picker' }
$pattern=$null
if ($target.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) {$pattern.Select()}
elseif ($target.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {$pattern.Invoke()}
else {$target.SetFocus();[Windows.Forms.SendKeys]::SendWait(' ')}
foreach($label in @('Share','Compartilhar')) {
  $buttons=$root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$label))
  for($i=0;$i -lt $buttons.Count;$i++) { $e=$buttons[$i];if($e.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $e.Current.IsEnabled -and $e.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {$pattern.Invoke();Write-Output 'Owned window selected and shared';exit 0} }
}
throw 'Share action not enabled after selecting owned window'
