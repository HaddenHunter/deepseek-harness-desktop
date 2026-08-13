// Sidecar dist bundle: packs the entire SDK JSON-RPC runtime into a
// single portable CJS file so the packaged Tauri app does NOT need
// node_modules installed on the end-user machine.
//
// Output:  dsh-desktop/src-tauri/resources/dsh-runtime.cjs
// Consumed:  Rust side spawns `node <absolute-path-to-resources>/dsh-runtime.cjs`
//
// Uses esbuild (dev dependency) to tree-shake the Cordis plugin graph,
// resolve all workspace imports, and emit a single bundle.

const { build } = await import("esbuild");
const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
const { dirname, join, resolve } = await import("node:path");
const { fileURLToPath } = await import("node:url");

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

try {
  await build({
    entryPoints: [entryTmp],
    outfile: outFile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    sourcemap: false,
    minify: false,
    legalComments: "none",
    logLevel: "info",
    allowOverwrite: true,
    external: [],
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
  console.log("\n✅ sidecar bundle written:", outFile);
  const kb = Math.round(readFileSync(outFile).length / 1024);
  console.log(`   size: ${kb} KB`);
} catch (e) {
  console.error("❌ sidecar bundle failed:", e);
  process.exit(1);
}
