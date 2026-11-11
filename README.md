# Model2API

Client-side tool that turns data models (classes, DTOs, JSON, schemas) into the code of a REST API you review before it is written: resources, endpoints, validation, persistence, authentication, tests and the OpenAPI contract, **without sending anything to a server**.

> [!IMPORTANT]
> Model2API is not published on the website yet. What it does is listed in the [changelog](./CHANGELOG.md); every stack it marks as verified has been built, run and called in Docker ([docs/verification.md](./docs/verification.md)).

- 🇬🇧 **English:** [Full documentation](./README_en.md)
- 🇪🇸 **Español:** [Documentación completa](./README_es.md)

## What is this repository?

Model2API helps go from the models of an application to its backend: paste or open the models, review the resources and endpoints it proposes, choose the framework (FastAPI, Django REST Framework, Express, NestJS, Spring Boot, Laravel, Symfony, ASP.NET Core, Ktor, Axum or Vapor), the architecture, the persistence and the authentication, and copy each file or download the whole project.

It proposes, but never decides an ambiguity: decisions to review wait for the user, and the generated code leaves a `TODO` where each one goes, and where the business logic of a custom endpoint belongs.

There are two versions, checked by shared test cases:

- **Web**: React + TypeScript, in the browser.
- **Desktop**: Python + PySide6, with the same features and the same files.

It continues the chain [Api2Class](https://github.com/RaulEstevezA/Api2Class) → [Mapper](https://github.com/RaulEstevezA/Mapper) → [Model2DB](https://github.com/RaulEstevezA/Model2DB), and works on its own as well.

## Suggestions

Ideas for improvements, bugs or a framework you would like Model2API to write for: write to [contact.raulesteveza@gmail.com](mailto:contact.raulesteveza@gmail.com).

## Developer

**Raul Estevez**

- [Personal Website](https://raulesteveza.github.io/)
- [LinkedIn Profile](https://www.linkedin.com/in/raulesteveza/)

## License

[MIT](./LICENSE)
