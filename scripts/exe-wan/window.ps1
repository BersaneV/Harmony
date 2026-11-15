#requires -Version 5.1
param(
 [Parameter(Mandatory=$true)][string]$Title,
 [ValidateSet(1280,1920,2560)][int]$Width=1280,
 [ValidateSet(720,1080,1440)][int]$Height=720,
 [ValidateSet(30,60)][int]$Fps=30
)
if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony' -or $Title -notmatch '^HarmonyWAN-[a-zA-Z0-9-]+$') { throw 'Owned test window required' }
if ($Width * 9 -ne $Height * 16) { throw 'Owned 16:9 capture source required' }
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,System -TypeDefinition @'
using System; using System.Drawing; using System.Windows.Forms; using System.Threading; using System.Runtime.InteropServices;
public class HarmonyCanvas : Form {
 int frames, pending; readonly int canvasWidth,canvasHeight;
 readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
 System.Threading.Timer highRateTimer;
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd,int command);
 [DllImport("user32.dll")] static extern bool UpdateWindow(IntPtr hwnd);
 [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint period);
 [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint period);
 public HarmonyCanvas(string title,int width,int height,int fps) {
  canvasWidth=width;canvasHeight=height;
  Text=title; FormBorderStyle=FormBorderStyle.None; AutoScaleMode=AutoScaleMode.None;
  MinimumSize=new Size(width,height); MaximumSize=new Size(width,height); ClientSize=new Size(width,height);
  StartPosition=FormStartPosition.Manual; Location=new Point(0,0); TopMost=true;
  BackColor=Color.FromArgb(18,27,44); DoubleBuffered=true;
  SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);
  timer.Interval=15; timer.Tick+=(s,e)=>{frames++;Invalidate();if(frames%300==0)Console.WriteLine("TICK "+frames);};
  FormClosed+=(s,e)=>{timer.Stop();if(highRateTimer!=null)highRateTimer.Dispose();};
  Shown+=(s,e)=>{ShowWindow(Handle,5);ShowWindow(Handle,5);UpdateWindow(Handle);if(fps==30)timer.Start();else highRateTimer=new System.Threading.Timer(_=>{
   if(IsDisposed||!IsHandleCreated||Interlocked.Exchange(ref pending,1)!=0)return;
   try{BeginInvoke((Action)(()=>{try{frames++;Invalidate();Update();if(frames%300==0)Console.WriteLine("TICK "+frames);}finally{Interlocked.Exchange(ref pending,0);}}));}catch(InvalidOperationException){Interlocked.Exchange(ref pending,0);}
  },null,0,Math.Max(1,1000/(fps*2)));
  Console.WriteLine("WINDOW "+Handle.ToInt64()+" "+width+"x"+height+" TARGET "+fps);};
 }
 protected override void OnPaint(PaintEventArgs e) {
  var g=e.Graphics; g.Clear(Color.FromArgb(18,27,44)); g.ScaleTransform(canvasWidth/1280f,canvasHeight/720f);
  using(var p=new SolidBrush(Color.FromArgb(35,58,84))) for(int y=0;y<6;y++)for(int x=0;x<10;x++)g.FillRectangle(p,12+x*126,12+y*110,110,90);
  using(var p=new SolidBrush(Color.Turquoise))g.FillRectangle(p,(frames*7)%1100,180,150,110);
  using(var p=new SolidBrush(Color.Orange))g.FillEllipse(p,800,300+(int)(Math.Sin(frames/20.0)*110),100,100);
  using(var f=new Font("Segoe UI",28))g.DrawString("Harmony generated Windows capture frame "+frames,f,Brushes.White,30,620);
 }
 public static void Run(string title,int width,int height,int fps) {
  var thread=new Thread(()=>{timeBeginPeriod(1);try{Application.Run(new HarmonyCanvas(title,width,height,fps));}finally{timeEndPeriod(1);}});
  thread.SetApartmentState(ApartmentState.STA);thread.Start();thread.Join();
 }
}
'@
[HarmonyCanvas]::Run($Title,$Width,$Height,$Fps)
