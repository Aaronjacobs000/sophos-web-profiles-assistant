/**
 * Prints the report to PDF with a local Chrome or Edge in headless mode. No
 * extra package: most Windows PCs have Edge, most Macs Chrome. CHROME_PATH in
 * .env names a browser when it isn't found. Without one, the HTML report's
 * own Print button still saves a PDF.
 */

import { spawn } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class NoBrowserError extends Error {
  constructor() {
    super("No Chrome or Edge found to print the PDF. Set CHROME_PATH in .env, or open the HTML report and print it to PDF.");
    this.name = "NoBrowserError";
  }
}

function candidates(): string[] {
  const env = process.env.CHROME_PATH?.trim();
  const list: string[] = env ? [env] : [];
  if (process.platform === "darwin") {
    list.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else if (process.platform === "win32") {
    const roots = [process.env["PROGRAMFILES(X86)"], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const root of roots) {
      list.push(
        path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      );
    }
  } else {
    list.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge");
  }
  return list;
}

export function findBrowser(): string | null {
  return candidates().find((p) => existsSync(p)) ?? null;
}

/** How long a browser stopped after the timeout gets to exit before it's killed, and then before the export gives up on it. */
const STOP_GRACE_MS = 5_000;

/**
 * Prints the HTML to a PDF and returns its bytes. Everything it writes, the
 * browser's own temp folders included, is in one folder it removes when it's
 * done, whether the PDF was made or not.
 */
export async function htmlToPdf(html: string, timeoutMs = 60_000): Promise<Buffer> {
  const browser = findBrowser();
  if (!browser) throw new NoBrowserError();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wpa-pdf-"));
  try {
    const input = path.join(dir, "report.html");
    const output = path.join(dir, "report.pdf");
    // The browser makes temp folders of its own (its singleton socket, a component download it starts) and can leave
    // them, so its temp folder is in dir. Chrome on macOS takes MAC_CHROMIUM_TMPDIR, on Windows TMP and TEMP, else TMPDIR.
    const temp = path.join(dir, "tmp");
    await fs.mkdir(temp);
    await fs.writeFile(input, html, "utf8");
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      `--user-data-dir=${path.join(dir, "profile")}`,
      "--no-pdf-header-footer",
      `--print-to-pdf=${output}`,
      pathToFileURL(input).href,
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(browser, args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, MAC_CHROMIUM_TMPDIR: temp } });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr = (stderr + String(d)).slice(-2000)));
      let settled = false;
      const timers: NodeJS.Timeout[] = [];
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        if (err) reject(err);
        else resolve();
      };
      const late = new Error(`The browser didn't finish the PDF within ${timeoutMs / 1000} s.`);
      let stopped = false;
      timers.push(
        setTimeout(() => {
          // A browser stopped still writes in dir as it exits, so the export waits for it to exit before dir goes.
          stopped = true;
          child.kill();
          timers.push(
            setTimeout(() => {
              child.kill("SIGKILL");
              timers.push(setTimeout(() => settle(late), STOP_GRACE_MS));
            }, STOP_GRACE_MS),
          );
        }, timeoutMs),
      );
      child.on("error", (err) => settle(err));
      child.on("exit", (code) => {
        if (stopped) settle(late);
        else if (existsSync(output)) settle();
        else settle(new Error(`The browser exited (${code}) without a PDF. ${stderr.trim().split("\n").slice(-2).join(" ")}`));
      });
    });
    return await fs.readFile(output);
  } finally {
    // Retried, as a helper process of the browser can still be closing a file in it.
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}
