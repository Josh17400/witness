// Compile the coins sample (examples/cpp) with witness.h's web bridge (WITNESS_WEB_BRIDGE) natively, against the
// stub emscripten.h in em-stub/ and bridge_host.c: a C build (coins_c.c) and a C++ build (coins.cpp +
// witness_impl.cpp), with strict warnings as errors. Windows: MSVC (cl, or found via vswhere); elsewhere $CC/$CXX.
// Usage: node build-bridge.mjs <out dir>  → prints the two executables, exit 2 when no compiler is found.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || path.join(here, "build"));
fs.mkdirSync(out, { recursive: true });
const ex = path.join(here, "..", "..", "examples", "cpp"), inc = path.join(here, "..", "..", "adapters", "cpp"), stub = path.join(here, "em-stub");
const host = path.join(here, "bridge_host.c");
const exe = (n) => path.join(out, n + (process.platform === "win32" ? ".exe" : ""));

function findVcvars() {
  const installer = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer");
  const vswhere = path.join(installer, "vswhere.exe");
  if (!fs.existsSync(vswhere)) return null;
  const r = spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" });
  const root = (r.stdout || "").trim().split(/\r?\n/)[0];
  const bat = root && path.join(root, "VC", "Auxiliary", "Build", "vcvars64.bat");
  return bat && fs.existsSync(bat) ? { bat, installer } : null;
}

let ok;
if (process.platform === "win32") {
  const q = (p) => `"${p}"`;
  const common = ["/nologo", "/W4", "/WX", "/O2", "/DWITNESS_WEB_BRIDGE", `/I${q(stub)}`, `/I${q(inc)}`];
  const c = ["cl", ...common, "/TC", q(path.join(ex, "coins_c.c")), q(host), `/Fe:${q(exe("coins_c_web"))}`].join(" ");
  // the C++ build compiles bridge_host.c as C (/Tc) next to the C++ files
  const cpp = ["cl", ...common, "/EHsc", "/std:c++14", q(path.join(ex, "coins.cpp")), q(path.join(ex, "witness_impl.cpp")), `/Tc${q(host)}`, `/Fe:${q(exe("coins_cpp_web"))}`].join(" ");
  const haveCl = spawnSync("where", ["cl"], { stdio: "ignore" }).status === 0;
  const vc = haveCl ? null : findVcvars();
  if (!haveCl && !vc) { console.error("no C compiler (MSVC) found"); process.exit(2); }
  const line = `${vc ? `call "${vc.bat}" >nul && ` : ""}${c} && ${cpp}`;
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { cwd: out, stdio: "inherit", windowsVerbatimArguments: true, env: { ...process.env, PATH: `${vc ? vc.installer + ";" : ""}${process.env.PATH || ""}` } });
  ok = r.status === 0;
  for (const f of fs.readdirSync(out)) if (f.endsWith(".obj")) fs.rmSync(path.join(out, f));
} else {
  const warn = ["-O2", "-Wall", "-Wextra", "-Wpedantic", "-Werror", "-DWITNESS_WEB_BRIDGE", `-I${stub}`, `-I${inc}`];
  const cc = process.env.CC || "cc", cxx = process.env.CXX || "c++";
  if (spawnSync(cc, ["--version"], { stdio: "ignore" }).status !== 0) { console.error("no C compiler found"); process.exit(2); }
  const r1 = spawnSync(cc, ["-std=c99", ...warn, path.join(ex, "coins_c.c"), host, "-o", exe("coins_c_web"), "-lm"], { stdio: "inherit" });
  const hostObj = path.join(out, "bridge_host.o");
  const r2 = r1.status === 0 && spawnSync(cc, ["-std=c99", ...warn, "-c", host, "-o", hostObj], { stdio: "inherit" });
  const r3 = r2 && r2.status === 0 && spawnSync(cxx, ["-std=c++11", ...warn, path.join(ex, "coins.cpp"), path.join(ex, "witness_impl.cpp"), hostObj, "-o", exe("coins_cpp_web"), "-lm"], { stdio: "inherit" });
  ok = !!(r3 && r3.status === 0);
}
if (!ok) process.exit(1);
console.log(exe("coins_c_web"));
console.log(exe("coins_cpp_web"));
