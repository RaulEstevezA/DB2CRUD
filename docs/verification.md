# Verification

Producing files is not proof that they work. A language, ORM and database combination will be offered as verified only after a project generated with it has been built and its tests have passed, with their own tools, in Docker, by the scripts of `verification/`.

Verified today, on PostgreSQL, MySQL, MariaDB and SQLite: Python + SQLAlchemy 2 (synchronous and asynchronous), Python + Django 5.2, TypeScript + TypeORM 0.3, TypeScript + Prisma 7, TypeScript + Drizzle 0.45, TypeScript + Sequelize 6, Java 21 + JPA (Hibernate 7), C# (.NET 10) + EF Core 9, PHP 8.4 + Doctrine ORM 3, PHP 8.4 + Eloquent 12, Kotlin (JVM) + Exposed 1.6, asynchronous Rust + SeaORM 2, Swift + FluentKit 1, and Python, TypeScript, Java, C#, PHP, Kotlin, Rust and Swift without an ORM (SQL through each database's driver). On MongoDB 8: TypeScript + Mongoose 8, Java 21 + Spring Data MongoDB 5 and Python + Beanie 2. The list the interface reads is `web/src/core/settings/verified.ts` (and its desktop copy), with the scenarios that proved each combination and their date. The runners of the other languages come from Model2API and are kept for the stacks still to write.

## Runners

Each runner takes the folder of a generated project and, in a clean container:

| Runner | Image | Steps |
|---|---|---|
| `runners/python.sh` | `python:3.12-slim` | Installs `requirements-dev.txt`, compiles every module, runs the project's tests with pytest (pytest-django for Django) |
| `runners/node.sh` | `node:24-alpine` | Installs the dependencies, checks the types (`tsc --noEmit`), builds, runs the project's tests with Vitest |
| `runners/java.sh` | `maven:3.9-eclipse-temurin-21` | Compiles and runs the project's tests with Maven (JUnit) |
| `runners/php.sh` | `php:8.5-cli` with the PostgreSQL and MySQL drivers and Composer, built once | Installs the dependencies with Composer, checks the syntax of every file (`php -l`), runs the project's tests with PHPUnit |
| `runners/dotnet.sh` | `mcr.microsoft.com/dotnet/sdk:10.0` | Restores the packages, builds the solution and runs the project's tests with xUnit v3 on the Microsoft Testing Platform (`dotnet test`) |
| `runners/kotlin.sh` | `gradle:9.8.2-jdk21` | Compiles and runs the project's tests with Gradle, and prints how many ran |
| `runners/rust.sh` | `rust:1.99.1` | Compiles the project with every warning treated as an error and runs its tests with Cargo (registry and compiled dependencies cached in Docker volumes), and prints how many ran |
| `runners/swift.sh` | `swift:6.4.2-noble` | Builds the project and its tests with the Swift Package Manager, fails on any warning of the project's own code, runs its Swift Testing suites (packages and compiled dependencies cached in a Docker volume), and prints how many ran |

Downloads and compiled dependencies are cached in Docker volumes, so later runs are faster.

Projects that need a database run with one: `runners/with-database.sh` starts PostgreSQL 16, MySQL 8.4 or MariaDB 11 on a private network, passes its address to the runner and removes the container, its volume and the network afterwards. SQLite runs inside the project's own container.

## What the tests check

The tests are generated with the project and are the same the developer keeps:

