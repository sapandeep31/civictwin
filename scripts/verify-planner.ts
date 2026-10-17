/** AI planner smoke test: picks stack, each apply flies the camera to the change. */
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1500,920"] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 920 });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.goto("http://localhost:3000", { waitUntil: "networkidle2", timeout: 120000 });
await sleep(1500);
const clickText = (t: string, nth = 0) =>
  page.evaluate(
    (t, nth) => {
      const b = Array.from(document.querySelectorAll("button")).filter((x) => (x.textContent ?? "").includes(t))[nth];
      (b as HTMLElement | undefined)?.click();
      return !!b;
    },
    t,
    nth
  );
const ed = () => page.evaluate(() => {
  const s = (window as any).__praesidiumEditor.getState();
  const c = (window as any).__praesidiumControls?.current;
  return { cams: s.project.world.cameras.length, lights: s.project.world.streetlights.length, target: c ? [Math.round(c.target.x), Math.round(c.target.z)] : null, zoom: c ? +c.object.zoom.toFixed(2) : null };
});

await clickText("Launch demo");
await sleep(2000);
console.log("baseline clicked:", await clickText("Run simulation"));
await page.waitForFunction(() => !!(window as any).__praesidiumEditor.getState().project.baselineRun, { timeout: 90000 });
await page.evaluate(() => (window as any).__praesidiumEditor.setState({ resultsOpen: false }));
await page.evaluate(() => (window as any).__praesidiumEditor.getState().setAssistantOpen(true));
await page.waitForFunction(() => document.body.innerText.includes("+ Add to plan"), { timeout: 30000 });
await sleep(1500);
await page.screenshot({ path: "screenshots/planner_0_picks.png" });
console.log("before:", await ed());

console.log("apply #1:", await clickText("+ Add to plan", 0));
await sleep(1600);
console.log("after #1:", await ed());
await page.screenshot({ path: "screenshots/planner_1_applied.png" });

console.log("apply #2:", await clickText("+ Add to plan", 0)); // next un-applied pick
await sleep(1600);
console.log("after #2:", await ed());
await page.screenshot({ path: "screenshots/planner_2_applied.png" });
console.log("applied badges:", await page.evaluate(() => (document.body.innerText.match(/Added to your plan/g) ?? []).length));
console.log("plan footer:", await page.evaluate(() => /Your plan · \d+ change/.exec(document.body.innerText)?.[0] ?? "none"));

console.log("remove first:", await clickText("Remove", 0));
await sleep(800);
console.log("after remove:", await ed(), await page.evaluate(() => /Your plan · \d+ change/.exec(document.body.innerText)?.[0] ?? "none"));
await browser.close();
