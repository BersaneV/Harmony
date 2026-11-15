#requires -Version 7.0
param([Parameter(Mandatory=$true)][string]$Title)
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony' -or $Title -notmatch '^HarmonyWAN-[a-zA-Z0-9-]+$') { throw 'Owned test window required' }
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Windows.Forms;
public class HarmonyCanvas : Control {
  int frames; readonly Timer timer = new Timer();
  public HarmonyCanvas() { DoubleBuffered=true; timer.Interval=33; timer.Tick+=(s,e)=>{frames++;Invalidate();}; timer.Start(); }
  protected override void OnPaint(PaintEventArgs e) {
    var g=e.Graphics; g.Clear(Color.FromArgb(18,27,44));
    using(var p=new SolidBrush(Color.FromArgb(35,58,84))) for(int y=0;y<6;y++)for(int x=0;x<10;x++)g.FillRectangle(p,12+x*126,12+y*110,110,90);
    using(var p=new SolidBrush(Color.Turquoise))g.FillRectangle(p,(frames*7)%1100,180,150,110);
    using(var p=new SolidBrush(Color.Orange))g.FillEllipse(p,800,300+(int)(Math.Sin(frames/20.0)*110),100,100);
    using(var f=new Font("Segoe UI",28))g.DrawString("Harmony — generated Windows capture — frame "+frames,f,Brushes.White,30,620);
  }
}
'@
$form = [Windows.Forms.Form]::new()
$form.Text=$Title; $form.FormBorderStyle='None'; $form.AutoScaleMode='None'; $form.ClientSize=[Drawing.Size]::new(1280,720)
$form.StartPosition='Manual'; $form.Location=[Drawing.Point]::new(0,0)
$canvas=[HarmonyCanvas]::new(); $canvas.Dock='Fill'; $form.Controls.Add($canvas)
[Windows.Forms.Application]::Run($form)
