$ErrorActionPreference = 'Stop'
if (-not $env:CI) { throw 'Previous-installer downloads are CI-only.' }
$destination = Join-Path $env:RUNNER_TEMP 'ABW-previous-installer'
if (Test-Path $destination) {
    Remove-Item -LiteralPath $destination -Recurse -Force
}
New-Item $destination -ItemType Directory -ErrorAction Stop | Out-Null
$repository = $env:GITHUB_REPOSITORY
$currentVersion = [version](Get-Content 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
$releases = @(gh api "repos/$repository/releases?per_page=30" | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw 'Unable to list previous releases.' }

function Find-Release([bool] $AllowSameVersion) {
    $releases | Where-Object {
        -not $_.draft -and -not $_.prerelease -and
        $_.tag_name -match '^v\d+\.\d+\.\d+$' -and
        ($(if ($AllowSameVersion) { [version]$_.tag_name.Substring(1) -le $currentVersion } else { [version]$_.tag_name.Substring(1) -lt $currentVersion })) -and
        ($_.assets.name -like '*-setup.exe')
    } | Select-Object -First 1
}

$runsResponse = gh api "repos/$repository/actions/workflows/windows-installer.yml/runs?branch=main&status=success&per_page=30" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Unable to list previous successful installer runs.' }

function Find-ArtifactBaseline([bool] $AllowSameVersion) {
    foreach ($run in $runsResponse.workflow_runs) {
        if ([string]$run.id -eq $env:GITHUB_RUN_ID) { continue }
        $artifacts = gh api "repos/$repository/actions/runs/$($run.id)/artifacts" | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0) { throw 'Unable to list previous installer artifacts.' }
        $artifact = $artifacts.artifacts | Where-Object {
            -not $_.expired -and $_.name -match '^ABW-Windows-installer-v(\d+\.\d+\.\d+)-' -and
            ($(if ($AllowSameVersion) { [version]$Matches[1] -le $currentVersion } else { [version]$Matches[1] -lt $currentVersion }))
        } | Select-Object -First 1
        if ($artifact) {
            return @{ Run = $run; Artifact = $artifact }
        }
    }
    return $null
}

$baseline = $null
$release = Find-Release -AllowSameVersion $false
if ($release) {
    gh release download $release.tag_name --repo $repository --pattern '*-setup.exe*' --dir $destination
    if ($LASTEXITCODE -ne 0) { throw "Unable to download release $($release.tag_name)." }
    $baseline = "release $($release.tag_name)"
} else {
    $match = Find-ArtifactBaseline -AllowSameVersion $false
    if (-not $match) {
        $release = Find-Release -AllowSameVersion $true
        if ($release) {
            gh release download $release.tag_name --repo $repository --pattern '*-setup.exe*' --dir $destination
            if ($LASTEXITCODE -ne 0) { throw "Unable to download release $($release.tag_name)." }
            $baseline = "release $($release.tag_name) (same-version fallback)"
        } else {
            $match = Find-ArtifactBaseline -AllowSameVersion $true
            if ($match) {
                $baseline = "successful run $($match.Run.id), commit $($match.Run.head_sha) (same-version fallback)"
            }
        }
    } else {
        $baseline = "successful run $($match.Run.id), commit $($match.Run.head_sha)"
    }

    if ($match) {
        gh run download $match.Run.id --repo $repository --name $match.Artifact.name --dir $destination
        if ($LASTEXITCODE -ne 0) { throw "Unable to download artifact $($match.Artifact.name)." }
    }
}

if (-not $baseline) {
    "has_previous=false" >> $env:GITHUB_OUTPUT
    "Upgrade baseline: skipped (no prior published release or non-expired main artifact available yet)." >> $env:GITHUB_STEP_SUMMARY
    Write-Warning 'No downloadable previous installer baseline found; skipping previous-version upgrade smoke test.'
    exit 0
}

$installers = @(Get-ChildItem $destination -Filter '*-setup.exe' -File -Recurse)
if ($installers.Count -ne 1) { throw 'Expected exactly one previous installer.' }
$checksum = "$($installers[0].FullName).sha256"
if (-not (Test-Path $checksum)) { throw 'Previous installer has no SHA-256 checksum.' }
$expected = ((Get-Content $checksum -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash $installers[0].FullName -Algorithm SHA256).Hash -ine $expected) { throw 'Previous installer checksum mismatch.' }
"has_previous=true" >> $env:GITHUB_OUTPUT
"previous_installer=$($installers[0].FullName)" >> $env:GITHUB_OUTPUT
"Upgrade baseline: $baseline (checksum verified)." >> $env:GITHUB_STEP_SUMMARY
