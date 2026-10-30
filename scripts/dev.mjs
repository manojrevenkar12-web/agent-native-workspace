// Starts the workspace server (dev tokens on) and the web app together.
import { spawn } from "node:child_process";

const procs = [
  spawn("npx", ["tsx", "src/main.ts"], {
    cwd: "apps/server",
    stdio: "inherit",
    env: { ...process.env, ANW_DEV: "1" },
  }),
  spawn("npx", ["next", process.argv.includes("--prod") ? "start" : "dev", "-p", "3417"], {
    cwd: "apps/web",
    stdio: "inherit",
  }),
];
const stop = () => {
  for (const p of procs) p.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", (code) => code && stop());
