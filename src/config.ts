import fs from "node:fs/promises";
import { configPath } from "./paths.js";

export interface TaskMasterConfig {
  version: 1;
  enabledRuntimes: string[];
}

export const DEFAULT_CONFIG: TaskMasterConfig = {
  version: 1,
  enabledRuntimes: [],
};

export function parseConfig(raw: string): TaskMasterConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_CONFIG };
  const record = parsed as Record<string, unknown>;
  const enabled = Array.isArray(record.enabledRuntimes)
    ? record.enabledRuntimes.filter((item): item is string => typeof item === "string")
    : [];
  return { version: 1, enabledRuntimes: enabled };
}

export async function loadConfig(home: string): Promise<TaskMasterConfig> {
  const file = configPath(home);
  try {
    const raw = await fs.readFile(file, "utf8");
    return parseConfig(raw);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    await saveConfig(home, DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(home: string, config: TaskMasterConfig): Promise<void> {
  const file = configPath(home);
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}
