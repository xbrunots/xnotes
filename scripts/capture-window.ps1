param([Parameter(Mandatory=$true)][long]$Handle,[Parameter(Mandatory=$true)][string]$Output)
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class NotesWindowCapture {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr handle, IntPtr target, uint flags);
  public static Bitmap Capture(IntPtr handle) {
    Rect rect; if(!GetWindowRect(handle,out rect)) throw new Exception("Janela indisponível.");
    var image=new Bitmap(rect.Right-rect.Left,rect.Bottom-rect.Top);
    using(var graphics=Graphics.FromImage(image)) { var target=graphics.GetHdc(); try { if(!PrintWindow(handle,target,2)) throw new Exception("Captura indisponível."); } finally { graphics.ReleaseHdc(target); } }
    return image;
  }
}
'@
$capture = [NotesWindowCapture]::Capture([IntPtr]::new($Handle))
try { $capture.Save([IO.Path]::GetFullPath($Output),[Drawing.Imaging.ImageFormat]::Png) } finally { $capture.Dispose() }
