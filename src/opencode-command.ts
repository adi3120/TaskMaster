import { shellQuote } from "./tmux.js";

/**
 * OpenCode must receive --model on every automated run.
 * Omitting it would reuse whatever model OpenCode remembered.
 */
export function buildOpenCodeRunCommand(input: { bin: string; model: string; prompt: string }): string {
  const model = input.model.trim();
  const prompt = input.prompt.trim();
  if (!model) {
    throw new Error(
      'Builder OpenCode model is not configured. Set agents.builder.model. TaskMaster will not use OpenCode\'s remembered model.',
    );
  }
  if (!prompt) {
    throw new Error("Builder prompt is empty.");
  }
  return [
    shellQuote(input.bin),
    "run",
    "--model",
    shellQuote(model),
    shellQuote(prompt),
  ].join(" ");
}

export function fileRequestedByPrompt(prompt: string): string | null {
  const match = prompt.match(/\bCreate\s+([A-Za-z0-9._/-]+\.md)\b/);
  return match?.[1] ?? null;
}

export function sessionIdFromOutput(output: string): string | null {
  const match = output.match(/\bses_[A-Za-z0-9]+\b/);
  return match?.[0] ?? null;
}
