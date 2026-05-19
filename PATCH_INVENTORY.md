# Patch Inventory

Every modification this project made to stock GZDoom 4.11.3 to get a working
WebAssembly + WebGL2 build. All engine-side changes are guarded by
`#ifdef __EMSCRIPTEN__` (or equivalent CMake `if(EMSCRIPTEN)` blocks) so the
desktop build is a no-op.

The engine source lives in the sibling fork `rejectedcoins/gzdoom` (branch
to be named `wasm-port`). This file is the apply-checklist: someone walking
a clean `g4.11.3` checkout into our fork should be able to find every
insertion point from the descriptions here.

Paths are relative to the engine root (`gzdoom-src/` in this dev tree).
Line ranges are approximate — exact lines drift with surrounding edits.

---

## Renderer — GLES backend (`vid_preferbackend 1`)

**The shipping default path** (since 2026-05-19). A/B'd against GL3+
under the worker harness on idle MAP01: GLES sustained 70 FPS (capped by
`vid_maxfps`), GL3+ topped out at ~40 FPS. Per-draw cost is materially
lower on GLES, presumably because WebGL2 drivers are GLES-shaped
internally and the GLES path skips state-management abstraction the GL3+
path adds. Earlier docs in this file claimed GL3+ was the shipping path
on the theory that WebGL2 maps closer to GL 3.3 core; measurement
contradicted that on this hardware.

### `src/common/rendering/gles/gles_system.cpp`
- **L153–174** — In `InitGLES`, after VAO setup, call
  `glVertexAttribI4ui(8, 0, 0, 0, 0)` (`aBoneSelector` uvec4) and
  `glVertexAttrib4f(7, 0, 0, 0, 0)` (`aBoneWeight` vec4). WebGL2 strict mode
  raises `GL_INVALID_OPERATION` on every draw if an active integer attribute
  has no integer current value. This is the headline bug.
- **L211–225** — Override GLES capability detection: force
  `shaderVersionString = "300 es"`, `depthStencilAvailable = true`,
  `npotAvailable = true`. WebGL2 actually provides these but the
  capability-probe code reads back as "GLES 2".

### `src/common/rendering/gles/gles_shader.cpp`
- **GLSL preamble shim** — `#define varying in/out`, `#define attribute in`,
  `#define texture2D texture`, define `gl_FragColor`. Lets stock
  GLSL ES 1.0 shaders compile against the 300 ES backend.
- **~L550** — Stub `linked = true` skipping the real `glGetProgramiv`
  link-status check. Asyncify workaround (the call hung in the drain).
  *Should be removed under JSPI.*

### `src/common/rendering/gles/gles_shaderprogram.cpp`
- **L260–267** — Same GLSL preamble shim, applied to post-process shaders.
- **L165** — Skip the `glGetProgramiv(LINK_STATUS)` block on Emscripten
  (same asyncify-drain reason as above).

### `src/common/rendering/gles/gles_hwtexture.cpp`
- **L144–172** — BGRA→RGBA byte-swap on game texture upload. WebGL2 has no
  `GL_BGRA`, so the swap has to happen host-side via `malloc + copy`.

### `src/common/rendering/gles/gles_renderbuffers.cpp`
- **L235–244** — Force sized internal format `GL_RGBA8` for pipeline
  textures (WebGL2 rejects unsized internal formats for renderbuffer-backed
  textures).
- **L295–298** — Use `GL_DEPTH_STENCIL_ATTACHMENT` for the combined
  depth-stencil renderbuffer.
- **L34–42** — `WTRACE` macro neutered to no-op (was `fprintf+fflush` per
  frame; cost ~17 traces/frame from `CopyToBackbuffer` alone).

### `src/common/rendering/gles/gles_postprocess.cpp`
- **L39–48** — `WTRACE` macro no-op (same reason).

### `src/common/rendering/gles/gles_framebuffer.cpp`
- **L42–50** — `WTRACE` macro no-op (same reason).

---

## Renderer — GL3+ backend (`vid_preferbackend 0`, fallback)

The non-default path. Kept in the tree as a fallback / diagnostic
(`?glb=gl3` in the smoke harness URL flips to it). The patches below
are still required for GL3+ to *function* under WebGL2 — what changed
in 2026-05-19 was the perf verdict, not the correctness work. WebGL2
maps onto GL 3.3 core cleanly enough that this renderer works; it just
costs more per draw than the GLES path on real browser drivers.

### `src/common/rendering/gl/gl_renderer.cpp`
- **L85–145** — In `FGLRenderer::Initialize`, the same
  `glVertexAttribI4ui(8, ...)` + `glVertexAttrib4f(7, ...)` calls as the
  GLES path, plus a one-line `Printf` confirming the patch fired. Same bug,
  separate init site.

