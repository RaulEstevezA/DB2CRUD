# Architecture

Model2API turns data models into the code of a REST API. Everything runs locally, in the browser or in the desktop version; there is no backend. The user's code is read by hand-written parsers and is never executed, and every proposal comes from explicit, deterministic rules that can be explained.

```text
Input text ──► Importer ──► Model ──► Analysis ──► Proposal ──► API design ──► Generator ──► files ──► Export
                                         │             ▲            │   │
                                    pending        reconcile    user edits   └──► OpenAPI contract
                                    decisions    (input edited)  (undo/redo)
```

Every stage has a language-neutral input and output. A new input format, framework, architecture or database is a new module registered next to the existing ones; it never changes the stages around it.

| Stage | Input | Output | Folder |
|---|---|---|---|
| Importing | Text in a supported format | `Model` | `web/src/core/importers/` |
| Analysis | `Model` | Identifiers, relations, constraints and pending decisions, each with its reason | `web/src/core/analysis/` |
| Proposal | `Model` + analysis | `ApiDesign` with the confidence of each proposal | `web/src/core/design/` |
| Editing | `ApiDesign` + a user action | A new `ApiDesign` | `web/src/core/design/` |
| Validation | `ApiDesign` | Errors and warnings (duplicate routes, undeclared parameters, missing models) | `web/src/core/validation/` |
| Compatibility | Selected stack | The options that work together, and why the others do not | `web/src/core/compatibility/` |
| Contract | `ApiDesign` | OpenAPI document | `web/src/core/openapi/` |
| Generation | `ApiDesign` + settings | Project files | `web/src/core/generators/` |
| Export | Project files | ZIP, single file, OpenAPI file | `web/src/core/export/` |

## Folders

```text
.github/workflows/          CI and publication to raulesteveza.github.io/tools/Model2API/
docs/                       Project documentation (architecture, decisions, formats, how to add a generator)
web/                        The web application (React + TypeScript + Vite)
├── public/                 Static files served as they are (favicon)
└── src/
    ├── core/               No React and no browser APIs: pure TypeScript, tested in Node
    │   ├── model/          Normalized model: entities, fields, types, keys, relations, enums,
    │   │                   constraints, defaults, and where each fact came from in the input
    │   ├── importers/      One importer per format and the importer registry
    │   │   ├── code/       Python, TypeScript, JavaScript, Java, C#, Kotlin, Dart
    │   │   ├── schema/     JSON Schema, OpenAPI, exchange formats of the other tools
    │   │   └── data/       JSON documents
    │   ├── analysis/       Rules that read the model and raise pending decisions
    │   ├── api/            The API design: resources, endpoints, parameters, bodies,
    │   │                   responses, errors, security, pagination, filters, sorting
    │   ├── design/         Proposal from the model, immutable edits, business endpoints,
    │   │                   reconciliation when the input changes
    │   ├── validation/     Consistency checks on an API design
    │   ├── compatibility/  Language × framework × architecture × persistence × auth matrix
    │   ├── openapi/        OpenAPI contract built from the design, independent of frameworks
    │   ├── generators/     Generator registry
    │   │   ├── common/     Generator contract, file tree, code writer, TODO markers
    │   │   ├── languages/  What frameworks of one language share: type mapping, naming,
    │   │   │               imports, dependency files (python/, typescript/, java/)
    │   │   └── frameworks/ One generator per framework (fastapi/, djangoRest/, express/,
    │   │                   nestjs/, springBoot/), each with its architectures and persistence
    │   ├── export/         ZIP writer and file downloads as plain data
    │   ├── project/        Model2API project files: versioned format, save and open
    │   └── interop/        Models received from Mapper, Model2DB and other tools
    ├── app/                Interface logic without React: workspace state, history, pending decisions
    ├── hooks/              React state on top of app/ (undo/redo, preferences, startup, handoff)
    ├── components/         React components, one CSS file each (BEM names)
    │   ├── layout/         Header, introduction, links and footer shared by every tool
    │   ├── common/         Pane, code editor, badges, tabs and other building blocks
    │   ├── models/         Input and the detected models
    │   ├── endpoints/      Resources and endpoints, editable
    │   └── project/        Settings, file tree, code view and export
    ├── i18n/               English and Spanish texts, including every reason and note
    ├── examples/           Built-in examples with invented data, also used as test fixtures
    └── styles/tokens/      Design tokens copied from personal_web_style
desktop/                    The desktop version (Python + PySide6)
├── model2api/
│   ├── core/               Mirrors web/src/core/ module by module, with snake_case names
│   ├── ui/                 The window: the state App.tsx and its hooks hold on the web
│   └── assets/             Icon (same SVG as web/public/favicon.svg)
├── packaging/              PyInstaller spec, launcher, .icns and .ico built from the icon
└── tests/                  Desktop tests, including the shared cases
shared/
└── test-cases/             Language-neutral cases both versions must pass
    ├── calls/              Arguments and results of core functions, as JSON
    ├── outputs/            Files every generator writes for every built-in example
    └── variants/           Examples with decisions and settings, and the files they produce
verification/               Builds, runs and calls the generated projects with their real tools
├── scenarios/              Example + stack combinations to verify
└── runners/                One runner per language toolchain (Python, Node, Java)
```

