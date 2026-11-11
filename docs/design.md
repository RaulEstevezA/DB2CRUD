# Design

The internal models of DB2CRUD and the rules that fill them: what each stage receives and produces, and how sure each proposal is. Written before the code (ROADMAP phase 3); every type below becomes a module of `web/src/core/` and its mirror in `desktop/db2crud/core/`.

```text
Database input ──► importer ──► DbSchema ──► analysis ──┐
                                                         ├──► CrudDesign ──► generator ──► files + crud-contract
App models ──► importer ──► ModelSchema ──► matching ───┘        ▲
Mapper project ──────────────────────────────┘              user edits
```

Every proposal is a `Decision` (`core/decisions/`): a value, a confidence (`exact`, `high`, `probable`, `review`, `conflict`, `none`) and the reasons. `review` and `conflict` are never applied on their own; the generated code writes a `TODO` where they go.

## 1. The physical schema: `db-schema`

What exists in the database, whichever input it came from. It is DB2CRUD's internal model and the format Model2DB will export (decision 15), so it is a plain JSON document with a format name and a version.

It starts from Model2DB's `RelationalSchema` (`physical/types.ts`) and adds what an existing database can have and Model2DB never writes: types exactly as declared, default expressions, `ON UPDATE`, free `CHECK` expressions, tables without a primary key, and where each fact was read.

```ts
interface DbSchema {
  format: 'db-schema'
  version: 1
  /** null when the input does not say (ORM code without a configured engine) */
  dialect: 'postgresql' | 'mysql' | 'mariadb' | 'sqlite' | null
  source: { kind: 'model2db' | 'orm' | 'ddl'; format: string } // format: 'sqlalchemy', 'postgresql-ddl'…
  tables: DbTable[]
  enums: DbEnum[]
  /** What was read but not understood, with its place in the input */
  notes: DbNote[]
}

interface DbTable {
  name: string
  schema?: string                // namespace: `sales.orders`
  columns: DbColumn[]
  primaryKey: string[] | null    // null: the table has none
  foreignKeys: DbForeignKey[]
  uniques: DbIndex[]             // UNIQUE constraints and unique indexes
  indexes: DbIndex[]             // non-unique indexes
  checks: DbCheck[]
  /** Class name when the input is ORM code or a Model2DB project: `Customer` for `customers` */
  entity?: string
  comment?: string
  origin?: Origin
}

interface DbColumn {
  name: string
  type: DbType
  nullable: boolean
  default?: { kind: 'literal'; value: Literal } | { kind: 'expression'; sql: string }
  /** Filled by the database, never sent by the application on insert */
  generated?: 'identity' | 'uuid' | 'now' | 'onUpdateNow' | { computed: string }
  /** Attribute name in the ORM class, when it differs from the column: `createdAt` for `created_at` */
  attribute?: string
  comment?: string
  origin?: Origin
}

/** `sql` keeps the type as declared (`NUMERIC(10,2)`, `varchar(50)`), so an entity can be written exactly. */
type DbType = { sql: string } & (
  | { kind: 'integer'; bits: 16 | 32 | 64 }
  | { kind: 'decimal'; precision?: number; scale?: number }
  | { kind: 'float'; bits: 32 | 64 }
  | { kind: 'text'; length?: number; fixed?: boolean }
  | { kind: 'boolean' }
  | { kind: 'date' }
  | { kind: 'time'; timezone: boolean }
  | { kind: 'datetime'; timezone: boolean }
  | { kind: 'uuid' }
  | { kind: 'binary'; length?: number }
  | { kind: 'json' }
  | { kind: 'enum'; name: string }
  | { kind: 'array'; items: DbType }
  | { kind: 'unknown' }            // read, but not a type the rules know: always a decision to review
)

interface DbForeignKey {
  name?: string
  columns: string[]
  references: { table: string; schema?: string; columns: string[] }
  /** undefined: not declared (the engine's default, NO ACTION) */
  onDelete?: 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action'
  onUpdate?: 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action'
  /** ORM navigation names, when the input has them: `Order.customer` and `Customer.orders` */
  attribute?: string
  inverse?: string
}

interface DbIndex { name?: string; columns: string[] }

interface DbCheck {
  name?: string
  sql: string
  /** The forms the rules understand; anything else keeps only `sql` and is reported */
  parsed?:
    | { kind: 'in'; column: string; values: (string | number)[] }
    | { kind: 'compare'; column: string; op: '>' | '>=' | '<' | '<='; value: number }
    | { kind: 'length'; column: string; op: '>' | '>=' | '<' | '<='; value: number }
}

interface DbEnum { name: string; values: string[]; storage: 'native' | 'check' }

interface Origin { line: number; column: number }
```

