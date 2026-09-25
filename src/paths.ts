import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function taskmasterHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TASKMASTER_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".taskmaster");
}

export async function ensureHome(home: string): Promise<void> {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700);
  const secrets = path.join(home, "secrets");
  await fs.mkdir(secrets, { recursive: true, mode: 0o700 });
  await fs.chmod(secrets, 0o700);
}

export function configPath(home: string): string {
  return path.join(home, "config.json");
}

export function databasePath(home: string): string {
  return path.join(home, "state.sqlite");
}

export function secretsDir(home: string): string {
  return path.join(home, "secrets");
}