### `src/common/rendering/gl/gl_shader.cpp`
- Preamble injection so the same 100→300-es shim works against the GL3+
  shader pipeline.

### `src/common/rendering/gl/gl_shaderprogram.cpp`
- Mirror of `gles_shaderprogram.cpp` for the GL3+ post-process pipeline.

### `src/common/rendering/gl/gl_hwtexture.cpp` + `gl_hwtexture.h`
- BGRA→RGBA byte-swap path for the GL3+ texture uploader, matching the
  GLES one.

### `src/common/rendering/gl/gl_renderbuffers.cpp`
- Sized internal formats + `GL_DEPTH_STENCIL_ATTACHMENT` analogues for the
  GL3+ pipeline. Texture-leak fix at `CreatePipeline` (CYCLE 11 comment).

### `src/common/rendering/gl/gl_postprocessstate.cpp`
- WebGL2-strict-mode adjustments to PP state save/restore (the desktop GL
  fast path elides some calls WebGL2 still expects).

### `src/common/rendering/gl/gl_renderstate.cpp`
- Render-state diffs to handle integer uniforms whose defaults aren't zero
  under WebGL2.

### `src/common/rendering/gl/gl_buffers.cpp` + `gl_buffers.h`
- Buffer-binding workarounds where WebGL2 differs from desktop GL3 (no
  shared CPU pointer, persistent mapping limitations).

### `src/common/rendering/gl/gl_stereo3d.cpp`
- Stereo presentation path skipped under Emscripten (no real fullscreen,
  no swap-chain control).

### `src/common/rendering/gl/gl_framebuffer.cpp`
- Present-pass adjustments — `glBlitFramebuffer` instead of the shader-quad
  fallback where WebGL2 supports it.

### `src/common/rendering/gl_load/gl_interface.cpp`
- GL loader: force-report the WebGL2 extension set as the GL3+ extension
  set so the engine's capability gates take the right branches.

---

## Shader source

