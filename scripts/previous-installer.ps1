$ErrorActionPreference = 'Stop'
if (-not $env:CI) { throw 'Previous-installer downloads are CI-only.' }
$destination = Join-Path $env:RUNNER_TEMP 'ABW-previous-installer'
New-Item $destination -ItemType Directory -ErrorAction Stop | Out-Null
$repository = $env:GITHUB_REPOSITORY
$currentVersion = [version](Get-Content 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
$releases = gh api "repos/$repository/releases?per_page=30" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Unable to list previous releases.' }
$release = $releases | Where-Object { -not $_.draft -and -not $_.prerelease -and
    $_.tag_name -match '^v\d+\.\d+\.\d+$' -and
    [version]$_.tag_name.Substring(1) -lt $currentVersion -and ($_.assets.name -like '*-setup.exe') } | Select-Object -First 1
if ($release) {
    gh release download $release.tag_name --repo $repository --pattern '*-setup.exe*' --dir $destination
    $baseline = "release $($release.tag_name)"
} else {
    $runs = gh api "repos/$repository/actions/workflows/windows-installer.yml/runs?branch=main&status=success&per_page=30" | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Unable to list previous successful installer runs.' }
    foreach ($run in $runs.workflow_runs) {
        if ([string]$run.id -eq $env:GITHUB_RUN_ID) { continue }
        $artifacts = gh api "repos/$repository/actions/runs/$($run.id)/artifacts" | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0) { throw 'Unable to list previous installer artifacts.' }
        $artifact = $artifacts.artifacts | Where-Object {
            -not $_.expired -and $_.name -match '^ABW-Windows-installer-v(\d+\.\d+\.\d+)-' -and
            [version]$Matches[1] -lt $currentVersion
        } | Select-Object -First 1
        if ($artifact) {
            gh run download $run.id --repo $repository --name $artifact.name --dir $destination
            $baseline = "successful run $($run.id), commit $($run.head_sha)"
            break
        }
    }
}
if (-not $baseline -or $LASTEXITCODE -ne 0) { throw 'No downloadable previous installer baseline. Publish an installer release or retain a successful build artifact.' }
$installers = @(Get-ChildItem $destination -Filter '*-setup.exe' -File -Recurse)
if ($installers.Count -ne 1) { throw 'Expected exactly one previous installer.' }
$checksum = "$($installers[0].FullName).sha256"
if (-not (Test-Path $checksum)) { throw 'Previous installer has no SHA-256 checksum.' }
$expected = ((Get-Content $checksum -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash $installers[0].FullName -Algorithm SHA256).Hash -ine $expected) { throw 'Previous installer checksum mismatch.' }
"previous_installer=$($installers[0].FullName)" >> $env:GITHUB_OUTPUT
"Upgrade baseline: $baseline (checksum verified)." >> $env:GITHUB_STEP_SUMMARY
