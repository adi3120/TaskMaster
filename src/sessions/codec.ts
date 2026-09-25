/**
 * Session params persisted per agent, task, and runtime.
 * Inspired by Paperclip's AdapterSessionCodec. Unknown fields are dropped
 * so a later resume cannot smuggle arbitrary JSON into the next launch.
 */
export interface SessionCodec {
  deserialize(raw: unknown): Record<string, unknown> | null;
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null;
  getDisplayId(params: Record<string, unknown> | null): string | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const runtimeSessionCodec: SessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readString(record.sessionId) ?? readString(record.session_id) ?? readString(record.sessionID);
    if (!sessionId) return null;
    const cwd = readString(record.cwd) ?? readString(record.workdir);
    const model = readString(record.model);
    return { sessionId, ...(cwd ? { cwd } : {}), ...(model ? { model } : {}) };
  },
  serialize(params) {
    if (!params) return null;
    return this.deserialize(params);
  },
  getDisplayId(params) {
    if (!params) return null;
    return readString(params.sessionId);
  },
};