### `wadsrc/static/shaders/glsl/main.fp` and `main.vp`
No `__EMSCRIPTEN__` guards (shader source can't `#ifdef` on host defines),
but the engine-side `gles_shader.cpp` / `gl_shader.cpp` preamble does the
syntax conversion at link time. The skinning gate in `main.vp:172`
(`if (aBoneWeight != vec4(0.0))`) is unmodified — what we patched was the
context default of `aBoneWeight`, so static geometry takes the false
branch.

---

## SDL / platform

### `src/common/platform/posix/sdl/sdlglvideo.cpp`
- **L51–60** — `WTRACE` macro no-op, with `#include <emscripten.h>` block
  preserved.
- WebGL2 context attribute setup (alpha=false, depth=true, stencil=true,
  antialias=false, premultipliedAlpha=false) — pinned so the canvas
  doesn't try to render at unexpected pixel ratios.
- Skip SDL fullscreen / mode-set paths that Emscripten's SDL2 port
  doesn't honour.

---

## Console / CVar lockdown

### `src/common/console/c_cvars.h`
- **L164–166** — Added `MakeNoSet()` accessor next to `SetArchiveBit()`.
  ORs `CVAR_NOSET` onto the CVar's flags.

### `src/common/console/c_cvars.cpp`
- **L1774–1795** — New `CCMD (lockcvar)`. Accepts one or more CVar names,
  calls `MakeNoSet()` on each. Designed for boot-time use:
  `+lockcvar vid_rendermode vid_fullscreen sv_cheats ...` from the
  Emscripten boot args locks them so menu / console `set` can't change
  them. Silently skips unknown names so a stale arg doesn't abort
  startup. One-way (no `unlockcvar`).

---

## Status bar — the invisible-panel fix

### `src/common/statusbar/base_sbar.cpp`
- **L603–606** — Cast `(uint32_t)color` at the `DTA_Color` site in
  `DStatusBarCore::DrawGraphic` (and the same cast at the sibling
  `DrawRotated` site below). On wasm32, small structs like `PalEntry` are
  passed by reference through varargs; the receiver's `va_arg(int)` reads
  the pointer instead of the colour, giving alpha=0 and rendering the
  whole status bar transparent.

---

## Audio — OpenAL

### `src/common/audio/sound/oalsound.cpp`
Four discrete patches, all under `#ifdef __EMSCRIPTEN__` (sites visible
via grep, lines drift):

1. **numMono / numStereo clamp** (~L187, ~L231) — Emscripten's OpenAL
   reports `INT_MAX` source counts; clamp to a sensible cap to avoid
   integer overflow downstream.
2. **Music pump single-threaded** (~L291, ~L471) — replaces the
   `std::thread`-based music driver with a per-tic pump callable from
   the main loop. Emscripten doesn't ship `-pthread` in our build.
3. **AL_INVALID_ENUM drain** (~L539, ~L727, ~L744) — drain the AL error
   queue before each operation so Emscripten's
   not-quite-OpenAL-Soft-compatible enum returns don't poison later
   queries.
4. **Float→int16 sample conversion** (~L757, ~L763, ~L803–851, ~L1096,
   ~L1125, ~L1343, ~L1427, ~L1606, ~L1962) — in-place conversion on the
   music-buffer path because Emscripten's libopenal doesn't expose
   `AL_EXT_FLOAT32`. The full ZMusic float sample path goes through this
   downcast before `alBufferData`.

---

## ZMusic / build wiring

### `CMakeLists.txt` (top-level)
- **L37–57, L126–135, L471–515** — Under `if(EMSCRIPTEN)`:
  - Enable OpenAL via `-sUSE_OPENAL=1` at both compile and link.
  - Point `OPENAL_INCLUDE_DIR` / `OPENAL_LIBRARY` at GZDoom's bundled
    OpenAL Soft headers (Emscripten's stripped `al.h` is missing
    entry points GZDoom needs).
  - Skip the `add_pk3()` builds (`zipdir` host tool isn't reachable from
    the emcmake configure).
  - Wire in `deps/zmusic-real/` as a static library — we vendored real
    ZMusic 1.1.9 instead of using the stub.
  - Build only the OPL/ADL music backend (skip FluidSynth, OPN, GME,
    libsndfile).

### `src/CMakeLists.txt`
- **L135** — Use Emscripten's bundled SDL2 port (`-sUSE_SDL=2`).
- **L149** — Skip `find_package(OpenAL)` under Emscripten (the package
  lookup fails; we hardcode paths above).
- **L1308–1310** — Link `-lopenal` plain (not via the modern CMake target,
  which doesn't exist in Emscripten's CMake module).

### `deps/zmusic-real/source/musicformats/music_midi.cpp`
- **L258+** — Skip the `MIDIDeviceFluidSynth` ctor on Emscripten. Its
  dlopen path triggers a JS-EH unwind that breaks JSPI.

---

## Engine bootstrap — trace prints

### `src/d_main.cpp`
- **L880–1015** — `D_Display` gate tracing (`gate-A`, `gate-B`, past
  gates, pre `BeginFrame`). Load-bearing for render-gate diagnosis.
  Some lines still present.
- **L1233–1308** — `D_DoomLoop` enter/iter/exception tracing.

  *Cleanup note:* most of these can be deleted before the fork PR;
  the patch site is small but the noise is real.

### `src/p_setup.cpp`
- Trace prints around map load.

### `src/d_net.cpp`
- Skip netgame startup paths under Emscripten (no UDP socket).

### `src/common/utility/i_time.cpp`
- Time source uses `emscripten_get_now()` instead of monotonic clock.

### `src/common/engine/i_interface.cpp`
- Stubs for platform interfaces that depend on a real desktop window
  manager.

### `src/common/textures/formats/webptexture.cpp`
- Webp decoder skipped under Emscripten (libwebp not linked into the
  wasm build).

### `src/common/thirdparty/richpresence.cpp`
- Discord rich-presence stubbed (no Discord SDK in browser).

### `src/common/platform/posix/i_system.h`
- Platform header touch-up for Emscripten's nominally-POSIX environment.

### Other touched files (light)
- `src/rendering/hwrenderer/scene/hw_skyportal.cpp`,
  `hw_portal.cpp`, `hw_drawinfo.cpp`, `hw_bsp.cpp`,
  `hw_entrypoint.cpp`, `src/common/rendering/hwrenderer/data/hw_skydome.cpp`
  — small WebGL2-strict-mode adjustments to portal / sky / BSP draw paths.

---

## Build flags (this repo, not the engine)

### `build.ps1`
- `-sJSPI=1` — Native VM-stack-based suspending. Removes the asyncify
  workarounds.
- `-DNO_OPENAL=OFF` — Re-enable sound at the CMake level.
- `-DDYN_OPENAL=OFF -DDYN_FLUIDSYNTH=OFF -DDYN_SNDFILE=OFF` — Static
  linking only (Emscripten has no dlopen).
- Dropped `-fwasm-exceptions` in favour of JS-emulated exceptions
  (the wasm-exceptions ABI cost a ~9× perf hit measured against the
  same scene). JS exceptions only break JSPI when actively thrown
  during a suspend, which the renderer init does not do.

---

## Patch count summary

- Renderer (GLES): 7 files
- Renderer (GL3+): 12 files
- Shader preamble: handled via engine, not shader source
- SDL / platform: 1 file
- Console / CVar lockdown: 2 files
- Status bar: 1 file
- Audio (OpenAL): 1 file, 4 patch families
- ZMusic + CMake: 3 files
- Engine bootstrap / misc: ~10 files

All under `__EMSCRIPTEN__` guards. The fork PR is a fast-forward apply
onto stock `g4.11.3`.
