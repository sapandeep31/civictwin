/**
 * Manual-testing helper: one persistent browser, driven one action at a time.
 *   bun scripts/browse.ts            → listens on :3999
 *   POST {"cmd":"goto","url":"..."} | {"cmd":"click","x":..,"y":..} | {"cmd":"text","t":"Run simulation"}
 *        {"cmd":"type","t":"..."} | {"cmd":"key","k":"Enter"} | {"cmd":"scroll","x":..,"y":..,"dy":..}
 *        {"cmd":"move","x":..,"y":..} | {"cmd":"eval","js":"..."} | {"cmd":"shot"} | {"cmd":"wait","ms":..}
 * Every command answers with a fresh screenshot path (+ any new page errors).
 */
import path from "path";
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DIR = process.env.SHOTS ?? path.join(process.cwd(), "screenshots", "manual");
await Bun.write(path.join(DIR, ".keep"), "");
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  protocolTimeout: 300000,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--window-size=${process.env.W ?? 1440},${process.env.H ?? 900}`],
});
const page = (await browser.pages())[0] ?? (await browser.newPage());
await page.setViewport({ width: Number(process.env.W ?? 1440), height: Number(process.env.H ?? 900) });
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DIR });
let errs: string[] = [];
page.on("pageerror", (e) => errs.push(`pageerror: ${String(e).slice(0, 200)}`));
page.on("console", (m) => m.type() === "error" && !/favicon|DevTools/.test(m.text()) && errs.push(`console: ${m.text().slice(0, 200)}`));
page.on("response", (r) => r.url().includes("/api/") && r.status() >= 400 && errs.push(`HTTP ${r.status()} ${r.url().split("/api/")[1]}`));
let n = 0;
let n0 = 0;

Bun.serve({
  port: 3999,
  idleTimeout: 255,
  async fetch(req) {
    const c = (await req.json()) as Record<string, any>;
    let out: unknown = null;
    try {
      switch (c.cmd) {
        case "goto":
          await page.goto(c.url, { waitUntil: "networkidle2", timeout: 180000 });
          break;
        case "click":
          await page.mouse.click(c.x, c.y, { button: c.button ?? "left", clickCount: c.count ?? 1 });
          break;
        case "move":
          await page.mouse.move(c.x, c.y);
          break;
        case "drag": {
          // press at (x,y), move in steps to (x2,y2), optionally screenshot mid-drag, release
          await page.mouse.move(c.x, c.y);
          await page.mouse.down();
          const n = c.steps ?? 12;
          for (let i = 1; i <= n; i++) {
            await page.mouse.move(c.x + ((c.x2 - c.x) * i) / n, c.y + ((c.y2 - c.y) * i) / n);
            await new Promise((r) => setTimeout(r, 30));
          }
          if (c.midShot) await page.screenshot({ path: path.join(DIR, `${String(++n0).padStart(3, "0")}-mid.png`) });
          await page.mouse.up();
          break;
        }
        case "text":
          out = await page.evaluate(
            (t: string, nth: number, scope: string) => {
              const els = Array.from(document.querySelectorAll(`${scope} button, ${scope} a, ${scope} [role=button], ${scope} label`)).filter((x) => (x as HTMLElement).innerText?.includes(t));
              const el = els[nth] as HTMLElement | undefined;
              el?.click();
              return el ? `clicked "${el.innerText.slice(0, 60)}" (${els.length} matches)` : "NOT FOUND";
            },
            c.t,
            c.nth ?? 0,
            c.scope ?? "body"
          );
          break;
        case "type":
          await page.keyboard.type(c.t, { delay: 5 });
          break;
        case "key":
          await page.keyboard.press(c.k);
          break;
        case "scroll":
          await page.mouse.move(c.x, c.y);
          await page.mouse.wheel({ deltaY: c.dy });
          break;
        case "eval":
          out = await page.evaluate(c.js);
          break;
        case "wait":
          break;
      }
    } catch (e) {
      out = `ERROR ${(e as Error).message.slice(0, 300)}`;
    }
    await new Promise((r) => setTimeout(r, c.ms ?? 700));
    const file = path.join(DIR, `${String(++n).padStart(3, "0")}.png`);
    if (c.noshot !== true) await page.screenshot({ path: file });
    const res = { shot: c.noshot ? null : file, out, errors: errs };
    errs = [];
    return Response.json(res);
  },
});
console.log("browse ready on :3999");
