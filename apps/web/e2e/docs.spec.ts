import { expect, test } from "./helpers";

test("the assistant writes a suggestion while a colleague types, and accepting keeps the text", async ({
  open,
}) => {
  const lena = await open("lena", "/docs/retro");
  const maya = await open("maya", "/docs/retro");
  await expect(lena.locator(".prose h1")).toHaveText("Sprint retro");
  await expect(maya.locator(".prose h1")).toHaveText("Sprint retro");
  await lena.locator(".prose h1").click();
  await lena.getByLabel("What should it write?").fill("Write 12 paragraphs about the next sprint");
  await lena.getByRole("button", { name: "Draft after my cursor" }).click();
  // Maya sees the assistant as a collaborator, with its own caret.
  await expect(maya.locator(".caret-agent .caret-label")).toHaveText("Assistant is writing");
  await maya.locator(".prose li").last().click();
  await maya.keyboard.press("End");
  await maya.keyboard.type(" and the API docs", { delay: 20 });
  await expect(lena.getByText(/Suggested \d+ characters for review/)).toBeVisible({ timeout: 30_000 });
  await expect(maya.locator(".prose")).toContainText("and the API docs");
  await expect(maya.locator(".prose .suggestion").first()).toBeVisible();
  // Maya's words are hers, not part of the suggestion.
  await expect(maya.locator(".prose .suggestion", { hasText: "API docs" })).toHaveCount(0);
  await lena.getByRole("button", { name: "Accept" }).click();
  await expect(maya.locator(".prose .suggestion")).toHaveCount(0);
  await expect(maya.locator(".prose")).toContainText("Point 12:");
});

test("a viewer can read a document but not change it or ask the assistant to", async ({ open }) => {
  const jonas = await open("jonas", "/docs/launch-brief");
  await expect(jonas.locator(".prose h1")).toHaveText("Launch brief");
  await expect(jonas.locator(".prose")).toHaveAttribute("contenteditable", "false");
  await expect(jonas.getByText("View only", { exact: true })).toBeVisible();
  await expect(jonas.getByRole("button", { name: "Draft after my cursor" })).toHaveCount(0);
});
