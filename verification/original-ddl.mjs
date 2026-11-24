/**
 * Scenarios whose database is the user's own (`ddl: true`): the tests of the generated project create their tables
 * from the hand-written SQL of verification/ddl/<database>.sql instead of from the entities, so an entity with a
 * wrong name or type cannot hide behind a table created with the same mistake. A round trip of every table is added.
 * Only the files of verification/.work/ change: the generated projects are written as always.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const originalDdl = (database) => readFileSync(join(here, 'ddl', `${database}.sql`), 'utf8')

/** The statements of a script of verification/ddl/ (none has a semicolon at the end of a line inside it). */
export const statementsOf = (sql) =>
  sql
    .split(/;\s*(?:\n|$)/)
    .map((item) => item.trim())
    .filter((item) => item !== '')

function replaced(files, path, changes) {
  const file = files.find((item) => item.path === path)
  if (!file) throw new Error(`No ${path} to create the original database from`)
  let content = file.content
  for (const [from, to, optional] of changes) {
    const next = content.replaceAll(from instanceof RegExp ? new RegExp(from.source, 'g') : from, () => to)
    if (next === content && !optional) throw new Error(`${path} does not contain: ${from}`)
    content = next
  }
  return files.map((item) => (item === file ? { ...file, content } : item))
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
${async ? 'async ' : ''}def test_round_trip(engine, sql_uow, mapper):
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
    stored = ${async ? 'await ' : ''}add(sql_uow, 1)
    session = sql_uow.session
    ${async ? 'await ' : ''}session.flush()
    key = inspect(stored).identity
    session.expunge_all()
    found = ${async ? 'await ' : ''}session.get(entity, key)
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
        ${async ? 'await ' : ''}session.flush()
        session.expunge_all()
        found = ${async ? 'await ' : ''}session.get(entity, key)
        assert [found.tags, found.numbers, str(found.ip), found.span.days] == [["a", "b"], [1, 2], "10.0.0.1", 1]
    if hasattr(found, "note"):
        found.note = "changed"
        ${async ? 'await ' : ''}session.flush()
        session.expunge_all()
        assert (${async ? 'await ' : ''}session.get(entity, key)).note == "changed"
    assert CREATE
`
  const original = `CREATE = ${JSON.stringify(create, null, 1)}
DROP = ${JSON.stringify(drop, null, 1)}


def run(connection, statements):
    for statement in statements:
        connection.exec_driver_sql(statement)
`
  const pad = async ? '        ' : '    '
  const changed = replaced(
    files,
    'tests/conftest.py',
    async
      ? [
          ['await connection.run_sync(Base.metadata.drop_all)', 'await connection.run_sync(run, DROP)'],
          ['await connection.run_sync(Base.metadata.create_all)', 'await connection.run_sync(run, CREATE)'],
          ['import pytest\n', 'import pytest\nfrom tests.original import CREATE, DROP, run\n'],
        ]
      : [
          ['    Base.metadata.drop_all(engine)', '    with engine.begin() as connection:\n        run(connection, DROP)'],
          ['    Base.metadata.create_all(engine)', '    with engine.begin() as connection:\n        run(connection, CREATE)'],
          ['import pytest\n', 'import pytest\nfrom tests.original import CREATE, DROP, run\n'],
        ],
  )
  return [...changed, { path: 'tests/original.py', content: original }, { path: 'tests/test_original.py', content: test }]
}

/** The test of the TypeScript projects: what the factories store is what is read, type included. */
const TS_ROUND_TRIP = `import { expect, it } from 'vitest'
import { useTestDatabase } from './database.js'
import { addOrder, addThing, newOrder, newThing } from './factories.js'

const sqlUow = useTestDatabase()

const show = (value: unknown): string =>
  // SQLite keeps no trailing zeros
  typeof value === 'string' && /^\\d\\d:\\d\\d:\\d\\d[+]00$/.test(value) ? show(value.slice(0, 8)) : typeof value === 'string' && /^\\d+\\.\\d+$/.test(value) ? 'decimal ' + Number(value) :
  value instanceof Uint8Array ? 'bytes ' + [...value].join() : value instanceof Date ? 'date ' + value.toISOString() : typeof value + ' ' + JSON.stringify(value)

function differences(wanted: object, found: object | null | undefined): string[] {
  return Object.entries(wanted)
    .filter(([name, value]) => value !== null && value !== undefined && show(value) !== show((found as Record<string, unknown> | null)?.[name]))
    .map(([name, value]) => name + ': ' + show(value) + ' / ' + show((found as Record<string, unknown> | null)?.[name]))
}

it('keeps every value of a thing', async () => {
  const uow = sqlUow()
  const stored = await addThing(uow, 1)
  expect(differences(newThing(1), await uow.things.findById(stored.id))).toEqual([])
  const found = (await uow.things.findById(stored.id))!
  SPECIAL
  found.note = 'changed'
  await uow.things.update(found)
  expect((await uow.things.findById(stored.id))?.note).toBe('changed')
})

it('keeps every value of an order', async () => {
  const uow = sqlUow()
  const stored = await addOrder(uow, 1)
  expect(differences(newOrder(1), await uow.order.findById(stored.id))).toEqual([])
})
`

/** Django's test database is created from the models, then replaced by the original tables. */
function django(files, { create, drop }) {
  const fixture = `

@pytest.fixture(scope="session")
def django_db_setup(django_db_setup, django_db_blocker):  # type: ignore[no-untyped-def]
    from django.core.management import call_command
    from django.db import connection

    from tests.original import ORIGINAL

    call_command("check", fail_level="ERROR")
    with django_db_blocker.unblock(), connection.cursor() as cursor:
        for statement in ORIGINAL:
            cursor.execute(statement)
`
  const test = `import pytest

from tests import factories


@pytest.mark.django_db
@pytest.mark.parametrize("name", ["thing", "order"])
def test_round_trip(sql_uow, name):
    wanted = getattr(factories, f"new_{name}")(1)
    stored = getattr(factories, f"add_{name}")(sql_uow, 1)
    found = type(stored).objects.get(pk=stored.pk)
    for field in type(stored)._meta.concrete_fields:
        if field.generated:
            continue
        value = getattr(wanted, field.attname)
        if value is None or type(value).__name__ in ("DatabaseDefault", "Deferred") or field.primary_key or field.attname in ("changed", "created_at"):
            continue
        read = getattr(found, field.attname)
        if getattr(read, "tzinfo", None):
            read = read.replace(tzinfo=None)
        if getattr(value, "tzinfo", None):
            value = value.replace(tzinfo=None)
        assert (type(read), read) == (type(value), value), field.attname
    if hasattr(found, "note"):
        special = {"tags": ["a", "b"], "numbers": [1, 2], "ip": "10.0.0.1", "span": "1 day"}
        if not hasattr(found, "span"):
            special = {}
        for key, value in special.items():
            setattr(found, key, value)
        found.note = "changed"
        sql_uow.things.update(found)
        found = type(stored).objects.get(pk=stored.pk)
        assert found.note == "changed"
        if special:
            assert (found.tags, found.numbers, str(found.ip)) == (["a", "b"], [1, 2], "10.0.0.1")
`
  return [
    ...files.map((item) => (item.path === 'tests/conftest.py' ? { ...item, content: item.content + fixture } : item)),
    { path: 'tests/original.py', content: `ORIGINAL = ${JSON.stringify([...drop, ...create], null, 1)}\n` },
    { path: 'tests/test_original.py', content: test },
  ]
}

const typescript =
  (path, changes) =>
  (files, { create, drop, database }) => [
    ...replaced(files, path, changes),
    { path: 'test/original.ts', content: `export const ORIGINAL: string[] = ${JSON.stringify([...drop, ...create], null, 2)}\n` },
    {
      path: 'test/round-trip.test.ts',
      content: TS_ROUND_TRIP.replace(
        'SPECIAL',
        database === 'postgresql' ? `Object.assign(found, { tags: ['a', 'b'], numbers: [1, 2], ip: '10.0.0.1', span: '1 day' })` : '',
      ).replace(
        "toBe('changed')",
        database === 'postgresql'
          ? "toBe('changed')\n  expect((await uow.things.findById(stored.id))).toMatchObject({ tags: ['a', 'b'], numbers: [1, 2], ip: '10.0.0.1' })"
          : "toBe('changed')",
      ),
    },
  ]
const TS_IMPORT = ['import { SqlUnitOfWork }', "import { ORIGINAL } from './original.js'\nimport { SqlUnitOfWork }"]
const typeorm = typescript('test/database.ts', [
  TS_IMPORT,
  ['await dataSource.synchronize(true)', 'for (const statement of ORIGINAL) await dataSource.query(statement)'],
])
const sequelize = typescript('test/database.ts', [
  TS_IMPORT,
  ['await db.sequelize.sync()', 'for (const statement of ORIGINAL) await db.sequelize.query(statement)'],
])
const drizzle = typescript('test/database.ts', [TS_IMPORT, [/return generate\w*Migration\([^\n]*/, 'return ORIGINAL']])
const prisma = typescript('test/setup.ts', [
  ['import type { TestProject }', "import { ORIGINAL } from './original.js'\nimport type { TestProject }"],
  [/  const script = [\s\S]*project\.provide\('schemaSql', statements\)/, "  project.provide('schemaSql', ORIGINAL)"],
])

/** A path of the project that ends like this. */
const pathOf = (files, end) => files.find((item) => item.path.endsWith(end)).path
const json = (items) => items.map((item) => JSON.stringify(item))
const php = (items) => items.map((item) => `'${item.replace(/['\\]/g, '\\$&')}'`)

