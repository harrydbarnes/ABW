param([Parameter(Mandatory)][string] $Executable, [Parameter(Mandatory)][string] $DataDirectory)
$ErrorActionPreference = 'Stop'
if (-not $env:CI) { throw 'Native workflow smoke checks require a disposable CI runner.' }
if ([IO.Path]::GetFullPath($DataDirectory) -ne [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'net.insidemedia.abw'))) {
    throw 'Unexpected application-data fixture path.'
}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AbwWindow {
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
    public static void Close(IntPtr window) {
        IntPtr result;
        if (SendMessageTimeout(window, 0x0010, IntPtr.Zero, IntPtr.Zero, 2, 5000, out result) == IntPtr.Zero)
            throw new Exception("Native close request timed out.");
    }
}
'@
$settingsPath = Join-Path $DataDirectory 'settings.json'
$settings = @{
    spellCheck = $true; launchWrikeOnStart = $false; downloadNotifications = $false
    openAbwAtSystemStartup = $false; closeToNotificationArea = $true
    confirmBeforeClosingTabs = $true; openDownloadedFilesAutomatically = $false
    customDictionary = @(); theme = 'default'; startupTabUrls = @(); pinnedDownloadIds = @()
}
$settings | ConvertTo-Json | Set-Content $settingsPath
$app = Start-Process $Executable -WindowStyle Hidden -PassThru
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
    Start-Sleep -Milliseconds 250
    $app.Refresh()
    $window = $app.MainWindowHandle
} until ($window -ne [IntPtr]::Zero -or $app.HasExited -or [DateTime]::UtcNow -gt $deadline)
if ($app.HasExited -or $window -eq [IntPtr]::Zero) { throw 'Installed app has no main window.' }
[AbwWindow]::Close($window)
Start-Sleep -Seconds 1
if ($app.HasExited -or [AbwWindow]::IsWindowVisible($window)) { throw 'Native close did not keep ABW running in the tray.' }
$second = Start-Process $Executable -WindowStyle Hidden -PassThru
if (-not $second.WaitForExit(15000) -or $second.ExitCode -ne 0) { throw 'Second instance did not exit cleanly.' }
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while (-not [AbwWindow]::IsWindowVisible($window) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
if (-not [AbwWindow]::IsWindowVisible($window)) { throw 'Second instance did not reactivate the first window.' }
$settings.closeToNotificationArea = $false
$settings | ConvertTo-Json | Set-Content $settingsPath
[AbwWindow]::Close($window)
if (-not $app.WaitForExit(15000)) { throw 'Native close did not quit with tray behavior disabled.' }
Write-Output 'Native close-to-tray, second-instance activation and native quit passed.'
