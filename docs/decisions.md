# Decisions

Choices that shape the project, with the reason, so they are not undone by accident.

| Decision | Reason |
|---|---|
| No backend | Models and code may be private; everything Model2API does fits in the browser (personal_web_style `UX_GUIDE.md`, local processing) |
| A desktop version in Python + PySide6, mirroring the web core | Same as the other tools of the suite; both versions pass the cases in `shared/test-cases/` |
| Importers start from Mapper's parsers and model | Model2API aims to read as many formats as Mapper, and the suite should read a model the same way in every tool. Model2API extends them with what an API needs: validations, lengths, ranges, formats and defaults |
| Hand-written parsers instead of compilers or language servers | They run in the browser, need no downloads per language, never execute the user's code, and only have to find declarations |
| Deterministic rules, no AI | Every proposal must be repeatable and explainable; the user decides when the information is not enough |
| Pending decisions are never applied on their own | The generated code leaves a `TODO` where a pending decision goes (personal_web_style `patterns/confidence-states.md`) |
| Generated projects are written in English | Code, comments, README files and `TODO` markers of a backend project are read by any developer and usually in English; the interface language does not change the output |
| Generators in this order: FastAPI, Express, NestJS, Spring Boot, Django REST Framework | From the most direct framework to the one with the most different structure; each is verified before the next starts |
| Generated projects are verified with Docker | Each language toolchain runs in its own container, so verification needs nothing installed on the machine but Docker, and the same runs work locally and in CI |
| A stack is recorded as verified only after `verification/` has built, run and called a generated project with it | Producing files is not proof that they work (spec, quality and tests) |
| Inputs are not stored unless the user turns on "Remember in this browser" | personal_web_style stores preferences, not user data; the option makes the exception explicit and reversible |
| Cloudflare Web Analytics only counts visits | It is the site-wide beacon of personal_web_style `PUBLISHING.md`; it does not see the models or the generated code, and nothing about it is shown in the interface |
| Only stacks that a generator writes and the verification ran are offered; Prisma and Mongoose are not yet | A combination shown in the interface must work. Prisma 7 changed its configuration model and Mongoose needs its own verification on MongoDB; they come back when both are written and verified |
| No clean or hexagonal architecture yet | The spec asks for it "when appropriate"; offering it before a generator writes it well would only add layers |
| Generated tests are part of every project and are what the verification runs | The same tests check the generator and later help the developer, instead of tests that only Model2API sees |
| Django projects ship without migrations; the README says to run `makemigrations` | Hand-written migrations could drift from the models; Django writes them exactly |
| TypeORM stores dates as ISO text and objects as JSON text | The same columns work on PostgreSQL, MySQL, MariaDB and sql.js (the tests' database), and the API sends text anyway |
| Date-times the server sets are kept to microseconds and read back as UTC | Every database keeps microseconds at most; the answer of a creation and a later read must give the same value |
