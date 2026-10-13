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

/** Prints the HTML to a PDF and returns its bytes. */
export async function htmlToPdf(html: string, timeoutMs = 60_000): Promise<Buffer> {
  const browser = findBrowser();
  if (!browser) throw new NoBrowserError();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wpa-pdf-"));
  try {
    const input = path.join(dir, "report.html");
    const output = path.join(dir, "report.pdf");
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
      const child = spawn(browser, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr = (stderr + String(d)).slice(-2000)));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`The browser didn't finish the PDF within ${timeoutMs / 1000} s.`));
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (existsSync(output)) resolve();
        else reject(new Error(`The browser exited (${code}) without a PDF. ${stderr.trim().split("\n").slice(-2).join(" ")}`));
      });
    });
    return await fs.readFile(output);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
