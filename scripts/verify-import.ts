/** End-to-end: search → auto boundary → build → open twin, through the real dialog + APIs. */
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const Q = process.argv[2] ?? "DLF The Crest, Gurugram";
const TAG = process.argv[3] ?? "dlf";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1500,950"] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.goto("http://localhost:3000", { waitUntil: "networkidle2", timeout: 120000 });
await sleep(1000);
const clickText = (t: string) =>
  page.evaluate((t) => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent ?? "").includes(t));
    (b as HTMLElement | undefined)?.click();
    return !!b;
  }, t);
await clickText("Launch demo");
await sleep(1500);
await page.evaluate(() => (window as any).__praesidiumEditor.getState().setImportOpen(true));
await page.waitForSelector('input[placeholder*="Prestige"]', { timeout: 20000 });
await page.type('input[placeholder*="Prestige"]', Q);
const t0 = Date.now();
await clickText("Search");
// result rows are the buttons whose label contains the society name
const key = Q.split(",")[0].trim().toLowerCase();
await page.waitForFunction((k) => Array.from(document.querySelectorAll("button")).some((b) => (b.textContent ?? "").toLowerCase().includes(k)), { timeout: 30000 }, key);
const first = await page.evaluate((k) => {
  const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent ?? "").toLowerCase().includes(k)) as HTMLElement;
  b.click();
  return b.textContent;
}, key);
console.log(`search ${Date.now() - t0} ms → "${first?.slice(0, 90)}"`);
const t1 = Date.now();
await page.waitForFunction(() => !document.body.innerText.includes("Finding the society's boundary"), { timeout: 90000 });
await sleep(800);
console.log(`boundary ${Date.now() - t1} ms → ${await page.evaluate(() => (document.body.innerText.match(/(✓ Society boundary[^\n]*|Couldn't find[^\n]*|Boundary lookup failed[^\n]*)/) ?? ["?"])[0])}`);
await page.screenshot({ path: `screenshots/import_${TAG}_1_boundary.png` });
const t2 = Date.now();
await clickText("Build 3D twin with Gemini");
await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.includes("Open 3D twin")), { timeout: 240000 });
console.log(`build ${Date.now() - t2} ms`);
console.log(await page.evaluate(() => Array.from(document.querySelectorAll("div.text-\\[10px\\].text-\\[\\#8a8272\\]")).map((d) => "  · " + d.textContent).join("\n")));
await page.screenshot({ path: `screenshots/import_${TAG}_2_pipeline.png` });
await clickText("Open 3D twin");
await sleep(2500);
await page.evaluate(() => {
  const c = (window as any).__praesidiumControls?.current;
  if (!c) return;
  c.target.set(0, 0, 0);
  c.object.position.set(0.01, 320, 0.01);
  c.object.zoom = 2.2;
  c.object.updateProjectionMatrix();
  c.update();
});
await sleep(1500);
await page.screenshot({ path: `screenshots/import_${TAG}_3_twin.png` });
console.log("world:", await page.evaluate(() => {
  const w = (window as any).__praesidiumEditor.getState().project.world;
  return `${w.buildings.length} buildings · ${w.roads.length} roads · ${w.site?.gates.length ?? 0} gates · ${w.guards.length} guards`;
}));
await browser.close();
