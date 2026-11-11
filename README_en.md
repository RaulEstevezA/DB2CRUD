# Model2API

Model2API turns data models into the code of a REST API you review before it is written, and then writes it: a project with its resources and endpoints, validation, error handling, persistence, authentication, tests, OpenAPI contract and a README to run it. Everything happens on your side, in the browser: what you paste or open is never sent anywhere, and code is analyzed, never run.

> [!IMPORTANT]
> Model2API is not published on the website yet. Everything on this page works, in the browser and in the desktop version.

```text
Paste or open the models  →  Review the proposed endpoints  →  Choose the framework and options  →  Download the project
```

## What it does

1. **Reads the models**: classes and DTOs in Python (dataclasses, Pydantic), TypeScript, JavaScript, Java (classes, records), C#, Kotlin and Dart, JSON, JSON Schema and OpenAPI, or any of the 23 formats Mapper reads (also Go, Rust, PHP, Swift, Scala, GraphQL, Protocol Buffers, Prisma, Smithy, YAML, XML and CSV). What the input declares (required fields, lengths, ranges, formats, enums, defaults, keys, relations) is kept as it is.
2. **Proposes the API**: a resource per model with its operations (`GET /products`, `GET /products/{id}`, `POST`, `PUT`, `PATCH`, `DELETE`), each with its parameters, bodies, responses, status codes and errors.
3. **Explains every proposal and never decides an ambiguity**: what it is not sure about waits for you, and the generated code leaves a `TODO` where the decision goes.
4. **Lets you change everything**: turn endpoints on and off, edit routes, add business endpoints that are not CRUD, configure pagination, filters, sorting, validation and permissions, with undo and redo.
5. **Writes idiomatic code for the framework you choose**, with the architecture that fits it (by layers, or one folder per resource) and no layers it does not need. A clean or hexagonal architecture is not offered yet.
6. **Checks combinations**: only framework, persistence and authentication options that work together are offered, and a combination is shown as verified only after a generated project with it has been built, run and called.

## Frameworks

| Framework | Architecture | Storage | Authentication |
|---|---|---|---|
| FastAPI | By layers, one folder per resource | In memory, interfaces to implement, SQLAlchemy 2 (PostgreSQL, MySQL, MariaDB, SQLite) | None, API key, JWT with roles |
| Django REST Framework | One app, one app per resource | Django ORM (PostgreSQL, MySQL, MariaDB, SQLite) | None, API key, JWT with roles |
| Express (TypeScript) | By layers, one folder per resource | In memory, interfaces to implement | None, API key, JWT with roles |
| NestJS | One module per resource | In memory, interfaces to implement, TypeORM (PostgreSQL, MySQL, MariaDB) | None, API key, JWT with roles |
| Spring Boot (Java 21) | By layers, one package per resource | In memory, interfaces to implement, JPA / Hibernate (PostgreSQL, MySQL, MariaDB) | None, API key, JWT with roles (Spring Security) |
| Laravel 13 (PHP 8.3+) | By layers, one folder per resource | In memory, interfaces to implement, Eloquent (PostgreSQL, MySQL, MariaDB, SQLite) | None, API key, JWT with roles |
| Symfony 8.1 (PHP 8.4+) | By layers, one folder per resource | In memory, interfaces to implement, Doctrine ORM (PostgreSQL, MySQL, MariaDB, SQLite) | None, API key, JWT with roles |
| ASP.NET Core (.NET 10) | By layers, one folder per resource | In memory, interfaces to implement, Entity Framework Core (PostgreSQL, MySQL, MariaDB, SQLite) | None, API key, JWT with roles |
| Ktor 3 (Kotlin 2.4) | By layers, one folder per resource | In memory, interfaces to implement, Exposed (PostgreSQL, MySQL, MariaDB, SQLite) | None, API key, JWT with roles |
| Axum 0.8 (Rust 1.99) | By layers, one folder per resource | In memory, traits to implement, SeaORM (PostgreSQL, MySQL, MariaDB, SQLite) | None, API key, JWT with roles |
| Vapor 4 (Swift 6.4) | By layers, one folder per resource | In memory, protocols to implement, Fluent (PostgreSQL, MySQL, MariaDB, SQLite) | None, API key, JWT with roles |

Each project ships its own tests, which call every endpoint. Every framework, storage, database and authentication above has been verified by building, running and testing generated projects in Docker ([docs/verification.md](./docs/verification.md)).

Generated projects are written in English. They are a starting point to review, not a promise of a production-ready service.

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
npm run build    # production build, served from /tools/Model2API/
```

How the code is organized, and why: [docs/architecture.md](./docs/architecture.md) and [docs/decisions.md](./docs/decisions.md). How the generated projects are verified: [docs/verification.md](./docs/verification.md).

## Suggestions

Ideas for improvements, bugs or a framework you would like Model2API to write for: write to [contact.raulesteveza@gmail.com](mailto:contact.raulesteveza@gmail.com).

## Developer

**Raul Estevez**

- [Personal Website](https://raulesteveza.github.io/)
- [LinkedIn Profile](https://www.linkedin.com/in/raulesteveza/)

## License

[MIT](./LICENSE)
