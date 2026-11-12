// Writes schema/aitrack.schema.json from the zod schema, for editors and other tools.
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { ProjectFileSchema, SCHEMA_URL } from "../packages/core/src/index.ts";

const schema = z.toJSONSchema(ProjectFileSchema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
const out = {
  $id: SCHEMA_URL,
  title: "AI Tracking System project file (.aitrack)",
  ...schema,
};
writeFileSync(new URL("../schema/aitrack.schema.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log("schema/aitrack.schema.json written");
