# Project-owned native bindings

`Application`, `Window`, window options, and input transport are registered in C++
with nobind17 2.0.1. The public TypeScript layer supplies window render listeners and a WebGPU context.
Dawn still supplies every WebGPU binding; `@webgpu/types` remains the authority for
WebGPU declarations. nobind does not wrap or replace Dawn GPU objects.

## Sources of truth

- `packages/native/src/module.cpp` registers methods, constructors, and read-only
  properties. `bindings.h` contains typed facades over the existing resource owners.
- `record_fields.h` registers C++ members of options, snapshots, and each input
  event. The same registrations read options, serialize input, and generate named
  TypeScript records. Input variants and literal tokens determine discriminated
  unions. There are no separately maintained object-shaped declaration fragments.
- `WindowInput` queues the typed `InputEvent` variant directly. The same variant
  supplies build-time event-name metadata; extraction emits a frozen
  `build/native/generated/input-events.ts` list for TypeScript listener validation.
  Input callbacks remain deferred until dispatch, after GLFW callbacks return.
- `binding_maps.h` maps GPU owners, standard adapter options, canvas configuration,
  and adapter promises to their standard WebGPU types; internal frame callbacks
  use `(texture: GPUTexture) => undefined`. Native window state validates
  and retains the original device. Presentation still uses Dawn's
  `GPUTexture::Create<binding::GPUTexture>` and expires textures/views on return.
- `packages/native/bridge.ts` imports the generated module type and retains the
  process GPU root. Core input exports alias the generated types.

Both `setup` and `native:build` use `buildNative`. Before compilation it prepares
build-owned nobind headers through `scripts/native/generate.ts` and regenerates
GLFW constants. After linking, `scripts/native/declarations.ts` starts a fresh Node
process to extract the addon's read-only `__typescript` property into
`build/native/generated/native.d.ts`, along with runtime event names from its
internal `__inputEventTypes` metadata. Both generated files record the addon's
SHA-256; the declarations also reference `@webgpu/types`. Missing/stale output is
recreated; unchanged output is not rewritten. Extraction failures preserve the
previous generated files and fail the build. Run setup before typechecking a
clean checkout.

GLFW constant names come from the configured C++ preprocessor's active macro
list. A temporary C++ program includes the pinned header and prints the evaluated
expressions. The compiler resolves aliases, conditional branches, casts, shifts,
and integer bases/suffixes. The script only selects identifiers and maps their
public names; it never parses C expressions or duplicates GLFW numeric values.
The output remains `build/native/generated/glfw-input.ts`.

Public names strip the family prefix and retain the remaining GLFW spelling.
The only overrides are standalone digits (`0` → `ZERO` through `9` → `NINE`),
defined once in `scripts/native/input-constants.ts` for every group. Embedded
digits such as `KP_0` stay unchanged. `LAST` is omitted; other aliases are retained.
There is no per-key registration list or matching C++ naming table.

## Runtime compatibility and ownership

Dawn's pinned node-addon-api 8.0.0 disables automatic C++ exceptions. nobind requires
newer headers with exceptions. Only the nobind translation units use the workspace
node-addon-api headers, in the distinct `Napi::HostframeBindings` namespace. The native
facades exchange borrowed raw Node-API handles, C++ records, and resource ownership
with Dawn-facing implementation files. `NativeBoundary` preserves pending JS
exceptions instead of transporting C++ exceptions between these configurations.

`scripts/native/dawn-patches.ts` also guards Dawn's dictionary, enum and array
conversion steps in the build-owned interop template and `Core.h`. With C++
exceptions disabled, an accessor failure otherwise yields an empty `Napi::Value`;
the subsequent enum `ToString()` can reach `Error::New` with a null environment
and abort. Raw Node-API property access and enum coercion return immediately on
failure, leaving the original JavaScript exception pending. Decoding completes
before presentation replaces its configuration or retained device. The
`configuration-exceptions.ts` subprocesses cover initial and replacement failures,
arbitrary thrown values, recovery, surface readback and caller-owned devices in
both runtimes as part of `native:verify --presentation` and native CI.

Two integration probes established necessary adaptations to the build-owned
nobind headers, leaving installed dependencies and vendored inputs unchanged:

1. The default nobind module initializer calls `uv_async_init` even for synchronous
   registrations. Bun 1.3.14 aborts on that call. This addon disables nobind's basic
   finalizers, object identity store, and async locking, and omits its libuv queue
   and async cleanup hook. Only synchronous registrations are supported by this
   integration. Native shared ownership stays in `ApplicationState`/`WindowState`.
