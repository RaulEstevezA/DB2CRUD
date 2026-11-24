# Interoperability

What DB2CRUD reads from the other apps of the suite and what it leaves for them. Everything is a file: no app calls another.

| Direction | File | Format | Who writes it | Who reads it |
|---|---|---|---|---|
| In | `*.model2db.json` | `model2db-project` | Model2DB | DB2CRUD (`core/interop/model2db/`) |
| In | ORM code or SQL DDL | as each ORM or engine writes it | Model2DB, the user's project, `pg_dump`, `mysqldump` | DB2CRUD (`core/importers/orm/`, `core/importers/ddl/`) |
| In (application models) | `*.mapper.json` | `mapper-project` | Mapper | DB2CRUD (`core/interop/mapper/`) |
| Out | `crud-contract.json` | `crud-contract` | DB2CRUD, in every generated project | CRUD2Controller |

Whatever the input, DB2CRUD reads it into one physical schema (`db-schema`, `core/schema/types.ts`); see `design.md` for that format.

## `mapper-project` (version 1)

A saved Mapper project, opened in the application models tab. DB2CRUD reads, and checks, only what it uses: both sides (`source`, `target`: input format, chosen model and their `model-schema`) and the mapping (`root` and `mappings`, each `Source->Target` with one entry per target field: `sources` as paths, `transform`, `status`, plus `ignoredSources`). The texts and the output settings are left alone. A project from a newer version is refused, and a damaged one is rejected with the path of the first problem.

For each table, the model mapping whose target (or source) is named like the table relates it with the model on the other side, for both directions (`core/matching/mapper.ts`):

- Table as **target** (`CustomerForm->Customer`): each column is filled as Mapper fills the field of the same name.
- Table as **source** (`Order->OrderSummary`): each column is read into the field Mapper fills from it.
- When both models are named like the table, the side whose fields name more columns is the table; the target on a tie.
- A relation whose transformation can be undone without loss (`direct`, `epoch`, `arithmetic` by a number other than 0, `enum` with one-to-one pairs and no fallback) serves both directions and is `exact`. The others (`concat`, `split`, `expression`, `constant`, `boolean`, `object`, `collection`) serve one direction and are left for review: the other is a `TODO`. A relation still pending in Mapper is left for review too.
- A column Mapper says nothing of follows the rules of a column with no field. The sources the user ignored in Mapper are not reported as unused.

Every match stays a decision the user can change, as with any other models.

## `crud-contract`

Every project DB2CRUD writes has a `crud-contract.json` at its root. It says what was generated (the types, the services and their operations, the errors), so CRUD2Controller can write controllers on top of the services without reading the code back. It describes the project exactly as written: the shared test cases (`shared/test-cases/outputs/`) keep the contract of every case next to its code.

### Top level

```json
{
  "format": "crud-contract",
  "version": 1,
  "stack": { "language": "java", "orm": "jpa", "database": "postgresql", "execution": "sync" },
  "transactions": "operation",
  "paging": "offset",
  "types": [],
  "errors": [],
  "common": "app.common",
  "services": []
}
```

| Field | Meaning |
|---|---|
| `format`, `version` | Always `crud-contract` and `1`. A reader refuses other formats and newer versions. |
| `stack.language` | `python`, `typescript`, `java`, `csharp`, `php`, `kotlin`, `rust` or `swift`. |
| `stack.orm` | The ORM of the data access: `sqlalchemy`, `django`, `typeorm`, `prisma`, `drizzle`, `sequelize`, `jpa`, `efcore`, `doctrine`, `eloquent`, `exposed`, `seaorm`, `fluent`, `mongoose` or `springdata`. |
| `stack.database` | `postgresql`, `mysql`, `mariadb` or `sqlite`. |
| `stack.execution` | `sync` or `async`: whether the operations of the services are awaited. |
| `transactions` | Where a transaction starts and ends: `operation` (each service operation is one), `caller` (the caller opens it through the unit of work) or `write` (each repository write is one). |
| `paging` | How lists are paged: `offset` or `cursor`. |
| `types` | The types the services take and return (below). |
| `errors` | The three errors the services raise (below). |
| `common` | Where the shared types live (the page of a list, the `Patch` of an update): a package, namespace or module. Every language but Python and TypeScript, which keep them next to their use. |
| `services` | One per table that has a service (below). |

### Types

```json
{
  "name": "CustomerCreate",
  "module": "app.dtos",
  "kind": "create",
  "fields": [{ "name": "email", "type": { "kind": "text", "length": 120 }, "nullable": false }]
}
```

- `name` and `module` say where the type is: a module (Python), a file (TypeScript), a package (Java, Kotlin), a namespace (C#, PHP), a module path (Rust) or a target (Swift).
- `kind`: `entity` (the row of the table), and, when the services take DTOs, `create` (what a new row needs: no generated column), `update` (what can change: no key and no generated column; every field optional) and `read` (what a row shows: no hidden column).
- Each field has its `name` as the code spells it, its `type` (a `kind` of the physical schema: `integer`, `decimal`, `float`, `text` with its `length`, `boolean`, `date`, `time`, `datetime`, `uuid`, `binary`, `json`, `enum`, `array`, `unknown`) and whether it is `nullable`.

### Errors

```json
[
  { "kind": "notFound", "name": "NotFoundException", "module": "app.errors" },
  { "kind": "conflict", "name": "ConflictException", "module": "app.errors" },
  { "kind": "validation", "name": "ValidationFailedException", "module": "app.errors" }
]
```

`notFound` is a row that does not exist, `conflict` a write the database refuses (a unique value taken, a row still pointed to) and `validation` values that break a rule of the table (the fields that failed are in the error). A controller maps them to its responses (404, 409 and 422 in HTTP).

### Services

```json
{
  "name": "ProductService",
  "module": "app.services",
  "operations": [
    { "name": "createProduct", "kind": "create", "errors": ["validation", "conflict"] },
    { "name": "getProduct", "kind": "get", "errors": ["notFound"] },
    { "name": "listProductsByCategoryId", "kind": "listByParent", "by": ["category_id"], "errors": [] },
    { "name": "findProductBySku", "kind": "find", "by": ["sku"], "errors": [] },
    { "name": "addTag", "kind": "link", "through": "product_tags", "errors": ["notFound", "conflict"] }
  ]
}
```

| `kind` | What the operation does |
|---|---|
| `create` | Inserts a row and returns it. |
| `get` | Returns the row with this key, or raises `notFound`. |
| `list` | Returns a page of rows (`paging`). |
| `update` | Changes a row and returns it. |
| `delete` | Deletes a row (or marks it deleted, when the table deletes softly). |
| `find` | Returns the row with these unique values (`by`), or nothing. |
| `listByParent` | Returns a page of the rows that point to a parent (`by`: the columns of the foreign key). |
| `link`, `unlink` | Adds or removes a row of a many-to-many table (`through`). |

`errors` lists the errors the operation can raise. `by` names the columns of the table the operation looks rows up by, as the database names them.

### Open questions (with CRUD2Controller)

- **How an update takes its changes.** In Java, C#, Kotlin, Swift and Rust the project setting `updates` chooses it (`patch`, `optional` or `full`, see `decisions.md`); the contract does not say which one yet, and a controller needs it to build the call.
- **From `by` to parameters.** `by` gives column names (`category_id`), while the fields of the types give the names of the code (`categoryId`); the contract has no link between both yet.

Both wait for CRUD2Controller's decision 2 on how it reads the contract.
