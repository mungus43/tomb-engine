# gzdoom-wasm full build (v4: auto-detect MSVC for Stage 1)
#
# v3 lesson: Stage 1 (native cmake on tools/) failed because plain PowerShell
# has no MSVC compiler on PATH -- that env only exists inside "Developer
# PowerShell for VS" or after running vcvars64.bat. Fix is to auto-locate
# Visual Studio with vswhere.exe and call vcvars64.bat inside a cmd /c that
# also runs Stage 1's cmake commands. Keeps MSVC env isolated to Stage 1 so
# it can't pollute Stage 2's emscripten setup.
#
# Usage (no admin):
#   cd D:\deck\rc\gzdoom-wasm
#   .\build.ps1
#
# Outputs:
#   tools-build\re2c\re2c.exe       host re2c (used by Stage 2)
#   tools-build\lemon\lemon.exe     host lemon
#   build\gzdoom.js / .wasm / .data on success
#   build-log.txt                   full transcript

$ErrorActionPreference = 'Continue'
$here     = $PSScriptRoot
$log      = Join-Path $here 'build-log.txt'
$src      = Join-Path $here 'gzdoom-src'
$srcTools = Join-Path $src 'tools'
$bld      = Join-Path $here 'build'
$bldTools = Join-Path $here 'tools-build'
$shimDir  = Join-Path $here 'tools-cmake-shim'

# Edit if your emsdk lives somewhere else
$emsdkRoot = 'C:\emsdk'

# Fresh log, plain UTF-8
[System.IO.File]::WriteAllText($log, "")
function L ($s) { Add-Content -Path $log -Value $s -Encoding UTF8; Write-Host $s }
function Append-Captured ($lines) {
    if ($null -eq $lines) { return }
    $joined = ($lines | Out-String).TrimEnd("`r","`n")
    Add-Content -Path $log -Value $joined -Encoding UTF8
    Write-Host $joined
}

L "=== gzdoom-wasm build (v4 two-stage + msvc auto-detect) ==="
L "Started: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
L "Source     : $src"
L "Build      : $bld"
L "Host tools : $bldTools"
L "EMSDK      : $emsdkRoot"
L ""

# ----------------------------------------------------------------------
# Stage 0 -- locate MSVC via vswhere
# ----------------------------------------------------------------------

L ">> Stage 0: locate Visual Studio toolchain"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    # vswhere also ships under Program Files (newer installers)
    $vswhere = "${env:ProgramFiles}\Microsoft Visual Studio\Installer\vswhere.exe"
}
if (-not (Test-Path $vswhere)) {
    L "   ABORT: vswhere.exe not found. Install Visual Studio Build Tools (with the C++ workload) and re-run."
    exit 6
}
$vsPath = & $vswhere -latest -prerelease -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
if (-not $vsPath) {
    L "   ABORT: vswhere found no VS install with the C++ x64 toolchain."
    L "   In Visual Studio Installer, modify the install and add 'Desktop development with C++'."
    exit 6
}
$vcvars = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) {
    L "   ABORT: vcvars64.bat not found at $vcvars."
    exit 6
}
L "   VS install : $vsPath"
L "   vcvars64   : $vcvars"
L ""

# ----------------------------------------------------------------------
# Stage 1 -- build host re2c + lemon natively (NO emcmake, MSVC env)
# ----------------------------------------------------------------------

