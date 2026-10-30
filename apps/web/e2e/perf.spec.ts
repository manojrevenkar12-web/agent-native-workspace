import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";

import budgets from "../../../config/perf.json" with { type: "json" };
import { expect, test } from "./helpers";

const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0;
};
const results: Record<string, unknown> = {};
const keyEvents = ["keydown", "keypress", "keyup", "beforeinput", "input"];

test.afterAll(() => {
  mkdirSync("../../reports", { recursive: true });
  writeFileSync(
    "../../reports/perf.json",
    `${JSON.stringify({ measuredOn: `${cpus()[0]?.model ?? "unknown cpu"} × ${cpus().length}, headless Chromium`, budgets, results }, null, 2)}\n`,
  );
});

test("a 100,000-row sheet scrolls without dropping frames", async ({ page }) => {
  const b = budgets.gridScroll;
  const t0 = Date.now();
  await page.goto("/sheets/ledger?as=jonas");
  await expect(page.locator("#cell-B2")).toHaveText(/ #1$/, { timeout: 60_000 });
  const loadMs = Date.now() - t0;
  await expect(page.locator("#cell-E2")).not.toBeEmpty();
  const frames = await page.evaluate(
    async ([steps, px]) => {
      const el = document.querySelector("[role=grid]") as HTMLElement;
      const times: number[] = [];
      let last = performance.now();
      for (let i = 0; i < steps; i++) {
        el.scrollTop += px;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const now = performance.now();
        times.push(now - last);
        last = now;
      }
      return times.slice(2);
    },
    [b.scrollSteps, b.pixelsPerFrame] as const,
  );
  results.gridScroll = { frameP95Ms: Math.round(p95(frames) * 10) / 10, loadAndComputeMs: loadMs };
  expect(p95(frames)).toBeLessThanOrEqual(b.frameP95Ms);
});

test("typing stays responsive while the assistant streams into the same document", async ({ open }) => {
  const b = budgets.typingWhileStreaming;
  const lena = await open("lena", "/docs/launch-brief");
  const maya = await open("maya", "/docs/launch-brief");
  await expect(maya.locator(".prose h1")).toBeVisible();
  await maya.evaluate((names) => {
    const w = window as unknown as { __events: number[]; __long: number };
    w.__events = [];
    w.__long = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (names.includes(e.name)) w.__events.push(e.duration);
    }).observe({ type: "event", buffered: false, durationThreshold: 16 } as PerformanceObserverInit);
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__long += e.duration - 50;
    }).observe({ type: "longtask", buffered: false });
  }, keyEvents);
  const take = () =>
    maya.evaluate(() => {
      const w = window as unknown as { __events: number[]; __long: number };
      const out = { events: w.__events, long: w.__long };
      w.__events = [];
      w.__long = 0;
      return out;
    });
  const type = async (n: number) => {
    for (let i = 0; i < n; i++) await maya.keyboard.type(i % 10 === 9 ? " " : "k", { delay: 40 });
  };
  await maya.locator(".prose p").last().click();
  await maya.keyboard.press("End");
  await type(b.baselineKeystrokes);
  const quiet = await take();

  await lena.locator(".prose h1").click();
  await lena
    .getByLabel("What should it write?")
    .fill(`Write ${Math.ceil(b.tokens / 25)} paragraphs about the launch`);
  await lena.getByRole("button", { name: "Draft after my cursor" }).click();
  await expect(maya.locator(".caret-agent")).toBeVisible();
  // In real life Lena is on another computer; here her tab would compete for the same two
  // CPU cores as Maya's. The run continues on the server without her.
  await lena.context().close();
  await take();
  await type(b.keystrokes);
  const busy = await take();
  await expect(maya.locator(".caret-agent")).toBeVisible(); // still streaming while she typed
  const measured = {
    quietP95Ms: Math.round(p95(quiet.events)),
    streamingP95Ms: Math.round(p95(busy.events)),
    keyEventsMeasured: busy.events.length,
    longTaskTotalMs: Math.round(busy.long),
  };
  results.typingWhileStreaming = measured;
  expect(measured.streamingP95Ms).toBeLessThanOrEqual(
    Math.max(b.inputDelayP95Ms, measured.quietP95Ms + b.maxSlowdownMs),
  );
  expect(measured.longTaskTotalMs).toBeLessThanOrEqual(b.longTaskTotalMs);
});
