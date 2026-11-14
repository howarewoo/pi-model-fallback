import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "./config.ts";
import { installFallback } from "./fallback.ts";

export default async function fallback(pi: ExtensionAPI) {
  const path = join(getAgentDir(), "model-fallback.json");
  try {
    installFallback(pi, parseConfig(JSON.parse(await readFile(path, "utf8"))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Cannot load ${path}: ${String(error)}`);
  }
}
