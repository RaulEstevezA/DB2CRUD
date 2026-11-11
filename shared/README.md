# Shared

Language-neutral resources used by both the web (TypeScript) and desktop (Python) versions.

## test-cases/

Cases that define the expected behavior of the core. The web suite (`web/src/core/shared.test.ts` and `web/src/core/generators/shared.test.ts`) and the desktop suite (`desktop/tests/`) read the same files, so if one version behaves differently, its tests fail.

| Folder | What it checks |
|---|---|
| `calls/<module>.<function>.json` | Arguments of a core function and the result it gives, as JSON: names, format detection and every importer, validations, model analysis, proposals, edits, design checks, settings, the resolved API, the OpenAPI contract and its YAML, project files |
| `outputs/<framework>/<example>/` | The files every framework writes for every built-in example, with the proposal and the default settings |
| `variants/<scenario>.json` | An example, its settings, the edits made on its proposal (calls to `design/edit.ts` without the design) and the files written: the scenarios of `verification/`, and every framework with its decisions taken, public endpoints and a custom endpoint |

In the files, a missing key is `undefined` and `null` is `null`. Analysis facts, a `Map` on the web, are written as an object.

### Updating the cases

When the web version changes on purpose, write the results again from what it does now:

```bash
cd web
UPDATE_SHARED=1 npx vitest run src/core/shared.test.ts src/core/generators/shared.test.ts
```

Then review the diff and port the change to `desktop/` until its tests pass.

## How it maps to each version

Shared logic lives in a `core/` folder in each version, with no interface code:

- Web: `web/src/core/` (TypeScript)
- Desktop: `desktop/model2api/core/` (Python)

A file in one `core/` has its counterpart in the other (`design/propose.ts` / `design/propose.py`). In Python, models, designs and specifications are dictionaries with the same keys as the JSON.

The model and the importers come from Mapper, where they were ported first, by way of Model2DB: the tools of the suite read the same 23 input formats in the same way.

## Notes on the Python port

- Errors of YAML and XML documents come from different libraries in each version (`yaml` and `DOMParser` on the web, PyYAML and the standard library on the desktop): only the error code is compared, not the message.
- The OpenAPI contract is written by `openapi/yaml.ts` on the web, not by a library, so both versions write the same text.
- Texts are ordered with `compareText` (case first ignored, then character codes), never by the rules of a language.