L ">> Stage 1.0: prep tools-build/ + shim CMakeLists"
if (Test-Path $bldTools) { Remove-Item -Recurse -Force $bldTools }
New-Item -ItemType Directory -Path $bldTools | Out-Null
if (Test-Path $shimDir)  { Remove-Item -Recurse -Force $shimDir  }
New-Item -ItemType Directory -Path $shimDir  | Out-Null
# Shim CMakeLists.txt: configures ONLY re2c + lemon as host tools.
# Skips zipdir (which references parent-scope BZIP2_INCLUDE_DIR / LZMA_INCLUDE_DIR
# we don't have when tools/ is the top-level project, and which isn't needed
# for the wasm build since add_pk3() is no-op'd under EMSCRIPTEN).
$shimContent = @"
cmake_minimum_required(VERSION 3.16)
project(gzdoom_host_tools C CXX)
add_subdirectory("`${CMAKE_CURRENT_LIST_DIR}/../gzdoom-src/tools/re2c"  re2c)
add_subdirectory("`${CMAKE_CURRENT_LIST_DIR}/../gzdoom-src/tools/lemon" lemon)
"@
Set-Content -Path (Join-Path $shimDir 'CMakeLists.txt') -Value $shimContent -Encoding UTF8
L "   created $bldTools"
L "   wrote shim CMakeLists at $shimDir"
L ""

L ">> Stage 1.1: native cmake configure + build (under MSVC env)"
# Force NMake Makefiles generator -- works without ninja, deterministic.
# vcvars64 silently primes cl.exe / link.exe / nmake on PATH for this cmd subprocess only.
$stage1Batch = "call `"$vcvars`" >nul 2>&1 && cd /D `"$bldTools`" && cmake -G `"NMake Makefiles`" -DCMAKE_BUILD_TYPE=Release `"$shimDir`" && cmake --build . --config Release --target re2c lemon"
L "   cmd: $stage1Batch"
L ""
$s1Out = cmd /c "$stage1Batch 2>&1"
Append-Captured $s1Out
if ($LASTEXITCODE -ne 0) {
    L ""
    L "   ABORT: Stage 1 host build failed. Check log above for cmake/cl errors."
    exit 3
}
L ""

# Locate the produced .exe files
L ">> Stage 1.2: locate host tool binaries"
$re2cExe  = Get-ChildItem -Path $bldTools -Recurse -Filter 're2c.exe'  -ErrorAction SilentlyContinue | Select-Object -First 1
$lemonExe = Get-ChildItem -Path $bldTools -Recurse -Filter 'lemon.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $re2cExe)  { L "   ABORT: re2c.exe not found under $bldTools after build."; exit 4 }
if (-not $lemonExe) { L "   ABORT: lemon.exe not found under $bldTools after build."; exit 4 }
L "   re2c : $($re2cExe.FullName)"
L "   lemon: $($lemonExe.FullName)"

# Prepend tool dirs onto PATH so Stage 2's `COMMAND re2c ...` finds them.
$env:PATH = "$($re2cExe.Directory.FullName);$($lemonExe.Directory.FullName);$($env:PATH)"
L "   PATH prepended with tool dirs."
L ""

# ----------------------------------------------------------------------
# Stage 2 -- full wasm build via emcmake
# ----------------------------------------------------------------------

L ">> Stage 2.0: activate emsdk_env"
$emsdkEnv = Join-Path $emsdkRoot 'emsdk_env.ps1'
if (-not (Test-Path $emsdkEnv)) {
    L "   ABORT: $emsdkEnv not found. Edit `$emsdkRoot at top of this script."
    exit 1
}
$env:EMSDK_QUIET = '1'
$prevPref = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
. $emsdkEnv 2>&1 | ForEach-Object { Add-Content -Path $log -Value ($_.ToString()) -Encoding UTF8 }
$ErrorActionPreference = $prevPref

# Reassert tool dirs in case emsdk_env replaced PATH
$env:PATH = "$($re2cExe.Directory.FullName);$($lemonExe.Directory.FullName);$($env:PATH)"

$gitOk     = $null -ne (Get-Command git -ErrorAction SilentlyContinue)
$cmakeOk   = $null -ne (Get-Command cmake -ErrorAction SilentlyContinue)
$emcmakeOk = $null -ne (Get-Command emcmake -ErrorAction SilentlyContinue)
$ninjaOk   = $null -ne (Get-Command ninja -ErrorAction SilentlyContinue)
$re2cOk    = $null -ne (Get-Command re2c -ErrorAction SilentlyContinue)
$lemonOk   = $null -ne (Get-Command lemon -ErrorAction SilentlyContinue)
L "   git=$gitOk cmake=$cmakeOk emcmake=$emcmakeOk ninja=$ninjaOk re2c=$re2cOk lemon=$lemonOk"
if (-not ($gitOk -and $cmakeOk -and $emcmakeOk -and $ninjaOk -and $re2cOk -and $lemonOk)) {
    L "   ABORT: prereq missing after emsdk activation."
    exit 1
}
L ""

