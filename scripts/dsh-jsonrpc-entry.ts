import { Context } from "@deepseek-ai/cordis";
import * as agentSpine from "@deepseek-ai/dsh-agent-spine-demo";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import * as jsonrpcServer from "@deepseek-ai/dsh-sdk-jsonrpc-server";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const workspace = process.env.DSH_WORKSPACE || join(tmpdir(), `dsh-desktop-${process.pid}`);
mkdirSync(workspace, { recursive: true });
const sessionsDir = join(workspace, "sessions");
mkdirSync(sessionsDir, { recursive: true });

const ctx = new Context();

async function boot() {
  try {
    await ctx.plugin(agentSpine as never, { workspaceContext: false });
    await ctx.plugin(JsonlSessionPersistence as never, { root: sessionsDir });
    await ctx.plugin(jsonrpcServer as never);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[dsh-jsonrpc-entry] boot failed:", e);
    process.exit(1);
  }
}

void boot();

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
