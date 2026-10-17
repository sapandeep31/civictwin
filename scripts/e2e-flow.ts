/**
 * Full product flow, as in the deck, driven through the real UI with live APIs:
 *   pick society â†’ build twin â†’ draft setup + Local Intel â†’ run the night â†’
 *   choose fixes (quick picks + ask the planner) â†’ re-run & compare â†’ committee PDF.
 *
 *   bun scripts/e2e-flow.ts "<society query>" <tag>      (query "demo" = the built-in demo society)
 * Needs `bun run dev` on :3000. Screenshots + PDF land in screenshots/flow-<tag>/.
 */
import fs from "fs";
import path from "path";
import puppeteer, { type Page } from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const Q = process.argv[2] ?? "demo";
const TAG = process.argv[3] ?? "demo";
const OUT = path.join(process.cwd(), "screenshots", `flow-${TAG}`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  protocolTimeout: 300000,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1500,950"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT });

const issues: string[] = [];
page.on("pageerror", (e) => issues.push(`pageerror: ${String(e).slice(0, 200)}`));
page.on("console", (m) => m.type() === "error" && !/favicon|DevTools|Download the React/.test(m.text()) && issues.push(`console: ${m.text().slice(0, 200)}`));
page.on("response", (r) => r.url().includes("/api/") && r.status() >= 400 && issues.push(`HTTP ${r.status()} ${r.url().split("/api/")[1]}`));

const results: { step: string; ok: boolean; ms: number; info: string }[] = [];
async function step(name: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push({ step: name, ok: true, ms: Date.now() - t0, info });
    console.log(`âœ“ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s) ${info}`);
  } catch (e) {
    results.push({ step: name, ok: false, ms: Date.now() - t0, info: (e as Error).message.slice(0, 200) });
    console.log(`âœ— ${name}: ${(e as Error).message.slice(0, 200)}`);
    await page.screenshot({ path: path.join(OUT, `fail-${name.replace(/\W+/g, "_")}.png`) }).catch(() => {});
  }
}
const shot = (n: string) => page.screenshot({ path: path.join(OUT, `${n}.png`) });
const clickText = (p: Page, t: string, scope = "body") =>
  p.evaluate(
    (t, scope) => {
      const b = Array.from(document.querySelector(scope)?.querySelectorAll("button") ?? []).find((x) => (x.textContent ?? "").includes(t) && !(x as HTMLButtonElement).disabled);
      (b as HTMLElement | undefined)?.click();
      return !!b;
    },
    t,
    scope
  );
const ed = <T>(fn: string) => page.evaluate((f) => new Function("s", `return (${f})(s)`)((window as any).__praesidiumEditor.getState()), fn) as Promise<T>;
const waitEd = (cond: string, timeout: number) => page.waitForFunction((c) => new Function("s", `return (${c})(s)`)((window as any).__praesidiumEditor.getState()), { timeout, polling: 500 }, cond);
const bodyHas = (re: RegExp, timeout: number) => page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), { timeout, polling: 500 }, re.source);
const cam = () => page.evaluate(() => {
  const c = (window as any).__praesidiumControls?.current;
  return c ? `${Math.round(c.target.x)},${Math.round(c.target.z)} z${c.object.zoom.toFixed(1)}` : "?";
});

await page.goto("http://localhost:3000", { waitUntil: "networkidle2", timeout: 180000 });
await sleep(1000);
await clickText(page, "Launch");
await page.waitForFunction(() => !!(window as any).__praesidiumEditor?.getState().project, { timeout: 30000 });
await sleep(1000);

if (Q !== "demo") {
  await step("1 pick society", async () => {
    await page.evaluate(() => (window as any).__praesidiumEditor.getState().setImportOpen(true));
    await page.waitForSelector('input[placeholder*="Prestige"]', { timeout: 20000 });
    await page.type('input[placeholder*="Prestige"]', Q);
    await clickText(page, "Search");
    const key = Q.split(",")[0].trim().toLowerCase();
    await page.waitForFunction((k) => Array.from(document.querySelectorAll("button")).some((b) => (b.textContent ?? "").toLowerCase().includes(k)), { timeout: 30000 }, key);
    const hit = await page.evaluate((k) => {
      const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent ?? "").toLowerCase().includes(k)) as HTMLElement;
      b.click();
      return b.textContent ?? "";
    }, key);
    await page.waitForFunction(() => !document.body.innerText.includes("Finding the society's boundary"), { timeout: 90000 });
    await sleep(600);
    await shot("1-boundary");
    const b = await page.evaluate(() => (document.body.innerText.match(/(âœ“ Society boundary[^\n]*|Couldn't find[^\n]*|Boundary lookup failed[^\n]*)/) ?? ["(no boundary message)"])[0]);
    return `"${hit.slice(0, 50)}" Â· ${b.slice(0, 110)}`;
  });
  await step("2 build twin", async () => {
    if (!(await clickText(page, "Build 3D twin"))) throw new Error("build button missing/disabled");
    await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.includes("Open 3D twin")), { timeout: 240000, polling: 1000 });
    await shot("2-pipeline");
    const notes = await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"] .text-\\[10px\\]')).map((d) => d.textContent).filter(Boolean).slice(0, 6).join(" | "));
    await clickText(page, "Open 3D twin");
    await sleep(2500);
    const w = await ed<string>("s => `${s.project.world.buildings.length} bldg Â· ${s.project.world.roads.length} roads Â· ${s.project.world.site?.gates.length ?? 0} gates Â· ${s.project.world.guards.length} guards Â· ${s.project.world.cameras.length} cams Â· ${s.project.world.streetlights.length} lights`");
    await shot("2-twin");
    return `${w} :: ${notes.slice(0, 220)}`;
  });
}

