# DB2CRUD

Client-side tool that generates the data access layer of a database that already exists: ORM entities (when they are missing), repositories and services, linked to your application models, **without sending anything to a server**.

> [!IMPORTANT]
> DB2CRUD is in development and not published on the website yet. What already works is listed in the [changelog](./CHANGELOG.md).

- 🇬🇧 **English:** [Full documentation](./README_en.md)
- 🇪🇸 **Español:** [Documentación completa](./README_es.md)

## What is this repository?

DB2CRUD starts from a database you already have: a Model2DB project, ORM code or SQL DDL, and, if you have them, the models of your application. It proposes the repositories with the queries the schema allows, the services that convert between models and entities, validate and report domain errors, and the ORM entities that are missing.

It proposes, but never decides an ambiguity: decisions to review wait for the user, and the generated code leaves a `TODO` where each one goes.

There are two versions, checked by shared test cases:

- **Web**: React + TypeScript, in the browser.
- **Desktop**: Python + PySide6, with the same features.

It continues the chain [Api2Class](https://github.com/RaulEstevezA/Api2Class) → [Mapper](https://github.com/RaulEstevezA/Mapper) → [Model2DB](https://github.com/RaulEstevezA/Model2DB), and works on its own as well.

## Suggestions

Ideas for improvements, bugs or an ORM you would like DB2CRUD to write for: write to [contact.raulesteveza@gmail.com](mailto:contact.raulesteveza@gmail.com).

## Developer

**Raul Estevez**

- [Personal Website](https://raulesteveza.github.io/)
- [LinkedIn Profile](https://www.linkedin.com/in/raulesteveza/)

## License

[MIT](./LICENSE)
