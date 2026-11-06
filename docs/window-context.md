# Window WebGPU contexts

Create a window with `app.createWindow(options?)`, obtain its stable context with
`window.getContext("webgpu")`, request an adapter/device, and configure the context.
See the [complete clear-screen example](../README.md#minimal-application-api).
One application can own multiple live windows; only one application may be live at a time.

## Adapter selection

`context.requestAdapter(options?: GPURequestAdapterOptions)` returns
`Promise<GPUAdapter | null>`. This is a Hostframe extension: the context supplies
its native surface, selecting only adapters that can present to it. Standard
power preference, fallback, and feature-level options use Dawn's existing binding
selection logic, including backend environment overrides. No compatible adapter
returns null. Invalid options or disposed/reentrant use reject the promise.

`app.gpu` remains a standard `GPU`. Devices obtained through its ordinary
`requestAdapter()` also work when compatible; configuration validates the device's
adapter against the native surface. Adapters/devices remain ordinary Dawn objects.

## Configuration

`context.configure(configuration: GPUCanvasConfiguration)` selects the device,
format, usage, alpha mode and allowed view formats. It does not render a frame.
Hostframe validates supported surface formats/usages/alpha modes, compatible view
formats, device ownership and loss before replacing an existing configuration.
If a descriptor getter or enum string conversion throws, `configure()` propagates
the exact thrown value and preserves the previous configuration (or leaves an
initial context unconfigured). Later configuration, rendering and disposal remain
valid. This also applies to nested tone mapping and view-format elements.
Only `colorSpace: "srgb"` and `toneMapping: { mode: "standard" }` are currently
supported; other values throw explicitly. This is a native presentation context,
not a DOM canvas or a complete implementation of `GPUCanvasContext`.

`app.gpu.getPreferredCanvasFormat()` supplies the ordinary preferred SDR format;
the context checks that the native surface supports it. Pipeline color-target
formats must match the actual attachment view format.

The window's creation-time `vsync` policy chooses FIFO (`true`) or Immediate,
then Mailbox (`false`). Unsupported policies throw during configuration. Read
`window.presentMode` after configuration; it throws while unconfigured/disposed.
Framebuffer dimensions are applied when acquiring a frame, independently of
logical window size. Use the current texture's dimensions for render resources.

`getConfiguration()` returns a copy, including independent `viewFormats` and
`toneMapping` objects, or null when unconfigured. `unconfigure()` releases surface
configuration and the retained device, is repeatable, and permits reconfiguration.
Configuration and unconfiguration are forbidden during native callback dispatch.
GPU cleanup uses the existing bounded drain; timeout destroys the stalled device
and throws after releasing presentation configuration.

## Render events and frame lifetime

`app.run()` polls native events, advances application fixed updates, and schedules
window rendering. Subscribe with `window.on("render", event => { ... })`.
Registration alone does not start scheduling. Timing fields (`alpha`, `frameTime`,
`droppedTime`, `frame`) come from the shared application scheduler; skipped window
frames can produce gaps in its frame numbers. They describe scheduler timing,
not measured monitor presentation times.

For each drawable frame:

1. Hostframe updates surface dimensions/configuration and acquires one texture.
2. It dispatches window render listeners synchronously in registration order.
3. Listeners encode and submit ordinary WebGPU commands. Repeated
   `context.getCurrentTexture()` calls across all listeners return the same object.
4. After successful dispatch, Hostframe presents once and expires the texture and
   every derived view. The application cannot reuse them for another frame.

`getCurrentTexture()` throws outside render dispatch. An unconfigured window emits
no render events. Minimized/zero-size windows, acquisition timeouts, and persistent
temporary surface unavailability skip dispatch while polling/fixed updates continue.
Outdated/lost acquisition gets one recovery attempt; a suboptimal texture remains
usable and triggers reconfiguration on the next frame. Device loss fails the run.

A thrown listener value abandons the frame, clears the current texture, expires
views, and rejects `app.run()` with that value. Removing the listener allows a later
run to retry. Listeners must return undefined synchronously; promises/other values
reject the run with TypeError. Rejected returned promises are consumed.

Registrations return independent idempotent unsubscribe functions. Additions during
dispatch begin next frame; removals apply immediately. Stop/pause skips remaining
listeners, while the acquired frame completes presentation. Configuration, polling,
window creation/disposal, close requests, and input mutations inside rendering are
rejected by native reentrancy guards. `app.stop()` and `app.pause()` remain safe.

## Ownership

A window owns its native surface and retains its configured JavaScript device;
devices remain caller-owned. Dispose/unconfigure the window before destroying its
device. App disposal closes its windows before GLFW. Repeated disposal and disposal
before initial configuration are safe. Retained contexts become unusable after
window/application disposal. Closing the last window resolves `run()` normally;
explicit cleanup still belongs in `finally`.

## Verification for this API change

On Linux x64 with X11 and Mesa lavapipe 26.2.5, Node.js 26.7.0 and Bun 1.3.14
passed the context fixture and the complete native presentation suite. GPU readback
checked blue pixels from the actual acquired presentation texture. Tests cover
unconfigured windows, shared textures across listeners, expired views, failed and
async listeners, restart, invalid/reentrant configuration, device replacement,
caller-owned device survival, close requests, device loss, and disposal.

All 16 migrated examples passed in both runtimes. An isolated Xvfb/KWin desktop
also passed the full resize/input suite, including new-context resize and
minimize/restore checks, in Bun 1.3.14 and Node.js 26.13.0. Captured blue frames at
initial, resized, and restored sizes were inspected under
`build/native/context-validation/screenshots/`. Package installation, declarations,
and rendering passed in clean npm/Bun consumers using both JavaScript runtimes.

The new API has not been verified on macOS or physical GPU/display hardware in
this change. Existing historical platform checks in native-build.md do not
establish that compatibility. No frame-rate or latency claims were measured.

## Multiple surfaces

Every window owns an independent context and surface configuration. A device
chosen with one context's `requestAdapter()` may be shared with another window;
`configure()` checks its adapter's capabilities against that specific surface
and rejects incompatibility before replacing an existing configuration. Use a
separate adapter/device selected through the second context if necessary. Devices
must belong to the process GPU instance exposed by `app.gpu`. GPU resources remain
bound to their device and cannot be shared across different devices.

Dispose/unconfigure all contexts using a caller-owned device before destroying
it. Normal cleanup drains work without destroying the device, including work
submitted by other windows. The bounded five-second cleanup timeout destroys the
stalled device and throws after releasing the cleaned context. All other contexts
sharing that device then fail rendering with device loss; explicitly clean them
up before configuring replacement devices. They retain their configuration and
device references until that cleanup. This fail-fast policy avoids leaving
deferred native swapchain deletion attached to a destroyed display.
