/**
 * Writes the ORM code Model2DB generates for each example project into shared/test-cases/orm/model2db/<example>/<orm>/,
 * so the ORM readers of both versions can be checked against the schema of the same project. The files are never
 * edited by hand: run this again when Model2DB's generators change, then write their expected.json with
 * `UPDATE_SHARED=1 npx vitest run src/core/importers/orm/orm.test.ts` from web/.
 *
 * Usage: node scripts/orm-fixtures.mts [path to the Model2DB repository]   (default: ../Model2DB)
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const core = join(
  resolve(root, process.argv[2] ?? "../Model2DB"),
  "web/src/core",
);
const { readProject } = await import(join(core, "interop/project.ts"));
const { detectFormat, parseInput } = await import(
  join(core, "parsers/registry.ts")
);
const { reconcile } = await import(join(core, "design/edit.ts"));
const { generate, findOutput } = await import(
  join(core, "generate/outputs.ts")
);
const { EXAMPLES } = await import(join(root, "web/src/examples/index.ts"));

/** The ORMs DB2CRUD reads, in the order of the roadmap. */
const ORMS = ["sqlalchemy", "sqlmodel", "django", "tortoise", "prisma", "typeorm", "sequelize", "drizzle"];

const out = join(root, "shared/test-cases/orm/model2db");
// The code is written again; the schema read from it (expected.json) stays until the tests write it again
const clean = (folder: string): void => {
  if (!existsSync(folder)) return;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) clean(path);
    else if (entry.name !== "expected.json") rmSync(path);
  }
};
clean(out);
for (const example of EXAMPLES) {
  const project = readProject(example.text);
  if (!project.ok) throw new Error(`${example.id}: ${project.error}`);
  const { input, output } = project.project;
  const parsed = parseInput(
    input.text,
    input.format ?? detectFormat(input.text, input.fileName),
    { rootName: "Root" },
  );
  const design = reconcile(
    project.project.designs.relational,
    parsed.schema,
    "relational",
  );
  for (const orm of ORMS) {
    const generator = findOutput(orm);
    const options = {
      naming: output.naming.relational,
      strings: output.strings,
      engine: output.engine,
      migrations: false,
    };
    for (const file of generate(parsed.schema, design, generator, options)
      .files) {
      const path = join(out, example.id, orm, file.name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
  }
}
console.log(`ORM fixtures written to ${out}`);
