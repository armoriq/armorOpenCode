export const MAX_PARAM_CHARS = 2000;

// Strings truncated to MAX_PARAM_CHARS, secrets redacted, non-objects become {}.
export function sanitizeParams(value: unknown): Record<string, unknown> {
  throw new Error("not implemented");
}

export function redactText(text: string): string {
  throw new Error("not implemented");
}
