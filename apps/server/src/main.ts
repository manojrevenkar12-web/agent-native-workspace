import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// node:sqlite is stable enough for this and the warning is noise in logs.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  if (String(typeof w === "string" ? w : w.message).includes("SQLite")) return;
  return (emit as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;

const { startServer } = await import("./app.ts");
const dbPath = resolve(process.env.ANW_DB ?? ".data/workspace.db");
mkdirSync(dirname(dbPath), { recursive: true });
const dev = process.env.ANW_DEV === "1";
const server = await startServer({
  port: Number(process.env.PORT ?? 4417),
  dbPath,
  secret: process.env.ANW_SECRET,
  dev,
});
console.log(
  `workspace server on ${server.url} (ws ${server.wsUrl})${dev ? ", dev tokens at /auth/dev?user=lena" : ""}`,
);
const stop = async () => {
  server.rooms.compactAll();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