Each importer produces this and nothing else, so everything after it only knows one format:

| Input | How | Phase |
|---|---|---|
| `model2db-project` | Re-read with copies of Model2DB's parsers, `design/` and `physical/` until Model2DB exports `db-schema` (decision 15); `RelationalSchema` maps to `DbSchema` field by field | 5 |
| ORM code | Hand-written readers per ORM, starting with the code Model2DB writes | 10 |
| SQL DDL | `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE … ADD CONSTRAINT`, `CREATE TYPE … AS ENUM`, for PostgreSQL, MySQL, MariaDB and SQLite, including `pg_dump --schema-only` and `mysqldump --no-data` | 13 |

Validation of a `DbSchema` (phase 4) reports keys, foreign keys and indexes that name missing columns or tables, and enums that are not declared.

## 2. Matching application models

Only when the input has application models (`ModelSchema`, from the inherited importers) or a `mapper-project`. Each table gets the model it corresponds to, and each column the field it comes from.

```ts
interface Matching {
  tables: TableMatch[]
}

interface TableMatch {
  table: string
  model: Decision<string | null>        // null: no model, the service works with the entity
  columns: ColumnMatch[]
}

interface ColumnMatch {
  column: string
  source: Decision<ColumnSource | null>
  /** Where the model and the column disagree: shown, never resolved on their own */
  conflicts: Conflict[]
}

type ColumnSource =
  | { kind: 'field'; field: string }                                       // product.name → name
  | { kind: 'lookup'; field: string; table: string; by: string }           // categoryName → categories.name → category_id
  | { kind: 'children'; field: string; table: string }                     // tagIds → order_tags rows
  | { kind: 'mapper'; relation: string; inverse: 'exact' | 'none' }        // a Mapper relation, inverted when it can be
  | { kind: 'database' }                                                   // generated column: the model does not send it

type Conflict =
  | { kind: 'length'; model: number; column: number }       // DTO allows 100, VARCHAR(50)
  | { kind: 'nullable' }                                     // optional in the model, NOT NULL without default
  | { kind: 'type'; model: string; column: string }          // text vs integer
  | { kind: 'values'; missing: string[] }                    // enum values the CHECK does not accept
```

Rules, each with its confidence:

| Rule | Confidence |
|---|---|
| Model name equals the entity or table name after normalizing (case, `snake`/`camel`, plural, suffixes `Entity`, `Model`, `Dto`, `Record`, `Request`, `Response`) | `exact` when one model matches; `review` when several do |
| Field name equals the column or the ORM attribute after normalizing | `exact`, or `probable` when only the normalized form matches |
| Field `<x>Name`/`<x>Code`… and a foreign key `<x>_id` to a table with a **unique** column of that name | Lookup, `probable` |
| Same, but the column is not unique | Lookup, `review`: the database may return several rows |
| Field that is a list of keys and a join table or a child table with a foreign key to this one | Children, `probable` |
| Mapper relation `direct`, `enum`, `epoch`, `arithmetic` | Inverted for the other direction, `exact` |
| Other Mapper transformations (`concat`, `split`, `expression`…) | One direction only; the other is a `TODO`, `review` |
| Column with no field | NOT NULL without default: `conflict`; otherwise `none` (stays null or default) |

Decision 13: without a database, application models alone give repository interfaces and an in-memory implementation; the matching step is skipped.

## 3. The CRUD design

What will be generated, proposed from the schema (and the matching) and edited by the user with undo and redo.

