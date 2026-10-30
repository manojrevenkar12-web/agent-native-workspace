import { type BrowserContext, test as base, type Page } from "@playwright/test";

/**
 * `open("lena", "/chat/launch")` opens the app as a demo person in a fresh browser context.
 * Contexts close when the test ends, so one test's tabs never burn CPU during the next
 * (which matters for the performance budgets).
 */
export const test = base.extend<{ open: (user: string, path: string) => Promise<Page> }>({
  open: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (user, path) => {
      const ctx = await browser.newContext();
      contexts.push(ctx);
      const page = await ctx.newPage();
      await page.goto(`${path}${path.includes("?") ? "&" : "?"}as=${user}`);
      return page;
    });
    for (const c of contexts) await c.close().catch(() => {});
  },
});

export { expect } from "@playwright/test";