L ">> Stage 2.1: clean wasm build/ dir"
# Refuse to wipe build/ if a prior wasm-opt / ninja is still holding files inside.
# Last time we raced and got a TRUNCATED gzdoom.wasm. Detect by trying to open
# .ninja_lock for write -- if it errors, abort with a clear message.
if (Test-Path $bld) {
    $lockPath = Join-Path $bld '.ninja_lock'
    if (Test-Path $lockPath) {
        try {
            $fs = [System.IO.File]::Open($lockPath, 'Open', 'Write', 'None')
            $fs.Close()
        } catch {
            L "   ABORT: $lockPath is locked by another process. A prior build is still running."
            L "          Kill any leftover ninja.exe / wasm-opt.exe / node.exe and retry."
            exit 4
        }
    }
    Remove-Item -Recurse -Force $bld
}
New-Item -ItemType Directory -Path $bld | Out-Null
L "   created $bld"
L ""

L ">> Stage 2.2: emcmake configure"
Push-Location $bld
try {
    # -sJSPI=1: JavaScript Promise Integration. Native VM-stack-based suspending —
    # no asyncify trampolines, no rewind/unwind, no IGNORE_INDIRECT issues. Lets
    # the engine yield via emscripten_sleep without the workarounds asyncify forced
    # (linked=true stub, glGetProgramiv skip, SDL_GL_SwapWindow yield skip).
    # JSPI shipped stable in Chrome 125 (2024-05); RCOS targets a much newer baseline.
    # No JSPI_EXPORTS list needed — `main` is async by default, and emscripten_sleep
    # is a built-in async import.
    #
    # NOTE: dropped -fwasm-exceptions in favor of JS-emulated exceptions
    # (NO_DISABLE_EXCEPTION_CATCHING in CMakeLists.txt). wasm-exceptions cost
    # ~9x perf hit (22 FPS vs 195 baseline) due to per-function unwind metadata
    # overhead. JS exceptions only break JSPI when actively thrown during a
    # suspend — and the renderer init path no longer throws now that all
    # shaders compile cleanly. If a throw resurfaces we'll see the
    # "SuspendError: trying to suspend JS frames" again.
    $asyncifyFlags = "-sJSPI=1"
    # NO_OPENAL=OFF re-enables sound. Emscripten ships OpenAL Soft linked to Web Audio,
    # so we get audio in the browser without dlopen.
    # No -fwasm-exceptions on compile or link — back to JS-emulated exceptions
    # for the perf win. See the asyncifyFlags comment above for the rationale.
    $cfgInner = "emcmake cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DDYN_OPENAL=OFF -DDYN_FLUIDSYNTH=OFF -DDYN_SNDFILE=OFF -DNO_OPENAL=OFF -DCMAKE_EXE_LINKER_FLAGS_RELEASE=`"$asyncifyFlags`" `"$src`" 2>&1"
    L "   cwd: $(Get-Location)"
    L "   cmd: $cfgInner"
    L ""
    $cfgOut = cmd /c $cfgInner
    Append-Captured $cfgOut
    if ($LASTEXITCODE -ne 0) {
        L "   ABORT: emcmake configure failed."
        Pop-Location
        exit 5
    }
} finally {
    if ((Get-Location).Path -eq $bld) { Pop-Location }
}
L ""

