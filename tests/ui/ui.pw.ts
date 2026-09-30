// The web screens end to end in a real browser, against tests/ui/serve.ts.
import { expect, test, type Page } from "@playwright/test";

const TOKEN = "e2e-token-0123456789abcdefgh";

async function ids(page: Page): Promise<Record<"delivered" | "parked" | "waiting" | "running", string>> {
  const runs = await (await page.request.get("/api/runs", { headers: { "X-Factory-Token": TOKEN } })).json() as { runId: string; request: string }[];
  // the fixture's runs, by their request (a test may start more runs)
  const by = (start: string) => runs.find((r) => r.request.startsWith(start))!.runId;
  return { delivered: by("Show the order count next"), parked: by("Add a CSV export"), waiting: by("Return 404 Not Found"), running: by("Rename the orders heading") };
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // an API refusal (400, 409) is logged by the browser as a failed load; that's expected, the page shows it
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource: the server responded with a status of (400|404|409)/.test(m.text())) errors.push(m.text()); });
  (page as unknown as { errors: string[] }).errors = errors;
  await page.goto(`/?t=${TOKEN}`);
  await expect(page.locator("h1")).toContainText("What kind of work is it?");
});
test.afterEach(async ({ page }) => {
  expect((page as unknown as { errors: string[] }).errors, "no script errors or CSP violations").toEqual([]);
});

test("new run → start → the run view shows steps as they happen", async ({ page }) => {
  await expect(page.locator(".mode.off")).toHaveCount(2);
  await expect(page.locator(".mode.off .ribbon").first()).toHaveText("not built yet");
  await page.getByRole("link", { name: /Brownfield/ }).click();
  await expect(page.locator("h1")).toHaveText("What should change?");
  // a bad request is refused inline, before any run exists
  await page.locator("#project").selectOption("shop-web");
  await page.getByRole("button", { name: /Start run/ }).click();
  await expect(page.locator(".error")).toContainText("Give a request");
  // Jira is off without a login, and says why
  await page.getByRole("tab", { name: /Jira key/ }).click();
  await expect(page.locator("#jira")).toBeDisabled();
  await expect(page.locator(".jira-off")).toContainText("JIRA");
  await page.getByRole("tab", { name: /Prompt/ }).click();
  await page.locator("#prompt").fill("Show a total next to the heading");
  await page.locator("#maxcost").fill("4");
  await page.getByRole("button", { name: /Start run/ }).click();
  await expect(page).toHaveURL(/#\/runs\/\d{8}-show-a-total-next/);
  // the stub executor completes a step every ~700 ms: the chain fills in live
  const doneNodes = page.locator(".node.s-completed");
  await expect(doneNodes.first()).toBeVisible({ timeout: 15_000 });
  const n1 = await doneNodes.count();
  await expect.poll(async () => doneNodes.count(), { timeout: 15_000 }).toBeGreaterThan(n1);
  // a second run on the same project is refused while this one starts, inline
  await page.goto("/#/new/brownfield");
  await page.locator("#project").selectOption("shop-web");
  await page.locator("#prompt").fill("Another change to the same project");
  await page.getByRole("button", { name: /Start run/ }).click();
  await expect(page.locator(".error")).toContainText("is already running on shop-web");
});

test("the four live views of a run", async ({ page }) => {
  const id = (await ids(page)).running;
  await page.goto(`/#/runs/${id}`);
  await expect(page.locator(".node.s-running")).toHaveCount(1);
  await expect(page.locator(".node .loop")).toHaveCount(1); // TASK-1 needed a retry
  await page.locator('.node[data-step="implement/TASK-1"]').click();
  await expect(page.locator(".drawer")).toContainText("outside the task's file scope");
  await expect(page.locator(".drawer .chip.fail")).toContainText("task.diff-in-scope");
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: "Graphical" }).click();
  await expect(page).toHaveURL(new RegExp(`#/runs/${id}/charts$`));
  await expect(page.locator("svg.chart.bars")).toHaveCount(3);
  await expect(page.locator("svg.chart.line .cap")).toHaveCount(1);
  await expect(page.locator("svg.chart.retries .row.s-wait")).toHaveCount(1);

  await page.getByRole("tab", { name: "Statistical" }).click();
  await expect(page.locator(".tile")).toHaveCount(8);
  await expect(page.locator(".tile", { hasText: "Attempts" })).toContainText("1 retry");
  await expect(page.locator(".tile", { hasText: "Total cost" }).locator(".big")).toHaveText("$2.94");

  await page.getByRole("tab", { name: "Text" }).click();
  const rows = page.locator(".log .ev");
  await expect(rows.first()).toBeVisible();
  const all = await rows.count();
  await page.locator(".log-bar select").nth(1).selectOption("step.failed");
  await expect(rows).toHaveCount(1);
  await rows.first().locator("summary").click();
  await expect(rows.first().locator("pre")).toContainText('"retryMode": "reset"');
  await page.locator(".log-bar select").nth(1).selectOption("");
  await page.locator(".log-bar input[type=text]").fill("diff-in-scope");
  await expect.poll(async () => rows.count()).toBeLessThan(all);
  await page.getByRole("button", { name: "Trace lines" }).click();
  await expect(page.locator(".log-foot")).toContainText("trace lines");

  await page.getByRole("tab", { name: "Interactive" }).click();
  await expect(page.locator(".phases")).toBeVisible();
});

