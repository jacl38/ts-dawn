import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { root } from "./release";
import { patchDescriptorConversions } from "./dawn-patches";

const dictionaryObject = "  auto object = value.ToObject();";
const dictionaryMembers = `{{-      if   $m.Init }}res = interop::FromJSOptional(env, object.Get("{{$m.Name}}"), out.{{$m.Name}});
{{-      else         }}res = interop::FromJS(env, object.Get("{{$m.Name}}"), out.{{$m.Name}});`;
const enumString = "  std::string str = value.ToString();";
const arrayElement = "            auto res = Converter<T>::FromJS(env, arr[static_cast<uint32_t>(i)], vec[i]);";
const conversionTemplate = [dictionaryObject, dictionaryMembers, enumString].join("\n");

const temporary: string[] = [];
afterEach(async () => {
  for(const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "hostframe-generation-"));
  temporary.push(directory);
  const scripts = resolve(directory, "scripts/native");
  await mkdir(scripts, { recursive: true });
  for(const name of ["generate.ts", "dawn-patches.ts", "nobind.ts", "release.ts", "dawn.lock.json"]) {
    await cp(resolve(import.meta.dir, name), resolve(scripts, name));
  }
  return directory;
}

async function write(path: string, content: string) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await Bun.write(path, content);
}

test("nobind adaptation preserves inputs and rejects missing, duplicated and displaced anchors", async () => {
  const dir = await fixture();
  const source = resolve(dir, "node_modules/nobind17");
  await cp(resolve(root, "node_modules/nobind17"), source, { recursive: true });
  const { prepareNobind } = await import(resolve(dir, "scripts/native/nobind.ts"));
  const path = resolve(source, "include/notypes.h");
  const original = await Bun.file(path).text();
  await prepareNobind();
  expect(await Bun.file(path).text()).toBe(original);
  expect(await Bun.file(resolve(dir, "build/native/nobind/notypes.h")).text()).toContain("if (actual > expected)");
  const anchor = "if (actual != expected)";
  for(const changed of [original.replace(anchor, "removed"), original + `\n${anchor}\n`]) {
    await Bun.write(path, changed);
    await expect(prepareNobind()).rejects.toThrow("nobind patch mismatch in notypes.h");
  }
  await Bun.write(path, original);
  const header = resolve(source, "include/nobind.h");
  const contents = await Bun.file(header).text();
  await Bun.write(header, contents.replace("Failed to register Object Store cleanup hook", "changed cleanup"));
  await expect(prepareNobind()).rejects.toThrow("nobind patch mismatch in nobind.h");
  // An inserted preprocessor boundary inside the removed span must not be swallowed.
  await Bun.write(header, contents.replace("    auto r = napi_add_async_cleanup_hook(", "    auto r = napi_add_async_cleanup_hook(\n#ifndef NOBIND_NO_TYPESCRIPT_GENERATOR"));
  await expect(prepareNobind()).rejects.toThrow("nobind patch mismatch in nobind.h");
  const queue = "    Nobind::InitMainThreadQueue<Nobind::EnvInstanceData<INSTANCE_DATA_TYPE>>(env);";
  await Bun.write(header, contents.replace(queue, "").replace("    auto r = napi_add_async_cleanup_hook(", `    auto r = napi_add_async_cleanup_hook(\n${queue}`));
  await expect(prepareNobind()).rejects.toThrow("nobind patch mismatch in nobind.h");
});

