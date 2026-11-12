"""What changes from one TypeScript ORM to another (Strategy pattern). Mirrors
web/src/core/generators/typescript/common/orm.ts.

An ORM is a dictionary: {"id", "label", "plainEntities", "databaseFiles", "repository": {"doc", "init", "body" and
optionally "helpers"}, "unitOfWork", "unset", "testDatabase", "memoryTests", "dependencies", "devDependencies",
"defaultUrl", "layout"} and optionally {"testSetup", "scripts", "ignored"}, each a function of the context (and the
table, the method or the imports) as in the web version; "plainEntities" is a boolean.
"""
