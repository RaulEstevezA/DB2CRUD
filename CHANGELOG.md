# Changelog

Notable changes to DB2CRUD, the web and the desktop version together. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/). Desktop releases will be tagged `v<version>` and published on [Releases](https://github.com/RaulEstevezA/DB2CRUD/releases).

## [Unreleased]

DB2CRUD starts from the code of Model2API (which continues as Controller2API), keeping what reads models and dropping what designs and writes an API: endpoints, OpenAPI, authentication, the framework generators and their project format.

### Added

- Web and desktop: reads application models in 23 formats with the importers of Mapper (code in 12 languages, JSON Schema, OpenAPI, GraphQL, Protocol Buffers, Smithy, Prisma, model schema, and JSON, YAML, XML or CSV documents), and the validations each field declares: Jakarta Bean Validation, class-validator, DataAnnotations, Symfony Validator, Laravel Data and Laravel rules, Pydantic, Django, JPA, SQLAlchemy, Prisma, Zod, Go tags and JSON Schema.
- Web and desktop: three built-in examples, and the page of the tool in English and Spanish, following the layout of the other tools.
- Its own icon: the database the tool reads, in grey, and the code it writes, in blue.

[Unreleased]: https://github.com/RaulEstevezA/DB2CRUD/commits/main
