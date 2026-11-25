# DB2CRUD

DB2CRUD generates the data access layer of a database you already have: entities when they are missing, repositories and services, linked to the models of your application. It does not design the database or write migrations (that is [Model2DB](https://github.com/RaulEstevezA/Model2DB)), and it does not write controllers or endpoints. Everything happens on your side, in the browser: what you paste or open is never sent anywhere, no database is connected to, and code is analyzed, never run.

**Try it online:** [raulesteveza.github.io/tools/DB2CRUD](https://raulesteveza.github.io/tools/DB2CRUD/)

```text
Paste or open the database and the models  →  Review the proposed repositories and services  →  Choose the language and library  →  Download the code
```

## What it does

1. **Reads the database**, with exact column types, keys, unique constraints, indexes, foreign keys and checks, from any of the [inputs below](#what-it-reads).
2. **Reads the application models**, in any of the 23 formats Mapper reads: classes and DTOs in 12 languages, JSON Schema, OpenAPI, GraphQL, Protocol Buffers or sample data, with the validations each field declares. Correspondences from a Mapper project are read too.
3. **Proposes the repositories** with the queries the schema allows: by primary key, by unique fields, by indexed fields and by foreign keys. In MongoDB, also adding and removing one item of a nested list.
4. **Proposes the services**: conversions between application models and entities in both directions, lookups that need the database (`categoryName` → `categoryId`), validation from the constraints, and domain errors (`NotFound`, `Conflict`, `ValidationFailed`) without HTTP codes. Where a model and a column disagree, it shows the conflict.
5. **Writes entities only when they are missing**, faithful to the database: exact table and column names and precise types.
6. **Never decides an ambiguity**: transactions, soft or hard deletes, concurrency, cascades or sensitive fields wait for you, and the generated code leaves a `TODO` where each decision goes.
7. **Writes tests**: services with in-memory repositories, and repositories against a real database. A language, library and database combination is shown as verified only after a generated project with it has passed its tests in Docker.

### What it reads

- **Model2DB projects**, relational or for MongoDB.
- **SQL DDL** for PostgreSQL, MySQL, MariaDB and SQLite, also the dumps of `pg_dump --schema-only` and `mysqldump --no-data`.
- **ORM code**: SQLAlchemy, SQLModel, Django and Tortoise; Prisma, TypeORM, Sequelize and Drizzle; JPA/Hibernate; EF Core; Doctrine; Laravel migrations with Eloquent models.
- **MongoDB**: Mongoose schemas, Spring Data classes, Beanie documents, the `$jsonSchema` validators of the collections, or sample documents when there is neither (`mongoexport`, Compass, mongosh).

### What it writes

| Language | With an ORM | Without an ORM (SQL) | MongoDB |
|---|---|---|---|
| Python | SQLAlchemy 2, Django 5.2 | psycopg, MySQL Connector, sqlite3 | Beanie 2 |
| TypeScript | TypeORM 0.3, Prisma 7, Drizzle 0.45, Sequelize 6 | pg, mysql2, better-sqlite3 | Mongoose 8 |
| Java 21 | JPA (Hibernate 7) | JDBC | Spring Data MongoDB 5 |
| C# (.NET 10) | EF Core 9 | ADO.NET | MongoDB.Driver 3 |
| PHP 8.4 | Doctrine ORM 3, Eloquent 12 | PDO | mongodb/mongodb 2 |
| Kotlin (JVM), experimental | Exposed 1.6 | JDBC | MongoDB Kotlin driver 5 |
| Rust, experimental | SeaORM 2 | sqlx | MongoDB Rust driver 3 |
| Swift, experimental | Fluent (FluentKit 1) | SQLKit | MongoKitten 7 |

Kotlin, Rust and Swift are **experimental**: they work and get fixes, but new features are written for the other five languages.

Relational projects are for PostgreSQL, MySQL, MariaDB or SQLite. Every combination has been verified in Docker, on those four databases or on MongoDB 8.

Every choice of style is a setting: entities or DTOs, how updates come, transactions, pages by offset or cursor, folders by layer or by table, names and tests. With application models in the language of the project, conversions between them and the rows or documents are written too.

## Versions

- **Web**: React + TypeScript + Vite, in the browser: [raulesteveza.github.io/tools/DB2CRUD](https://raulesteveza.github.io/tools/DB2CRUD/).
- **Desktop**: Python + PySide6, the same tool as an installable app ([download](./desktop/README_en.md#download)), checked against the same cases in `shared/test-cases/` ([desktop/README_en.md](./desktop/README_en.md)).

## Development

The web version lives in `web/`:

```bash
cd web
npm install
npm run dev      # development server
npm run check    # types, lint, format and tests
npm run build    # production build, served from /tools/DB2CRUD/
```

How the code is organized, and why: [docs/architecture.md](./docs/architecture.md) and [docs/decisions.md](./docs/decisions.md). How the generated code is verified: [docs/verification.md](./docs/verification.md).

## Suggestions

Ideas for improvements, bugs or a library you would like DB2CRUD to write for: write to [contact.raulesteveza@gmail.com](mailto:contact.raulesteveza@gmail.com).

## Developer

**Raul Estevez**

- [Personal Website](https://raulesteveza.github.io/)
- [LinkedIn Profile](https://www.linkedin.com/in/raulesteveza/)

## License

[MIT](./LICENSE)
