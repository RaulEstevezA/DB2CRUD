/**
 * Scenarios whose database is the user's own (`ddl: true`): the tests of the generated project create their tables
 * from the hand-written SQL of verification/ddl/<database>.sql instead of from the entities, so an entity with a
 * wrong name or type cannot hide behind a table created with the same mistake. A round trip of every table is added.
 * Only the files of verification/.work/ change: the generated projects are written as always.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const originalDdl = (database) =>
  readFileSync(join(here, "ddl", `${database}.sql`), "utf8");

/** The statements of a script of verification/ddl/ (none has a semicolon at the end of a line inside it). */
export const statementsOf = (sql) =>
  sql
    .split(/;\s*(?:\n|$)/)
    .map((item) => item.trim())
    .filter((item) => item !== "");

function replaced(files, path, changes) {
  const file = files.find((item) => item.path === path);
  if (!file) throw new Error(`No ${path} to create the original database from`);
  let content = file.content;
  for (const [from, to] of changes) {
    if (!content.includes(from))
      throw new Error(`${path} does not contain: ${from}`);
    content = content.replaceAll(from, to);
  }
  return files.map((item) => (item === file ? { ...file, content } : item));
}

function sqlalchemy(files, { create, drop, async }) {
  const test = `"""Every table of the original database is the entities' one, and keeps the values written."""

import inspect as python

import pytest
from sqlalchemy import inspect, select

import tests.factories as factories
from app.db import Base
from tests.original import CREATE


def names(connection, schema):
    found = inspect(connection)
    return {t: {c["name"]: c["nullable"] for c in found.get_columns(t, schema=schema)} for t in found.get_table_names(schema=schema)}


@pytest.mark.parametrize("mapper", sorted(Base.registry.mappers, key=lambda m: m.class_.__name__), ids=lambda m: m.class_.__name__)
${async ? "async " : ""}def test_round_trip(engine, sql_uow, mapper):
    entity = mapper.class_
    table = mapper.local_table
    ${
      async
        ? `async with engine.connect() as connection:
        columns = (await connection.run_sync(names, table.schema))[table.name]`
        : `with engine.connect() as connection:
        columns = names(connection, table.schema)[table.name]`
    }
    # SQLite reports INTEGER PRIMARY KEY as nullable
    keys = {c.name for c in table.primary_key}
    assert {n: v and n not in keys for n, v in columns.items()} == {c.name: c.nullable for c in table.columns}
    add = next(f for n, f in vars(factories).items() if n.startswith("add_") and f.__annotations__["return"] in (entity, entity.__name__))
    make = getattr(factories, add.__name__.replace("add_", "new_"))
    required = [p for p in python.signature(make).parameters.values() if p.default is p.empty]
    wanted = {} if len(required) > 1 else {k: v for k, v in vars(make(1)).items() if not k.startswith("_")}
    stored = ${async ? "await " : ""}add(sql_uow, 1)
    session = sql_uow.session
    ${async ? "await " : ""}session.flush()
    key = inspect(stored).identity
    session.expunge_all()
    found = ${async ? "await " : ""}session.get(entity, key)
    assert found is not None
    for name, value in wanted.items():
        if name not in mapper.column_attrs or value is None:
            continue
        read = getattr(found, name)
        if getattr(read, "tzinfo", None):
            read = read.replace(tzinfo=None)
        assert (type(read), read) == (type(value), value), name
    # Arrays and the types the entities only pass on, with a value
    special = {"tags": ["a", "b"], "numbers": [1, 2], "ip": "10.0.0.1", "span": "1 day"}
    if set(special) <= set(mapper.column_attrs.keys()):
        for name, value in special.items():
            setattr(found, name, value)
        ${async ? "await " : ""}session.flush()
        session.expunge_all()
        found = ${async ? "await " : ""}session.get(entity, key)
        assert [found.tags, found.numbers, str(found.ip), found.span.days] == [["a", "b"], [1, 2], "10.0.0.1", 1]
    if hasattr(found, "note"):
        found.note = "changed"
        ${async ? "await " : ""}session.flush()
        session.expunge_all()
        assert (${async ? "await " : ""}session.get(entity, key)).note == "changed"
    assert CREATE
`;
  const original = `CREATE = ${JSON.stringify(create, null, 1)}
DROP = ${JSON.stringify(drop, null, 1)}


def run(connection, statements):
    for statement in statements:
        connection.exec_driver_sql(statement)
`;
  const pad = async ? "        " : "    ";
  const changed = replaced(
    files,
    "tests/conftest.py",
    async
      ? [
          [
            "await connection.run_sync(Base.metadata.drop_all)",
            "await connection.run_sync(run, DROP)",
          ],
          [
            "await connection.run_sync(Base.metadata.create_all)",
            "await connection.run_sync(run, CREATE)",
          ],
          [
            "import pytest\n",
            "import pytest\nfrom tests.original import CREATE, DROP, run\n",
          ],
        ]
      : [
          [
            "    Base.metadata.drop_all(engine)",
            "    with engine.begin() as connection:\n        run(connection, DROP)",
          ],
          [
            "    Base.metadata.create_all(engine)",
            "    with engine.begin() as connection:\n        run(connection, CREATE)",
          ],
          [
            "import pytest\n",
            "import pytest\nfrom tests.original import CREATE, DROP, run\n",
          ],
        ],
  );
  return [
    ...changed,
    { path: "tests/original.py", content: original },
    { path: "tests/test_original.py", content: test },
  ];
}

// Without an ORM the tests already create their tables from SQL: only the schema changes
const STACKS = { sqlalchemy, sql: (files) => files };

export function onOriginalDatabase(files, settings, drop) {
  const create = statementsOf(originalDdl(settings.database));
  // The schemas of PostgreSQL are kept between tests: dropStatements drops what is in them
  const safe = create.map((item) =>
    item.replace(/^CREATE SCHEMA (?!IF)/, "CREATE SCHEMA IF NOT EXISTS "),
  );
  return STACKS[settings.orm ?? "sqlalchemy"](files, {
    create: safe,
    drop,
    async: settings.execution === "async",
  });
}
