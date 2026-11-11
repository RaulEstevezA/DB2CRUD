# Decisions

Choices that shape the project, with the reason, so they are not undone by accident.

| Decision | Reason |
|---|---|
| No backend | Models and code may be private; everything DB2CRUD does fits in the browser (personal_web_style `UX_GUIDE.md`, local processing) |
| A desktop version in Python + PySide6, mirroring the web core | Same as the other tools of the suite; both versions pass the cases in `shared/test-cases/` |
| Importers start from Mapper's parsers and model | The suite should read a model the same way in every tool, and DB2CRUD reads application models in as many formats as Mapper, with the validations each field declares |
| Hand-written parsers instead of compilers or language servers | They run in the browser, need no downloads per language, never execute the user's code, and only have to find declarations |
| Deterministic rules, no AI | Every proposal must be repeatable and explainable; the user decides when the information is not enough |
| Pending decisions are never applied on their own | The generated code leaves a `TODO` where a pending decision goes (personal_web_style `patterns/confidence-states.md`) |
| Generated projects are written in English | Code, comments, README files and `TODO` markers of a backend project are read by any developer and usually in English; the interface language does not change the output |
| Generated projects are verified with Docker | Each language toolchain runs in its own container, so verification needs nothing installed on the machine but Docker, and the same runs work locally and in CI |
| A stack is recorded as verified only after `verification/` has built a generated project with it and its tests have passed | Producing files is not proof that they work |
| Cloudflare Web Analytics only counts visits | It is the site-wide beacon of personal_web_style `PUBLISHING.md`; it does not see the models or the generated code, and nothing about it is shown in the interface |
| Generated tests are part of every project and are what the verification runs | The same tests check the generator and later help the developer, instead of tests that only DB2CRUD sees |
| Inputs are never stored | Models and schemas may be private; only preferences (the language) are kept |
| Application models alone are accepted, without a database: repository interfaces to implement plus an in-memory implementation, no tables or ORM entities (2026-11-11) | It covers developers without a database yet without overlapping Model2DB, which designs databases; the inherited generators already write it |
| With DDL and no ORM, the user chooses how repositories reach the data: SQL with each language's official driver, or ORM entities reflected from the DDL (2026-11-11) | Reflecting entities from an existing database is exactly the "my database exists, I only want my models" case, and whoever does not want an ORM still has plain SQL |
| The physical schema has a common format, `db-schema`, that Model2DB will export; until it does, DB2CRUD recalculates it with copies of Model2DB's parsers, `design/` and `physical/` (2026-11-11) | `model2db-project` stores the input text and design decisions, not the schema. A shared format avoids duplicating Model2DB's logic for good, and it is also DB2CRUD's internal model: the DDL and ORM-code importers produce the same thing |
| DB2CRUD generates the services, not only the repositories (2026-11-11) | Validation from the constraints, unique checks, database lookups (`categoryName` → `categoryId`), model ↔ entity conversions and domain errors all depend on the schema, and DB2CRUD is the only tool in the chain that knows it; CRUD2Controller then writes thin controllers over finished services |
| The first stack taken end to end is Python + SQLAlchemy 2 + PostgreSQL (2026-11-11) | Model2DB already generates SQLAlchemy, and the inherited code has it verified in Docker, so the new path is checked against known, working output before other stacks follow |
| Every choice that is a matter of taste or of the surrounding project is a setting with all its options generated; the recommended one is only the default (2026-11-11) | The user knows the project the code goes into; DB2CRUD foresees the options instead of choosing for them (docs/design.md, section 4) |
| Defaults: services take and return the application models, or the entities when there are none; models in another language are written again in the stack's; one transaction per service operation; synchronous code (2026-11-11) | Answers of the design review: no invented DTOs, models usable by the services, operations that happen whole, the simplest code to read. Each is a setting |
| Python + SQLAlchemy is generated synchronous and asynchronous (2026-11-11) | Both styles are common in Python projects; each is verified on its own |
