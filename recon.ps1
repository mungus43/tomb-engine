# ===========================================================================
# HISTORICAL — this script is no longer the canonical build workflow.
# The shipping build pipeline is `build.ps1` (invoked via `go.bat`).
# This file is preserved for reference: it documents the original recon pass
# used to size up the dependency wall before any patches were applied.
# Engine source now lives in a separate repo; see PATCH_INVENTORY.md.
# ===========================================================================
#
# GZDoom-wasm build reconnaissance
# Clones GZDoom at a pinned tag, runs an emcmake configure pass,
# and dumps the dependency wall to recon-log.txt for triage.
#
# Prereqs on this Windows machine:
#   - git
#   - cmake (>= 3.16)
#   - Emscripten SDK installed and on PATH
#       https://emscripten.org/docs/getting_started/downloads.html
#       Quick install:
#         git clone https://github.com/emscripten-core/emsdk.git C:\emsdk
#         cd C:\emsdk
#         .\emsdk install latest
#         .\emsdk activate latest
#         .\emsdk_env.ps1
#
# Usage:
#   cd D:\deck\rc\gzdoom-wasm
#   .\recon.ps1
#
# Output:
#   recon-log.txt -- full transcript (paste this back to Claude)
#   gzdoom-src/   -- cloned source (~150MB, kept for follow-up work)
#   build/        -- CMake configure output (NOT a real build)

$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$log  = Join-Path $here 'recon-log.txt'
$src  = Join-Path $here 'gzdoom-src'
$bld  = Join-Path $here 'build'

# Pinned version. g4.11.x line is the sweet spot:
#   - has UDMF / DECORATE / MAPINFO / ACS (the whole reason we are doing this)
#   - last release line BEFORE Vulkan SDK became required
#   - softpoly renderer still present (the realistic WebGL2 target)
# Newer (4.12+) drags in Vulkan and other deps that bloat the port.
$gzdoomTag = 'g4.11.3'

"" | Out-File -FilePath $log -Encoding utf8
function L ($s) { Add-Content -Path $log -Value $s -Encoding utf8; Write-Host $s }

L "=== GZDoom-wasm reconnaissance ==="
L "Started: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
L "Pinned tag: $gzdoomTag"
L ""

# Step 0: prereq check
L ">> Step 0: prereq check"
$gitOk     = $null -ne (Get-Command git -ErrorAction SilentlyContinue)
$cmakeOk   = $null -ne (Get-Command cmake -ErrorAction SilentlyContinue)
$emcmakeOk = $null -ne (Get-Command emcmake -ErrorAction SilentlyContinue)
$ninjaOk   = $null -ne (Get-Command ninja -ErrorAction SilentlyContinue)
L "   git on PATH     : $gitOk"
L "   cmake on PATH   : $cmakeOk"
L "   emcmake on PATH : $emcmakeOk"
L "   ninja on PATH   : $ninjaOk"
if (-not $gitOk)     { L "   ABORT: install git first."; exit 1 }
if (-not $cmakeOk)   { L "   ABORT: install cmake (>= 3.16) first."; exit 1 }
if (-not $emcmakeOk) { L "   ABORT: emsdk not activated. Run emsdk_env.ps1 in this shell first."; exit 1 }
if (-not $ninjaOk)   { L "   ABORT: ninja not on PATH. Drop ninja.exe in C:\emsdk\ and rerun."; exit 1 }
L ""

# Step 1: clone (or refresh) GZDoom source at pinned tag
L ">> Step 1: cloning GZDoom @ $gzdoomTag"
if (Test-Path $src) {
    L "   gzdoom-src/ already exists -- fetching tags only, leaving working tree alone"
    Push-Location $src
    $fetchOut = git fetch --tags 2>&1
    foreach ($line in $fetchOut) { L "   | $line" }
    Pop-Location
} else {
    $cloneOut = git clone --depth 1 --branch $gzdoomTag https://github.com/ZDoom/gzdoom.git $src 2>&1
    foreach ($line in $cloneOut) { L "   | $line" }
    if ($LASTEXITCODE -ne 0) { L "   ABORT: clone failed."; exit 2 }
}
L "   OK: source at $src"
L ""

# Step 2: clean build dir
L ">> Step 2: prep clean build/ dir"
if (Test-Path $bld) {
    Remove-Item -Recurse -Force $bld
    L "   removed previous build/"
}
New-Item -ItemType Directory -Path $bld | Out-Null
L "   created build/"
L ""

# Step 3: emcmake configure -- this is the ACTUAL recon
# We expect this to FAIL. The failure list is the data we want.
L ">> Step 3: running 'emcmake cmake' configure pass"
L "   This is expected to fail. The failures ARE the punch-list."
L ""
Push-Location $bld
try {
    # Flags chosen to surface as many missing deps as possible without
    # accidentally succeeding via a system lib we do not actually want:
    #   -DDYN_OPENAL=OFF     don't dlopen OpenAL at runtime; force compile-time link (will fail loudly)
    #   -DDYN_FLUIDSYNTH=OFF same, for FluidSynth
    #   -DDYN_SNDFILE=OFF    same, for libsndfile
    #   -DCMAKE_BUILD_TYPE=Release  fewer debug-only deps
    $cmd = "emcmake cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DDYN_OPENAL=OFF -DDYN_FLUIDSYNTH=OFF -DDYN_SNDFILE=OFF `"$src`""
    L "   cwd: $(Get-Location)"
    L "   cmd: $cmd"
    L ""
    $cmakeOut = cmd /c "$cmd 2>&1"
    foreach ($line in $cmakeOut) { L "   | $line" }
    $exit = $LASTEXITCODE
    L ""
    L "   cmake exit code: $exit"
} finally {
    Pop-Location
}
L ""

L "=== reconnaissance complete ==="
L "Finished: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
L ""
L "NEXT: paste recon-log.txt back to Claude for triage."
