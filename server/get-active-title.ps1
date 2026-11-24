param(
  [int]$IntervalMs = 1200
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

Add-Type -AssemblyName Accessibility
Add-Type @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class CodexPresenceUi
{
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder buffer, int maxLength);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    private static string ClassName(IntPtr hWnd)
    {
        var buffer = new StringBuilder(256);
        GetClassName(hWnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    private static IntPtr FindRenderer(IntPtr parent)
    {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(parent, (child, _) =>
        {
            if (ClassName(child) == "Chrome_RenderWidgetHostHWND")
            {
                found = child;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    private static long Area(IntPtr hWnd)
    {
        RECT rect;
        if (!GetWindowRect(hWnd, out rect))
        {
            return 0;
        }
        return Math.Max(0, rect.Right - rect.Left) * (long)Math.Max(0, rect.Bottom - rect.Top);
    }

    public static IntPtr[] RendererWindows()
    {
        var candidates = new List<KeyValuePair<long, IntPtr>>();
        EnumWindows((hWnd, _) =>
        {
            if (!IsWindowVisible(hWnd) || ClassName(hWnd) != "Chrome_WidgetWin_1")
            {
                return true;
            }

            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            if (processId == 0)
            {
                return true;
            }

            try
            {
                if (!Process.GetProcessById((int)processId).ProcessName.Equals(
                    "ChatGPT",
                    StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            catch
            {
                return true;
            }

            IntPtr renderer = FindRenderer(hWnd);
            if (renderer != IntPtr.Zero)
            {
                candidates.Add(new KeyValuePair<long, IntPtr>(Area(hWnd), renderer));
            }
            return true;
        }, IntPtr.Zero);

        candidates.Sort((left, right) => right.Key.CompareTo(left.Key));
        var result = new IntPtr[candidates.Count];
        for (int index = 0; index < candidates.Count; index++)
        {
            result[index] = candidates[index].Value;
        }
        return result;
    }
}

public static class CodexPresenceAccessibility
{
    [DllImport("oleacc.dll")]
    public static extern int AccessibleObjectFromWindow(
        IntPtr hWnd,
        uint objectId,
        ref Guid interfaceId,
        [MarshalAs(UnmanagedType.Interface)] out object accessibleObject);
}
"@

$accessibleId = [Guid]"618736E0-3C3D-11CF-810C-00AA00389B71"

function Get-CodexWindowTitle {
  foreach ($renderer in [CodexPresenceUi]::RendererWindows()) {
    $accessible = $null
    try {
      $result = [CodexPresenceAccessibility]::AccessibleObjectFromWindow(
        $renderer,
        [uint32]4294967292,
        [ref]$accessibleId,
        [ref]$accessible
      )
      if ($result -ne 0 -or -not $accessible) {
        continue
      }

      $name = [string]$accessible.accName(0)
      if (-not [string]::IsNullOrWhiteSpace($name) -and $name -ne "ChatGPT") {
        return $name.Trim()
      }
    } catch {
      continue
    } finally {
      if ($accessible -and [Runtime.InteropServices.Marshal]::IsComObject($accessible)) {
        [Runtime.InteropServices.Marshal]::ReleaseComObject($accessible) | Out-Null
      }
    }
  }
  return $null
}

while ($true) {
  try {
    $title = Get-CodexWindowTitle
    if ($title) {
      [Console]::Out.WriteLine((@{ title = $title } | ConvertTo-Json -Compress))
      [Console]::Out.Flush()
    }
  } catch {
    # Keep polling; the renderer may be rebuilding its accessibility tree.
  }
  Start-Sleep -Milliseconds $IntervalMs
}
