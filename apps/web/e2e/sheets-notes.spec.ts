import { expect, test } from "./helpers";

test("keyboard editing, formulas, and an assistant fill that people accept", async ({ open }) => {
  const lena = await open("lena", "/sheets/budget");
  const arif = await open("arif", "/sheets/budget");
  const grid = lena.getByRole("grid", { name: "Launch budget" });
  await expect(grid).toBeVisible();
  await grid.focus();
  // A2 is active; go to J2 and type a formula.
  for (let i = 0; i < 9; i++) await lena.keyboard.press("ArrowRight");
  await lena.keyboard.type("=D2*2");
  await lena.keyboard.press("Enter");
  await expect(lena.locator("#cell-J2")).toHaveText("2480");
  await expect(arif.locator("#cell-J2")).toHaveText("2480");
  // Arif sees where Lena is.
  await expect(arif.locator("#cell-J3")).toContainText("Lena");

  await lena.getByRole("button", { name: "Fill blanks" }).click();
  await expect(lena.getByText(/cells suggested/)).toBeVisible();
  await expect(arif.locator("#cell-C2")).toHaveText("Travel");
  await expect(arif.locator("#cell-C2")).toHaveAttribute("data-pending", "");
  await lena.getByRole("button", { name: "Accept" }).click();
  await expect(arif.locator("#cell-C2")).not.toHaveAttribute("data-pending", "");
  await expect(lena.locator("#cell-H11")).toHaveText("0");
});

test("a date in a note becomes a calendar event when you say so", async ({ open }) => {
  const lena = await open("lena", "/notes");
  await lena.getByRole("button", { name: "Ideas for the digest" }).click();
  const chip = lena.getByLabel("Found in this note");
  await expect(chip).toContainText("Dentist Tue 10am");
  await chip.getByRole("button", { name: "Add to calendar" }).click();
  await expect(chip).toContainText("In your calendar");
  await lena.goto("/calendar");
  for (let i = 0; i < 2 && !(await lena.getByRole("button", { name: /^Dentist,/ }).count()); i++) {
    await lena.getByRole("button", { name: "Next week" }).click();
  }
  await expect(lena.getByRole("button", { name: /^Dentist, 10:00/ })).toBeVisible();
});
