/**
 * Runs a blind message set through the intent reader exactly as the server does.
 *
 *   npm run heldout -- messages-1
 *
 * The first run of a set is written to reports/heldout/<set>/first_run.json and never
 * rewritten; later runs go to latest.json. A set whose failures have been studied is marked
 * `regression` in heldout/<set>/STATUS and no longer counts as blind.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractIntent } from "@anw/agent";
import { channelMembers, channels, config, dayParts, people, person } from "@anw/sync";
import { Temporal } from "temporal-polyfill";

interface Expect {
  kind: "meeting" | "task" | "none";
  day?: string;
  after?: string;
  durationMin?: number;
  assignee?: string;
  due?: string;
}
interface Case {
  id: string;
  channel: string;
  author: string;
  text: string;
  expect: Expect;
}

const set = process.argv[2] ?? "messages-1";
const root = join(import.meta.dirname, "..");
const input = JSON.parse(readFileSync(join(root, "heldout", set, "messages.json"), "utf8")) as {
  now: string;
  messages: Case[];
};
const status = readFileSync(join(root, "heldout", set, "STATUS"), "utf8").trim();
const names = Object.fromEntries(
  people.map((p) => [p.id, [p.name.toLowerCase(), p.name.split(" ")[0]!.toLowerCase()]]),
);

const rows = input.messages.map((c) => {
  const tz = person(c.author).timeZone;
  const intent = extractIntent(c.text, {
    author: c.author,
    timeZone: tz,
    members: channelMembers(c.channel),
    names,
    now: input.now,
    channelName: channels.find((x) => x.id === c.channel)?.name ?? c.channel,
    dayParts,
    defaultDurationMin: config.scheduling.defaultDurationMinutes,
  });
  const offered = intent && intent.confidence >= config.agent.proactive.minConfidence ? intent : null;
  const got = offered?.kind ?? "none";
  const checks: Record<string, boolean> = { kind: got === c.expect.kind };
  if (offered?.kind === "meeting" && c.expect.kind === "meeting") {
    const start = Temporal.Instant.from(offered.windows[0]!.start).toZonedDateTimeISO(tz);
    if (c.expect.day) checks.day = start.toPlainDate().toString() === c.expect.day;
    if (c.expect.after) checks.after = start.toPlainTime().toString().slice(0, 5) === c.expect.after;
    if (c.expect.durationMin) checks.duration = offered.durationMin === c.expect.durationMin;
  }
  if (offered?.kind === "task" && c.expect.kind === "task") {
    if (c.expect.assignee) checks.assignee = offered.assignee === c.expect.assignee;
    if (c.expect.due) checks.due = offered.due === c.expect.due;
  }
  return {
    id: c.id,
    text: c.text,
    expected: c.expect,
    got: offered
      ? offered.kind === "meeting"
        ? {
            kind: "meeting",
            label: offered.label,
            durationMin: offered.durationMin,
            confidence: offered.confidence,
          }
        : {
            kind: "task",
            assignee: offered.assignee,
            due: offered.due ?? null,
            confidence: offered.confidence,
          }
      : { kind: "none" },
    checks,
  };
});

const n = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
const fieldChecks = rows.flatMap((r) => Object.entries(r.checks).filter(([k]) => k !== "kind"));
const summary = {
  set,
  status,
  messages: rows.length,
  kindCorrect: n((r) => r.checks.kind === true),
  unwantedOffers: n((r) => r.expected.kind === "none" && r.got.kind !== "none"),
  missedOffers: n((r) => r.expected.kind !== "none" && r.got.kind === "none"),
  wrongKind: n((r) => r.expected.kind !== "none" && r.got.kind !== "none" && r.got.kind !== r.expected.kind),
  detailsCorrect: fieldChecks.filter(([, ok]) => ok).length,
  detailsChecked: fieldChecks.length,
  byKind: Object.fromEntries(
    (["meeting", "task", "none"] as const).map((k) => [
      k,
      {
        expected: n((r) => r.expected.kind === k),
        correct: n((r) => r.expected.kind === k && r.checks.kind === true),
      },
    ]),
  ),
};

const outDir = join(root, "reports", "heldout", set);
mkdirSync(outDir, { recursive: true });
const first = join(outDir, "first_run.json");
const target = existsSync(first) ? join(outDir, "latest.json") : first;
writeFileSync(target, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(
  `written to ${target.replace(`${root}/`, "")}${target === first ? " (first run, never rewritten)" : ""}`,
);
