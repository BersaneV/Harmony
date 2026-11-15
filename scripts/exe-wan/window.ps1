#requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$Title)
if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony' -or $Title -notmatch '^HarmonyWAN-[a-zA-Z0-9-]+$') { throw 'Owned test window required' }
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Windows.Forms; using System.Threading; using System.Runtime.InteropServices;
public class HarmonyCanvas : Form {
 int frames; readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd,int command);
 [DllImport("user32.dll")] static extern bool UpdateWindow(IntPtr hwnd);
 public HarmonyCanvas(string title) {
  Text=title; FormBorderStyle=FormBorderStyle.None; AutoScaleMode=AutoScaleMode.None;
  MinimumSize=new Size(1280,720); MaximumSize=new Size(1280,720); ClientSize=new Size(1280,720);
  StartPosition=FormStartPosition.Manual; Location=new Point(0,0); TopMost=true;
  BackColor=Color.FromArgb(18,27,44); DoubleBuffered=true;
  SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);
  timer.Interval=33; timer.Tick+=(s,e)=>{frames++;Invalidate();if(frames%300==0)Console.WriteLine("TICK "+frames);};
  Shown+=(s,e)=>{ShowWindow(Handle,5);ShowWindow(Handle,5);UpdateWindow(Handle);timer.Start();Console.WriteLine("WINDOW "+Handle.ToInt64());};
 }
 protected override void OnPaint(PaintEventArgs e) {
  var g=e.Graphics; g.Clear(Color.FromArgb(18,27,44));
  using(var p=new SolidBrush(Color.FromArgb(35,58,84))) for(int y=0;y<6;y++)for(int x=0;x<10;x++)g.FillRectangle(p,12+x*126,12+y*110,110,90);
  using(var p=new SolidBrush(Color.Turquoise))g.FillRectangle(p,(frames*7)%1100,180,150,110);
  using(var p=new SolidBrush(Color.Orange))g.FillEllipse(p,800,300+(int)(Math.Sin(frames/20.0)*110),100,100);
  using(var f=new Font("Segoe UI",28))g.DrawString("Harmony generated Windows capture frame "+frames,f,Brushes.White,30,620);
 }
 public static void Run(string title) {
  var thread=new Thread(()=>Application.Run(new HarmonyCanvas(title)));
  thread.SetApartmentState(ApartmentState.STA);thread.Start();thread.Join();
 }
}
'@
[HarmonyCanvas]::Run($Title)
