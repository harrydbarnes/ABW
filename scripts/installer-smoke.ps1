param([string] $PreviousInstaller, [string] $ExpectedExecutableHash)
$ErrorActionPreference = 'Stop'
if (-not $env:CI) { throw 'Installer smoke checks must run on a disposable CI runner.' }
if ($PreviousInstaller -and $ExpectedExecutableHash -notmatch '^[A-Fa-f0-9]{64}$') {
    throw 'Previous-version upgrades require the verified current installer executable hash.'
}
$installers = @(Get-ChildItem 'src-tauri/target/release/bundle/nsis/*-setup.exe' -File)
if ($installers.Count -ne 1) { throw 'Expected one installer.' }
$directory = Join-Path $env:RUNNER_TEMP 'ABW-installer-smoke'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$preferenceKey = 'HKCU:\Software\net.insidemedia.abw'
if ((Test-Path $directory) -or (Test-Path $preferenceKey) -or
    (Get-ItemProperty $runKey -Name ABW -ErrorAction SilentlyContinue)) {
    throw 'Refusing to overwrite an existing ABW installation or startup preference.'
}
function Invoke-Setup([string[]] $Arguments) {
    $process = Start-Process -FilePath $script:setupPath -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(180000)) { throw 'Installer timed out.' }
    if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
}
function Assert-Startup([bool] $Enabled) {
    $value = Get-ItemProperty $runKey -Name ABW -ErrorAction SilentlyContinue
    if ($Enabled -ne [bool]$value) { throw 'Startup choice was not preserved.' }
    if ($Enabled -and $value.ABW -ne ('"' + $directory + '\ABW.exe"')) {
        throw 'Startup command points to the wrong executable.'
    }
}
$script:setupPath = if ($PreviousInstaller) { (Resolve-Path -LiteralPath $PreviousInstaller).Path } else { $installers[0].FullName }
Invoke-Setup @('/S', "/D=$directory")
$executable = Join-Path $directory 'ABW.exe'
if (-not (Test-Path $executable)) { throw 'Fresh installation did not create ABW.exe.' }
if (-not $PreviousInstaller) {
    $version = (Get-Content 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
    $installedVersion = (Get-Item $executable).VersionInfo.ProductVersion
    if ($installedVersion -notmatch ('^' + [regex]::Escape($version) + '(?:\.0)?$')) {
        throw "Fresh installer version mismatch: expected $version, found $installedVersion."
    }
    $ExpectedExecutableHash = (Get-FileHash $executable -Algorithm SHA256).Hash
    if ($env:GITHUB_OUTPUT) { "executable_hash=$ExpectedExecutableHash" >> $env:GITHUB_OUTPUT }
}
Assert-Startup $false
$dataDirectory = Join-Path $env:APPDATA 'net.insidemedia.abw'
if (Test-Path $dataDirectory) { throw 'Refusing to overwrite existing application data.' }
New-Item $dataDirectory -ItemType Directory | Out-Null
$sentinel = Join-Path $dataDirectory 'installer-smoke.txt'
Set-Content $sentinel 'preserve local user data'
@{
    spellCheck = $true; launchWrikeOnStart = $false; downloadNotifications = $false
    openAbwAtSystemStartup = $false; closeToNotificationArea = $true
    confirmBeforeClosingTabs = $true; openDownloadedFilesAutomatically = $false
    customDictionary = @('InstallerSmoke'); theme = 'default'; startupTabUrls = @(); pinnedDownloadIds = @()
} | ConvertTo-Json | Set-Content (Join-Path $dataDirectory 'settings.json')
New-Item $preferenceKey -Force | Out-Null
New-ItemProperty $preferenceKey -Name StartupEnabled -Value 1 -PropertyType DWord -Force | Out-Null
if (-not (Test-Path -LiteralPath $runKey)) {
    New-Item -Path $runKey -Force | Out-Null
}
New-ItemProperty $runKey -Name ABW -Value ('"' + $executable + '"') -PropertyType String -Force | Out-Null
$app = Start-Process $executable -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 8
if ($app.HasExited) { throw 'Installed app failed to stay running.' }
$script:setupPath = $installers[0].FullName
Invoke-Setup @('/S', '/UPDATE', "/D=$directory")
Assert-Startup $true
if ((Get-FileHash $executable -Algorithm SHA256).Hash -ne $ExpectedExecutableHash) {
    throw 'Upgrade executable differs from the verified fresh current installation.'
}
if ((Get-Content $sentinel -Raw).Trim() -ne 'preserve local user data') { throw 'Upgrade changed local user data.' }
if ((Get-Content (Join-Path $dataDirectory 'settings.json') -Raw | ConvertFrom-Json).customDictionary -notcontains 'InstallerSmoke') { throw 'Upgrade lost saved preferences.' }
Remove-ItemProperty $runKey -Name ABW
Set-ItemProperty $preferenceKey -Name StartupEnabled -Value 0
Invoke-Setup @('/S', '/UPDATE', "/D=$directory")
Assert-Startup $false
if ((Get-FileHash $executable -Algorithm SHA256).Hash -ne $ExpectedExecutableHash) {
    throw 'Startup-disabled upgrade executable differs from the verified fresh current installation.'
}
./scripts/native-workflow-smoke.ps1 -Executable $executable -DataDirectory $dataDirectory
$uninstaller = Join-Path $directory 'uninstall.exe'
if (-not (Test-Path $uninstaller)) { throw 'Uninstaller was not created.' }
$process = Start-Process $uninstaller -ArgumentList @('/S', "_?=$directory") -WindowStyle Hidden -PassThru
if (-not $process.WaitForExit(180000)) { throw 'Uninstaller timed out.' }
if ($process.ExitCode -ne 0 -or (Test-Path $executable)) { throw 'Uninstall failed.' }
Assert-Startup $false
if (-not (Test-Path $sentinel)) { throw 'Uninstall unexpectedly removed local user data.' }
Write-Output 'Fresh silent install, running-app upgrade, startup preservation and uninstall passed.'
$resolvedDirectory = [IO.Path]::GetFullPath($directory)
$runnerRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (-not $resolvedDirectory.StartsWith($runnerRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe installer cleanup path.' }
Remove-Item -LiteralPath $resolvedDirectory -Recurse -Force
if ([IO.Path]::GetFullPath($dataDirectory) -ne [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'net.insidemedia.abw')) -or
    -not (Test-Path $sentinel)) { throw 'Unsafe application-data cleanup path.' }
Remove-Item -LiteralPath $dataDirectory -Recurse -Force
Remove-Item -LiteralPath $preferenceKey -Recurse
