import assert from "node:assert/strict";
import { Application, installWebGPUGlobals } from "../../../index.ts";
import { assertDeviceAlive } from "./device.ts";

installWebGPUGlobals();
const phase = process.argv[2];
assert.ok(phase === "initial" || phase === "replacement");
const app = new Application();
let device: GPUDevice | undefined;
let candidate: GPUDevice | undefined;
try {
  const window = app.createWindow({ width: 32, height: 32 });
  const context = window.getContext("webgpu");
  const adapter = await context.requestAdapter();
  assert.ok(adapter);
  device = await adapter.requestDevice();
  const candidateAdapter = await context.requestAdapter();
  assert.ok(candidateAdapter);
  candidate = await candidateAdapter.requestDevice();
  const format = app.gpu.getPreferredCanvasFormat();
  const configuration = { device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC };
  const errors: string[] = [];
  for(const gpu of [device, candidate]) gpu.addEventListener("uncapturederror", event => { errors.push(event.error.message); });

  async function render() {
    const gpu = device!;
    const readback = gpu.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const off = window.on("render", () => {
      const texture = context.getCurrentTexture();
      const encoder = gpu.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{
        view: texture.createView(), clearValue: [0, 0, 1, 1], loadOp: "clear", storeOp: "store"
      }] });
      pass.end();
      encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: 256 }, [1, 1]);
      gpu.queue.submit([encoder.finish()]);
      app.stop();
    });
    try {
      await app.run();
      await readback.mapAsync(GPUMapMode.READ);
      assert.deepEqual([...new Uint8Array(readback.getMappedRange()).subarray(0, 4)],
        format === "bgra8unorm" ? [255, 0, 0, 255] : [0, 0, 255, 255]);
      readback.unmap();
    } finally {
      off();
      readback.destroy();
    }
  }

  const sentinels = [new Error("format getter"), Symbol("format getter"), { sentinel: true }, undefined, null, 0, "thrown string"];
  const cases: Array<{ name: string, descriptor: (sentinel: unknown) => object }> = [
    // Keep the reported crash first, including when run against the old addon.
    ...sentinels.map((_, index) => ({
      name: `format getter ${index}`,
      descriptor: (sentinel: unknown) => ({ device: candidate, get format() { throw sentinel; } })
    })),
    ...["device", "usage", "viewFormats", "colorSpace", "toneMapping", "alphaMode"].map(member => ({
      name: `${member} getter`,
      descriptor: (sentinel: unknown) => Object.defineProperty({ device: candidate, format }, member, { get() { throw sentinel; } })
    })),
    {
      name: "nested toneMapping mode getter",
      descriptor: sentinel => ({ device: candidate, format, toneMapping: { get mode() { throw sentinel; } } })
    },
    {
      name: "viewFormats element getter",
      descriptor: sentinel => ({ device: candidate, format, viewFormats: Object.defineProperty([format], "0", { get() { throw sentinel; } }) })
    },
    ...["format", "colorSpace", "alphaMode"].map(member => ({
      name: `${member} string coercion`,
      descriptor: (sentinel: unknown) => ({ device: candidate, format, [member]: { [Symbol.toPrimitive]() { throw sentinel; } } })
    })),
    {
      name: "nested enum string coercion",
      descriptor: sentinel => ({ device: candidate, format, toneMapping: { mode: { toString() { throw sentinel; } } } })
    },
    {
      name: "viewFormats element string coercion",
      descriptor: sentinel => ({ device: candidate, format, viewFormats: [{ toString() { throw sentinel; } }] })
    },
    {
      name: "descriptor proxy",
      descriptor: sentinel => new Proxy({ device: candidate, format }, { get(target, key, receiver) {
        if(key === "format") throw sentinel;
        return Reflect.get(target, key, receiver);
      } })
    }
  ];
  for(const [index, test] of cases.entries()) {
    if(phase === "replacement") {
      context.configure(configuration);
      await render(); // Ensure replacement failure preserves an active swapchain too.
    }
    const before = context.getConfiguration();
    const sentinel = sentinels[index % sentinels.length];
    const descriptor = test.descriptor(sentinel);
    // Decoding must stop at the failure; it must not evaluate subsequent members.
    let laterReads = 0;
    if(test.name.startsWith("format getter")) Object.defineProperty(descriptor, "usage", { get() { laterReads++; return 0; } });
    let caught = false;
    try {
      Reflect.apply(context.configure, context, [descriptor]);
    } catch (error) {
      caught = true;
      assert.equal(error, sentinel, test.name);
    }
    assert.ok(caught, `${test.name} must throw`);
    assert.equal(laterReads, 0);
    assert.deepEqual(context.getConfiguration(), before, test.name);
    if(phase === "replacement") await render();
    context.configure(configuration);
    await render();
    context.unconfigure();
    assert.equal(context.getConfiguration(), null);
  }
  let formatReads = 0;
  let coercions = 0;
  Reflect.apply(context.configure, context, [{
    ...configuration,
    get format() {
      formatReads++;
      return { [Symbol.toPrimitive]() { coercions++; return format; } };
    },
    viewFormats: [{ toString() { return format; } }],
    toneMapping: { mode: { toString() { return "standard"; } } }
  }]);
  assert.equal(formatReads, 1);
  assert.equal(coercions, 1);
  assert.equal(context.getConfiguration()?.format, format);
  assert.deepEqual(context.getConfiguration()?.viewFormats, [format]);
  await render();
  await assertDeviceAlive(device);
  await assertDeviceAlive(candidate);
  assert.deepEqual(errors, []);
  window.dispose();
  window.dispose();
  app.dispose();
  await assertDeviceAlive(device);
  await assertDeviceAlive(candidate);
} finally {
  try { app.dispose(); } finally { candidate?.destroy(); device?.destroy(); }
}
console.log(`${process.versions.bun ? "Bun" : "Node.js"}: ${phase} descriptor exceptions preserve values/configuration, recover, render/read back and dispose.`);
