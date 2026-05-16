# GZDoom-wasm

Goal: port GZDoom to WebAssembly so RCOS can play TOMB.BAS (a UDMF map with
ZDoom specials) in the browser. Current in-RCOS engine is webprboom 2.4.0,
which can't load UDMF.

This is multi-week work. Track progress in the `gzdoom-wasm` task family.

## Layout

- `recon.ps1` — Step 1. Clones GZDoom @ pinned tag, runs `emcmake` configure,
  dumps the dependency wall to `recon-log.txt`. Run on Matt's Windows machine.
- `gzdoom-src/` — populated by recon.ps1 (gitignored, ~150MB).
- `build/` — populated by recon.ps1 (gitignored, ephemeral).
- `recon-log.txt` — paste this back to Claude after each recon run.

## Pinned version

`g4.11.3` — last GZDoom line before Vulkan SDK was required. Has UDMF /
DECORATE / MAPINFO / ACS (the entire reason for the port), and still ships
the softpoly renderer that's the realistic WebGL2 target.

## High-level plan

1. **Recon** (`recon.ps1`) — find out what fails to configure. ← we are here
2. **Triage** — for each failed dep, pick: stub, Emscripten port, or custom replacement.
3. **Renderer** — replace GL/Vulkan with WebGL2 path on top of softpoly.
4. **Audio** — Emscripten SDL2 + a JS-side MIDI synth (or strip music v1).
5. **Filesystem** — MEMFS for IWAD/PWAD, IDBFS for saves.
6. **Threading** — Emscripten pthreads (requires SAB → COOP/COEP headers).
7. **Bundle + integrate** — replace `assets/os/tomb-engine/` package, swap
   IWAD freedoom1 → freedm, update `tomb.html` Module loader.
8. **Test** — TOMB MAP01 plays start-to-end in browser.

## Worker headers (already in plan)

When we ship: add `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` to `/os/*` responses in the
Cloudflare Worker. Required for SharedArrayBuffer / pthreads.
