import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const path of [
  "/chat/launch",
  "/docs/launch-brief",
  "/notes",
  "/calendar",
  "/sheets/budget",
  "/sign-in",
]) {
  test(`${path} has no serious accessibility violations`, async ({ page }) => {
    await page.goto(`${path}?as=maya`);
    await page.waitForSelector("main, [role=main], h1");
    await page.waitForTimeout(800);
    const result = await new AxeBuilder({ page: page as never })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    const serious = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.nodes.length} × ${v.help}`)).toEqual([]);
  });
}
