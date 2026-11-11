# Architecture

DB2CRUD generates the data access layer of a database that already exists: ORM entities when they are missing, repositories and services, linked to the application models. Everything runs locally, in the browser or in the desktop version; there is no backend. The user's code is read by hand-written parsers and is never executed, and every proposal comes from explicit, deterministic rules that can be explained.

DB2CRUD starts from the code of Model2API. What read models was kept; what designed and wrote an API was removed. This page describes what exists today and the stages being built; each stage is documented in detail as it is written.

## Stages

```text
Database input ──► Importer ──► Physical schema ─┐
                                                 ├──► Analysis ──► Correspondences ──► CRUD design ──► Generator ──► files ──► Export
Application models ──► Importer ──► Model ───────┘                                         ▲
                                                                                       user edits
                                                                                      (undo/redo)
```

| Stage | Input | Output | State |
|---|---|---|---|
| Model importing | Text in a supported format | `Model` | Works: `core/importers/`, `core/model/` |
| Constraints and model facts | `Model` | Validations each field declares, entities, keys and references | Works: `core/analysis/` |
| Database importing | Model2DB project, ORM code or SQL DDL | Physical schema (`db-schema`) | To write |
| Analysis | Physical schema | Repository queries and pending decisions | To write |
| Correspondences | Physical schema + `Model` (+ Mapper project) | Model ↔ entity and field ↔ column, with their confidence | To write |
| CRUD design | All of the above + user edits | Repositories, services and decisions | To write |
| Generation | CRUD design + settings | Project files | To write |
| Export | Project files | ZIP, single file | Works: `core/export/` |

Decisions and their confidence (`core/decisions/`) are shared by every stage that proposes something.

## Folders

```text
.github/workflows/          CI and desktop releases
docs/                       Project documentation (architecture, decisions, verification)
web/                        The web application (React + TypeScript + Vite)
├── public/                 Static files served as they are (favicon)
└── src/
    ├── core/               No React and no browser APIs: pure TypeScript, tested in Node
    │   ├── model/          Normalized model: entities, fields, types, keys, relations, enums,
    │   │                   constraints, defaults, and where each fact came from in the input
    │   ├── importers/      One importer per format and the importer registry
    │   │   ├── code/       Python, TypeScript, JavaScript, Java, C#, Kotlin, Dart, Go, Rust, PHP, Swift, Scala
    │   │   ├── schema/     JSON Schema, OpenAPI, GraphQL, Protocol Buffers, Prisma, Smithy, model schema
    │   │   └── data/       JSON, YAML, XML and CSV documents
    │   ├── analysis/       Validations declared on each field, and facts about each model
    │   ├── decisions/      Proposals with their confidence and reasons
    │   ├── export/         Generated files as data, and the ZIP writer
    │   └── interop/        Inputs from Model2DB and Mapper (to write)
    ├── app/                Interface logic without React: reading the input, workspace parts, downloads
    ├── hooks/              React state on top of app/ (history, preferences, clipboard)
    ├── components/         React components, one CSS file each (BEM names)
    │   ├── layout/         Header, introduction, workspace, links and footer shared by every tool
    │   ├── common/         Pane, code editor, confidence badges, decision controls
    │   ├── models/         Input and the detected models
    │   └── project/        File tree of the generated project
    ├── i18n/               English and Spanish texts
    ├── examples/           Built-in examples with invented data, also used as test fixtures
    └── styles/tokens/      Design tokens copied from personal_web_style
desktop/                    The desktop version (Python + PySide6)
├── db2crud/
│   ├── core/               Mirrors web/src/core/ module by module, with snake_case names
│   ├── ui/                 The window: the state App.tsx and its hooks hold on the web
│   └── assets/             Icon (same SVG as web/public/favicon.svg)
├── packaging/              PyInstaller spec, launcher, smoke test, .icns and .ico built from the icon
└── tests/                  Desktop tests, including the shared cases
shared/
└── test-cases/calls/       Arguments and results of core functions both versions must give
verification/runners/       One Docker runner per language toolchain, and one to start a database
```

## Patterns

- **Registry** for every variable case: importers (`importers/registry.ts`), and the generators when they are written. Adding a format or an ORM is a new module and one line in its registry.
- **Strategy** for interchangeable algorithms inside a generator: the ORM or the plain driver, the database, the architecture.
- **Composition over inheritance.** Generators of the same language share helpers by calling them, not by extending a base generator.
- **Immutable values.** Edits return a new design; undo and redo keep the previous values.

## Principles

- **The core has no interface code.** Everything under `core/` runs in Node and is covered by tests. Components only call it. External dependencies (storage, clipboard, clock) are passed in.
- **No invented decisions.** What the input declares is kept as it is. A proposal the rules are not sure about stays pending, is never applied on its own, and the generated code leaves a `TODO` in its place.
- **One job.** DB2CRUD does not design databases or write migrations (Model2DB), and does not write controllers or endpoints.
- **Verified means verified.** A combination is recorded as verified only when `verification/` has built a generated project with it and its tests have passed.
- **Local first.** Inputs stay in memory and no database is connected to. Only preferences are stored.

## Desktop version

`desktop/` is the same tool as a Python (PySide6) application, as in the other tools of the suite. `desktop/db2crud/core/` mirrors `web/src/core/` file by file: the web uses camelCase names, the desktop snake_case. Models and decisions are plain dictionaries with the same keys as the TypeScript JSON, so both versions can be compared as JSON.

The web version writes the expected results to `shared/test-cases/` and the desktop tests must give the same ones, so a change in the core is made in both versions.

## Interface

The page follows the tool layout of personal_web_style (`layouts/tool-page.md`) and the screen of Model2DB, in a single screen. Today the workspace only holds the input; the CRUD design and the generated project are added as the core is written.

```text
Header          Raúl Estévez                                                  EN  ES
Presentation    icon  DB2CRUD  [Processed locally] · subtitle · description · examples
Workspace       ┌ Models ────────────────────────────────────────────────────────┐
                │ input, detected models and issues                               │
                └─────────────────────────────────────────────────────────────────┘
Links           Download for … · Source code · All tools
Footer          MIT License · Source code · Raúl Estévez
```

- Header and workspace share the same width (1440px) and horizontal padding (24px, 16px below 600px). Header text keeps the size and style of the rest of the site.
- Below 1100px, when the workspace has more than one part, each part becomes a tab with its count of pending decisions or errors.
- Results are computed as the input changes; there is no "Generate" button.
