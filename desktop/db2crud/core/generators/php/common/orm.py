"""What changes from one PHP ORM to another (Strategy pattern). Mirrors web/src/core/generators/php/common/orm.ts.

An ORM is a dictionary: {"id", "label", "property", "phpType", "entityFile", "databaseFiles", "repository": {"doc",
"init", "body", "helpers"}, "unitOfWork", "forget", "begin", "close", "testDatabase", "require", "defaultUrl",
"layout"}, each a function of the context (and the table, the method or the uses) as in the web version.
"""
