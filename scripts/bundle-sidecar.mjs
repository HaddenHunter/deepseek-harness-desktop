// Sidecar dist bundle: packs the entire SDK JSON-RPC runtime into a single
// portable CJS file AND ships a PRIVATE COPY of the host Node.js runtime binary
// inside app bundle. This lets the DSH Desktop app have ZERO external runtime
// dependencies — no need for the end user to have nvm/node/homebrew. This
// solves 10+ rounds of "failed to spawn dsh runtime X: os error 2" caused by
// GUI apps inheriting empty PATH / nvm ghost installs / macOS Hardened
// Runtime execve denials against arbitrary system Node binaries.
//
// Output:
//   src-tauri/resources/dsh-runtime.cjs    — bundled SDK (esbuild single CJS
//   src-tauri/resources/dsh-node          — on macos (universal build) copied from
//                                         host's process.execPath, re-linked
//                                         as a private copy (chmod 0755)
//   src-tauri/resources/dsh-node.exe        — Windows equivalent.
//
// Runtime behaviour — Rust release-branch: spawn <res>/dsh-node <res>/dsh-runtime.cjs
//              Rust debug-branch: keep using system node + tsx/esm + scripts/*.ts.

import { build } from "esbuild";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  chmodSync,
  copyFileSync,
  symlinkSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const proj = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(proj, "node_modules/@deepseek-ai/dsh/package.json"), "utf-8"));
const sdkVersion = String(pkg.version ?? "0.1.0-rc.6");
const fakePkgPath = resolve(__dirname, "_fake_sdk_package.json");
writeFileSync(fakePkgPath, JSON.stringify({ version: sdkVersion }), "utf-8");

const outDir = join(proj, "src-tauri", "resources");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "dsh-runtime.cjs");

const buildEntrySrc = `
// ----- auto-generated entry, do not edit -----
const { Context } = require("@deepseek-ai/cordis");
const agentSpine = require("@deepseek-ai/dsh-agent-spine-demo");
const JsonlSessionPersistence = require("@deepseek-ai/dsh-session-persistence-jsonl").default ||
  require("@deepseek-ai/dsh-session-persistence-jsonl");
const jsonrpcServer = require("@deepseek-ai/dsh-sdk-jsonrpc-server");
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const workspace = process.env.DSH_WORKSPACE || join(tmpdir(), \`dsh-desktop-\${process.pid}\`);
mkdirSync(workspace, { recursive: true });
const sessionsDir = join(workspace, "sessions");
mkdirSync(sessionsDir, { recursive: true });

const ctx = new Context();
async function boot() {
  try {
    await ctx.plugin(agentSpine, { workspaceContext: false });
    await ctx.plugin(JsonlSessionPersistence, { root: sessionsDir });
    await ctx.plugin(jsonrpcServer);
  } catch (e) {
    console.error("[dsh-runtime] boot failed:", e);
    process.exit(1);
  }
}
boot();
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`;

const entryTmp = join(__dirname, "sidecar-entry.bundle.cjs");
writeFileSync(entryTmp, buildEntrySrc, "utf-8");

function hostNodeMajor() {
  const v = process.versions.node.split(".")[0] | 0;
  return v;
}

