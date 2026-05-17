# gzdoom-wasm

**GZDoom in the browser.** A WebAssembly port of the [GZDoom](https://zdoom.org/) source port (pinned to `g4.11.3`) that runs at ~100 FPS on a single canvas tag, renders through WebGL2, and pipes audio through Web Audio via OpenAL Soft. No native plugin, no server-side rendering, no proxy — the engine boots, mounts WADs into MEMFS, and drives the canvas directly.

It plays MAP01 of FreeDM out of the box. It also loads heavy mods: Brutal Doom v22 (159 MB pk3) sits on top of FreeDM and runs at 81 FPS at 480x300 with 507 textures, 15 GL buffers, and 8 framebuffers live.

```
   IWAD          PWAD                       FPS @ 480x300    notes
   freedm.wad    -                          ~100             MAP01 Antechamber, baseline
   freedm.wad    brutal22test6.pk3          ~81              gore/SFX/HUD shaders all working
   doom2.wad     -                          ~95              sprite-heavy reference (Tier 2)
```

Live demo: **https://staging.rejectedcoins.com/gzdoom**

---

## Table of contents

- [Why this exists](#why-this-exists)
- [Quick start](#quick-start)
- [Browser support](#browser-support)
- [Technical highlights](#technical-highlights)
  - [The aBoneSelector bug](#the-abonesector-bug-and-its-sibling)
  - [GLES to GL3+ renderer swap](#gles-to-gl3-renderer-swap)
  - [Asyncify to JSPI](#asyncify-to-jspi)
  - [The performance hunt: 22 to 100+ FPS](#the-performance-hunt-22-to-100-fps)
  - [Audio: OpenAL Soft to Web Audio](#audio-openal-soft-to-web-audio)
- [What's in the box](#whats-in-the-box)
- [Embedding in your own page](#embedding-in-your-own-page)
- [Mod compatibility notes](#mod-compatibility-notes)
- [Status and roadmap](#status-and-roadmap)
- [License and bundling](#license-and-bundling)
- [Acknowledgments](#acknowledgments)

---

## Why this exists

GZDoom is a modern Doom source port with a huge living mod ecosystem — Brutal Doom, Beautiful Doom, Project Brutality, plus every UDMF / DECORATE / ZScript / ACS map made in the last decade. None of that runs on PrBoom or webprboom; the format support just isn't there. The existing in-browser Doom ports all stop at vanilla Doom 2's feature set.

This port closes that gap. UDMF maps with ZDoom specials, ZScript actors, MAPINFO, and full GZDoom rendering — all in a tab, no install, no plugin.

The original itch was a fictional retro-computing OS ("RCOS", a [Rejected Coins LLC](https://rejectedcoins.com) project) needing to play TOMB.BAS, a UDMF map. webprboom couldn't load it. So GZDoom got ported instead.

The result turned out to be generally useful, so it's getting released.

---

## Quick start

### Run the prebuilt demo

The fastest path: clone, drop in a free IWAD, serve, play.

```bash
git clone https://github.com/<user>/gzdoom-wasm.git
cd gzdoom-wasm/demo
# FreeDM is bundled as a free-software IWAD; commercial DOOM.WAD/DOOM2.WAD
# are NOT included and must NOT be redistributed with this repo.
# Drop them in here yourself if you own them and edit demo/index.html line ~472.

# Any static server works. The demo includes a run-server.cmd / run-server.sh:
./run-server.sh        # Linux/macOS
run-server.cmd         # Windows
# or:
python3 -m http.server 8765
```

Open `http://localhost:8765/` in Chrome 119+ or Edge 119+, click **Boot GZDoom**, click the canvas to capture mouse, play.

The demo includes the prebuilt `gzdoom.js` + `gzdoom.wasm` artifacts so you do not need to compile anything to try the port.

### Build from source

The build is a two-stage CMake dance: stage 1 compiles `re2c` and `lemon` natively (they generate parser sources at build time), stage 2 runs `emcmake` to produce the wasm.

**Prerequisites:**

- [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) (`emsdk install latest` then `emsdk activate latest`)
- Ninja, CMake 3.16+, Git
- A C++ host toolchain: MSVC on Windows (Visual Studio Build Tools with the C++ workload), GCC or Clang on Linux/macOS

**On Windows** (the supported build host):

```cmd
cd D:\path\to\gzdoom-wasm
go.bat
```

`go.bat` shells into `build.ps1`, which:

1. Locates Visual Studio via `vswhere.exe` and primes the MSVC environment with `vcvars64.bat`.
2. Builds `re2c.exe` and `lemon.exe` natively into `tools-build/` using NMake Makefiles.
3. Activates `emsdk_env.ps1` (edit `$emsdkRoot` at the top of `build.ps1` if yours isn't `C:\emsdk`).
4. Stages `lempar.c` into `build/src/` so `lemon` finds its template at parser-gen time.
5. Runs `emcmake cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DNO_OPENAL=OFF -DCMAKE_EXE_LINKER_FLAGS_RELEASE="-sJSPI=1" gzdoom-src`.
6. Runs `ninja` with `-j (ncpu-1)`.
7. Walks the produced `gzdoom.wasm` byte-by-byte through its module sections — if any section overruns the file, the build aborts. (We hit a truncated-wasm race once with stale `wasm-opt` holding files inside `build/`; this catches it.)

A full clean build takes ~25 minutes on a recent laptop. Iterative rebuilds after a single-file patch are ~3-5 minutes.

Output: `build/gzdoom.js`, `build/gzdoom.wasm`, `build/gzdoom.data`, plus a transcript at `build-log.txt`.

To stage into the demo:

```powershell
Copy-Item .\build\gzdoom.* .\demo\ -Force
```

**On Linux/macOS:** there is no `build.sh` yet — the build was developed on Windows. The CMake invocation should translate directly; `build.ps1` lines 204-218 show the exact `emcmake` arguments. Patches welcome.

---

## Browser support

JSPI (JavaScript Promise Integration) is the gate. The port suspends on emscripten's main loop via JSPI rather than Asyncify (see [Asyncify to JSPI](#asyncify-to-jspi) for why).

| Browser              | Status         | Notes                                                                 |
|----------------------|----------------|-----------------------------------------------------------------------|
| Chrome 125+          | Fully working  | JSPI shipped stable here; primary development target.                 |
| Chrome 119-124       | Working        | JSPI behind `chrome://flags/#enable-experimental-webassembly-jspi`.   |
| Edge 119+            | Working        | Same JSPI status as Chrome.                                           |
| Firefox              | TBD            | JSPI was behind `javascript.options.wasm_js_promise_integration` last we checked. Probably works. Untested. |
| Safari               | TBD            | JSPI support is more recent and less mature. Untested.                |
| Mobile (Chrome/Edge) | Works          | Touch input is not yet wired; keyboard+mouse only.                    |

WebGL2 is mandatory. The port uses `glVertexAttribI4ui`, integer attribute locations, GLSL ES 3.00 — none of that works on WebGL1.

For cross-origin isolation: if you bundle the demo into a larger site and want SharedArrayBuffer / pthreads later, you'll need `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on your responses. The current build is single-threaded and does **not** require COOP/COEP.

---

## Technical highlights

This is a real renderer-internals port. Six engine bugs and three architectural rewrites are documented below. If you only read one section, read the first.

### The aBoneSelector bug, and its sibling

This is the headline diagnostic story.

**Symptom:** engine boots. ZScript compiles. WADs mount. Map loads. The canvas stays black. No errors in the console. No exception in the wasm. ~78 world draws per frame are being submitted; the present pass copies the scene framebuffer to the canvas every frame; the canvas is black because the scene framebuffer is black because every single one of those 78 draws is silently failing.

**The clue:** hooking `gl.drawElements` at `getContext` time and counting `gl.getError()` after each call showed an error rate of 100%. Every draw was returning `GL_INVALID_OPERATION` (0x0502). WebGL2's strict mode raises this error and discards the draw — quietly.

**The cause:** `gzdoom-src/wadsrc/static/shaders_gles/glsl/main.vp` declares

```glsl
attribute uvec4 aBoneSelector;  // location 8
```

GZDoom's GLES renderer was written for GLES 3.0, where this binds to attribute location 8 via `glBindAttribLocation`. Our GLSL 100→300-es compat preamble preserves the binding, so under WebGL2 it stays as an **active integer vertex attribute** at location 8.

For static (non-skinned) geometry — which is most of a Doom map — the engine doesn't enable location 8 in the VAO. Per OpenGL/WebGL2 spec, if an attribute is active but its array isn't enabled, draws read the **current vertex attribute value** from context-level state. For integer attributes, that current value is **undefined** until you set it with `glVertexAttribI4ui` (or one of its siblings).

WebGL2 in strict mode raises `INVALID_OPERATION` on every draw that hits an active integer attribute with no enabled array and no explicit current value. ~78 world draws per frame, every frame, silently dropped.

**The fix:**

```cpp
// gzdoom-src/src/common/rendering/gles/gles_system.cpp, in InitGLES,
// right after VAO setup, under #ifdef __EMSCRIPTEN__:
glVertexAttribI4ui(8, 0, 0, 0, 0);   // aBoneSelector default
```

One line. Engine renders.

**Except it didn't.** The world was still black after that fix — but now without the GL errors. The draws were succeeding; they just weren't producing visible fragments.

**The sibling bug:** `aBoneWeight` is the **float** vec4 at location 7. WebGL2's default current value for an unset float attribute is `(0, 0, 0, 1)`. The skinning gate at `main.vp:172` reads:

```glsl
if (aBoneWeight != vec4(0.0)) {
    // skinning path: blend by bones[uBoneIndexBase + int(boneIndex.x)]
    ...
}
```

With the default `(0, 0, 0, 1)`, the gate is true for **every static-geometry vertex**. The shader then looks up `bones[0]`, which is `mat4(0)` at init for non-skinned models. Every vertex collapses to the origin. Geometry rasterizes — into a degenerate point. Hence: black.

**The fix, part two:**

```cpp
glVertexAttrib4f(7, 0.0f, 0.0f, 0.0f, 0.0f);   // aBoneWeight default
```

World renders.

**Why this matters beyond gzdoom-wasm:** the same bug pattern appears at *two different renderer call sites* — once in the GLES renderer (`gles_system.cpp`) and again, identically, in the GL3+ renderer (`gl_renderer.cpp`). Same shader, same VAO assumption, same WebGL2-strict-mode failure. This is a structural assumption about default attribute values that holds on desktop OpenGL drivers (which are forgiving about default integer values) but does not hold under WebGL2 (which is strict, by design, to give ANGLE a defensible spec).

Anyone porting GZDoom or any similar GLES-targeting renderer to WebGL2 will hit this. There is an open question of whether to upstream it; the patches under `#ifdef __EMSCRIPTEN__` are conservative, but the bug is arguably an engine bug, not a porting workaround.

### GLES to GL3+ renderer swap

GZDoom ships two renderer backends: `gles` (GL ES 2.0/3.0 target, intended for low-end hardware and mobile) and `gl` (OpenGL 3.3 core target, the desktop default). The first version of this port targeted `gles` — the obvious choice, since WebGL2 ≈ GLES 3.0 on paper.

That turned out to be wrong in the ways that matter. The GLES renderer relies on:

- **`glBindAttribLocation` defaulting attributes by name.** Works on most native GLES drivers, fails under WebGL2 strict mode for the reasons described above.
- **Default values for active integer attributes.** Defined as `(0,0,0,0)` on most desktop GL drivers, undefined under WebGL2.
- **Uniform default values for integer types.** WebGL2 zero-initializes uniforms, but the GLES renderer assumes specific defaults that aren't portable.

The GL3+ renderer is closer to a clean fit. It uses explicit `layout(location=N)` for attributes, real UBOs, no reliance on legacy defaults. The swap was:

```
+vid_preferbackend 0    # 0 = GL3+ (gl_renderer), 1 = GLES (gles_system, legacy)
```

…plus ~25-28 patches across the engine for the WebGL2 strict-mode bumps that surfaced as a result. Net effect: all 50 material shaders in `wadsrc/static/shaders/` compile + link cleanly under WebGL2.

### Asyncify to JSPI

GZDoom's main loop blocks. `D_DoomLoop` calls `I_WaitForTic`, which sleeps until the next gametic boundary. The renderer calls `glGetProgramiv(LINK_STATUS)` after a link, which on some drivers is synchronous and can take milliseconds. `SDL_GL_SwapWindow` blocks on vsync. None of that is allowed in a browser tab without yielding to the event loop.

**First approach: Asyncify.** Emscripten's `-sASYNCIFY=1` rewrites every function in the call graph that might reach a blocking call, threading suspend/resume machinery through the entire program. It works, but:

- **Wasm size: +40%.** Every async-reachable function gets a trampoline and a state machine.
- **Runtime cost: -25% FPS.** Suspend/resume thrashes the wasm stack on every yield.
- **Real `glGetProgramiv` doesn't fit cleanly.** The asyncify-era port stubbed out `glGetProgramiv(LINK_STATUS)` to return `linked = true` unconditionally because it couldn't suspend cleanly across the WebGL boundary. Real shader link errors were silently swallowed for months.
- **`emscripten_sleep` of 0ms costs more than it should** because of the per-call rewind/unwind buffer cycling.

**Second approach: JSPI (JavaScript Promise Integration).** Native VM-stack-based suspending. No wasm rewrites, no trampolines. The wasm yields by calling `emscripten_sleep`, which under JSPI awaits a Promise that V8 resolves on the next microtask.

```
-sJSPI=1
```

Build flag, that's it. (No `JSPI_EXPORTS` list needed — `main` is async by default, and `emscripten_sleep` is a built-in async import.)

Results, measured side-by-side on the same scene (FreeDM MAP01 at 320x200):

| metric                  | Asyncify | JSPI    | delta  |
|-------------------------|----------|---------|--------|
| `gzdoom.wasm` size      | 16.0 MB  | 10.1 MB | **-37%** |
| FPS (calibrated)        | 81       | 101     | **+25%** |
| Real `glGetProgramiv` working | no | yes    | restored |
| Real `glGetShaderInfoLog` working | no | yes | restored |

The link-status restoration is worth a sentence on its own. Under the asyncify build, *every shader was reported as successfully linked* — even the ones that didn't compile. We were running on whatever subset of the program pipeline still worked, and the failures were invisible. JSPI restored real status queries; we found and fixed three latent shader bugs in the first 48 hours after the swap.

JSPI requires Chrome 125+ stable, or 119-124 behind a flag. The browser-support table above has the details.

### The performance hunt: 22 to 100+ FPS

Three independent wins, each accidentally hiding the others.

**Win 1: canvas size.** First playable build rendered at 2752x1152 — the SDL resize path in the GL3+ renderer expands the canvas to the browser viewport on the first present. That's 3.17M pixels per frame, ~20x the fillrate of native Doom resolution. Fixed by pinning the canvas backbuffer to **320x200** (native Doom) and using CSS `image-rendering: pixelated` to upscale to 480x300 via nearest-neighbor 1.5x. 64,000 pixels per frame instead of 3.17M. The pixelated look is also the *correct* aesthetic — Doom was never meant to be smooth.

**Win 2: dropped `-fwasm-exceptions`.** Native wasm exceptions sound like the right call (lower overhead than JS-emulated). Empirically: ~9x perf hit on this codebase (22 FPS vs. 195 baseline on a trivial scene), because the per-function unwind metadata blows up code size and the JIT has a harder time optimizing across function boundaries when every call site has an unwind table. Switched back to JS-emulated exceptions (`-sNO_DISABLE_EXCEPTION_CATCHING`). The renderer init path doesn't throw anymore (now that shaders all compile), so the only cost is unused unwind tables that the wasm validator skips.

**Win 3: per-frame Printf spam.** `I_WaitForTic` in `i_time.cpp` was firing `Printf` 35 times per second. `D_Display` in `d_main.cpp` was logging gate states. Each `Printf` call:

1. Crosses the wasm-to-JS boundary.
2. Marshals a C string into a JS string.
3. Appends a `<div>` to the on-page log element.
4. Triggers a CSS layout if the log was visible.

35 of those per second, plus the gate spam, plus a per-frame WTRACE macro in four files (`gles_postprocess.cpp`, `gles_framebuffer.cpp`, `gles_renderbuffers.cpp`, `sdlglvideo.cpp`) that fired ~17 traces per frame from `CopyToBackbuffer` alone. Total: >1000 console writes per second at 60 FPS.

Patched to no-ops gated under `#if 0 && defined(__EMSCRIPTEN__)` so they're one-line re-enables for debugging. 12.5x speedup on initial render rate. 5x speedup combined with the other wins.

### Audio: OpenAL Soft to Web Audio

Emscripten ships `-sUSE_OPENAL=1` which provides a libopenal-compatible emulation backed by Web Audio. The challenge wasn't enabling it; it was making GZDoom's `oalsound.cpp` compile against emscripten's stripped system AL headers.

Emscripten's `<AL/al.h>` is a subset of OpenAL Soft's headers and **doesn't define `AL_APIENTRY`** (the calling-convention macro). GZDoom's `oalsound.cpp` uses it directly. Fix: point `OPENAL_INCLUDE_DIR` at the bundled headers GZDoom ships under `gzdoom-src/include/openal/` so the engine sees the full API surface, while emscripten's runtime still provides the implementation.

Two more `oalsound.cpp` patches were needed:

- **`numMono` / `numStereo` clamps.** Emscripten's libopenal returns `INT_MAX` for `AL_MONO_SOURCES` / `AL_STEREO_SOURCES`. GZDoom then tries to allocate that many channels and integer-overflows. Patched to `min(64, value)`.
- **Init order.** GZDoom queries device capabilities before fully constructing the AL context. Works on native OpenAL Soft; emscripten's emulation needs the context first. Reordered.

Result: SFX work end-to-end. Pistol fires, doors open, monsters growl, footsteps. The lag is real (Web Audio adds ~20-40ms of perceptible latency) but it's playable.

**Music is a known gap.** GZDoom delegates music to ZMusic, which depends on FluidSynth (for MIDI) and a long tail of decoders. The current build links a stub ZMusic that returns "no backend" cleanly — the engine notices, logs once, and continues without music. The path forward is a JS-side MUS player feeding Web Audio directly; a sketch is in `docs/music-design.md` (not yet implemented).

---

## What's in the box

| Path                              | What it is                                                                              |
|-----------------------------------|-----------------------------------------------------------------------------------------|
| `gzdoom-src/`                     | Patched GZDoom source at `g4.11.3`. Currently a tree, not a submodule.                  |
| `gzdoom-src/src/common/rendering/gles/gles_system.cpp` | aBoneSelector/aBoneWeight default values fix.                      |
| `gzdoom-src/src/common/rendering/gl/...`              | GL3+ renderer (the path actually used at runtime).                  |
| `gzdoom-src/src/sound/oalsound.cpp`                   | Emscripten OpenAL header fixes + INT_MAX channel clamps.            |
| `gzdoom-src/src/d_main.cpp`, `i_time.cpp`             | Printf no-ops on hot paths under `__EMSCRIPTEN__`.                  |
| `patches/`                        | Standalone patches you can `git apply` if running against pristine GZDoom upstream.     |
| `patches/01-diagnose-creg-walk.patch` | ZScript class-registry diagnostic (the `creg` linker-section walk).                 |
| `patches/02-fix-creg-keep-alive.patch` | `__attribute__((used))` on per-class `RegistrationInfoPtr` so wasm-ld doesn't strip it. |
| `build.ps1`                       | Two-stage CMake driver. MSVC for host tools, emcmake for wasm.                          |
| `go.bat`                          | Double-click launcher around `build.ps1`.                                               |
| `demo/`                           | Smoke-test harness — `index.html`, `run-server.cmd`, FreeDM IWAD, and the prebuilt wasm.|
| `demo/index.html`                 | Boot logic, canvas pin, MEMFS WAD mount, GL call hooks, in-page FPS HUD, log capture.   |
| `TEST_MATRIX.md`                  | Compatibility tier ladder (vanilla → Brutal Doom → MD3 models).                         |
| `build-log.txt`                   | Last-build transcript (generated, gitignored).                                          |

---

## Embedding in your own page

The minimum-viable embed is roughly:

```html
<canvas id="canvas" width="320" height="200" tabindex="1"></canvas>
<script>
  var Module = {
    canvas: document.getElementById('canvas'),
    arguments: [
      '-iwad', 'freedm.wad',
      '-warp', '01',
      '+vid_preferbackend', '0',  // 0 = GL3+ (the path that works)
    ],
    preRun: [function () {
      // Fetch WADs and copy them into MEMFS before main() runs.
      // The demo's index.html shows the full fetch + Module.FS.writeFile pattern.
    }],
  };
</script>
<script src="gzdoom.js"></script>
```

**Required setup:**

1. Serve `gzdoom.js`, `gzdoom.wasm`, and any WADs from the same origin (or with the correct CORS headers).
2. Mount your IWAD into MEMFS in `preRun` via `Module.FS.writeFile('/freedm.wad', bytes)` before `main()` runs.
3. Pin the canvas backbuffer size — see `demo/index.html` lines 143-196 for the `Object.defineProperty` clamp that prevents SDL from resizing the canvas to the viewport.
4. Lock down user-facing CVars (`vid_fps`, `vid_fullscreen`, `vid_rendermode`, etc.) if you're embedding in a UI where you don't want users escaping into the GZDoom console.

`demo/index.html` also installs a `MessageChannel`-based unthrottle for `setTimeout(_, 0)` so the engine keeps running when the tab is backgrounded — useful for a test rig, **not appropriate for production**. Strip that block before shipping.

---

## Mod compatibility notes

The TEST_MATRIX.md file in this repo tracks the compatibility ladder. Highlights:

- **FreeDM MAP01** — baseline. Renders, plays, sound works.
- **Vanilla DOOM2.WAD** — works the same as FreeDM. Sprites, animated textures, monsters, weapons all rendered correctly. (Bring your own IWAD; commercial Doom is not bundled.)
- **Brutal Doom v22** (`brutal22test6.pk3`, 159 MB) — loads on top of FreeDM, runs at ~81 FPS. Gore overlays render, custom HUD works, weapon SFX play. **Known issue:** Brutal Doom's bloom toggle hits a GLSL ES 3.00 pattern our PatchShader substitution lambda doesn't yet cover — keep bloom OFF. (Fix tracked.)
- **MD3 / IQM skinned models** — untested at time of writing. Our `aBoneSelector` patch makes the skinning gate skip for static geometry; for actual skinned models, the gate is supposed to fire and `bones[]` must be a real transform. There's a real chance of a sibling bug here. Tier 4 on the test matrix.
- **Project Brutality, custom shader-heavy WADs** — likely partial. Our 100→300-es preamble handles `attribute`, `varying`, `texture2D`, `gl_FragColor`, precision quals, but does not handle `gl_FragData[N]` (legacy MRT), `discard` in vertex shaders, or `texture2DProj`. PRs welcome.

---

## Hosting / deployment

The Python quick-start above "just works" because `python -m http.server`
serves bytes raw. Production serving needs two things right, or `Play FreeDM`
will hang silently or throw `SuspendError: trying to suspend JS frames`
mid-init.

### 1. Don't compress `.wasm` (or the WAD/PK3 files)

Most CDNs and web servers auto-compress `application/wasm` with brotli/gzip.
Emscripten's asyncify-driven streaming instantiation breaks on encoded
responses in subtle ways — the picker shows, the click registers, then the
engine throws `SuspendError` deep in the C++ exception path.

- **Cloudflare**: set `Cache-Control: no-transform` on `/path/to/demo/*`
  responses (Worker or Page Rule)
- **nginx**: `gzip off;` inside the `demo/` location block, or exclude
  `application/wasm` from `gzip_types`
- **Caddy**: `encode` directive — exclude `*.wasm`, `*.wad`, `*.pk3`
- **Apache**: `Header set Cache-Control "no-transform"` inside
  `<FilesMatch "\.(wasm|wad|pk3)$">`

### 2. COOP / COEP headers are NOT required

The engine runs on Emscripten asyncify, not pthreads, so it does NOT use
`SharedArrayBuffer`. You don't need `Cross-Origin-Opener-Policy` or
`Cross-Origin-Embedder-Policy`. Setting them anyway works, but it's pointless
complexity that breaks unrelated embeds. The original port plan called for
pthreads — the implementation ended up asyncify; this note corrects the
record.

### 3. Cache-busting via `?cb=Date.now()`

The smoke harness appends `?cb=<timestamp>` to every asset fetch. This
intentionally bypasses every cache layer (browser, CDN, edge) so reloads
always get fresh bytes — useful when iterating on builds, expensive at
scale. If you put this in front of real traffic and want CDN caching to
work, either strip the `?cb=` at your edge before the upstream fetch, or
remove the `locateFile` override in `demo/index.html` (line ~870).

---

## Status and roadmap

**Working today (v1.0):**

- Engine renders FreeDM MAP01 and Brutal Doom v22 at 80-100 FPS at 480x300.
- Keyboard and mouse input forwarded; mouse capture on canvas click.
- SFX via OpenAL Soft → Web Audio.
- ZScript / DECORATE / MAPINFO / UDMF all loading and executing.
- IDBFS savegames (engine-side; demo doesn't expose UI for them yet).

**Work-in-progress:**

- Music — JS-side MUS player via Web Audio synth. Engine cleanly degrades to "no backend" until this lands.
- MD3 / IQM skinned model rendering — patch is structurally right for static geometry; skinned needs validation. Tier 4 test on the matrix.
- Brutal Doom bloom shader — extend the PatchShader float-substitution lambda for the GLSL ES 3.00 pattern it uses.

**Future (v1.1+):**

- Touch input for mobile.
- Threading via Emscripten pthreads (needs COOP/COEP, single-threaded works for now).
- Vulkan-via-WebGPU exploration when the WebGPU baseline is wider.
- Upstream the `aBoneSelector` / `aBoneWeight` patches as an unconditional fix (they're correct on desktop too — desktop drivers just don't notice).

**Build host:**

- Windows + MSVC is the supported and tested host.
- Linux/macOS builds should work — `build.ps1` is essentially documentation of the CMake invocation. A `build.sh` would be a welcome contribution.

---

## License and bundling

**Source code: GPLv3.** Inherited from GZDoom (`gzdoom-src/LICENSE`, `gzdoom-src/docs/licenses/gpl.txt`). Any fork or derivative must remain GPLv3 and include the source.

**Bundled WADs:**

- **FreeDM** (`demo/freedm.wad`) — free-software IWAD under the modified BSD license. Bundled and redistributable. © Freedoom team.
- **Commercial IWADs are NOT bundled.** `DOOM.WAD`, `DOOM2.WAD`, `PLUTONIA.WAD`, `TNT.WAD`, etc. are id Software's property and **must not** be redistributed with this repo. If you own them you can drop them into `demo/` and edit `demo/index.html`'s boot arguments to load them.

**Third-party libraries:** GZDoom links a long list of permissively-licensed C libraries (zlib, bzip2, libsndfile, etc.). Their licenses are intact under `gzdoom-src/docs/licenses/`.

**Brutal Doom and other PWADs** referenced in test logs are not bundled. Get them from their original authors / [ModDB](https://www.moddb.com/).

---

## Acknowledgments

- **The GZDoom team** — Graf Zahl, Rachael Alexanderson, and contributors. This port is ~25-28 patches on top of a 4.11.3 release that already does the hard work.
- **The ZDoom community** — for two decades of source-port development, the ZScript / DECORATE / MAPINFO surface area, and the doc trail that made every renderer-internals dive tractable.
- **The Emscripten team** — `-sUSE_OPENAL=1`, `-sJSPI=1`, MEMFS, IDBFS, the whole toolchain. None of this exists without it.
- **The Freedoom project** — for FreeDM, a genuinely good free-software IWAD that made this releasable without commercial-IWAD encumbrance.
- **id Software** — for releasing the Doom source in 1997 and making thirty years of derivative work possible.

---

## Citing / reading more

If the `aBoneSelector` bug is useful to you in your own GZDoom-on-WebGL2 port, the diagnostic pattern was:

1. Hook `gl.drawElements` at `getContext` time. Count `gl.getError()` after each call. If error rate is non-zero, you have a draw-time problem.
2. If `INVALID_OPERATION`, inspect every active attribute on the program. For each integer attribute (type `unsigned int`, `int`, or any `uvec*`/`ivec*`), check whether its array is enabled in the bound VAO. If not, you need a `glVertexAttribI4*` call to set the current value.
3. If geometry then renders but pixels are wrong, check float attribute defaults the same way — `glVertexAttrib4f` is the call. WebGL2's defaults (`(0,0,0,1)`) bite anywhere a shader compares to `vec4(0.0)`.

Open an issue or a PR if you find a parallel bug; this port is happy to absorb fixes.

---

*Built by [Rejected Coins LLC](https://rejectedcoins.com). Released under GPLv3.*