- **Services**, with in-memory repositories: validation from the constraints, and domain errors.
- **Conversions**, when the project has application models: a row stored by the factories is read as the model, and a model that goes both ways and leaves nothing to the user is written back, giving the same values (lookups and Mapper's lossless transformations included). With the models imported from the user's module, the tests use a copy when that module is missing.
- **Repositories**, against a real database created from the entities: every query the schema allows, unique and foreign key checks, and generated columns.
- **The database itself**: one test fails when the tests did not run on the database `TEST_DATABASE_URL` names, so a green run proves which one it was.

The test database is created empty for every test. Most ORMs create it from their entities; with Prisma, a Vitest global setup asks Prisma for the SQL of the schema (`prisma migrate diff --from-empty`) once, and every test drops the tables and runs it; with Drizzle, the SQL comes from `drizzle-kit/api` in the same way. With JPA, one EntityManagerFactory is created from the entities and every test drops and creates the tables again (`SchemaManager`); Hibernate creates no foreign keys on SQLite, so there only the services check them. With EF Core, every test deletes and creates the database again (`EnsureDeleted`, `EnsureCreated`), on SQLite in memory unless `TEST_DATABASE_CONNECTION` names another. With Doctrine, every test drops the tables (`SchemaTool`) and creates them from the mapping, adding the foreign keys the entities do not map; with Eloquent, the tests create every table with the schema builder, parents first. Both fall back to SQLite in memory only for SQLite projects. With Exposed, every test drops the tables and creates them from the table objects (`SchemaUtils`), with the schemas and the native enums of PostgreSQL first; SQLite projects fall back to SQLite in a temporary file. With SeaORM, every test drops the tables and creates them from the entities (`Schema::builder`), with the schemas and the native enums of PostgreSQL first; `cargo test` runs the tests of one crate in parallel, so they take turns at the database through a lock, and SQLite projects use a new temporary file for every test (SQLite in memory would be another database on every connection of the pool). The Rust runner treats every compiler warning as an error. With Fluent, every test drops the tables and creates them with Fluent's schema builder, as the database has them (types, keys, unique values, foreign keys, defaults), with the schemas and the native enums of PostgreSQL first; swift-testing runs suites in parallel, so every test is in one serialized suite, and SQLite projects use a new database in memory for every test. The Swift runner fails on any warning of the project's own code, and adds `ssl-mode=DISABLED` to MySQL URLs, as MySQLKit asks for TLS by default. Without an ORM, DB2CRUD writes the DDL of the schema for the project's engine (`tests/schema.py`, `test/schema.ts`, the lists of `TestDatabase` in Java, C#, PHP and Kotlin, the constants of `tests/data/database.rs` in Rust, the lists of `TestDatabase` in Swift), and every test drops the tables and runs it; in TypeScript, Java, C#, PHP, Kotlin, Rust and Swift, on one connection, so MySQL's foreign key checks stay off while the tables are dropped. A Prisma schema, like Drizzle's tables, Sequelize's models and the JPA entities, is for one kind of database, so those projects on PostgreSQL, MySQL or MariaDB have no SQLite fallback: their database tests need `TEST_DATABASE_URL`.

## Scenarios

`verification/scenarios/index.mjs` lists the scenarios: an example schema (or a shared case of the matching with its application models, `case`), the settings that differ from the defaults and, for some, the decisions of the review taken the other way. Together they cover every option of every setting, on every database. `verification/run.sh [prefix]` writes their projects (`generate.mjs`, with the same core the web version runs) to `verification/.work/` and runs each one with its runner, with a database when it needs one.

Scenarios with `code` read their schema from a file, most of them of `verification/mongodb/`: Mongoose schemas, or the validators of collections. They run on a MongoDB replica set of one member (transactions need one), with a round trip added (`verification/mongodb-round-trip.mjs`): values, partial changes, items of lists, refusals, transactions, that nothing is created in the database, and that the documents fit the validators of their own script.

Scenarios marked `ddl` check that the entities fit a database that already exists: the schema is read from the hand-written SQL of `verification/ddl/<database>.sql` (names in mixed case, reserved words, another schema, composite keys and the types of each engine), and the project's tests create their tables from that same SQL instead of from the entities (`verification/original-ddl.mjs`, only in `.work/`), with a round trip of values added. Every ORM passes them on the four engines, and so does every language without an ORM. `ENTITIES=1 verification/run.sh <prefix>-ddl` runs the same projects with their tests as written.

The same scenarios are the shared outputs in `shared/test-cases/outputs/`: the desktop version must write exactly the same files.
