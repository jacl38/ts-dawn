import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { buildRoot, dawnRoot } from "./release";

function replaceConversion(source: string, anchor: string, replacement: string) {
  if(source.split(anchor).length !== 2) throw new Error("Descriptor exception patch no longer matches Dawn's conversion sources.");
  return source.replace(anchor, replacement);
}

export function patchDescriptorConversions(template: string, core: string) {
  // Dawn disables C++ exceptions. A failed JS operation must stop conversion
  // before an empty Napi handle is used. Raw Node-API leaves the exact thrown
  // value pending, without clearing/wrapping it through Napi::Error.
  template = replaceConversion(template, "  auto object = value.ToObject();", `  napi_value raw_object;
  if (napi_coerce_to_object(env, value, &raw_object) != napi_ok) return Error("Dictionary conversion failed");
  auto object = Napi::Object(env, raw_object);`);
  template = replaceConversion(template, `{{-      if   $m.Init }}res = interop::FromJSOptional(env, object.Get("{{$m.Name}}"), out.{{$m.Name}});
{{-      else         }}res = interop::FromJS(env, object.Get("{{$m.Name}}"), out.{{$m.Name}});`, `  napi_value member_{{$m.Name}};
  if (napi_get_named_property(env, object, "{{$m.Name}}", &member_{{$m.Name}}) != napi_ok) return Error("Dictionary member access failed");
{{-      if   $m.Init }}res = interop::FromJSOptional(env, Napi::Value(env, member_{{$m.Name}}), out.{{$m.Name}});
{{-      else         }}res = interop::FromJS(env, Napi::Value(env, member_{{$m.Name}}), out.{{$m.Name}});`);
  template = replaceConversion(template, "  std::string str = value.ToString();", `  napi_value string;
  if (napi_coerce_to_string(env, value, &string) != napi_ok) return Error("Enum string conversion failed");
  std::string str = Napi::String(env, string);`);
  core = replaceConversion(core, "            auto res = Converter<T>::FromJS(env, arr[static_cast<uint32_t>(i)], vec[i]);", `            napi_value element;
            if (napi_get_element(env, arr, static_cast<uint32_t>(i), &element) != napi_ok) return Error("Array element access failed");
            auto res = Converter<T>::FromJS(env, Napi::Value(env, element), vec[i]);`);
  return { template, core };
}

export async function patchDawnBindings() {
  // Patch a build-owned copy, leaving vendor/dawn unchanged.
  const binding = resolve(buildRoot, "binding/src/dawn/node");
  await rm(binding, { recursive: true, force: true });
  await mkdir(binding, { recursive: true });
  await cp(resolve(dawnRoot, "src/dawn/node"), binding, { recursive: true });
  const deviceHeader = resolve(binding, "binding/GPUDevice.h");
  const text = await Bun.file(deviceHeader).text();
  const anchor = "    void ForceLoss(wgpu::DeviceLostReason reason, const char* message);";
  if(text.split(anchor).length !== 2) {
    throw new Error("Native-device accessor patch no longer matches Dawn's GPUDevice.h.");
  }
  await Bun.write(deviceHeader, text.replace(anchor, `${anchor}\n\n    wgpu::Device GetNativeDevice() const { return device_; }`));
  // InstanceOf also accepts Object.create(GPU.prototype). Such objects have no
  // native wrapper; upstream Unwrap dereferences it without checking for null.
  const wrapperTemplate = resolve(binding, "interop/WebGPU.cpp.tmpl");
  const templateText = await Bun.file(wrapperTemplate).text();
  const unwrap = "  return Wrappers::W{{$.Name}}::Unwrap(object)->impl.get();";
  if(templateText.split(unwrap).length !== 2) throw new Error("Interface-wrapper guard no longer matches Dawn's template.");
  const guardedTemplate = templateText.replace(unwrap, `  void* wrapped = nullptr;
  if (napi_unwrap(object.Env(), object, &wrapped) != napi_ok || !wrapped) return nullptr;
  return static_cast<Wrappers::W{{$.Name}}*>(wrapped)->impl.get();`);
  const coreHeader = resolve(binding, "interop/Core.h");
  const conversions = patchDescriptorConversions(guardedTemplate, await Bun.file(coreHeader).text());
  await Bun.write(wrapperTemplate, conversions.template);
  await Bun.write(coreHeader, conversions.core);
  // Keep surface-aware adapter selection on the same path as upstream selection:
  // flags, backend choice, feature level, and power preference remain authoritative.
  const gpuHeader = resolve(binding, "binding/GPU.h");
  const gpuSource = resolve(binding, "binding/GPU.cpp");
  const header = await Bun.file(gpuHeader).text();
  const source = await Bun.file(gpuSource).text();
  const declaration = "    interop::GPUTextureFormat getPreferredCanvasFormat(Napi::Env) override;";
  const definition = "    interop::GPURequestAdapterOptions options) {";
  const selection = "        adapter = &a;";
  if(header.split(declaration).length !== 2 || source.split(definition).length !== 2 || source.split(selection).length !== 2 || source.split("    if (!adapter) {").length !== 2) {
    throw new Error("Surface-aware adapter patch no longer matches Dawn's GPU binding.");
  }
  await Bun.write(gpuHeader, header.replace(declaration, `${declaration}
    wgpu::Instance GetNativeInstance() const { return wgpu::Instance(instance_->Get()); }
    interop::Promise<std::optional<interop::Interface<interop::GPUAdapter>>> requestAdapterForSurface(
        Napi::Env env, interop::GPURequestAdapterOptions options, wgpu::Surface surface);`));
  await Bun.write(gpuSource, source.replace(definition, `${definition}
    return requestAdapterForSurface(env, std::move(options), nullptr);
}

interop::Promise<std::optional<interop::Interface<interop::GPUAdapter>>> GPU::requestAdapterForSurface(
    Napi::Env env, interop::GPURequestAdapterOptions options, wgpu::Surface surface) {`)
    .replace(selection, `        // EnumerateAdapters ignores compatibleSurface; filter explicitly.
        if (surface) {
            wgpu::SurfaceCapabilities capabilities;
            if (surface.GetCapabilities(a, &capabilities) != wgpu::Status::Success ||
                capabilities.formatCount == 0) continue;
        }
${selection}`)
    .replace("    if (!adapter) {", `    if (!adapter && surface) {
        promise.Resolve({});
        return promise;
    }
    if (!adapter) {`));
}
