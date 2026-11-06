import { $ } from "bun";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { buildNative, checkBuild, checkPrerequisites } from "./native/build";
import { prepareDependencies } from "./native/dependencies";
import { generateBindings } from "./native/generate";
import { buildRoot, root } from "./native/release";

export async function withBuildLock(action: () => Promise<void>) {
  await mkdir(buildRoot, { recursive: true });
  const lock = resolve(buildRoot, ".lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if(error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Another native setup/build is running. If a previous run was interrupted, remove ${lock} and retry.`);
    }
    throw error;
  }
  try {
    await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function verify(presentation: boolean, interactions: boolean) {
  if(interactions && process.platform !== "linux") {
    throw new Error("--window-interactions requires Linux/X11, xdotool, and xprop.");
  }
  const threadCheck = process.platform === "darwin" ? "--thread-only" : "--no-display";
  const checks = [
    [resolve(buildRoot, "cmake/native_presentation_check"), "--modes-only"],
    ["node", resolve(root, "packages/native/test/globals.ts")],
    ["bun", resolve(root, "packages/native/test/globals.ts")],
    ["node", resolve(root, "packages/native/test/globals.ts"), "--nonextensible"],
    ["bun", resolve(root, "packages/native/test/globals.ts"), "--nonextensible"],
    ["node", resolve(root, "packages/native/test/compute.ts")],
    ["bun", resolve(root, "packages/native/test/compute.ts")],
    ["node", resolve(root, "packages/native/test/window.ts"), threadCheck],
    ["bun", resolve(root, "packages/native/test/window.ts"), threadCheck]
  ];
  if(presentation) {
    checks.push(
      [resolve(buildRoot, "cmake/native_input_check")],
      ["node", resolve(root, "packages/native/test/key-labels.ts")],
      ["bun", resolve(root, "packages/native/test/key-labels.ts")],
      [resolve(buildRoot, "cmake/native_presentation_check")],
      ["node", resolve(root, "packages/native/test/bindings.ts")],
      ["bun", resolve(root, "packages/native/test/bindings.ts")],
      ["node", resolve(root, "packages/native/test/context.ts")],
      ["bun", resolve(root, "packages/native/test/context.ts")],
      ["node", resolve(root, "packages/native/test/configuration-exceptions.ts"), "initial"],
      ["bun", resolve(root, "packages/native/test/configuration-exceptions.ts"), "initial"],
      ["node", resolve(root, "packages/native/test/configuration-exceptions.ts"), "replacement"],
      ["bun", resolve(root, "packages/native/test/configuration-exceptions.ts"), "replacement"],
      ["node", "--expose-gc", resolve(root, "packages/native/test/window.ts")],
      ["bun", "--expose-gc", resolve(root, "packages/native/test/window.ts")],
      ["node", resolve(root, "packages/native/test/multiple-windows.ts")],
      ["bun", resolve(root, "packages/native/test/multiple-windows.ts")],
      ["node", resolve(root, "packages/native/test/loop.ts")],
      ["bun", resolve(root, "packages/native/test/loop.ts")],
      ["node", resolve(root, "packages/native/test/subscriptions.ts")],
      ["bun", resolve(root, "packages/native/test/subscriptions.ts")],
      ["node", resolve(root, "packages/native/test/presentation.ts")],
      ["bun", resolve(root, "packages/native/test/presentation.ts")],
      ["node", "--expose-gc", resolve(root, "packages/native/test/window.ts"), "--shutdown"],
      ["bun", "--expose-gc", resolve(root, "packages/native/test/window.ts"), "--shutdown"]
    );
  }
  if(presentation && process.env.HOSTFRAME_TEST_CLEANUP_TIMEOUT === "1") {
    for(const runtime of ["node", "bun"]) {
      for(const operation of ["unconfigure", "reconfigure", "window", "application"]) {
        checks.push([runtime, "--expose-gc", resolve(root, "packages/native/test/cleanup-timeout.ts"), operation]);
      }
    }
  }
  if(interactions) {
    checks.push(
      ["node", resolve(root, "packages/native/test/context.ts"), "--interactions"],
      ["bun", resolve(root, "packages/native/test/context.ts"), "--interactions"],
      ["node", resolve(root, "packages/native/test/resize.ts")],
      ["bun", resolve(root, "packages/native/test/resize.ts")],
      ["node", resolve(root, "packages/native/test/input.ts")],
      ["bun", resolve(root, "packages/native/test/input.ts")],
      ["node", resolve(root, "packages/native/test/multiple-window-input.ts")],
      ["bun", resolve(root, "packages/native/test/multiple-window-input.ts")],
      ["node", resolve(root, "packages/native/test/input-actions.ts")],
      ["bun", resolve(root, "packages/native/test/input-actions.ts")]
    );
  }
  for(const command of checks) {
    // Verification needs bounded process lifetimes and signal diagnostics.
    const env = { ...process.env };
    delete env.HOSTFRAME_TEST_STALL_CLEANUP;
    if(command.includes("--no-display")) env.DISPLAY = "";
    if(command.some(argument => argument.endsWith("/cleanup-timeout.ts"))) env.HOSTFRAME_TEST_STALL_CLEANUP = "1";
    const child = Bun.spawn(command, { cwd: root, env, stdout: "inherit", stderr: "inherit", timeout: 30_000 });
    const code = await child.exited;
    if(code !== 0) throw new Error(`${command[0]} verification failed (exit ${code}, signal ${child.signalCode || "none"}).`);
  }
}

async function main() {
  const [command, ...flags] = process.argv.slice(2);
  const usage = "Usage: bun scripts/native.ts <setup|build|check-build|verify> [--presentation] [--window-interactions]";
  if(command === "--help") {
    console.log(usage);
    return;
  }
  if(!command || !["setup", "build", "check-build", "verify"].includes(command) || flags.some(flag => command !== "verify" || !["--presentation", "--window-interactions"].includes(flag))) {
    throw new Error(usage);
  }
  if(command === "verify") return verify(flags.includes("--presentation") || flags.includes("--window-interactions"), flags.includes("--window-interactions"));
  if(command === "check-build") return checkBuild();
  checkPrerequisites(command === "setup");
  await withBuildLock(async () => {
    if(command === "setup") {
      await prepareDependencies();
      await generateBindings();
    }
    await buildNative();
  });
}

if(import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    if(error instanceof $.ShellError && error.stderr.length > 0) console.error(error.stderr.toString().trim());
    process.exitCode = 1;
  }
}
