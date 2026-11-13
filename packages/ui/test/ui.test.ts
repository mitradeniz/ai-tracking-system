import { describe, expect, it } from "vitest";
import { splitReport } from "../src/components/Markdown.tsx";
import { permissionRules } from "../src/model.ts";

describe("permission rules", () => {
  it("allows each command of a refused command line", () => {
    expect(permissionRules('Bash cd "/a b/c" && find . -type f | sort | sed \'s#x##\' && wc -l contracts/…')).toEqual([
      "Bash(cd:*)",
      "Bash(find:*)",
      "Bash(sort:*)",
      "Bash(sed:*)",
      "Bash(wc:*)",
    ]);
    expect(permissionRules("Bash git push origin main")).toEqual(["Bash(git push:*)"]);
    expect(permissionRules("Bash NODE_ENV=test /usr/local/bin/node x.mjs")).toEqual(["Bash(node:*)"]);
    expect(permissionRules("WebFetch https://example.com")).toEqual(["WebFetch"]);
  });
});

describe("chat messages", () => {
  it("takes the report off the end of a message", () => {
    const fenced = splitReport('Done.\n\n```aitrack-report\n{"task":"T1","status":"done"}\n```');
    expect(fenced).toEqual({ text: "Done.", report: '{"task":"T1","status":"done"}' });
    const bare = splitReport('All set.\n```json\n{"task":"T1","status":"blocked","pr":null}\n```\n');
    expect(bare.text).toBe("All set.");
    expect(JSON.parse(bare.report!)).toMatchObject({ task: "T1", status: "blocked" });
    expect(splitReport("Just text with {braces}.")).toEqual({ text: "Just text with {braces}.", report: null });
  });
});
