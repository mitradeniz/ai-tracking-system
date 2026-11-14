import { describe, expect, it } from "vitest";
import { nextClockTime, resetTime, usageLimit } from "../src/runners/limits.ts";

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
    expect(usageLimit("429 Too Many Requests", NOW)).toMatchObject({ known: false, until: NOW + 5 * 60_000 });
    expect(usageLimit("Your weekly usage limit is reached.", NOW)).toMatchObject({ known: false, until: NOW + 30 * 60_000 });
  });

  it("finds the next time a clock shows an hour, in a time zone", () => {
    expect(nextClockTime(9, 0, null, "Asia/Tokyo", NOW)).toBe(Date.UTC(2026, 10, 15, 0, 0, 0));
    expect(nextClockTime(9, 0, null, "Not/AZone", NOW)).toBeGreaterThan(NOW);
  });
});
