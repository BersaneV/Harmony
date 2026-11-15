#requires -Version 5.1
# Experimental native source. The full-size DIB is rasterized before User32 sees it;
# neither WM_PAINT nor the visible desktop rectangle supplies its pixels.
# API: https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-updatelayeredwindow
param(
 [Parameter(Mandatory=$true)][string]$Title,
 [ValidateSet(1280,1920,2560)][int]$Width=2560,
 [ValidateSet(720,1080,1440)][int]$Height=1440,
 [ValidateSet(30,60)][int]$Fps=60,
 [ValidateRange(15,180)][int]$DurationSeconds=90
)
$ErrorActionPreference='Stop'
if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_RUN_ID -notmatch '^[0-9]+$' -or $Title -cne "HarmonyWAN-$env:GITHUB_RUN_ID") { throw 'Owned disposable Windows runner and exact run title required' }
if ($Width * 9 -ne $Height * 16) { throw 'Owned native 16:9 capture source required' }
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,System -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public sealed class HarmonyLayeredCanvas : Form {
 const int WsExLayered=0x00080000, WsExAppWindow=0x00040000;
 const uint UlwAlpha=2, TimerAllAccess=0x001F0003, WaitObject0=0, WaitTimeout=258;
 [StructLayout(LayoutKind.Sequential)] struct Point { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] struct NativeSize { public int Width,Height; }
 [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential,Pack=1)] struct Blend { public byte Operation,Flags,Alpha,Format; }
 [StructLayout(LayoutKind.Sequential)] struct BitmapHeader {
  public uint Size; public int Width,Height; public ushort Planes,BitCount;
  public uint Compression,SizeImage; public int XPelsPerMeter,YPelsPerMeter;
  public uint ColorsUsed,ColorsImportant;
 }
 [StructLayout(LayoutKind.Sequential)] struct BitmapInfo { public BitmapHeader Header; public uint Colors; }
 [DllImport("gdi32.dll",SetLastError=true)] static extern IntPtr CreateCompatibleDC(IntPtr dc);
 [DllImport("gdi32.dll",SetLastError=true)] static extern IntPtr CreateDIBSection(IntPtr dc,ref BitmapInfo info,uint usage,out IntPtr bits,IntPtr section,uint offset);
 [DllImport("gdi32.dll",SetLastError=true)] static extern IntPtr SelectObject(IntPtr dc,IntPtr item);
 [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr item);
 [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
 [DllImport("user32.dll",SetLastError=true)] static extern bool UpdateLayeredWindow(IntPtr hwnd,IntPtr destinationDC,ref Point destination,ref NativeSize size,IntPtr sourceDC,ref Point source,uint colorKey,ref Blend blend,uint flags);
 [DllImport("user32.dll",SetLastError=true)] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint period);
 [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint period);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWaitableTimerEx(IntPtr attributes,string name,uint flags,uint access);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetWaitableTimer(IntPtr timer,ref long due,int period,IntPtr callback,IntPtr state,bool resume);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll")] static extern bool CancelWaitableTimer(IntPtr handle);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

 // One reusable, top-down 32-bit DIB, exactly Width*Height pixels. Drawing uses
 // vector coordinates and native-size fonts; there is no small bitmap to upscale.
 sealed class Surface : IDisposable {
  public IntPtr DC;
  IntPtr bitmap,previous;
  public Bitmap Image;
  public Graphics Drawing;
  public Surface(int width,int height) {
   try {
    DC=CreateCompatibleDC(IntPtr.Zero);
    if(DC==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
    var info=new BitmapInfo();
    info.Header.Size=(uint)Marshal.SizeOf(typeof(BitmapHeader));
    info.Header.Width=width;info.Header.Height=-height;info.Header.Planes=1;info.Header.BitCount=32;
    IntPtr bits;
    bitmap=CreateDIBSection(DC,ref info,0,out bits,IntPtr.Zero,0);
    if(bitmap==IntPtr.Zero||bits==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
    previous=SelectObject(DC,bitmap);
    if(previous==IntPtr.Zero||previous==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());
    Image=new Bitmap(width,height,checked(width*4),PixelFormat.Format32bppPArgb,bits);
    Drawing=Graphics.FromImage(Image);
    Drawing.CompositingMode=CompositingMode.SourceOver;
    Drawing.SmoothingMode=SmoothingMode.None;
    Drawing.TextRenderingHint=TextRenderingHint.AntiAliasGridFit;
   }catch{Dispose();throw;}
  }
  public void Dispose() {
   if(Drawing!=null){Drawing.Dispose();Drawing=null;}
   if(Image!=null){Image.Dispose();Image=null;}
   if(DC!=IntPtr.Zero&&previous!=IntPtr.Zero&&previous!=new IntPtr(-1))SelectObject(DC,previous);
   if(bitmap!=IntPtr.Zero){DeleteObject(bitmap);bitmap=IntPtr.Zero;}
   if(DC!=IntPtr.Zero){DeleteDC(DC);DC=IntPtr.Zero;}
   previous=IntPtr.Zero;
  }
 }

 readonly int canvasWidth,canvasHeight,fps,durationSeconds;
 readonly Stopwatch clock=new Stopwatch();
 readonly List<double> draws=new List<double>(),presents=new List<double>(),intervals=new List<double>();
 readonly SolidBrush grid=new SolidBrush(Color.FromArgb(35,58,84));
 readonly SolidBrush marker=new SolidBrush(Color.Black);
 Surface surface;
 Font caption;
 Thread producer;
 Exception failure;
 volatile bool stopped;
 int pending,frames,skipped;
 long previousPresent;
 bool reported;

 public HarmonyLayeredCanvas(string title,int width,int height,int targetFps,int seconds) {
  canvasWidth=width;canvasHeight=height;fps=targetFps;durationSeconds=seconds;
  Text=title;FormBorderStyle=FormBorderStyle.None;AutoScaleMode=AutoScaleMode.None;
  StartPosition=FormStartPosition.Manual;Location=new System.Drawing.Point(0,0);
  ClientSize=new Size(width,height);ShowInTaskbar=true;
  SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint,true);
 }
 protected override CreateParams CreateParams {
  get {
   var cp=base.CreateParams;
   cp.ExStyle|=WsExLayered|WsExAppWindow;
   // A borderless popup can exceed the desktop. No maximize/working-area resize.
   cp.Style=(cp.Style&~0x00CF0000)|unchecked((int)0x80000000);
   cp.X=0;cp.Y=0;cp.Width=canvasWidth;cp.Height=canvasHeight;
   return cp;
  }
 }
 protected override void OnPaint(PaintEventArgs e) { }
 protected override void OnPaintBackground(PaintEventArgs e) { }
 protected override void OnShown(EventArgs e) {
  base.OnShown(e);
  try {
   surface=new Surface(canvasWidth,canvasHeight);
   caption=new Font("Segoe UI",28f*canvasHeight/720f);
   clock.Start();RenderSurface();
   Rect actual;
   if(!GetWindowRect(Handle,out actual))throw new Win32Exception(Marshal.GetLastWin32Error());
   if(actual.Right-actual.Left!=canvasWidth||actual.Bottom-actual.Top!=canvasHeight)throw new InvalidOperationException("Native layered window dimensions were changed by Windows");
   Console.WriteLine("WINDOW "+Handle.ToInt64()+" "+canvasWidth+"x"+canvasHeight+" TARGET "+fps+" SOURCE native-layered-dib LIFETIME_SECONDS "+durationSeconds);
   producer=new Thread(Produce);producer.IsBackground=true;producer.Name="Harmony layered fixture clock";producer.Start();
  }catch(Exception error){Fail(error);}
 }
 void RenderSurface() {
  if(stopped)return;
  long drawStart=Stopwatch.GetTimestamp();
  frames++;
  var g=surface.Drawing;
  float sx=canvasWidth/1280f,sy=canvasHeight/720f;
  g.Clear(Color.FromArgb(18,27,44));
  for(int y=0;y<6;y++)for(int x=0;x<10;x++)g.FillRectangle(grid,(12+x*126)*sx,(12+y*110)*sy,110*sx,90*sy);
  g.FillRectangle(Brushes.Turquoise,((frames*7)%1100)*sx,180*sy,150*sx,110*sy);
  g.FillEllipse(Brushes.Orange,800*sx,(300+(float)(Math.Sin(frames/20.0)*110))*sy,100*sx,100*sy);
  g.DrawString("Harmony generated Windows capture frame "+frames,caption,Brushes.White,30*sx,620*sy);
  marker.Color=Color.FromArgb(frames%256,255-frames%256,127);
  g.FillRectangle(marker,0,0,32,32);
  g.Flush(FlushIntention.Sync);
  long presentStart=Stopwatch.GetTimestamp();
  var destination=new Point();var source=new Point();
  var size=new NativeSize{Width=canvasWidth,Height=canvasHeight};
  var blend=new Blend{Operation=0,Flags=0,Alpha=255,Format=1};
  if(!UpdateLayeredWindow(Handle,IntPtr.Zero,ref destination,ref size,surface.DC,ref source,0,ref blend,UlwAlpha))throw new Win32Exception(Marshal.GetLastWin32Error());
  long finished=Stopwatch.GetTimestamp();
  draws.Add(Milliseconds(presentStart-drawStart));presents.Add(Milliseconds(finished-presentStart));
  if(previousPresent!=0)intervals.Add(Milliseconds(finished-previousPresent));
  previousPresent=finished;
  if(frames%300==0)Console.WriteLine(String.Format(CultureInfo.InvariantCulture,"PAINT {0} ELAPSED_MS {1} DRAW_MS {2:F3} UPDATE_MS {3:F3} SKIPPED {4}",frames,clock.ElapsedMilliseconds,Milliseconds(presentStart-drawStart),Milliseconds(finished-presentStart),Interlocked.CompareExchange(ref skipped,0,0)));
 }
 void Produce() {
  IntPtr timer=IntPtr.Zero;
  try {
   timer=CreateWaitableTimerEx(IntPtr.Zero,null,2,TimerAllAccess);
   if(timer==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
   long origin=Stopwatch.GetTimestamp();long tick=1;
   double period=Stopwatch.Frequency/(double)fps;
   while(!stopped&&clock.Elapsed.TotalSeconds<durationSeconds) {
    long deadline=origin+(long)(tick*period);
    long remaining=deadline-Stopwatch.GetTimestamp();
    if(remaining>0) {
     long due=-Math.Max(1L,(long)Math.Ceiling(remaining*10000000.0/Stopwatch.Frequency));
     if(!SetWaitableTimer(timer,ref due,0,IntPtr.Zero,IntPtr.Zero,false))throw new Win32Exception(Marshal.GetLastWin32Error());
     uint wait=WaitForSingleObject(timer,250);
     if(wait==WaitTimeout)continue;
     if(wait!=WaitObject0)throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    if(stopped)break;
    tick++;
    long now=Stopwatch.GetTimestamp();
    if(now>origin+(long)(tick*period)) {
     long next=(long)((now-origin)/period)+1;
     Interlocked.Add(ref skipped,(int)Math.Min(Int32.MaxValue,next-tick));tick=next;
    }
    // One queued UI update at most. Missed deadlines are reported, never replayed.
    if(Interlocked.CompareExchange(ref pending,1,0)!=0){Interlocked.Increment(ref skipped);continue;}
    try {
     BeginInvoke((Action)(()=>{try{RenderSurface();}catch(Exception error){Fail(error);}finally{Interlocked.Exchange(ref pending,0);}}));
    }catch(InvalidOperationException){Interlocked.Exchange(ref pending,0);if(!stopped)throw;}
   }
   if(!stopped)BeginInvoke((Action)(()=>Close()));
  }catch(Exception error){Fail(error);}
  finally{if(timer!=IntPtr.Zero){CancelWaitableTimer(timer);CloseHandle(timer);}}
 }
 void Fail(Exception error) {
  Interlocked.CompareExchange(ref failure,error,null);stopped=true;
  Console.Error.WriteLine("LAYERED_SOURCE_ERROR "+error);
  try{if(IsHandleCreated&&!IsDisposed)BeginInvoke((Action)(()=>Close()));}catch(InvalidOperationException){}
 }
 protected override void OnFormClosing(FormClosingEventArgs e) {
  stopped=true;
  if(producer!=null&&producer!=Thread.CurrentThread&&!producer.Join(1500))Interlocked.CompareExchange(ref failure,new TimeoutException("Fixture timer did not terminate"),null);
  base.OnFormClosing(e);
 }
 protected override void Dispose(bool disposing) {
  stopped=true;
  if(disposing) {
   if(producer!=null&&producer!=Thread.CurrentThread)producer.Join(1500);
   Report();
   if(surface!=null){surface.Dispose();surface=null;}
   if(caption!=null){caption.Dispose();caption=null;}
   grid.Dispose();marker.Dispose();
  }
  base.Dispose(disposing);
 }
 void Report() {
  if(reported)return;reported=true;
  double elapsed=clock.Elapsed.TotalSeconds;
  Console.WriteLine(String.Format(CultureInfo.InvariantCulture,"LAYERED_SOURCE_SUMMARY frames={0} elapsed_s={1:F3} present_fps={2:F3} skipped={3} draw_ms_p50={4:F3} draw_ms_p95={5:F3} update_ms_p50={6:F3} update_ms_p95={7:F3} interval_ms_p95={8:F3} native_size={9}x{10}",frames,elapsed,elapsed>0?frames/elapsed:0,skipped,Percentile(draws,.50),Percentile(draws,.95),Percentile(presents,.50),Percentile(presents,.95),Percentile(intervals,.95),canvasWidth,canvasHeight));
 }
 static double Milliseconds(long ticks){return ticks*1000.0/Stopwatch.Frequency;}
 static double Percentile(List<double> values,double rank){if(values.Count==0)return 0;values.Sort();return values[Math.Min(values.Count-1,(int)(values.Count*rank))];}
 public static void Run(string title,int width,int height,int fps,int seconds) {
  Exception terminal=null;
  var ui=new Thread(()=>{
   IntPtr previousDpi=IntPtr.Zero;bool timerResolution=false;
   try {
    previousDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));
    if(previousDpi==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
    timerResolution=timeBeginPeriod(1)==0;
    using(var canvas=new HarmonyLayeredCanvas(title,width,height,fps,seconds)) {
     Application.Run(canvas);
     if(canvas.failure!=null)throw new InvalidOperationException("Native layered fixture failed",canvas.failure);
    }
   }catch(Exception error){terminal=error;}
   finally{if(timerResolution)timeEndPeriod(1);if(previousDpi!=IntPtr.Zero)SetThreadDpiAwarenessContext(previousDpi);}
  });
  ui.SetApartmentState(ApartmentState.STA);ui.Start();ui.Join();
  if(terminal!=null)throw new InvalidOperationException("Disposable native source failed",terminal);
 }
}
'@
[HarmonyLayeredCanvas]::Run($Title,$Width,$Height,$Fps,$DurationSeconds)
