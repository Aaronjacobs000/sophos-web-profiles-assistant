import { Router } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getRingBuffer } from "../log.js";
import { getState } from "../state.js";

export const logsRouter = Router();

logsRouter.get("/logs", (_req, res) => {
  res.json({ items: getRingBuffer() });
});

/** The last 200 audit entries, newest first. */
logsRouter.get("/audit", async (_req, res) => {
  const file = path.join(getState().dataDir, "audit.log");
  const text = await fs.readFile(file, "utf8").catch(() => "");
  const items = text
    .split("\n")
    .filter(Boolean)
    .slice(-200)
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  res.json({ items });
});
