import { expect, test } from "./helpers";

test("a message arrives live, and one sent offline arrives exactly once", async ({ open }) => {
  const lena = await open("lena", "/chat/arif-lena");
  const arif = await open("arif", "/chat/arif-lena");
  await expect(lena.getByRole("log")).toContainText("partner list");
  await lena.getByRole("textbox", { name: /^Message/ }).fill("Sending the list now");
  await lena.keyboard.press("Enter");
  await expect(arif.getByRole("log")).toContainText("Sending the list now");

  await lena.context().setOffline(true);
  await expect(lena.getByRole("status").filter({ hasText: "You're offline" })).toBeVisible();
  await lena.getByRole("textbox", { name: /^Message/ }).fill("Written on the train");
  await lena.keyboard.press("Enter");
  await expect(lena.getByText("Waiting for connection")).toBeVisible();
  await lena.context().setOffline(false);
  await expect(arif.getByRole("log")).toContainText("Written on the train");
  await expect(lena.getByText("Waiting for connection")).toHaveCount(0);
  await expect(arif.getByRole("log").getByText("Written on the train")).toHaveCount(1);
  await expect(lena.getByRole("log").getByText("Written on the train")).toHaveCount(1);
});

test("a meeting suggested in chat is booked from the message and lands in the calendar", async ({ open }) => {
  const lena = await open("lena", "/chat/design");
  const maya = await open("maya", "/chat/design");
  await lena
    .getByRole("textbox", { name: /^Message/ })
    .fill("Can we have a call on Wednesday after 3pm about onboarding?");
  await lena.keyboard.press("Enter");
  const slot = maya.getByRole("button", { name: /^Book / }).first();
  await expect(slot).toBeVisible();
  const label = (await slot.getAttribute("aria-label")) ?? "";
  await slot.click();
  await expect(lena.getByText(/Maya booked “Onboarding”/)).toBeVisible();
  await lena.goto("/calendar");
  // The booked day may be next week if Wednesday has passed.
  for (let i = 0; i < 2 && !(await lena.getByRole("button", { name: /^Onboarding,/ }).count()); i++) {
    await lena.getByRole("button", { name: "Next week" }).click();
  }
  await expect(lena.getByRole("button", { name: /^Onboarding,/ })).toBeVisible();
  expect(label).toMatch(/Book \w{3} \d+ \w{3} at \d\d:\d\d/);
});

test("the assistant streams a reply in the thread", async ({ open }) => {
  const lena = await open("lena", "/chat/launch");
  await lena.getByRole("textbox", { name: /^Message/ }).fill("@assistant can you summarise this thread?");
  await lena.keyboard.press("Enter");
  await expect(lena.getByRole("log")).toContainText("Here is where this thread stands");
});