test("Dawn patches operate on a copy and reject a missing upstream anchor", async () => {
  const dir = await fixture();
  const node = resolve(dir, "vendor/dawn/src/dawn/node");
  const device = "    void ForceLoss(wgpu::DeviceLostReason reason, const char* message);";
  await write(resolve(node, "binding/GPUDevice.h"), device);
  await write(resolve(node, "binding/GPU.h"), "    interop::GPUTextureFormat getPreferredCanvasFormat(Napi::Env) override;");
  await write(resolve(node, "binding/GPU.cpp"), "    interop::GPURequestAdapterOptions options) {\n        adapter = &a;\n    if (!adapter) {");
  const template = `${conversionTemplate}\n  return Wrappers::W{{$.Name}}::Unwrap(object)->impl.get();`;
  await write(resolve(node, "interop/WebGPU.cpp.tmpl"), template);
  await write(resolve(node, "interop/Core.h"), arrayElement);
  const { patchDawnBindings } = await import(resolve(dir, "scripts/native/dawn-patches.ts"));
  await patchDawnBindings();
  expect(await Bun.file(resolve(node, "binding/GPUDevice.h")).text()).toBe(device);
  expect(await Bun.file(resolve(node, "interop/WebGPU.cpp.tmpl")).text()).toBe(template);
  expect(await Bun.file(resolve(node, "interop/Core.h")).text()).toBe(arrayElement);
  expect(await Bun.file(resolve(dir, "build/native/binding/src/dawn/node/interop/WebGPU.cpp.tmpl")).text()).toContain("napi_get_named_property");
  expect(await Bun.file(resolve(dir, "build/native/binding/src/dawn/node/interop/Core.h")).text()).toContain("napi_get_element");
  expect(await Bun.file(resolve(dir, "build/native/binding/src/dawn/node/binding/GPUDevice.h")).text()).toContain("GetNativeDevice");
  await Bun.write(resolve(node, "binding/GPUDevice.h"), "changed");
  await expect(patchDawnBindings()).rejects.toThrow("Native-device accessor patch no longer matches");
});

test("descriptor exception patches reject missing and duplicate conversion anchors", () => {
  for(const anchor of [dictionaryObject, dictionaryMembers, enumString]) {
    for(const template of [conversionTemplate.replace(anchor, "changed"), `${conversionTemplate}\n${anchor}`]) {
      expect(() => patchDescriptorConversions(template, arrayElement)).toThrow("Descriptor exception patch no longer matches");
    }
  }
  for(const core of ["changed", `${arrayElement}\n${arrayElement}`]) {
    expect(() => patchDescriptorConversions(conversionTemplate, core)).toThrow("Descriptor exception patch no longer matches");
  }
});

test("generation marker reuses unchanged outputs and detects extracted patch changes", async () => {
  const dir = await fixture();
  const scripts = resolve(dir, "scripts/native");
  const build = resolve(dir, "build/native");
  for(const output of ["binding/src/dawn/node/binding/GPUDevice.h", "binding/src/dawn/node/binding/GPU.h", "generated/src/dawn/node/interop/WebGPU.h", "generated/src/dawn/node/interop/WebGPU.cpp", "generated/src/dawn/utils/ComboLimits.h", "generated/src/dawn/utils/ComboLimits.cpp"]) {
    await write(resolve(build, output), "fixture");
  }
  const lock = await Bun.file(resolve(scripts, "dawn.lock.json")).json();
  const key = createHash("sha256").update(JSON.stringify(lock))
    .update(await Bun.file(resolve(scripts, "generate.ts")).text())
    .update(await Bun.file(resolve(scripts, "dawn-patches.ts")).text()).digest("hex");
  await write(resolve(build, ".generated-inputs"), `${key}\n`);
  const { assertGeneratedBindings, generateBindings } = await import(resolve(scripts, "generate.ts"));
  await assertGeneratedBindings();
  await generateBindings();
  expect(await Bun.file(resolve(build, ".generated-inputs")).text()).toBe(`${key}\n`);
  const patch = resolve(scripts, "dawn-patches.ts");
  await Bun.write(patch, `${await Bun.file(patch).text()}\n// changed patch\n`);
  await expect(assertGeneratedBindings()).rejects.toThrow("Missing or stale generated bindings");
  await expect(generateBindings()).rejects.toThrow();
  expect(await Bun.file(resolve(build, ".generated-inputs")).exists()).toBe(false);
});
