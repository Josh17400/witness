// Build both coins front-ends into build/ (no CMake needed; Node is already required by Witness).
//   Windows: MSVC (cl from PATH, or found via vswhere + vcvars64.bat)
//   elsewhere: $CXX / $CC (default c++ / cc), strict warnings
// Usage: node build.mjs        (witness.json "build" runs this for `witness test --build`)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const inc = path.join("..", "..", "adapters", "cpp");
fs.mkdirSync(path.join(here, "build"), { recursive: true });

function run(cmd, args, opts = {}) {
  console.log(`> ${[cmd, ...args].join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: here, stdio: "inherit", ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const installerDir = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer");

function findVcvars() {
  const vswhere = path.join(installerDir, "vswhere.exe");
  if (!fs.existsSync(vswhere)) return null;
  const r = spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" });
  const root = (r.stdout || "").trim().split(/\r?\n/)[0];
  const bat = root && path.join(root, "VC", "Auxiliary", "Build", "vcvars64.bat");
  return bat && fs.existsSync(bat) ? bat : null;
}

if (process.platform === "win32") {
  const common = ["/nologo", "/W4", "/WX", "/O2", `/I${inc}`, "/Fobuild\\"];
  const cpp = ["cl", ...common, "/EHsc", "/std:c++14", "coins.cpp", "witness_impl.cpp", "/Fe:build\\coins.exe"];
  const c = ["cl", ...common, "/TC", "coins_c.c", "/Fe:build\\coins_c.exe"];
  const haveCl = spawnSync("where", ["cl"], { stdio: "ignore" }).status === 0;
  if (haveCl) {
    run(cpp[0], cpp.slice(1));
    run(c[0], c.slice(1));
  } else {
    const vcvars = findVcvars();
    if (!vcvars) { console.error("MSVC not found: run from a Developer Command Prompt, or install Visual Studio with the C++ workload"); process.exit(1); }
    const line = `call "${vcvars}" >nul && ${cpp.join(" ")} && ${c.join(" ")}`;
    console.log(`> ${line}`);
    const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      cwd: here, stdio: "inherit", windowsVerbatimArguments: true,
      env: { ...process.env, PATH: `${installerDir};${process.env.PATH || ""}` },   // vcvars itself calls vswhere
    });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  for (const f of fs.readdirSync(path.join(here, "build"))) if (f.endsWith(".obj")) fs.rmSync(path.join(here, "build", f));
} else {
  const warn = ["-O2", "-Wall", "-Wextra", "-Wpedantic", "-Werror", `-I${inc}`];
  run(process.env.CXX || "c++", ["-std=c++11", ...warn, "coins.cpp", "witness_impl.cpp", "-o", "build/coins", "-pthread", "-lm"]);
  run(process.env.CC || "cc", ["-std=c99", ...warn, "coins_c.c", "-o", "build/coins_c", "-pthread", "-lm"]);
}
console.log("built build/coins and build/coins_c");