2. Dawn and nobind both use Node-API's single instance-data slot. Dawn keeps that
   slot; `nobind_runtime.cpp` stores nobind's constructors separately per environment,
   with mutex-protected lookup and cleanup hooks. Application hooks run first,
   closing surfaces while retained devices are still alive.

The adaptation also counts zero-input environment arguments in constructors,
recognizes optional typemaps in argument checking and declarations, and preserves
`Napi::Error` rather than converting TypeError/RangeError into plain Error. It is
version-gated; review these changes before upgrading nobind. No asynchronous
nobind registration or nobind-managed cross-thread shared pointer is supported.

The process-main-thread requirement, operation guards, guarded option getters,
synchronous callback returns, frame abandonment, device retention, idempotent
disposal, and environment cleanup remain enforced by native code. A Window proxy
owns its facade; the application owns live native window state independently of
proxy collection. Window state refers weakly to its application. Devices remain
caller-owned, and the process GPU owner remains rooted until exit.

## Regression checks

`bun run typecheck` compiles `packages/native/test/types.ts`, including negative
contracts for WebGPU device types, callback results, read-only state and input
union narrowing. `bun run test` covers declaration/event-name extraction and
recovery, subscription and dispatch for every native event type, and compiler
constant evaluation, including expression and conditional fixtures.

`bun run native:verify --presentation` runs the typed binding boundary fixture in
both Node.js and Bun along with existing compute, presentation, scheduler, worker,
GC, shutdown and lifecycle checks. `--window-interactions` additionally exercises
resizing, keyboard repeat/modifiers, pointer buttons/motion, scrolling, capture,
and focus-loss reset through real X11 input. See [native build](native-build.md)
for environment setup and validation limits.

## Verified migration, 2026-11-01

Linux x64, Node.js 26.7.0 and Bun 1.3.14 passed setup, native build/source audit,
lint, typecheck, 34 regression tests, and the full native verification suite with
`--window-interactions`. Both runtimes passed actual X11 keyboard repeat/modifiers,
pointer movement/buttons, scrolling, normal/raw capture, focus-loss reset,
listener failure recovery, guarded mutations and disposal. Rendering, resizing,
minimize/restore, expired textures/views, worker rejection, GC and shutdown checks
also passed on Xvfb/KWin with Mesa lavapipe 26.2.5. Initial/resized/restored frame
captures were inspected in `build/native/nobind-validation/screenshots/`.

The local `xvfb-run -a` allocator initially collided with a display without a lock
file and produced misleading missing-input failures. Allocating a fresh display
with `-d`/`-displayfd` resolved that environment issue; screen geometry was checked
before input verification. This migration was not revalidated on hardware GPUs,
physical monitors, other operating systems or other runtime versions.

The [2026-11-01 hardware follow-up](presentation-performance.md) subsequently
passed the combined implementation's full interaction and lifecycle suite in
Node.js and Bun on Intel, including the generated binding boundary checks.

A build-owned interop-template guard rejects prototype-only objects such as
`Object.create(GPU.prototype)` before dereferencing their missing native wrapper.
The boundary regression fixture reproduces this failure for GPU owners and devices.

## Window contexts

`Application.createWindow(gpu, options)` creates a GLFW window and Dawn
surface before device selection. `Window.requestAdapter(options)` calls the
build-owned GPU binding's surface-aware selection path; the normal GPU method is
unchanged. Because upstream enumeration ignores `compatibleSurface`, this path
filters the same ordered adapters using surface capabilities. There is no second
handwritten adapter-options definition or backend/flag selection implementation.

Native configuration parses Dawn's generated `GPUCanvasConfiguration` and reuses
its enum/usage converters. It validates instance/device ownership, loss, surface
capabilities and supported configuration fields before replacing the old device.
The window retains the normalized configuration's JavaScript device. Unconfigure
and reconfigure drain deferred GPU deletion before releasing that device.

`WindowGPUContext` reuses the existing native synchronous frame scope internally.
It exposes the acquired texture only while all window render listeners dispatch;
a bound callback is reused across frames. Presentation and native texture expiry
still happen on success or failure through RAII. The context clears its current
texture in `finally`, and window/application disposal releases its saved device
configuration. No separate public `present()` call is needed.
