import { spawn } from "node:child_process";
const p = spawn("node", ["--import", "tsx/esm", "scripts/dsh-jsonrpc-entry.ts"], {
  stdio: ["pipe", "pipe", "inherit"],
});
let out = "";
p.stdout.on("data", (d) => { out += d.toString(); });
let done = false;
const t = setTimeout(() => {
  if (done) return;
  console.log("--- stdout so far (", out.length, "bytes) ---");
  console.log(out || "(empty stdout)");
  p.kill("SIGTERM");
  done = true;
  process.exit(0);
}, 20000);
p.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0",
    id: "req_test",
    method: "initialize",
    params: { cwd: "/tmp", provider: "deepseek-official", model: "deepseek-v4-flash" },
  }) + "\n",
);
p.stdin.end();
p.on("exit", (code) => {
  clearTimeout(t);
  if (done) return;
  done = true;
  console.log("--- exit code", code, "--- stdout", out.length, "bytes ---");
  console.log(out || "(empty stdout)");
});
