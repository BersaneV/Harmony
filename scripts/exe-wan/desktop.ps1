if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable desktop required' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public class HarmonyDisplay {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Mode {
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string device;
  public ushort spec,driver,size,extra; public uint fields; public int x,y; public uint orientation,fixedOutput;
  public short color,duplex,yResolution,ttOption,collate;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string form;
  public ushort logPixels; public uint bits,width,height,flags,frequency,icmMethod,icmIntent,media,dither,reserved1,reserved2,panningWidth,panningHeight;
 }
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern bool EnumDisplaySettings(string device,int mode,ref Mode data);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettings(ref Mode data,uint flags);
}
'@
$mode=[HarmonyDisplay+Mode]::new();$mode.size=[Runtime.InteropServices.Marshal]::SizeOf($mode)
if (-not [HarmonyDisplay]::EnumDisplaySettings($null,-1,[ref]$mode)) { throw 'Display mode unavailable' }
$before=@($mode.width,$mode.height);$mode.width=1920;$mode.height=1080;$mode.fields=0x180000
$result=[HarmonyDisplay]::ChangeDisplaySettings([ref]$mode,0)
$after=[Windows.Forms.SystemInformation]::VirtualScreen
[ordered]@{before=$before;change_result=$result;after=@($after.Width,$after.Height)}|ConvertTo-Json -Compress
if ($after.Width -lt 1280 -or $after.Height -lt 800) { throw 'Desktop too small for native 720p window' }