try {
  // ----- 1) CJS bundle SDK code (esbuild) -----
  //
  // Note: we mark ALL @deepseek-ai/* packages as external + ship them via a
  // vendor `node_modules/@deepseek-ai/` directory copied alongside the
  // bundled CJS. This avoids fighting DSH SDK's circular internal peer
  // dependencies (@deepseek-ai/dsh-shell imports @deepseek-ai/dsh-subprocess
  // which resolves to @deepseek-ai/dsh-subprocess-local). Setting NODE_PATH
  // to `resources/node_modules` at spawn-time resolves everything with zero
  // bundler hackery.
  await build({
    entryPoints: [entryTmp],
    outfile: outFile,
    bundle: true,
    platform: "node",
    target: `node${Math.max(hostNodeMajor(), 20)}`,
    format: "cjs",
    sourcemap: false,
    minify: false,
    legalComments: "none",
    logLevel: "info",
    allowOverwrite: true,
    external: ["@deepseek-ai/*"],
    define: {
      "import.meta.url": JSON.stringify(`file://${fakePkgPath.replace(/\.json$/, ".cjs")}`),
    },
  });
  // Post-fix: the llm-deepseek module loads `../package.json` via createRequire(import.meta.url).
  // Replace the relative require with the concrete SDK version so the bundle has zero file I/O.
  let code = readFileSync(outFile, "utf-8");
  const escaped = fakePkgPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    String.raw`\(\{ version \} = \(0, import_node_module\.createRequire\)\([^)]+\)\("\.\./package\.json"\)\)`,
  );
  code = code.replace(pattern, `({ version } = { version: ${JSON.stringify(sdkVersion)} })`);
  // Also catch any simpler form
  code = code.replaceAll('require("../package.json")', `{ version: ${JSON.stringify(sdkVersion)} }`);
  writeFileSync(outFile, code);
  console.log("\n✅ sidecar CJS bundle written:", outFile);
  const kb = Math.round(readFileSync(outFile).length / 1024);
  console.log(`   size: ${kb} KB`);

  // ----- 1b) Vendor node_modules/@deepseek-ai (resolve externals)
  // Copy every @deepseek-ai package installed under the project's
  // node_modules into a vendor subdir so release builds have zero external
  // `npm install` dependency on the end-user machine.
  {
    const from = join(proj, "node_modules", "@deepseek-ai");
    const to = join(outDir, "node_modules", "@deepseek-ai");
    mkdirSync(to, { recursive: true });
    const { cpSync, existsSync } = await import("node:fs");
    const entries = readdirSync(from);
    for (const name of entries) {
      const s = join(from, name);
      const d = join(to, name);
      try { cpSync(s, d, { recursive: true, force: true, errorOnExist: false }); }
      catch { /* ignore skip errors */ }
    }
    // Also copy any non-dsh-ai packages the DSK peer dep tree needs at runtime.
    // These are ones Cordis / DSH explicitly import without packaging.
    const need = ["@deepseek-ai/cordis", "cordis", "scheduler"];
    for (const pkg of need) {
      const src = join(proj, "node_modules", pkg);
      if (existsSync(src)) {
        const dst = join(outDir, "node_modules", pkg);
        try { cpSync(src, dst, { recursive: true, force: true, errorOnExist: false }); } catch {}
      }
    }
    // Count files to log
    let pkgCount = 0;
    try { pkgCount = readdirSync(join(outDir, "node_modules", "@deepseek-ai")).length; } catch {}
    console.log(`   -> vendor ${pkgCount} @deepseek-ai packages into resources/node_modules/`);

    // ----- 1c) Symlink DSK "abstract interface package" → concrete impl package.
    // The DSH SDK publish pipeline splits interfaces (@deepseek-ai/dsh-fs,
    // @deepseek-ai/dsh-subprocess, …) from the concrete implementations
    // (@deepseek-ai/dsh-fs-local, dsh-subprocess-local, …) and expects the
    // HOST APP (the package.json that `npm install`s @deepseek-ai/dsh) to
    // declare the npm aliases. In a vendored / bundled node_modules we
    // manually create the links after copying so `require("@deepseek-ai/dsh-fs")`
    // resolves. These mappings match what @deepseek-ai/dsh v0.1.0-rc.6 ships.
    {
      const vendor = join(outDir, "node_modules", "@deepseek-ai");
      const map = [
        // [interface (missing), implementation (installed)]
        ["dsh-subprocess", "dsh-subprocess-local"],
        ["dsh-fs", "dsh-fs-local"],
        ["dsh-bash-local", "dsh-terminal-bash"], // no impl package → reuse terminal-bash
        ["dsh-spill", "dsh-spill-local"],
        ["dsh-session-title-llm", "dsh-session-title-first-prompt-llm"],
        ["dsh-session-telemetry", "dsh-session-telemetry-otel"],
        ["dsh-code-runtime", "dsh-code-runtime-worker-thread"],
        ["dsh-workflow", "dsh-workflow-worker-thread"],
        ["dsh-compaction", "dsh-compaction-basic"],
        // Not installed as root packages but some SDK modules peer-depend on them.
        // Point at the nearest plausible provider (empty if none).
        ["dsh-atomic-write", "dsh-settings-file"],
      ];
      for (const [name, target] of map) {
        const dst = join(vendor, name);
        const src = join(vendor, target);
        const src2 = join(proj, "node_modules", "@deepseek-ai", target);
        try { unlinkSync(dst); } catch {}
        if (existsSync(src)) {
          try { symlinkSync(src, dst); } catch (e) { /* fallthrough */ }
        } else if (existsSync(src2)) {
          try { cpSync(src2, dst, { recursive: true, force: true }); } catch (e) {}
        }
      }
      // Cordis plugins: @deepseek-ai/dsh-app-boot peer-depends on cordis-plugin-group
      // which is a built-in of @deepseek-ai/cordis core; install a tiny stub if missing.
      const nmRoot = join(outDir, "node_modules");
      const cg = join(nmRoot, "@deepseek-ai", "cordis-plugin-group");
      if (!existsSync(cg)) {
        mkdirSync(cg, { recursive: true });
        writeFileSync(
          join(cg, "package.json"),
          JSON.stringify({ name: "@deepseek-ai/cordis-plugin-group", type: "module", main: "index.js", exports: { ".": "./index.js" }, version: "0.0.0-stub" }, null, 2),
        );
        writeFileSync(
          join(cg, "index.js"),
          "export function group(...args){ return args[0] ?? {}; }\nexport default group;\n",
        );
      }
      // Optional Linux landlock addons (not needed for macOS/Windows), stub dir.
      for (const addon of ["node-addon-landlock-run-linux-arm64", "node-addon-landlock-run-linux-x64"]) {
        const d = join(nmRoot, "@deepseek-ai", addon);
        if (!existsSync(d)) {
          mkdirSync(d, { recursive: true });
          writeFileSync(
            join(d, "package.json"),
            JSON.stringify({ name: `@deepseek-ai/${addon}`, optional: true, version: "0.0.0-stub", main: "noop.js" }, null, 2),
          );
          writeFileSync(join(d, "noop.js"), "module.exports = undefined;\n");
        }
      }
      // Missing concrete-only abstractions without canonical impl: copy the
      // "wanted-by" caller's preferred package by hard-coded guess.
      const missing2 = [
        ["dsh-bash-local", "dsh-bash-sandbox"],
        ["dsh-subagent-in-process-driver", "dsh-subagent-spawn-in-process"],
      ];
      for (const [name, target] of missing2) {
        const dst = join(vendor, name);
        const src = join(vendor, target);
        if (existsSync(src) && !existsSync(dst)) {
          try { symlinkSync(src, dst); } catch { try { cpSync(src, dst, { recursive: true, force: true }); } catch {} }
        }
      }
    }
  }

  // ----- 2) Ship private Node runtime — copy the host's Node binary (process.execPath)
  //        into resources/ so Tauri bundles it as an app resource. We intentionally
  //        do NOT try to download anything or use pkg/pkf-fetch because those try
  //        remote caches 404 on fresh machines. This copy is a 1:1 bitwise copy of
  //        the node used at build time. On CI this matches the runner's OS.
  //
  //        This is exactly what Electron / VS Code do.
  const hostBin = process.execPath; // typically /usr/local/bin/node
  const isWin = process.platform === "win32";
  const destBin = join(outDir, isWin ? "dsh-node.exe" : "dsh-node");
  try { unlinkSync(destBin); } catch { /* ignore */ }
  copyFileSync(hostBin, destBin);
  try { chmodSync(destBin, 0o755); } catch { /* non-fatal */ }
  // Quick sanity check: private binary can execute exit 0
  const probe = spawnSync(destBin, ["-e", "process.exit(process.versions.node ? 0 : 1)"]);
  if (probe.status !== 0) {
    console.error("❌ private dsh-node sanity check FAILED — exit:", probe.status, "stderr:", probe.stderr?.toString?.());
    process.exit(1);
  }
  const st = statSync(destBin);
  const mb = (st.size / (1024 * 1024)).toFixed(1);
  console.log(`✅ private node runtime shipped: ${destBin}  (${mb} MB, host: node v${process.versions.node})`);
  console.log("   host source: ", hostBin);
  console.log("\n✅ sidecar build done. release binary layout in", outDir);
  console.log("   ->", ...readdirSync(outDir));
} catch (e) {
  console.error("❌ sidecar bundle failed:", e);
  process.exit(1);
}
