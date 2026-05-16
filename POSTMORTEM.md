# Porting GZDoom 4.11.3 to WebAssembly + WebGL2

A postmortem of what it took to make a full GZDoom build render Brutal Doom v22
at 81 FPS inside a 480×300 browser panel — including the silent-failure bugs
that were the hardest to diagnose.

This is the engineering write-up. The repo is a build pipeline, a demo
harness, and an inventory of every patch we made to the engine; the engine
itself lives in a sibling fork (`rejectedcoins/gzdoom`).

## Premise

The brief: take stock GZDoom 4.11.3 — the last release before Vulkan SDK
became a hard build requirement — and run it in a Chromium tab, embedded as
a 480×300 panel inside a larger web app. UDMF, DECORATE, MAPINFO, ACS,
sprites, sound, music, the whole pipeline. Target was Chrome 119+.

GZDoom has a GLES2 renderer path (`vid_preferbackend 1`) and a GL3+ path
(`vid_preferbackend 0`). WebGL2 ≈ GLES 3.0, so GLES looked like the natural
target. That turned out to be the wrong call.

## Renderer choice: GLES looks right, isn't

WebGL2 is spec'd as "OpenGL ES 3.0 with extras", which sounds like a clean
home for GZDoom's GLES backend. But WebGL2 is *strict* in ways desktop GLES
isn't:

- No `glBindAttribLocation` defaults — every active attribute must be
  enabled in the VAO or have an explicit current value of the right type.
- No implicit zero current value for integer attributes — you must call
  `glVertexAttribI4ui` even to get `(0,0,0,0)`.
- Most GLSL ES 1.0 extensions aren't available. `lights[i]` with `i` as a
  function parameter is a compile error.
- `GL_BGRA` doesn't exist; uploads have to byte-swap host-side.

The GLES-path build used a `#define` preamble that converted GLSL ES 1.0
→ 300 ES (`#define attribute in`, `#define texture2D texture`, etc.) plus
shim'd default values. It rendered MAP01 with sound, but every new WAD
knocked something loose.

The GL3+ swap is what shipped. WebGL2 turns out to map much more cleanly
onto OpenGL 3.3 core than onto GLES 3.0 — for our needs, anyway. Combined
with JSPI (next section) the result is a smaller, faster, less patchy
build.

## The headline bug: integer attribute with no current value

`wadsrc/static/shaders/glsl/main.vp` declares:

```glsl
layout(location = 8) attribute uvec4 aBoneSelector;
```

For static (non-skinned) geometry the engine leaves location 8 disabled
in the VAO and doesn't bother setting a current value. On desktop OpenGL
this is fine; the driver returns zeroes and you move on. On WebGL2 strict
mode, every `drawElements` call raises `GL_INVALID_OPERATION` (0x502) and
drops on the floor: an active integer attribute with no integer current
value is a draw-time error, not a link-time one.

Roughly 78 world draws per frame were silently failing. The scene
framebuffer never got written, the present pass copied black to the
canvas every frame, and the only feedback was a console error queue
nobody was draining. Engine logs said the loop was running fine.

The diagnostic technique that worked was hooking `gl.drawElements` at
`getContext` time and counting errors per currently-bound program. With
every world program at 100% error rate and the HUD/2D programs at 0%,
the cause was "something specific to the world shader pipeline" — and
the only world-specific thing in WebGL2 strict mode is the integer
attribute.

The fix:

```cpp
#ifdef __EMSCRIPTEN__
    glVertexAttribI4ui(8, 0, 0, 0, 0);   // aBoneSelector (uvec4)
    glVertexAttrib4f (7, 0, 0, 0, 0);    // aBoneWeight  (vec4)
#endif
```

These are context state, not VAO state, so they go in `InitGLES` /
`FGLRenderer::Initialize` once at startup. The same patch had to be
applied at two different sites (`gles_system.cpp` and `gl_renderer.cpp`)
because the GLES and GL3+ paths each initialise the GL context
independently — confirmation that this is a structural problem in
GZDoom's renderer, not specific to one backend.

`aBoneWeight` (location 7) is the companion bug. With the integer
attribute no longer erroring, the world *still* rendered black, because
the GLSL skinning gate at `main.vp:172`:

```glsl
if (aBoneWeight != vec4(0.0)) { /* skin path */ }
```

…evaluates true for static geometry. The default current value of a vec4
attribute is `(0,0,0,1)`, not `(0,0,0,0)`. Every vertex ran through
`bones[0]`, which is `mat4(0)` at init, and collapsed to the origin.
Forcing the current value to `(0,0,0,0)` made the gate evaluate false
and the world rendered.

## Asyncify → JSPI

The Asyncify-based build ran `D_DoomLoop` as a yielding coroutine driven
by `emscripten_sleep`. That worked, but it required two ugly workarounds:
`glGetProgramiv(LINK_STATUS)` had to be skipped (the drain hung under
Asyncify), and the shader pipeline was forced to stub `linked = true`
and hope for the best. Silent shader failures hid behind these stubs.

The shipping build uses JSPI (JavaScript Promise Integration; Chrome 125+,
stable). Native VM-stack-based suspending — no asyncify trampolines, no
rewind/unwind metadata per function, no `JSPI_EXPORTS` list needed since
`main` is async by default. Concrete deltas measured on the same build:

