// Screenshots of every screen, dark and light, into docs/screens (npm run screens). Skipped by test:ui.
import { expect, test, type Page } from "@playwright/test";

const TOKEN = "e2e-token-0123456789abcdefgh";
test.skip(!process.env.SCREENS, "screenshots only with npm run screens");
test.use({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });

async function ids(page: Page) {
  const runs = await (await page.request.get("/api/runs", { headers: { "X-Factory-Token": TOKEN } })).json() as { runId: string; request: string }[];
  const by = (start: string) => runs.find((r) => r.request.startsWith(start))!.runId;
  return { delivered: by("Show the order count next"), parked: by("Add a CSV export"), waiting: by("Return 404 Not Found"), running: by("Rename the orders heading") };
}

for (const theme of ["dark", "light"] as const) {
  test(`every screen, ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`/?t=${TOKEN}`);
    await page.evaluate((t) => localStorage.setItem("factory-theme", t), theme);
    const r = await ids(page);
    const shot = async (name: string, hash: string, ready: string, after?: () => Promise<void>, overlay = false) => {
      await page.goto(`/${hash}`);
      await page.reload();
      await expect(page.locator(ready).first()).toBeVisible();
      if (after) await after();
      await page.waitForTimeout(400);
      // overlays (drawer, lightbox) are fixed-position: a full-page shot would stitch them badly
      await page.screenshot({ path: `docs/screens/${name}-${theme}.jpg`, type: "jpeg", quality: 80, fullPage: !overlay });
    };
    await shot("dashboard", "#/dashboard", ".recent li");
    await shot("new-run", "#/new", ".mode");
    await shot("new-run-request", "#/new/brownfield", "#prompt", async () => {
      await page.locator("#project").selectOption("shop-api");
      await page.locator("#prompt").fill("Return 404 Not Found when an order doesn't exist, instead of crashing with a 500.");
    });
    await shot("runs", "#/runs", "table.runs");
    await shot("run-running", `#/runs/${r.running}`, ".node.s-running");
    await shot("run-retry-drawer", `#/runs/${r.running}`, ".node .loop", async () => {
      await page.locator('.node[data-step="implement/TASK-1"]').click();
      await expect(page.locator(".drawer.open")).toBeVisible();
    }, true);
    await shot("run-approval", `#/runs/${r.waiting}`, ".card-box");
    await shot("run-parked", `#/runs/${r.parked}`, ".callout.bad");
    await shot("run-delivered", `#/runs/${r.delivered}`, ".big-ok");
    await shot("run-graphical", `#/runs/${r.running}/charts`, "svg.chart.line");
    await shot("run-statistical", `#/runs/${r.running}/stats`, ".tile");
    await shot("run-text", `#/runs/${r.running}/log`, ".log .ev", async () => {
      await page.locator(".log .ev").filter({ hasText: "step.failed" }).first().locator("summary").click();
    });
    await shot("design", `#/runs/${r.delivered}/design`, ".level-name, .slot");
    await shot("preview", `#/runs/${r.delivered}/preview`, "iframe", async () => {
      await expect(page.frameLocator("iframe").locator("h1")).toContainText("Your orders");
    });
    await shot("preview-before-after", `#/runs/${r.delivered}/preview`, ".shot", async () => {
      await page.locator(".shot").first().click();
      await page.locator(".ba-range").fill("15");
    }, true);
    await shot("preview-empty", `#/runs/${r.waiting}/preview`, ".big-empty");
  });
}
