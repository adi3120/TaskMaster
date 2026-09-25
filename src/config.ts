import fs from "node:fs/promises";
import { configPath } from "./paths.js";

export interface AgentAssignment {
  runtime: string;
  model: string;
}

export interface TaskMasterConfig {
  version: 1;
  enabledRuntimes: string[];
  agents: {
    builder?: AgentAssignment;
  };
}

export const BUILDER_OPENCODE_MODEL = "opencode/nemotron-3.5-lightning-free";

export const DEFAULT_CONFIG: TaskMasterConfig = {
  version: 1,
  enabledRuntimes: ["opencode"],
  agents: {
    builder: {
      runtime: "opencode",
      model: BUILDER_OPENCODE_MODEL,
    },
  },
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
  const agentsRecord =
    typeof record.agents === "object" && record.agents !== null
      ? (record.agents as Record<string, unknown>)
      : {};
  const builderRaw = agentsRecord.builder;
  let builder: AgentAssignment | undefined;
  if (typeof builderRaw === "object" && builderRaw !== null) {
    const builderRecord = builderRaw as Record<string, unknown>;
    builder = {
      runtime: typeof builderRecord.runtime === "string" ? builderRecord.runtime : "",
      model: typeof builderRecord.model === "string" ? builderRecord.model : "",
    };
  }
  return { version: 1, enabledRuntimes: enabled, agents: builder ? { builder } : {} };
}

export function requireBuilderOpenCodeModel(config: TaskMasterConfig): string {
  const assignment = config.agents.builder;
  const model = assignment?.model.trim() ?? "";
  if (assignment?.runtime !== "opencode" || model.length === 0) {
    throw new Error(
      'Builder OpenCode model is not configured. Set agents.builder.runtime to "opencode" and agents.builder.model. TaskMaster will not use OpenCode\'s remembered model.',
    );
  }
  return model;
}

export async function loadConfig(home: string): Promise<TaskMasterConfig> {
  const file = configPath(home);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = parseConfig(raw);
    if (!parsed.agents.builder) {
      const filled: TaskMasterConfig = {
        ...parsed,
        enabledRuntimes: parsed.enabledRuntimes.includes("opencode")
          ? parsed.enabledRuntimes
          : [...parsed.enabledRuntimes, "opencode"],
        agents: { builder: DEFAULT_CONFIG.agents.builder },
      };
      await saveConfig(home, filled);
      return filled;
    }
    return parsed;
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