## Patterns

- **Registry** for every variable case: importers (`importers/registry.ts`), generators (`generators/registry.ts`). Adding a format or a framework is a new module and one line in its registry.
- **Strategy** for interchangeable algorithms inside a generator: architecture (layered or modular; hexagonal is not written yet), persistence (an ORM, in memory, or interfaces to implement) and authentication (none, JWT, API key). A framework generator composes the strategies it supports; the compatibility matrix decides which ones are offered.
- **Composition over inheritance.** Frameworks of the same language reuse `generators/languages/<language>/` by calling it, not by extending a base generator.
- **Immutable values.** Edits return a new design; undo and redo keep the previous values.

## Principles

- **The core has no interface code.** Everything under `core/` runs in Node and is covered by tests. Components only call it. External dependencies (storage, clipboard, clock) are passed in.
- **No invented decisions.** What the input declares is kept as it is. A proposal the rules are not sure about stays pending, is never applied on its own, and the generated code leaves a `TODO` in its place.
- **Business logic is marked, not invented.** Non-CRUD endpoints get the full structure and a clearly marked place for the developer's logic.
- **No needless layers.** A generator writes only the layers the chosen architecture needs.
- **Verified means verified.** A stack combination is recorded as verified only when `verification/` has built, run and called a generated project with it.
- **Local first.** Inputs stay in memory. Only preferences are stored, plus the workspace when the user turns on "Remember in this browser".

## Desktop version

`desktop/` is the same tool as a Python (PySide6) application, as in the other tools of the suite. `desktop/model2api/core/` mirrors `web/src/core/` file by file: the web uses camelCase names (`djangoRest/`), the desktop snake_case (`django_rest/`). Models and designs are plain dictionaries with the same keys as the TypeScript JSON, so both versions can be compared as JSON.

The web version writes the expected results to `shared/test-cases/` and the desktop tests must give the same ones, so a change in the core is made in both versions.

## Interface

The page follows the tool layout of personal_web_style (`layouts/tool-page.md`) and the screen of Model2DB, in a single screen:

```text
Header          Raúl Estévez                                                  EN  ES
Presentation    icon  Model2API  [Processed locally] · subtitle · description · privacy
Project bar     Save · Open · Remember in this browser
Workspace       ┌ Models ─────────────┐ ┌ Endpoints ───────────────────────────┐
                │ input, detected     │ │ resources and endpoints, editable,   │
                │ models and issues   │ │ pending decisions, undo / redo       │
                └─────────────────────┘ └──────────────────────────────────────┘
                ┌ Project ───────────────────────────────────────────────────────┐
                │ framework, architecture, persistence, auth · file tree · code   │
                │ Copy · Download file · OpenAPI · Download .zip                  │
                └─────────────────────────────────────────────────────────────────┘
Links           Download for … · Source code · All tools
Footer          MIT License · Source code · Raúl Estévez
```

- Header and workspace share the same width (1440px) and horizontal padding (24px, 16px below 600px), so "Raúl Estévez" lines up with the left edge of the first column and the language switcher with the right edge of the last one. Header text keeps the size and style of the rest of the site: name in weight 600 at the base size, language codes at 0.9rem weight 500.
- Below 1100px the three panes become tabs (Models · Endpoints · Project), each with its count of pending decisions or errors.
- The result is computed as the design changes; there is no "Generate" button.
