# DB2CRUD

DB2CRUD generates the data access layer of a database you already have: ORM entities when they are missing, repositories and services, linked to the models of your application. It does not design the database or write migrations (that is [Model2DB](https://github.com/RaulEstevezA/Model2DB)), and it does not write controllers or endpoints. Everything happens on your side, in the browser: what you paste or open is never sent anywhere, no database is connected to, and code is analyzed, never run.

> [!IMPORTANT]
> DB2CRUD is in development and not published on the website yet. Today it reads Model2DB projects and writes Python (SQLAlchemy 2, Django 5.2) and TypeScript (TypeORM 0.3, Prisma 7, Drizzle 0.45, Sequelize 6) and Java (JPA with Hibernate 7) projects, verified in Docker on PostgreSQL, MySQL, MariaDB and SQLite; SQL DDL, ORM code, application models and the other languages are being written. What already works is listed in the [changelog](./CHANGELOG.md).

```text
Paste or open the database and the models  →  Review the proposed repositories and services  →  Choose the language and ORM  →  Download the code
```

## What it will do

1. **Reads the database**: a Model2DB project, ORM code (SQLAlchemy, Django, TypeORM, Prisma, JPA, EF Core, Doctrine, Eloquent…) or SQL DDL (PostgreSQL, MySQL, MariaDB, SQLite), with exact column types, keys, unique constraints, indexes, foreign keys and checks.
2. **Reads the application models**: classes and DTOs in Python, TypeScript, JavaScript, Java, C#, Kotlin and Dart, JSON, JSON Schema and OpenAPI, or any of the 23 formats Mapper reads, with the validations each field declares. Correspondences from a Mapper project are read too.
3. **Proposes the repositories** with the queries the schema allows: by primary key, by unique fields, by indexed fields and by foreign keys.
4. **Proposes the services**: conversions between application models and entities in both directions, lookups that need the database (`categoryName` → `categoryId`), validation from the constraints, and domain errors (`NotFound`, `Conflict`, `ValidationFailed`) without HTTP codes. Where a model and a column disagree, it shows the conflict.
5. **Writes ORM entities only when they are missing**, faithful to the database: exact table and column names and precise types.
6. **Never decides an ambiguity**: transactions, soft or hard deletes, concurrency, cascades or sensitive fields wait for you, and the generated code leaves a `TODO` where each decision goes.
7. **Writes tests**: services with in-memory repositories, and repositories against a real database. A language, ORM and database combination is shown as verified only after a generated project with it has passed its tests in Docker.

The first stack taken end to end was Python + SQLAlchemy 2 + PostgreSQL; Django and the four TypeScript ORMs (TypeORM, Prisma, Drizzle, Sequelize) followed.

## Versions

- **Web**: React + TypeScript + Vite, in the browser.
- **Desktop**: Python + PySide6, the same tool as an installable app, checked against the same cases in `shared/test-cases/` ([desktop/README_en.md](./desktop/README_en.md)).

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

Ideas for improvements, bugs or an ORM you would like DB2CRUD to write for: write to [contact.raulesteveza@gmail.com](mailto:contact.raulesteveza@gmail.com).

## Developer

**Raul Estevez**

- [Personal Website](https://raulesteveza.github.io/)
- [LinkedIn Profile](https://www.linkedin.com/in/raulesteveza/)

## License

[MIT](./LICENSE)
