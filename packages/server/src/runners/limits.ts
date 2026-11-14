/**
 * Usage limits of the AI CLIs. When a CLI says its plan's limit is reached, the tracker does not
 * treat the run as failed: it waits until the limit resets and then lets the chat go on.
 */

export interface UsageLimit {
  /** When to try again (ms since epoch). */
  until: number;
  /** False when the message did not say when the limit resets: the wait is a guess. */
  known: boolean;
  message: string;
}

/** Messages that mean "your plan's limit is used up, wait". Not a full context window or a too-long prompt. */
const LIMIT =
  /usage limit|(?:5-hour|five-hour|hourly|daily|weekly|monthly|session|opus|sonnet) limit|hit your (?:usage )?limit|limit (?:has been )?reached|limit will reset|rate[ _-]?limit|quota (?:exceeded|exhausted|reached)|exceeded your (?:current )?quota|resource_exhausted|too many requests|\b429\b|usage_limit/i;
const NOT_A_LIMIT = /context (?:window|length|limit)|token limit|prompt is too long|max_tokens|credit balance is too low/i;

/** Without a reset time: a short wait for a rate limit, a longer one for a plan's limit. */
const GUESS_RATE_MS = 5 * 60_000;
const GUESS_PLAN_MS = 30 * 60_000;

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** The wall-clock parts of a moment in a time zone (or the computer's own). */
function wall(at: number, tz: string | undefined): { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number } {
  if (!tz) {
    const t = new Date(at);
    return { y: t.getFullYear(), mo: t.getMonth(), d: t.getDate(), h: t.getHours(), mi: t.getMinutes(), s: t.getSeconds(), wd: t.getDay() };
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return {
    y: Number(parts.year),
    mo: Number(parts.month) - 1,
    d: Number(parts.day),
    h: Number(parts.hour) % 24,
    mi: Number(parts.minute),
    s: Number(parts.second),
    wd: DAYS.indexOf(String(parts.weekday).slice(0, 3).toLowerCase()),
  };
}

/** The next time the clock shows h:mi (on that weekday, when given), in a time zone or locally. */
export function nextClockTime(h: number, mi: number, weekday: number | null, tz: string | undefined, now: number): number {
  let zone = tz;
  if (zone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
    } catch {
      zone = undefined;
    }
  }
  const w = wall(now, zone);
  // The zone's offset now: its wall clock read as UTC, minus the real time.
  const offset = Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s) - Math.floor(now / 1000) * 1000;
  for (let add = 0; add <= 7; add += 1) {
    const day = (w.wd + add) % 7;
    if (weekday !== null && day !== weekday) continue;
    const at = Date.UTC(w.y, w.mo, w.d + add, h, mi, 0) - offset;
    if (at > now + 30_000) return at;
  }
  return now + 24 * 3_600_000;
}

const UNIT: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

/** When the limit resets, if the message says so. */
export function resetTime(text: string, now = Date.now()): number | null {
  // Claude Code: "Claude AI usage limit reached|1736272800".
  let m = /\|(\d{10})\b/.exec(text);
  if (m) return Number(m[1]) * 1000;
  // Codex and others in JSON: "resets_in_seconds": 5025, "retry_after": 30.
  m = /"?(?:resets?_in_seconds|retry_after(?:_seconds)?|retryDelay)"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s?"?/i.exec(text);
  if (m) return now + Math.round(Number(m[1]) * 1000);
  m = /"?(?:resets?_at|reset_time)"?\s*[:=]\s*"?(\d{10})\b/i.exec(text);
  if (m) return Number(m[1]) * 1000;
  // An ISO time: "resets at 2026-11-14T15:00:00Z".
  m = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/.exec(text);
  if (m && /reset|again|until|after/i.test(text)) {
    const at = Date.parse(m[1]!);
    if (Number.isFinite(at) && at > now) return at;
  }
  // "try again in 2 hours 13 minutes", "resets in 4h 30m", "retry in 34.5s".
  m = /(?:again|retry|resets?|reset|available|wait)\s+in\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (m) {
    let ms = 0;
    for (const part of m[1]!.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
      const unit = part[2]!.toLowerCase();
      const key = unit.startsWith("d") ? "d" : unit.startsWith("h") ? "h" : unit.startsWith("m") ? "m" : "s";
      ms += Number(part[1]) * UNIT[key]!;
    }
    if (ms > 0) return now + Math.round(ms);
  }
  // "resets 3pm (Europe/Istanbul)", "resets Mon 9am", "try again at 3:05 PM", "will reset at 15:00".
  m =
    /(?:resets?|reset at|again at|available at|until)\s+(?:at\s+)?(?:(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(?([A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?|UTC)\)?)?/i.exec(
      text,
    );
  if (m && (m[3] || m[4])) {
    let h = Number(m[2]);
    const mi = m[3] ? Number(m[3]) : 0;
    const ampm = m[4]?.toLowerCase();
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    if (h > 23 || mi > 59) return null;
    const weekday = m[1] ? DAYS.indexOf(m[1].toLowerCase()) : null;
    const tz = m[5] === "UTC" ? "UTC" : m[5];
    return nextClockTime(h, mi, weekday, tz, now);
  }
  return null;
}

/** A usage limit in a CLI's error, or null when the error is something else. */
export function usageLimit(text: string, now = Date.now()): UsageLimit | null {
  if (!text || !LIMIT.test(text) || NOT_A_LIMIT.test(text)) return null;
  const at = resetTime(text, now);
  const plan = /usage|hour|daily|weekly|monthly|session|plan|quota|opus|sonnet/i.test(text);
  const message = text.replace(/\s+/g, " ").trim().slice(0, 400);
  if (at && at > now) return { until: at + 60_000, known: true, message };
  return { until: now + (plan ? GUESS_PLAN_MS : GUESS_RATE_MS), known: false, message };
}
