"use strict";

// scripts/sidecar-entry.bundle.cjs
var { Context } = require("@deepseek-ai/cordis");
var agentSpine = require("@deepseek-ai/dsh-agent-spine-demo");
var JsonlSessionPersistence = require("@deepseek-ai/dsh-session-persistence-jsonl").default || require("@deepseek-ai/dsh-session-persistence-jsonl");
var jsonrpcServer = require("@deepseek-ai/dsh-sdk-jsonrpc-server");
var { mkdirSync } = require("node:fs");
var { join } = require("node:path");
var { tmpdir } = require("node:os");
var workspace = process.env.DSH_WORKSPACE || join(tmpdir(), `dsh-desktop-${process.pid}`);
mkdirSync(workspace, { recursive: true });
var sessionsDir = join(workspace, "sessions");
mkdirSync(sessionsDir, { recursive: true });
var ctx = new Context();
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