# Stage 2.2.5: stage lempar.c into build/src/ so lemon can find its template.
# lemon.exe needs lempar.c in CWD when invoked. The wasm build invokes it from
# build/src/, but lempar.c only lives in tools/lemon/. Copying it here makes
# steps [37] and [39] (xlat_parser.c, zcc-parse.c) succeed.
L ">> Stage 2.2.5: stage lempar.c into build/src/"
$lemparSrc = Join-Path $src 'tools\lemon\lempar.c'
$lemparDst = Join-Path $bld 'src\lempar.c'
if (-not (Test-Path $lemparSrc)) {
    L "   ABORT: lempar.c missing at $lemparSrc"
    exit 7
}
$dstDir = Split-Path $lemparDst -Parent
if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
Copy-Item -Path $lemparSrc -Destination $lemparDst -Force
L "   copied $lemparSrc"
L "        -> $lemparDst"
L ""

L ">> Stage 2.3: ninja wasm build"
Push-Location $bld
try {
    $jobs = [Math]::Max(2, [Environment]::ProcessorCount - 1)
    $bldInner = "ninja -j $jobs 2>&1"
    L "   cwd : $(Get-Location)"
    L "   jobs: $jobs"
    L "   cmd : $bldInner"
    L ""
    $bldOut = cmd /c $bldInner
    Append-Captured $bldOut
    L ""
    L "   ninja exit code: $LASTEXITCODE"
} finally {
    if ((Get-Location).Path -eq $bld) { Pop-Location }
}
L ""

# ----------------------------------------------------------------------
# Stage 3 -- artifact inventory
# ----------------------------------------------------------------------

L ">> Stage 3: artifact inventory"
$want = @('gzdoom.js', 'gzdoom.wasm', 'gzdoom.data', 'gzdoom.html', 'gzdoom.worker.js')
foreach ($name in $want) {
    $hits = Get-ChildItem -Path $bld -Recurse -Filter $name -ErrorAction SilentlyContinue
    if ($hits) {
        foreach ($h in $hits) {
            $sizeKB = [Math]::Round($h.Length / 1KB, 1)
            L "   FOUND  $name  ($sizeKB KB)  at $($h.FullName)"
        }
    } else {
        L "   MISSING  $name"
    }
}
L ""

# Stage 3.5: structural sanity-check the wasm. A truncated wasm (which is what
# bit us last build) will pass the "FOUND" check above but fail to instantiate
# in the browser. We walk the module-level section table; if we run off the end
# of the file before the last section finishes, the file is corrupt.
L ">> Stage 3.5: wasm structural sanity check"
$wasmPath = Join-Path $bld 'gzdoom.wasm'
if (Test-Path $wasmPath) {
    $bytes = [System.IO.File]::ReadAllBytes($wasmPath)
    $size  = $bytes.Length
    $ok    = $true
    if ($size -lt 8 -or $bytes[0] -ne 0x00 -or $bytes[1] -ne 0x61 -or $bytes[2] -ne 0x73 -or $bytes[3] -ne 0x6d) {
        L "   FAIL: bad magic, not a wasm file"
        $ok = $false
    } else {
        $i = 8
        $sect = 0
        while ($i -lt $size -and $ok) {
            $sectId = $bytes[$i]; $i++
            $len = 0; $shift = 0
            while ($true) {
                if ($i -ge $size) { L "   FAIL: ran off end while reading LEB length"; $ok = $false; break }
                $b = $bytes[$i]; $i++
                $len = $len -bor (($b -band 0x7f) -shl $shift)
                if ($b -lt 0x80) { break }
                $shift += 7
            }
            if (-not $ok) { break }
            if ($i + $len -gt $size) {
                L ("   FAIL: section {0} claims {1} payload bytes but only {2} remain (file size {3}, declared end {4})" -f $sectId, $len, ($size - $i), $size, ($i + $len))
                $ok = $false
                break
            }
            $i += $len
            $sect++
        }
        if ($ok) { L "   OK: $sect sections walked, file ends cleanly at $i bytes" }
    }
    if (-not $ok) {
        L "   ABORT: wasm is structurally invalid -- DO NOT STAGE."
        exit 9
    }
} else {
    L "   FAIL: $wasmPath missing"
    exit 8
}
L ""

L "=== build complete ==="
L "Finished: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
L ""
L "NEXT: drop 'log is ready' in chat. I'll read build-log.txt off disk."