function jpa(files, { create, drop }) {
  const path = pathOf(files, '/TestDatabase.java')
  // The enum types stay: the project's tests create them, and the driver remembers their number
  const statements = [...drop, ...create].filter((item) => !/^(DROP|CREATE) TYPE/.test(item))
  return replaced(files, path, [
    [
      / {8}factory\.getSchemaManager\(\)\.drop\(true\);\n {8}factory\.getSchemaManager\(\)\.create\(true\);\n {8}return factory\.createEntityManager\(\);/,
      `        EntityManager original = factory.createEntityManager();
        original.getTransaction().begin();
        original.unwrap(org.hibernate.Session.class).doWork(connection -> {
            try (java.sql.Statement statement = connection.createStatement()) {
                for (String sql : ORIGINAL) statement.execute(sql);
            }
        });
        original.getTransaction().commit();
        original.close();
        return factory.createEntityManager();`,
    ],
    [
      '    private static EntityManagerFactory factory;',
      `    private static final String[] ORIGINAL = {\n${json(statements).join(',\n')}\n    };\n\n    private static EntityManagerFactory factory;`,
    ],
  ])
}

function efcore(files, { create, database }) {
  const path = pathOf(files, '/TestDatabase.cs')
  return replaced(files, path, [
    [
      '        await db.Database.EnsureCreatedAsync();',
      `        var creator = (Microsoft.EntityFrameworkCore.Storage.IRelationalDatabaseCreator)Microsoft.EntityFrameworkCore.Infrastructure.AccessorExtensions.GetService<Microsoft.EntityFrameworkCore.Storage.IDatabaseCreator>(db.Database);
        if (!await creator.ExistsAsync()) await creator.CreateAsync();
        foreach (var sql in Original) await Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions.ExecuteSqlRawAsync(db.Database, sql);
${
  database === 'postgresql'
    ? `        var connection = (Npgsql.NpgsqlConnection)Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions.GetDbConnection(db.Database);
        await connection.OpenAsync();
        await connection.ReloadTypesAsync();
        await connection.CloseAsync();`
    : ''
}`,
    ],
    [
      '    private TestDatabase(',
      `    private static readonly string[] Original =\n    [\n${json(create).join(',\n')}\n    ];\n\n    private TestDatabase(`,
    ],
  ])
}

