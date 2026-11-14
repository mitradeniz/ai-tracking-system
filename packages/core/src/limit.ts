/**
 * The reason a task is parked with while its chat's CLI waits for its usage limit to reset. The
 * tracker writes it; the board and the UI read the CLI and the time back from it.
 */
export const LIMIT_REASON = "Usage limit:";

export function limitReason(cli: string, until: number): string {
  return `${LIMIT_REASON} ${cli} · until ${new Date(until).toISOString()}`;
}

/** The CLI name and the time in a reason written by limitReason. */
export function parseLimitReason(reason: string | undefined | null): { cli: string; until: number } | null {
  const m = /^Usage limit: (.+) · until (\S+)$/.exec(reason ?? "");
  if (!m) return null;
  const until = Date.parse(m[2]!);
  return Number.isFinite(until) ? { cli: m[1]!, until } : null;
}
