/**
 * The model writes; it never decides. Drafts, replies and labels come from a model; what is
 * written where, who it is for and when a meeting happens are decided by code around it.
 *
 * `SimulatedModel` is the default: deterministic, free, and paced like a real stream, so the
 * interface, the tests and the performance budgets see realistic token timing. `ClaudeModel`
 * streams from the Anthropic API when ANW_MODEL=claude and ANTHROPIC_API_KEY are set.
 */

export type ModelRequest =
  | { kind: "draft"; instruction: string; context: string[]; title?: string }
  | { kind: "reply"; question: string; context: string[] }
  | { kind: "classify"; instruction: string; items: string[] };

export interface Model {
  readonly name: string;
  stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<string>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });

/** Splits text the way a tokenizer roughly would: words with their trailing space, newlines alone. */
export function tokens(text: string): string[] {
  return text.match(/\n|[^\s\n]+[ \t]*|[ \t]+/g) ?? [];
}

const LABEL_WORDS: Record<string, string[]> = {
  travel: ["flight", "train", "hotel", "taxi", "uber", "bahn", "flug", "travel", "airbnb", "rail", "mileage"],
  venue: ["venue", "room", "hall", "space", "rent", "miete", "location", "stage", "av "],
  food: ["catering", "lunch", "dinner", "coffee", "snack", "breakfast", "pizza", "drinks", "kaffee", "essen"],
  marketing: [
    "ads",
    "ad ",
    "campaign",
    "print",
    "poster",
    "social",
    "flyer",
    "swag",
    "merch",
    "banner",
    "seo",
  ],
  software: [
    "license",
    "subscription",
    "saas",
    "figma",
    "notion",
    "slack",
    "hosting",
    "domain",
    "aws",
    "github",
  ],
  people: ["freelance", "contractor", "photographer", "speaker", "fee", "honorar", "designer", "staff"],
};

