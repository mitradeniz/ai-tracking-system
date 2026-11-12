import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Starting an agent runs a program on this computer, so those endpoints need a control token on
 * top of the loopback and same-origin checks. The token lives in the data folder (readable only by
 * this user); the desktop app passes it to its windows, and `aitrack serve` prints a link with it.
 */
export async function ensureControlToken(dataDir: string): Promise<string> {
  const file = path.join(dataDir, "control-token");
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (/^[a-f0-9]{32,128}$/.test(existing)) return existing;
  } catch {
    // Created below.
  }
  const token = randomBytes(24).toString("hex");
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, token + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
  return token;
}

export function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