const doctrine = (files, { create, drop }) =>
  replaced(files, 'tests/TestDatabase.php', [
    ['        $tool->dropDatabase();\n', '', true],
    [
      / {8}\$schema = \$tool->getSchemaFromMetadata[\s\S]*?\n {8}\}\n/,
      `        foreach ([\n${php([...drop, ...create]).join(',\n')}\n        ] as $sql) {\n            $connection->executeStatement($sql);\n        }\n`,
    ],
  ])

const eloquent = (files, { create, drop }) =>
  replaced(files, 'tests/TestDatabase.php', [
    [
      '        self::createTables($schema);',
      `        foreach ([\n${php([...drop, ...create]).join(',\n')}\n        ] as $sql) {\n            $db->unprepared($sql);\n        }`,
    ],
    [/\n {4}\/\*\* Every table as the database has it[\s\S]*$/, '}\n'],
  ])

const exposed = (files, { create, drop }) =>
  replaced(files, pathOf(files, '/TestDatabase.kt'), [
    [/ {12}exec\("(CREATE|DROP)[^\n]*\n/, '', true],
    ['            SchemaUtils.drop(*TABLES)\n', ''],
    [
      / {12}(?:SchemaUtils\.create\(\*TABLES\)|\/\/ MariaDB takes[^\n]*\n {12}SchemaUtils\.createStatements[^\n]*)/,
      `            for (sql in listOf(\n${json([...drop, ...create]).join(',\n')}\n            )) exec(sql)`,
    ],
  ])

const seaorm = (files, { create, drop }) =>
  replaced(files, 'tests/data/database.rs', [
    ['Database, DatabaseConnection, Schema, Statement', 'Database, DatabaseConnection, Statement'],
    [/use [a-z_]+::entities::[^\n]*\n/, '', true],
    [/ {4}db\.execute_unprepared\([^\n]*\n/, '', true],
    [
      / {4}Schema::new[\s\S]*?\.expect\("the tables"\);/,
      `    for sql in [\n${json([...drop, ...create]).join(',\n')}\n    ] {\n        db.execute_unprepared(sql).await.expect(sql);\n    }`,
    ],
  ])

const fluent = (files, { create, drop }) =>
  replaced(files, pathOf(files, '/TestDatabase.swift'), [
    [
      /(?: {8}try await sql\.raw\("[^\n]*\n)+ {8}try await db\.schema\([\s\S]*?\n {4}\}\n/,
      `        for statement in [\n${json([...drop, ...create]).join(',\n')}\n        ] { try await sql.raw(SQLQueryString(statement)).run() }\n    }\n`,
    ],
  ])

// The round trip of a thing and of an order in the other languages: what the factories store is what is read, and the
// columns PostgreSQL keeps in types of its own are changed too

const only = (condition, text) => (condition ? text : '')
const withFiles = (stack, extra) => (files, options) => [...stack(files, options), ...extra(files, options)]

const javaRoundTrip = (files, { database }) => [
  {
    path: pathOf(files, '/TestDatabase.java').replace('TestDatabase', 'RoundTripTest'),
    content: `package app;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;

class RoundTripTest {
    private static String show(Object value) {
        if (value instanceof byte[] bytes) return java.util.Arrays.toString(bytes);
        if (value instanceof java.math.BigDecimal number) return number.stripTrailingZeros().toPlainString();
        if (value instanceof java.time.OffsetDateTime time) return time.toInstant().toString();
        if (value instanceof java.time.OffsetTime time) return time.toLocalTime().toString();
        return value.toString().replace(" ", "");
    }

    private static Map<String, String> values(Object entity, Object like) throws Exception {
        Map<String, String> result = new TreeMap<>();
        for (var field : like.getClass().getDeclaredFields()) {
            field.setAccessible(true);
            if (field.get(like) != null) result.put(field.getName(), field.get(entity) == null ? "null" : show(field.get(entity)));
        }
        return result;
    }

    @Test
    void keepsEveryValue() throws Exception {
        var entityManager = TestDatabase.open();
        var uow = new SqlUnitOfWork(entityManager);
        var thing = Factories.newThing(1);
        var stored = Factories.addThing(uow, 1);
        entityManager.clear();
        var found = uow.things().findById(stored.getId()).orElseThrow();
        assertEquals(values(thing, thing), values(found, thing));
        ${only(database === 'postgresql', 'found.setTags("{a,b}"); found.setNumbers("{1,2}"); found.setIp("10.0.0.1"); found.setSpan("1 day");')}
        found.setNote("changed");
        uow.things().update(found);
        entityManager.clear();
        found = uow.things().findById(stored.getId()).orElseThrow();
        assertEquals("changed", found.getNote());
        ${only(database === 'postgresql', 'assertEquals("{a,b}{1,2}10.0.0.1", (found.getTags() + found.getNumbers() + found.getIp()).replace("\\"", ""));')}
        var order = Factories.newOrder(1);
        var storedOrder = Factories.addOrder(uow, 1);
        entityManager.clear();
        assertEquals(values(order, order), values(uow.order().findById(storedOrder.getId()).orElseThrow(), order));
        entityManager.close();
    }
}
`,
  },
]

const csharpRoundTrip = (files, { database }) => [
  {
    path: pathOf(files, '/TestDatabase.cs').replace('TestDatabase', 'RoundTripTests'),
    content: `using Xunit;

namespace App.Tests;

public class RoundTripTests
{
    private static string Show(object value) => value switch
    {
        byte[] bytes => Convert.ToHexString(bytes),
        decimal number => number.ToString("0.############", System.Globalization.CultureInfo.InvariantCulture),
        DateTimeOffset { Year: < 1990 } time => time.UtcDateTime.ToString("HH:mm:ss"),
        DateTimeOffset time => time.UtcDateTime.ToString("O"),
        DateTime time => time.ToString("yyyy-MM-dd HH:mm:ss.ffffff"),
        _ => value.ToString()!.Replace(" ", ""),
    };

    private static string Values(object entity, object like) => string.Join("\\n", like.GetType().GetProperties()
        .Where(property => property.GetValue(like) is { } value && !(property.PropertyType.IsValueType && value.Equals(Activator.CreateInstance(value.GetType()))))
        .Select(property => property.Name + "=" + (property.GetValue(entity) is { } value ? Show(value) : "null")));

    [Fact]
    public async Task KeepsEveryValue()
    {
        await using var database = await TestDatabase.OpenAsync();
        var uow = new SqlUnitOfWork(database.Db);
        var thing = Factories.NewThing(1);
        var stored = await Factories.AddThingAsync(uow, 1);
        uow.Db.ChangeTracker.Clear();
        var found = (await uow.Things.FindByIdAsync(stored.Id))!;
        Assert.Equal(Values(thing, thing), Values(found, thing));
        ${only(database === 'postgresql', 'found.Tags = "{a,b}"; found.Numbers = "{1,2}"; found.Ip = "10.0.0.1"; found.Span = "1 day";')}
        found.Note = "changed";
        await uow.Things.UpdateAsync(found);
        uow.Db.ChangeTracker.Clear();
        found = (await uow.Things.FindByIdAsync(stored.Id))!;
        Assert.Equal("changed", found.Note);
        ${only(database === 'postgresql', 'Assert.Equal("{\\"a\\",\\"b\\"}", found.Tags); Assert.Equal("10.0.0.1", found.Ip); found.Span = found.Span + ""; await uow.Things.UpdateAsync(found);')}
        var order = Factories.NewOrder(1);
        var storedOrder = await Factories.AddOrderAsync(uow, 1);
        uow.Db.ChangeTracker.Clear();
        Assert.Equal(Values(order, order), Values((await uow.OrderRows.FindByIdAsync(storedOrder.Id))!, order));
    }
}
`,
  },
]

const phpRoundTrip =
  (eloquent) =>
  (files, { database }) => {
    const entityManager = eloquent ? '' : '$uow->em->clear();'
    const values = eloquent
      ? '$values = fn (object $entity, object $like): array => array_map(fn (string $k): string => $show($entity->$k), array_combine($keys = array_keys($like->getAttributes()), $keys));'
      : '$values = fn (object $entity, object $like): array => array_map(fn (string $k): string => $show($entity->$k), array_combine($keys = array_keys(array_filter(get_object_vars($like), fn ($v) => $v !== null)), $keys));'
    return [
      {
        path: 'tests/RoundTripTest.php',
        content: `<?php

declare(strict_types=1);

namespace Tests;

use PHPUnit\\Framework\\TestCase;

final class RoundTripTest extends TestCase
{
    public function testKeepsEveryValue(): void
    {
        $show = fn (mixed $v): string => match (true) {
            is_resource($v) => bin2hex((string) stream_get_contents($v, null, 0)),
            $v instanceof \\DateTimeInterface => $v->format('m-d H:i:s.u'),
            is_string($v) && preg_match('/^[0-9]+[.][0-9]+$/', $v) === 1 => (string) (float) $v,
            is_string($v) && preg_match('/^[0-9:]+[+]00$/', $v) === 1 => (string) json_encode(substr($v, 0, 8)),
            is_string($v) && preg_match('/^[0-9-]+ 00:00:00$/', $v) === 1 => substr($v, 0, 10),
            is_string($v) && !ctype_print($v) => bin2hex($v),
            default => (string) json_encode($v),
        };
        ${values}
        $clock = fn (array $v): array => array_map(fn (string $t): string => preg_replace('/^[0-9-]+ (12:01)/', '$1', $t), array_diff_key($v, ['changed' => 0]));
        $uow = TestDatabase::open();
        $thing = Factories::newThing(1);
        $stored = Factories::addThing($uow, 1);
        ${entityManager}
        $found = $uow->things->findById($stored->id);
        self::assertSame($clock($values($thing, $thing)), $clock($values($found, $thing)));
        ${only(database === 'postgresql', "$found->tags = ['a', 'b \"c']; $found->numbers = [1, 2]; $found->ip = '10.0.0.1'; $found->span = '1 day';")}
        $found->note = 'changed';
        $uow->things->update($found);
        ${entityManager}
        $found = $uow->things->findById($stored->id);
        self::assertSame('changed', $found->note);
        ${only(database === 'postgresql', "self::assertSame([['a', 'b \"c'], [1, 2], '10.0.0.1', '1 day'], [$found->tags, $found->numbers, $found->ip, $found->span]);")}
        $order = Factories::newOrder(1);
        $storedOrder = Factories::addOrder($uow, 1);
        ${entityManager}
        $id = ${eloquent ? "'Id'" : "'id'"};
        self::assertSame($clock($values($order, $order)), $clock($values($uow->order->findById($storedOrder->$id), $order)));
    }
}
`,
      },
    ]
  }

const kotlinRoundTrip = (files, { database }) => [
  {
    path: pathOf(files, '/TestDatabase.kt').replace('TestDatabase', 'RoundTripTest'),
    content: `package app

import kotlin.test.Test
import kotlin.test.assertEquals

class RoundTripTest {
    private fun show(value: Any?): String = when (value) {
        is ByteArray -> value.toList().toString()
        is java.math.BigDecimal -> value.stripTrailingZeros().toPlainString()
        is java.time.OffsetDateTime -> value.toInstant().toString()
        is java.time.OffsetTime -> value.toLocalTime().toString()
        else -> value.toString().replace(" ", "")
    }

    private fun values(entity: Any, like: Any) = like.javaClass.declaredFields.onEach { it.isAccessible = true }
        .filter { it.get(like) != null && it.name != "changed" }.associate { it.name to show(it.get(entity)) }

    @Test
    fun keepsEveryValue() {
        val uow = TestDatabase.open()
        val thing = Factories.newThing(1)
        val stored = Factories.addThing(uow, 1)
        val found = uow.things.findById(stored.id!!)!!
        assertEquals(values(thing, thing), values(found, thing))
        ${only(database === 'postgresql', 'found.tags = "{a,b}"; found.numbers = "{1,2}"; found.ip = "10.0.0.1"; found.span = "1 day"')}
        found.note = "changed"
        uow.things.update(found)
        val changed = uow.things.findById(stored.id!!)!!
        assertEquals("changed", changed.note)
        ${only(database === 'postgresql', 'assertEquals("{a,b}{1,2}10.0.0.1", (changed.tags + changed.numbers + changed.ip).replace("\\"", ""))')}
        val order = Factories.newOrder(1)
        val storedOrder = Factories.addOrder(uow, 1)
        assertEquals(values(order, order), values(uow.order.findById(storedOrder.id!!)!!, order))
    }
}
`,
  },
]

const rustRoundTrip = (files, { database }) => [
  {
    path: 'tests/data/round_trip.rs',
    content: `use super::{database, factories};
use ${/use ([a-z0-9_]+)::unit_of_work/.exec(files.find((item) => item.path === 'tests/data/thing_repository.rs').content)[1]}::unit_of_work::UnitOfWork;

#[tokio::test]
async fn keeps_every_value() {
    let (_turn, uow) = database::open().await;
    let thing = format!("{:#?}", factories::new_thing(1)).replace("{\\\\\\"n\\\\\\": 1}", "JSON").replace("{\\\\\\"n\\\\\\":1}", "JSON");
    let stored = factories::add_thing(&uow, 1).await;
    let mut found = uow.things().find_by_id(stored.id.clone().unwrap()).await.unwrap().unwrap();
    let read = format!("{found:#?}").replace("{\\\\\\"n\\\\\\": 1}", "JSON").replace("{\\\\\\"n\\\\\\":1}", "JSON");
    let (wanted, got) = (fields(&thing), fields(&read));
    for (name, value) in &wanted {
        if !value.starts_with("None") && name != "changed" {
            assert_eq!((name, value), (name, &got[name]));
        }
    }
    ${only(database === 'postgresql', 'found.tags = Some("{a,b}".to_string()); found.numbers = Some("{1,2}".to_string()); found.ip = Some("10.0.0.1".to_string()); found.span = Some("1 day".to_string());')}
    found.note = Some("changed".to_string());
    uow.things().update(found).await.unwrap();
    let changed = uow.things().find_by_id(stored.id.unwrap()).await.unwrap().unwrap();
    assert_eq!(changed.note.as_deref(), Some("changed"));
    ${only(database === 'postgresql', 'assert_eq!((changed.tags.as_deref(), changed.numbers.as_deref(), changed.span.as_deref()), (Some("{a,b}"), Some("{1,2}"), Some("1 day")));')}
}

/// The fields of an entity by name, as \`{:#?}\` writes them.
fn fields(text: &str) -> std::collections::BTreeMap<String, String> {
    let mut result = std::collections::BTreeMap::new();
    let mut name = String::new();
    for line in text.lines() {
        if line.starts_with("    ") && !line.starts_with("     ") && line.contains(": ") {
            let (key, value) = line.trim().split_once(": ").unwrap();
            name = key.to_string();
            result.insert(name.clone(), value.trim_end_matches(',').to_string());
        } else if let Some(value) = result.get_mut(&name) {
            value.push_str(line.trim().replace(".50,", ".5,").as_str());
        }
    }
    result.into_iter().map(|(key, value)| (key, value.replace("+00:00", "Z").replace("1.50", "1.5"))).collect()
}
`,
  },
]

const swiftRoundTrip = (files, { database }) => {
  const path = pathOf(files, '/TestDatabase.swift')
  return [
    {
      path: path.replace('TestDatabase', 'RoundTripTests'),
      content: `import Foundation
import Testing
@testable import ${/@testable import (\w+)/.exec(files.find((item) => item.path === path).content)[1]}

extension DataTests {
    @Suite struct RoundTripTests {
        static func show(_ value: Any) -> String {
            "\\(value)".replacingOccurrences(of: "\\": 1", with: "\\":1").replacingOccurrences(of: " 12:00:00 +0000", with: " 00:00:00 +0000")
        }

        static func differences(_ wanted: Any, _ found: Any) -> [String] {
            zip(Mirror(reflecting: wanted).children, Mirror(reflecting: found).children).compactMap { a, b in
                let (left, right) = (show(a.value), show(b.value))
                return left == "nil" || left == right || a.label == "changed" ? nil : "\\(a.label!): \\(left) / \\(right)"
            }
        }

        @Test func keepsEveryValue() async throws {
            try await TestDatabase.with { uow in
                let stored = try await Factories.addThing(uow, 1)
                var found = try #require(try await uow.things.findById(stored.id!))
                let thing = Self.differences(Factories.newThing(1), found)
                #expect(thing == [])
                for line in thing { print("error:", line) }
                ${only(database === 'postgresql', 'found.tags = "{a,b}"; found.numbers = "{1,2}"; found.ip = "10.0.0.1"; found.span = "1 day"')}
                found.note = "changed"
                found.code = "00009"
                try await uow.things.update(found)
                let changed = try #require(try await uow.things.findById(stored.id!))
                #expect([changed.note, changed.code] == ["changed", "00009"])
                ${only(database === 'postgresql', '#expect([changed.tags, changed.numbers, changed.span] == ["{a,b}", "{1,2}", "1 day"])')}
                let order = try await Factories.addOrder(uow, 1)
                let read = Self.differences(Factories.newOrder(1), try #require(try await uow.order.findById(order.id!)))
                #expect(read == [])
                for line in read { print("error:", line) }
            }
        }
    }
}
`,
    },
  ]
}

// Without an ORM the tests already create their tables from SQL: only the schema changes
const STACKS = {
  sqlalchemy,
  django,
  typeorm,
  sequelize,
  drizzle,
  prisma,
  jpa: withFiles(jpa, javaRoundTrip),
  efcore: withFiles(efcore, csharpRoundTrip),
  doctrine: withFiles(doctrine, phpRoundTrip(false)),
  eloquent: withFiles(eloquent, phpRoundTrip(true)),
  exposed: withFiles(exposed, kotlinRoundTrip),
  seaorm: withFiles(
    (files, options) => replaced(seaorm(files, options), 'tests/data/main.rs', [['mod factories;\n', 'mod factories;\nmod round_trip;\n']]),
    rustRoundTrip,
  ),
  fluent: withFiles(fluent, swiftRoundTrip),
  sql: (files) => files,
}

export function onOriginalDatabase(files, settings, drop) {
  const create = statementsOf(originalDdl(settings.database))
  // The schemas of PostgreSQL are kept between tests: dropStatements drops what is in them
  const safe = create.map((item) => item.replace(/^CREATE SCHEMA (?!IF)/, 'CREATE SCHEMA IF NOT EXISTS '))
  return (STACKS[settings.orm ?? 'sqlalchemy'] ?? ((f) => f))(files, {
    create: safe,
    drop,
    async: settings.execution === 'async',
    database: settings.database,
  })
}