export function labelsFrom(instruction: string): string[] {
  const m = /\b(?:into|as|in|nach|als)\s+(.+)$/i.exec(instruction);
  if (!m) return ["Travel", "Venue", "Food", "Marketing", "Software", "People", "Other"];
  return m[1]!
    .split(/,|\bor\b|\boder\b|\band\b|\bund\b|\//i)
    .map((s) => s.trim().replace(/[.]$/, ""))
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
}

export function classify(item: string, labels: string[]): string {
  const t = ` ${item.toLowerCase()} `;
  for (const label of labels) {
    const words = LABEL_WORDS[label.toLowerCase()] ?? [label.toLowerCase()];
    if (words.some((w) => t.includes(w))) return label;
  }
  return labels.find((l) => /other|sonstig/i.test(l)) ?? labels.at(-1) ?? "Other";
}

function firstClause(s: string): string {
  const t = s
    .replace(/^[^:]{1,40}:\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = t.split(/(?<=[.!?])\s/)[0] ?? t;
  return cut.length > 110 ? `${cut.slice(0, 107)}…` : cut;
}

function draftText(req: Extract<ModelRequest, { kind: "draft" }>): string {
  const long = manyParagraphs(req.instruction);
  if (long) return long;
  const lines = req.context.filter((l) => l.trim());
  if (lines.length) {
    const speakers = [...new Set(lines.map((l) => l.split(":")[0]!.trim()).filter((s) => s.length < 40))];
    const decisions = lines
      .filter((l) =>
        /\b(decid|agreed|let'?s|we'?ll|go with|ship|launch|deadline|budget|confirm|final|beschlossen|machen wir)\w*/i.test(
          l,
        ),
      )
      .slice(0, 5);
    const asks = lines
      .filter((l) => /\b(can you|could you|i'?ll|please|kannst du|bitte|ich werde)\b/i.test(l))
      .slice(0, 5);
    const out = [
      "## Summary",
      `${speakers.join(", ")} exchanged ${lines.length} messages. ${firstClause(lines[0]!)} The latest point: ${firstClause(lines.at(-1)!)}`,
      "## Decisions and open points",
      ...(decisions.length ? decisions : lines.slice(-3)).map((l) => `- ${firstClause(l)}`),
    ];
    if (asks.length)
      out.push("## Next steps", ...asks.map((l) => `- ${l.split(":")[0]!.trim()}: ${firstClause(l)}`));
    return `${out.join("\n")}\n`;
  }
  const subject = topicOf(req.instruction);
  const title = subject.charAt(0).toUpperCase() + subject.slice(1);
  return [
    `## ${title}`,
    `This section covers ${subject}. It states what we are doing, who it is for, and how we will know it worked, so that anyone joining later can pick it up without a meeting.`,
    "- What changes for people using it, in one sentence each",
    "- What we are not doing yet, and why",
    "- The one number we will watch in the first two weeks",
    `Open question: who owns ${subject} after launch? Leave a comment with a name and a date.`,
    "",
  ].join("\n");
}

function topicOf(instruction: string): string {
  return (
    instruction
      .replace(/^(write|draft|add|create|schreib\w*|erstell\w*)\s+(an?|the|ein\w*)?\s*/i, "")
      .trim() || "this section"
  );
}

/** "Write 40 paragraphs about the launch": a long, steady stream, used by the performance tests. */
function manyParagraphs(instruction: string): string | null {
  const many = /\b(\d{1,3})\s+paragraphs?\b/i.exec(instruction);
  if (!many) return null;
  const n = Math.min(200, Number(many[1]));
  const topic = instruction.replace(/^.*?\bparagraphs?\s*(?:about|on)?\s*/i, "").trim() || "the plan";
  const out = [`## ${topic.charAt(0).toUpperCase()}${topic.slice(1)}`];
  for (let i = 1; i <= n; i++)
    out.push(
      `Point ${i}: what changes for people using ${topic}, what we measure in the first week, and who decides if the numbers disagree with the plan.`,
    );
  return `${out.join("\n")}\n`;
}

function replyText(req: Extract<ModelRequest, { kind: "reply" }>): string {
  const recent = req.context.slice(-6);
  if (/summar|zusammenfass|recap|tl;?dr/i.test(req.question)) {
    return [
      `Here is where this thread stands (${recent.length} recent messages):`,
      ...recent.map((l) => `- ${firstClause(l)}`),
    ].join("\n");
  }
  return `I read the last ${recent.length} messages. ${recent.length ? `The most recent point was: "${firstClause(recent.at(-1)!)}". ` : ""}Ask me to summarise the thread, draft it into a doc, or find a time to meet, and I will do it right here.`;
}

export class SimulatedModel implements Model {
  readonly name = "simulated";
  constructor(
    private readonly pace: { tokensPerSecond: number; firstTokenMs: number } = {
      tokensPerSecond: 0,
      firstTokenMs: 0,
    },
  ) {}

  async *stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<string> {
    const text =
      req.kind === "draft"
        ? draftText(req)
        : req.kind === "reply"
          ? replyText(req)
          : (() => {
              const labels = labelsFrom(req.instruction);
              return req.items.map((i) => `${classify(i, labels)}\n`).join("");
            })();
    await sleep(this.pace.firstTokenMs, signal);
    const gap = this.pace.tokensPerSecond > 0 ? 1000 / this.pace.tokensPerSecond : 0;
    for (const t of tokens(text)) {
      if (signal?.aborted) return;
      yield t;
      await sleep(gap, signal);
    }
  }
}

export class ClaudeModel implements Model {
  readonly name: string;
  constructor(
    private readonly model: string,
    private readonly maxTokens: number,
  ) {
    this.name = `claude:${model}`;
  }

  async *stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<string> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const system =
      "You write inside a team's workspace (chat, docs, sheets). Be brief and concrete. Use plain text; lines starting with '## ' are headings and '- ' are bullets. Never invent facts that are not in the context.";
    const content =
      req.kind === "draft"
        ? `Instruction: ${req.instruction}\n\nContext:\n${req.context.join("\n")}`
        : req.kind === "reply"
          ? `Reply to: ${req.question}\n\nThread:\n${req.context.join("\n")}`
          : `${req.instruction}\nAnswer with exactly one label per line, in order, nothing else.\n\n${req.items.map((x, i) => `${i + 1}. ${x}`).join("\n")}`;
    const stream = client.messages.stream(
      { model: this.model, max_tokens: this.maxTokens, system, messages: [{ role: "user", content }] },
      signal ? { signal } : undefined,
    );
    for await (const ev of stream as AsyncIterable<{
      type: string;
      delta?: { type: string; text?: string };
    }>) {
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text)
        yield ev.delta.text;
    }
  }
}

export function modelFromEnv(
  cfg: { claudeModel: string; maxTokens: number },
  pace: { tokensPerSecond: number; firstTokenMs: number },
): Model {
  if (process.env.ANW_MODEL === "claude" && process.env.ANTHROPIC_API_KEY)
    return new ClaudeModel(cfg.claudeModel, cfg.maxTokens);
  return new SimulatedModel(pace);
}
