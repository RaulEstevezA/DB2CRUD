"""What changes from one Python ORM to another (Strategy pattern). Mirrors web/src/core/generators/python/common/orm.ts.

An ORM is a dictionary: {"id", "label", "databaseFiles", "repository": {"doc", "init", "body"}, "unitOfWork",
"conftest", "databaseTest", "databaseFixture", "dependencies", "devDependencies", "pytestOptions", "defaultUrl",
"layout"}, each a function of the context (and the table, the method or the imports) as in the web version.
"""
