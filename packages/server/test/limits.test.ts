import { describe, expect, it } from "vitest";
import { codexRecordedReset, nextClockTime, resetTime, usageLimit } from "../src/runners/limits.ts";

// 2026-11-14 10:00 UTC: 13:00 in Istanbul.
const NOW = Date.UTC(2026, 10, 14, 10, 0, 0);

describe("usage limits", () => {
  it("reads when each CLI's limit resets", () => {
    expect(resetTime("Claude AI usage limit reached|1794655200", NOW)).toBe(1794655200 * 1000);
    expect(resetTime("You've hit your usage limit. Upgrade to Pro or try again in 2 hours 13 minutes.", NOW)).toBe(NOW + (2 * 60 + 13) * 60_000);
    expect(resetTime('{"error":{"type":"usage_limit_reached","resets_in_seconds":5025}}', NOW)).toBe(NOW + 5_025_000);
    expect(resetTime("Quota exceeded for quota metric. Please retry in 34.5s.", NOW)).toBe(NOW + 34_500);
    expect(resetTime("5-hour limit reached ∙ resets 3pm (Europe/Istanbul)", NOW)).toBe(Date.UTC(2026, 10, 14, 12, 0, 0));
    // 11am Istanbul has passed today: tomorrow.
    expect(resetTime("You've hit your limit · resets 11am (Europe/Istanbul)", NOW)).toBe(Date.UTC(2026, 10, 15, 8, 0, 0));
    // 14 November 2026 is a Saturday: next Monday.
    expect(resetTime("Weekly limit reached · resets Mon 9:30am (UTC)", NOW)).toBe(Date.UTC(2026, 10, 16, 9, 30, 0));
    expect(resetTime("Rate limit reached, try again at 2026-11-14T10:20:00Z", NOW)).toBe(Date.UTC(2026, 10, 14, 10, 20, 0));
  });

  it("tells a plan's limit from other errors, and guesses when no time is given", () => {
    expect(usageLimit("Prompt is too long", NOW)).toBeNull();
    expect(usageLimit("context window exceeded: token limit reached", NOW)).toBeNull();
    expect(usageLimit("Credit balance is too low", NOW)).toBeNull();
    expect(usageLimit("boom: not signed in", NOW)).toBeNull();
    expect(usageLimit("Claude AI usage limit reached|1794655200", NOW)).toMatchObject({ known: true, until: 1794655200 * 1000 + 60_000 });
  });

  it("without a time in the message, takes it from the plan, never from trying again and again", () => {
    // A rate limit passes in a minute or two; when it comes back right away it is the plan's limit.
    expect(usageLimit("429 Too Many Requests", NOW)).toMatchObject({ known: false, basis: "rate", until: NOW + 2 * 60_000 });
    expect(usageLimit("429 Too Many Requests", NOW, { again: true, windowStart: NOW - 3_600_000 })).toMatchObject({
      basis: "window",
      until: NOW + 4 * 3_600_000 + 60_000,
    });
    // The 5-hour window: 5 hours after its first run.
    expect(usageLimit("Claude usage limit reached.", NOW, { provider: "claude", windowStart: NOW - 2 * 3_600_000 })).toMatchObject({
      known: false,
      basis: "window",
      until: NOW + 3 * 3_600_000 + 60_000,
    });
    // Codex's own records say when.
    expect(usageLimit("You've hit your usage limit.", NOW, { provider: "codex", recorded: NOW + 1_800_000 })).toMatchObject({
      known: true,
      basis: "codex",
      until: NOW + 1_800_000 + 60_000,
    });
    // Gemini's daily quota: midnight Pacific (08:00 UTC the next day in November).
    expect(usageLimit("Quota exceeded: you have exhausted your daily quota", NOW, { provider: "gemini" })).toMatchObject({
      basis: "day",
      until: Date.UTC(2026, 10, 15, 8, 0, 0) + 60_000,
    });
    // Copilot's monthly premium requests: the 1st, 00:00 UTC.
    expect(usageLimit("You have reached your monthly limit of premium requests.", NOW, { provider: "copilot" })).toMatchObject({
      basis: "month",
      until: Date.UTC(2026, 11, 1) + 60_000,
    });
  });

  it("reads the reset time from Codex's session records", () => {
    const lines = [
      JSON.stringify({ timestamp: "2026-11-14T09:00:00Z", type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 40, window_minutes: 300, resets_in_seconds: 100 } } } }),
      JSON.stringify({
        timestamp: "2026-11-14T09:50:00Z",
        type: "event_msg",
        payload: { type: "token_count", rate_limits: { primary: { used_percent: 100, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 61, resets_in_seconds: 400000 } } },
      }),
    ];
    expect(codexRecordedReset(lines, NOW)).toBe(Date.UTC(2026, 10, 14, 10, 50, 0));
    expect(codexRecordedReset([lines[0]!], NOW)).toBeNull();
    expect(codexRecordedReset([JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 100, resets_at: 1794655200 } } } })], NOW)).toBe(1794655200 * 1000);
  });

  it("finds the next time a clock shows an hour, in a time zone", () => {
    expect(nextClockTime(9, 0, null, "Asia/Tokyo", NOW)).toBe(Date.UTC(2026, 10, 15, 0, 0, 0));
    expect(nextClockTime(9, 0, null, "Not/AZone", NOW)).toBeGreaterThan(NOW);
  });
});
