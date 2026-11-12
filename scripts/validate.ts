// Validates one or more .aitrack files: `npm run validate -- path/to/project.aitrack`.
import { readFileSync } from "node:fs";
import { buildGraph, parseProjectFile } from "../packages/core/src/index.ts";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: npm run validate -- <file.aitrack> [...]");
  process.exit(2);
}
let failed = false;
for (const file of files) {
  const { project, issues } = parseProjectFile(readFileSync(file, "utf8"));
  const errors = issues.filter((i) => i.level === "error");
  for (const i of issues) console.log(`${file}: ${i.level}: ${i.message}${i.path ? ` (${i.path})` : ""}`);
  if (!project || errors.length > 0) {
    failed = true;
    continue;
  }
  const g = buildGraph(project.tasks);
  const roots = project.tasks.filter((t) => t.dependsOn.length === 0).length;
  console.log(
    `${file}: ok — ${project.agents.length} chats, ${project.tasks.length} tasks, ${roots} can start immediately, ` +
      `${Math.max(...g.layer.values()) + 1} steps deep, critical path ${g.critical.size} tasks.`,
  );
}
process.exit(failed ? 1 : 0);