```ts
interface CrudDesign {
  repositories: RepositoryDesign[]
  services: ServiceDesign[]
  /** Per table: the decisions that the schema cannot settle */
  policies: TablePolicy[]
}

interface RepositoryDesign {
  table: string
  entity: string                 // class name: existing one, or the one generated
  generateEntity: boolean        // false when the input already has the class (ORM code, Model2DB entities)
  queries: QueryDesign[]
}

interface QueryDesign {
  id: string
  kind: 'getByKey' | 'findByUnique' | 'findAllBy' | 'listByParent' | 'list' | 'insert' | 'update' | 'delete' | 'exists'
  name: string                   // getById, findByEmail, listByCustomerId…
  columns: string[]
  returns: 'one' | 'optional' | 'many' | 'none' | 'boolean'
  include: Decision<boolean>
}

interface ServiceDesign {
  table: string
  name: string                   // ProductService
  model: string | null           // the application model it takes and returns; null: the entity
  operations: OperationDesign[]
}

interface OperationDesign {
  id: string
  kind: 'create' | 'get' | 'list' | 'update' | 'delete' | 'find' | 'listByParent' | 'link' | 'unlink'
  name: string
  include: Decision<boolean>
  /** What it checks before writing, in order */
  checks: ('validate' | 'unique' | 'parentExists' | 'lookup' | 'version')[]
  errors: ('NotFound' | 'Conflict' | 'ValidationFailed')[]
}

interface TablePolicy {
  table: string
  delete: Decision<{ mode: 'hard' } | { mode: 'soft'; column: string }>
  concurrency: Decision<{ mode: 'none' } | { mode: 'version'; column: string }>
  /** Children whose foreign key has no ON DELETE: block the delete, or delete them first in code */
  children: Decision<'block' | 'deleteFirst'>
  hidden: Decision<string[]>      // columns never returned: password_hash, token…
  role: Decision<'entity' | 'join' | 'readOnly'>
}
```

Rules that propose it:

| From the schema | Proposal | Confidence |
|---|---|---|
| Primary key | `getByKey` (one argument per column when composite), `update`, `delete` | `exact` |
| `UNIQUE` or unique index | `findByUnique`, and a uniqueness check before `create` and `update` (`Conflict`) | `exact` |
| Non-unique index | `findAllBy<columns>` | `review`: an index may exist only for speed |
| Foreign key | `listBy<Parent>Id`, and a `parentExists` check before writing (`ValidationFailed` naming the field) | `exact` |
| `NOT NULL`, length, `CHECK` understood (`in`, `compare`, `length`) | `validate` step | `exact`; a `CHECK` not understood becomes a `TODO`, `review` |
| Identity, `DEFAULT now()`, `uuid` default, computed column | Left out of the create input | `exact` |
| Column named `updated_at`/`modified_at` without `ON UPDATE` | The service sets it on update | `probable` |
| Table without primary key | `role: readOnly`: list and find by unique only | `review` |
| Two foreign keys forming the whole primary key, no other columns | `role: join`: `link`/`unlink` on both parents, no service of its own | `probable` |
| Column `<x>_id` without a foreign key, and a table `<x>s` with that key | A relation proposed as if declared | `review` |
| Column `deleted_at`/`is_deleted`/`deleted` | `delete: soft` on it, and every read filters it | `review` |
| No such column | `delete: hard` | `exact` (nothing else is possible) |
| Integer column `version`/`row_version`/`lock_version` | `concurrency: version` | `probable` |
| Child foreign key with `ON DELETE CASCADE` or `SET NULL` | The database does it: nothing in code | `exact` |
| Child foreign key without `ON DELETE` | `children: block`: delete fails with `Conflict` naming the children | `review` |
| Column named like a secret (`password`, `password_hash`, `token`, `secret`, `api_key`) | `hidden` | `review` |
| Column of type `unknown` | Kept as the ORM's generic type, with a `TODO` | `review` |