test("an approval card shows the command to paste, and there is no approve button", async ({ page }) => {
  const id = (await ids(page)).waiting;
  await page.goto(`/#/runs/${id}`);
  await expect(page.locator(".card-box")).toContainText("Waiting for you in the terminal");
  await expect(page.locator(".cmd code").filter({ hasText: `factory approve ${id} ` })).toHaveCount(1);
  await expect(page.locator(".cmd .copy").first()).toBeVisible();
  // the only "approve" button is the pipeline's step node, which opens its drawer
  await expect(page.locator("button:not(.node)").filter({ hasText: /^(approve|reject|answer|stop|pause|waive)/i })).toHaveCount(0);
  await expect(page.locator("form")).toHaveCount(0);
});

test("dashboard: outcome tiles, stage bars and recent runs", async ({ page }) => {
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.locator(".tile")).toHaveCount(5);
  await expect(page.locator(".tile").first().locator(".big")).toHaveText(/^1of [45]$/);
  await expect(page.locator(".hbar").first()).toBeVisible();
  await expect.poll(async () => page.locator(".recent li").count()).toBeGreaterThanOrEqual(4);
  await expect(page.locator(".recent li.k-bad")).toHaveCount(1);
});

test("preview: sandboxed clickable mock, viewports, gallery with before/after", async ({ page }) => {
  const id = (await ids(page)).delivered;
  await page.goto(`/#/runs/${id}/preview`);
  const frame = page.locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  const inner = page.frameLocator("iframe");
  await expect(inner.locator("h1")).toContainText("Your orders");
  await expect(inner.locator("#count")).toHaveText("2"); // the mock's own script ran
  await inner.locator("tr[data-href]").first().click();   // click through inside the mock
  await expect(inner.locator("h1")).toHaveText("Order #1");
  await page.locator(".screens button", { hasText: "Orders list" }).click();
  await expect(inner.locator("h1")).toContainText("Your orders");
  await page.getByRole("button", { name: /phone 390/ }).click();
  await expect(frame).toHaveCSS("width", "390px");
  // the frame runs in an opaque origin: it can't read this app
  const reach = await page.frames()[1]!.evaluate(() => { try { return String(window.parent.document.title); } catch { return "blocked"; } });
  expect(reach).toBe("blocked");
  await page.locator(".shot").first().click();
  await expect(page.locator(".lightbox .ba")).toBeVisible();
  await page.locator(".ba-range").fill("20");
  await expect(page.locator(".lightbox img.after")).toHaveAttribute("style", /inset\(0px 0px 0px 20%\)|inset\(0 0 0 20%\)/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".lightbox")).toHaveCount(0);
});

test("preview: an honest empty state", async ({ page }) => {
  const id = (await ids(page)).waiting;
  await page.goto(`/#/runs/${id}/preview`);
  await expect(page.locator(".big-empty")).toContainText("Clickable mocks appear here once the estimate module produces them.");
});
