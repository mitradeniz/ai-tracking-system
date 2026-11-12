import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { EventSchema, type TrackEvent } from "@aitrack/core";

export function defaultDataDir(): string {
  return process.env.AITRACK_DATA_DIR ?? path.join(homedir(), ".aitrack");
}

export interface RegistryEntry {
  key: string;
  filePath: string;
  addedAt: string;
}

/** Stable key for a project file path. */
export function projectKey(filePath: string): string {
  return "p-" + createHash("sha1").update(path.resolve(filePath)).digest("hex").slice(0, 12);
}

/** Writes a file atomically: temp file in the same directory, then rename. */
export async function writeFileAtomic(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, target);
}

export class Store {
  constructor(readonly dataDir: string) {}

  private get registryPath(): string {
    return path.join(this.dataDir, "registry.json");
  }

  private eventsPath(key: string): string {
    return path.join(this.dataDir, "events", `${key}.jsonl`);
  }

  async readRegistry(): Promise<RegistryEntry[]> {
    try {
      const raw = JSON.parse(await readFile(this.registryPath, "utf8")) as { projects?: RegistryEntry[] };
      return Array.isArray(raw.projects) ? raw.projects.filter((p) => p && p.key && p.filePath) : [];
    } catch {
      return [];
    }
  }

  async writeRegistry(projects: RegistryEntry[]): Promise<void> {
    await writeFileAtomic(this.registryPath, JSON.stringify({ projects }, null, 2) + "\n");
  }

  async readEvents(key: string): Promise<TrackEvent[]> {
    let text: string;
    try {
      text = await readFile(this.eventsPath(key), "utf8");
    } catch {
      return [];
    }
    const events: TrackEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = EventSchema.safeParse(JSON.parse(line));
        if (parsed.success) events.push(parsed.data);
      } catch {
        // A torn or corrupted line is skipped; the rest of the log stays usable.
      }
    }
    return events;
  }

  async appendEvents(key: string, events: TrackEvent[]): Promise<void> {
    if (events.length === 0) return;
    await mkdir(path.dirname(this.eventsPath(key)), { recursive: true });
    await appendFile(this.eventsPath(key), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  }
}