await step("3 local intel", async () => {
  await page.waitForFunction(() => /Local context: .*(grounded|ungrounded)|unavailable/.test(document.querySelector('[data-testid="intel-chip"]')?.textContent ?? ""), { timeout: 120000, polling: 1000 }).catch(() => {});
  const chip = await page.evaluate(() => document.querySelector('[data-testid="intel-chip"]')?.textContent ?? "(chip not shown)");
  return chip.slice(0, 120);
});

await step("4 run the night", async () => {
  if (!(await clickText(page, "Run simulation"))) throw new Error("Run simulation button missing");
  await waitEd("s => !!s.project.baselineRun", 120000);
  await sleep(4000);
  await shot("4-night");
  const m = await ed<string>(
    "s => { const m = s.project.baselineRun.metrics; return `incidents ${m.dramaIncidents} Â· blind-spot ${m.blindSpotIncidents} Â· caught ${m.perpsCaughtPct}% Â· cctv ${m.cctvCoveragePct}% Â· lit ${m.pathLenLitPct}% Â· events ${s.project.baselineRun.events.length}` }"
  );
  await page.evaluate(() => (window as any).__praesidiumEditor.setState({ resultsOpen: false }));
  return m;
});

await step("5a quick picks", async () => {
  await page.evaluate(() => (window as any).__praesidiumEditor.getState().setAssistantOpen(true));
  await bodyHas(/\+ Add to plan|No obvious gaps/, 60000);
  await page.waitForFunction(() => !document.querySelector('aside [role="progressbar"]'), { timeout: 90000, polling: 1000 }).catch(() => {});
  await sleep(500);
  await shot("5a-picks");
  return await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[data-testid="jev-quickpicks"] li')).slice(0, 3);
    return items.map((li) => (li.textContent ?? "").replace(/\s+/g, " ").slice(0, 110)).join(" || ") || document.body.innerText.match(/No obvious gaps[^\n]*/)?.[0] || "(none)";
  });
});

await step("5b add 2 picks (zoom)", async () => {
  const before = await cam();
  const z: string[] = [];
  for (let i = 0; i < 2; i++) {
    if (!(await clickText(page, "+ Add to plan", 'aside[aria-label="Planning assistant"]'))) break;
    await sleep(1400);
    z.push(await cam());
    await shot(`5b-added-${i + 1}`);
  }
  const plan = await page.evaluate(() => document.body.innerText.match(/Your plan Â· \d+ changes?/)?.[0] ?? "no plan bar");
  return `camera ${before} â†’ ${z.join(" â†’ ")} Â· ${plan}`;
});

await step("5c ask the planner", async () => {
  await page.click('aside[aria-label="Planning assistant"] textarea');
  await page.type('aside[aria-label="Planning assistant"] textarea', "The back lanes near the boundary wall feel unsafe at night. What should we fix first?");
  await page.keyboard.press("Enter");
  await bodyHas(/What changes \(\d+\)|retry/, 120000);
  const title = await page.evaluate(() => (document.querySelector("aside .text-\\[13px\\].font-bold.leading-snug") as HTMLElement | null)?.innerText ?? document.body.innerText.match(/[^\n]*retry/)?.[0] ?? "");
  const added = await clickText(page, "+ Add to plan", 'aside[aria-label="Planning assistant"] .mt-2.rounded-lg.border.bg-white.p-3');
  await sleep(1400);
  await shot("5c-proposal");
  return `"${title.slice(0, 80)}" ${added ? "Â· added" : "Â· not added"} Â· ${await page.evaluate(() => document.body.innerText.match(/Your plan Â· \d+ changes?/)?.[0] ?? "no plan")}`;
});

await step("6 re-run & compare", async () => {
  if (!(await clickText(page, "Re-run the night & compare", 'aside[aria-label="Planning assistant"]'))) throw new Error("re-run button missing");
  await waitEd("s => !!s.project.interventionRun && s.compareOpen", 120000);
  await sleep(5000);
  await shot("6-compare");
  const head = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return (d?.textContent ?? "").replace(/\s+/g, " ").match(/Headline difference \(simulated\).{0,200}/)?.[0] ?? "(no headline)";
  });
  const m = await ed<string>(
    "s => { const a = s.project.baselineRun.metrics, b = s.project.interventionRun.metrics; return `incidents ${a.dramaIncidents}â†’${b.dramaIncidents} Â· caught ${a.perpsCaughtPct}â†’${b.perpsCaughtPct}% Â· cost â‚¹${b.interventionCostInr}` }"
  );
  await page.evaluate(() => (window as any).__praesidiumEditor.setState({ compareOpen: false }));
  return `${m} Â· ${head.slice(0, 160)}`;
});

await step("7 committee PDF", async () => {
  await sleep(500);
  if (!(await clickText(page, "PDF report"))) throw new Error("PDF button missing");
  for (let i = 0; i < 30; i++) {
    const pdf = fs.readdirSync(OUT).find((f) => f.endsWith(".pdf"));
    if (pdf) return `${pdf} Â· ${Math.round(fs.statSync(path.join(OUT, pdf)).size / 1024)} KB`;
    await sleep(1000);
  }
  throw new Error("no PDF downloaded in 30 s");
});

console.log(`\n${TAG}: ${results.filter((r) => r.ok).length}/${results.length} steps ok`);
const uniq = [...new Set(issues)];
if (uniq.length) console.log("issues:\n  " + uniq.slice(0, 25).join("\n  "));
fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify({ q: Q, results, issues: uniq }, null, 1));
await browser.close();