Domain errors carry no HTTP codes (that is Controller2API's job): `NotFound(entity, key)`, `Conflict(entity, constraint, fields)`, `ValidationFailed(errors: { field, message }[])`. Database errors the checks could not prevent (a race on a unique value) are translated into the same errors.

## 4. Project settings: every choice is the user's

What the schema cannot settle per table is a decision (section 3). What is a matter of taste or of the project around the code is a **setting**: every option is foreseen and generated, and the default is only the recommended one. A setting a stack cannot honour is not offered for it, with the reason (the compatibility matrix), never silently ignored.

| Setting | Options | Default |
|---|---|---|
| Stack | Language × ORM or driver × database | — (the user chooses) |
| Layers | Entities, repositories, services, tests: each on or off | All on |
| Entities | Only the missing ones · all of them, replacing the input's · none | Only the missing ones |
| What services take and return | The entities · DTOs generated per table (create, update, read) · the application models, when there are any | The application models when there are any; otherwise the entities |
| Application models in another language | Written again in the stack's language (each language offers its kinds: dataclasses or Pydantic in Python, interfaces or classes in TypeScript, records or classes in Java…) · not used | Written again, with the language's most common kind |
| Transactions | One per service operation · managed by the caller (no commit in services or repositories) · one per repository call | One per service operation |
| Execution | Synchronous · asynchronous (where the ORM has both: SQLAlchemy, Django, EF Core, Doctrine has none…) | Synchronous |
| Errors | Exceptions · result values (`Result`, `Either`…) where the language has a common form | The language's usual form: exceptions, `Result` in Rust |
| Repository interface | Interface (Protocol, interface, trait) plus implementation · implementation only | Interface plus implementation |
| In-memory repositories | On · off | On (the service tests use them) |
| Lists | Without paging · offset and limit · cursor (keyset) | Offset and limit |
| Architecture | By layer (`repositories/`, `services/`) · by table (one folder per table) | By layer |
| Method names | The language's convention (`get_by_id`, `getById`, `GetByIdAsync`) with the verb chosen: `get`/`find` | `get` for one required row, `find` for optional and lists |
| Tests | Services and repositories · services only · none | Services and repositories |

The answers of the review of 2026-11-11 are these defaults: entities when there are no application models, models in another language written again, one transaction per operation, and both synchronous and asynchronous SQLAlchemy offered.

## 5. The first stack: Python + SQLAlchemy 2 + PostgreSQL

```text
<project>/
├── app/
│   ├── db.py                     engine, session factory, the unit of work
│   ├── errors.py                 NotFound, Conflict, ValidationFailed
│   ├── entities/<table>.py       only for tables whose class is missing: exact names and types
│   ├── repositories/<table>.py   a Protocol, the SQLAlchemy implementation and an in-memory one
│   └── services/<table>.py       operations, checks and conversions
├── tests/
│   ├── services/                 every operation, with the in-memory repositories
│   └── repositories/             every query, against PostgreSQL (TEST_DATABASE_URL), schema created from the input
├── crud-contract.json
├── pyproject.toml, requirements.txt, requirements-dev.txt, README.md
```

- SQLAlchemy 2 style (`Mapped[...]`, `mapped_column`, `select()`). Synchronous (`Session`) or asynchronous (`AsyncSession`, `async`/`await`), chosen in the project settings; both are verified. Types are precise: `Mapped[Decimal]` with `Numeric(10, 2)`, never `Any`.
- Repositories return entities; services convert them to the application models when there are any.
- Tests of repositories create the schema from the input (the DDL itself when the input is DDL; `metadata.create_all` otherwise) in a database started by `verification/runners/with-database.sh`.

## 6. `crud-contract` for CRUD2Controller

A JSON file in the generated project that describes what was written, so CRUD2Controller does not have to read the code back.

```json
{
  "format": "crud-contract",
  "version": 1,
  "stack": { "language": "python", "orm": "sqlalchemy", "database": "postgresql" },
  "types": [
    { "name": "ProductDto", "module": "app.models.product", "fields": [{ "name": "name", "type": { "kind": "text" }, "nullable": false }] }
  ],
  "errors": [
    { "kind": "notFound", "name": "NotFoundError", "module": "app.errors" },
    { "kind": "conflict", "name": "ConflictError", "module": "app.errors" },
    { "kind": "validation", "name": "ValidationFailedError", "module": "app.errors" }
  ],
  "services": [
    {
      "name": "ProductService",
      "module": "app.services.product",
      "operations": [
        {
          "name": "create_product",
          "kind": "create",
          "params": [{ "name": "data", "type": "ProductDto" }],
          "returns": { "type": "ProductDto", "many": false, "optional": false },
          "errors": ["validation", "conflict"]
        },
        {
          "name": "get_product",
          "kind": "get",
          "params": [{ "name": "id", "type": { "kind": "integer" } }],
          "returns": { "type": "ProductDto", "many": false, "optional": false },
          "errors": ["notFound"]
        }
      ]
    }
  ],
  "todos": [{ "where": "app.services.product.delete_product", "text": "Products have order lines: block the delete or delete them first" }]
}
```

It is documented in `docs/interoperability.md` once it is written (phase 15); CRUD2Controller reads this file, not this page.
