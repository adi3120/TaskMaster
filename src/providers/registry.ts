import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const PROVIDER_KINDS = [
  "openrouter",
  "openai",
  "anthropic",
  "openai-compatible",
  "ollama",
  "custom-cli",
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ProviderRecord {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string | null;
  apiKeyRef: string | null;
  defaultModel: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProviderRow {
  id: string;
  kind: string;
  label: string;
  base_url: string | null;
  api_key_ref: string | null;
  default_model: string | null;
  created_at: string;
  updated_at: string;
}

export function addProvider(
  db: DatabaseSync,
  input: {
    kind: ProviderKind;
    label: string;
    baseUrl?: string | null;
    apiKeyRef?: string | null;
    defaultModel?: string | null;
  },
): ProviderRecord {
  if (!PROVIDER_KINDS.includes(input.kind)) {
    throw new Error(`Unknown provider kind ${input.kind}`);
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO providers (id, kind, label, base_url, api_key_ref, default_model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.label,
    input.baseUrl ?? null,
    input.apiKeyRef ?? null,
    input.defaultModel ?? null,
    now,
    now,
  );
  return getProvider(db, id);
}

export function listProviders(db: DatabaseSync): ProviderRecord[] {
  const rows = db.prepare("SELECT * FROM providers ORDER BY created_at ASC").all() as unknown as ProviderRow[];
  return rows.map(toRecord);
}

export function getProvider(db: DatabaseSync, id: string): ProviderRecord {
  const row = db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as ProviderRow | undefined;
  if (!row) throw new Error(`Provider ${id} not found`);
  return toRecord(row);
}

function toRecord(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    kind: row.kind as ProviderKind,
    label: row.label,
    baseUrl: row.base_url,
    apiKeyRef: row.api_key_ref,
    defaultModel: row.default_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