- **wasm size: −37%**
- **FPS: +25%** on the smoke harness, baseline FreeDM MAP01
- **Real `glGetProgramiv` restored** — link errors now surface immediately

We also dropped `-fwasm-exceptions` in favour of JS-emulated exceptions.
The former cost a ~9× perf hit (22 FPS vs. 195 FPS baseline at one
measurement) because of per-function unwind metadata overhead, and the
renderer init no longer throws.

## 22 → 100+ FPS

The initial JSPI build ran at 22 FPS. With the fixes below it runs at
over 100. The culprits:

1. **`I_WaitForTic` was calling `Printf` ~35 times/sec.** Every call
   crossed the wasm/JS boundary into the page console. Silencing it (and
   the four other per-frame `WTRACE` macros in `gles_postprocess.cpp`,
   `gles_framebuffer.cpp`, `gles_renderbuffers.cpp`, `sdlglvideo.cpp`)
   alone moved the FreeDM smoke baseline from 2 FPS to 25 FPS.
2. **Canvas was 2752×1152, not 320×200.** The harness was inheriting page
   size. Pinning the canvas backbuffer to 320×200 (Doom's native res, then
   CSS-upscaled 1.5× with nearest-neighbour) collapsed the per-frame fill
   cost ~37×.
3. **`-fwasm-exceptions` removal**, as noted above.

The shipping build is at ~100 FPS on the FreeDM smoke baseline; the
canvas pin is the single biggest lever.

## Audio + music: real ZMusic, real OpenAL, four small fires

Sound came back via `-sUSE_OPENAL=1`, pointing the build at GZDoom's
bundled `AL_APIENTRY` headers (Emscripten's stripped-down `al.h` was
missing OpenAL Soft entry points GZDoom uses), and clamping
`numMono`/`numStereo` from an `INT_MAX` overflow on the wasm32 side.
Emscripten's `libopenal.js` is Web Audio under the hood; latency is fine
for game SFX.

Music was the harder problem. The shipping build vendors real ZMusic 1.1.9
with the ADL OPL3 emulator as the default MIDI device under Emscripten.
Four discrete patches were needed in `oalsound.cpp` and ZMusic itself:

- CMake wiring + macro re-assert (so the OPL paths actually compiled in).
- Skip `MIDIDeviceFluidSynth` ctor on Emscripten — its dlopen path
  triggers a JS-EH unwind that breaks JSPI.
- Single-threaded music pump — no `std::thread` available without
  `-pthread`, which we don't ship.
- AL_INVALID_ENUM drain plus an in-place float→int16 conversion on the
  music sample path, because Emscripten's `libopenal` doesn't expose
  `AL_EXT_FLOAT32`.

With these in place, real DOOM music plays in the browser. It sounds
correct.

## Status bar invisible-panel: the PalEntry va_args bug

The status bar was rendering — just transparent. `PalEntry` is a 4-byte
struct, and on wasm32 it gets passed by reference through varargs. The
receiver in `DTA_Color` read `va_arg(int)`, which on wasm32 unpacks as
the *pointer*, not the colour — so the alpha component came out 0 every
time. One-line fix at the `DrawTexture` call sites in `base_sbar.cpp`:

```cpp
DTA_Color, (uint32_t)color,
```

The kind of bug that's invisible without GBA-era ABI knowledge: wasm32
inherits the same small-struct-by-ref convention GCC's old ARM port
used.

## Brutal Doom validation

End state: 81 FPS at 480×300, 507 active textures, 15 buffers, SFX
loaded, music playing. Brutal Doom v22 is the heaviest gameplay-mod
target we know of — it stresses the sprite pipeline, particles, gore
overlays, and custom HUD shaders. Running it cleanly is the
project's PB-class compatibility checkpoint.

Known issue: toggling the bloom shader under JSPI without
`-fwasm-exceptions` triggers a `SuspendError` (JS frames can't be
suspended mid-throw). Bloom is off by default in the embed; we accept
this for v1.

## Lessons, for anyone porting a C++ game

- **WebGL2 strict mode is not GLES.** Treat it as OpenGL 3.3 core that
  happens to use GLSL ES syntax. If your engine has a GLES backend, the
  desktop-GL backend is probably a closer match.
- **Hook the GL error queue from JS.** The C++ side will hide everything.
  A 30-line hook on `drawElements` / `drawArrays` that buckets errors by
  program ID is the single best diagnostic to have ready before you
  start.
- **JSPI > Asyncify** if your browser baseline allows it. Smaller, faster,
  no stubs.
- **Profile what crosses the wasm/JS boundary.** A single `printf` per
  tic will dominate your frame time. Per-frame allocations on the JS
  side will too.
- **wasm32 ABI surprises live in varargs.** Small structs pass as
  pointers; cast at the call site.

Total engine patches: ~30 files, all under `#ifdef __EMSCRIPTEN__`. The
sibling fork's branch is a fast-forward apply onto stock GZDoom 4.11.3.

If you're doing a similar port and any of this is useful, the patch
inventory in `PATCH_INVENTORY.md` lists every site with file paths and
one-line rationales.
