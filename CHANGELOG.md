# Changelog

Notable changes to DB2CRUD, the web and the desktop version together. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/). Desktop releases will be tagged `v<version>` and published on [Releases](https://github.com/RaulEstevezA/DB2CRUD/releases).

## [Unreleased]

DB2CRUD starts from the code of Model2API (which continues as Controller2API), keeping what reads models and dropping what designs and writes an API: endpoints, OpenAPI, authentication, the framework generators and their project format.

### Added

- Web and desktop: reads Model2DB projects into the physical schema of the database (`db-schema`), with Model2DB's own code, for PostgreSQL, MySQL, MariaDB, SQLite, SQL Server and Oracle.
- Web and desktop: proposes the CRUD design of every table (its role, soft or hard deletes, version checks, rows that point to it, columns never returned; the queries of each repository and the operations of each service), each proposal with its confidence and its reason; what it is not sure about waits for the user. Every choice can be changed, with undo and redo.
- Web and desktop: writes Python + SQLAlchemy 2 projects with every setting as an option: entities (only the missing ones, all, none), repositories (interface, SQLAlchemy and in memory), services with entities or DTOs (Pydantic or dataclasses), transactions per operation, by the caller or per write, synchronous or asynchronous code, pages by offset or cursor, folders by layer or by table, get/find names, and tests; plus `crud-contract.json` for CRUD2Controller. Verified in Docker on PostgreSQL, MySQL, MariaDB and SQLite.
- Web and desktop: writes Python + Django 5.2 projects with the same settings (synchronous only: Django's transactions are), with models faithful to the database (composite keys, tables without a key left unmanaged) and pytest-django tests. Verified in Docker on PostgreSQL, MySQL, MariaDB and SQLite.
- Web and desktop: writes TypeScript + TypeORM 0.3 projects with the same settings (asynchronous, DTOs as interfaces or classes): an ES module with entities, repositories over an `EntityManager`, services, a unit of work whose transaction is the manager's, and Vitest tests. Verified in Docker on PostgreSQL, MySQL, MariaDB and SQLite.
- Web and desktop: writes TypeScript + Prisma 7 projects with the same settings: a Prisma schema that reflects the database (exact names, native types, keys, indexes, foreign keys with their actions, native enums), the client through the driver adapter of each database, plain entities the repositories convert Prisma's rows into (so services, DTOs and tests are those of every TypeScript project), and tests on a database Prisma creates from the schema. Verified in Docker on PostgreSQL, MySQL, MariaDB and SQLite.
- Web and desktop: reads application models in 23 formats with the importers of Mapper (code in 12 languages, JSON Schema, OpenAPI, GraphQL, Protocol Buffers, Smithy, Prisma, model schema, and JSON, YAML, XML or CSV documents), and the validations each field declares: Jakarta Bean Validation, class-validator, DataAnnotations, Symfony Validator, Laravel Data and Laravel rules, Pydantic, Django, JPA, SQLAlchemy, Prisma, Zod, Go tags and JSON Schema.
- Web and desktop: three built-in examples (Model2DB projects), and the page of the tool in English and Spanish, following the layout of the other tools.
- Its own icon: the database the tool reads, in grey, and the code it writes, in blue.

[Unreleased]: https://github.com/RaulEstevezA/DB2CRUD/commits/main
