# Model2API

Model2API convierte modelos de datos en el código de una API REST que revisas antes de que se escriba, y después lo escribe: un proyecto con sus recursos y endpoints, validación, gestión de errores, persistencia, autenticación, pruebas, contrato OpenAPI y un README para ejecutarlo. Todo ocurre en tu lado, en el navegador: lo que pegas o abres no se envía a ningún sitio, y el código se analiza, nunca se ejecuta.

> [!IMPORTANT]
> Model2API todavía no se ha publicado en la web. Todo lo que describe esta página funciona, en el navegador y en la versión de escritorio.

```text
Pegar o abrir los modelos  →  Revisar los endpoints propuestos  →  Elegir el framework y las opciones  →  Descargar el proyecto
```

## Qué hace

1. **Lee los modelos**: clases y DTOs en Python (dataclasses, Pydantic), TypeScript, JavaScript, Java (clases, records), C#, Kotlin y Dart, JSON, JSON Schema y OpenAPI, o cualquiera de los 23 formatos que lee Mapper (también Go, Rust, PHP, Swift, Scala, GraphQL, Protocol Buffers, Prisma, Smithy, YAML, XML y CSV). Lo que la entrada declara (campos obligatorios, longitudes, rangos, formatos, enums, valores por defecto, claves, relaciones) se toma tal cual.
2. **Propone la API**: un recurso por modelo con sus operaciones (`GET /products`, `GET /products/{id}`, `POST`, `PUT`, `PATCH`, `DELETE`), cada una con sus parámetros, cuerpos, respuestas, códigos de estado y errores.
3. **Explica cada propuesta y nunca decide una ambigüedad**: lo que no tiene claro te espera, y el código generado deja un `TODO` donde va la decisión.
4. **Te deja cambiarlo todo**: activar y desactivar endpoints, editar rutas, añadir endpoints de negocio que no son CRUD, configurar paginación, filtros, orden, validaciones y permisos, con deshacer y rehacer.
5. **Escribe código idiomático del framework que elijas**, con la arquitectura que le encaja (por capas o una carpeta por recurso) y sin capas que no necesita. Todavía no se ofrece una arquitectura limpia o hexagonal.
6. **Comprueba las combinaciones**: solo ofrece opciones de framework, persistencia y autenticación que funcionan juntas, y una combinación solo aparece como verificada después de compilar, arrancar y llamar a un proyecto generado con ella.

## Frameworks

| Framework | Arquitectura | Almacenamiento | Autenticación |
|---|---|---|---|
| FastAPI | Por capas, una carpeta por recurso | En memoria, interfaces por implementar, SQLAlchemy 2 (PostgreSQL, MySQL, MariaDB, SQLite) | Ninguna, clave de API, JWT con roles |
| Django REST Framework | Una app, una app por recurso | Django ORM (PostgreSQL, MySQL, MariaDB, SQLite) | Ninguna, clave de API, JWT con roles |
| Express (TypeScript) | Por capas, una carpeta por recurso | En memoria, interfaces por implementar | Ninguna, clave de API, JWT con roles |
| NestJS | Un módulo por recurso | En memoria, interfaces por implementar, TypeORM (PostgreSQL, MySQL, MariaDB) | Ninguna, clave de API, JWT con roles |
| Spring Boot (Java 21) | Por capas, un paquete por recurso | En memoria, interfaces por implementar, JPA / Hibernate (PostgreSQL, MySQL, MariaDB) | Ninguna, clave de API, JWT con roles (Spring Security) |
| Laravel 13 (PHP 8.3+) | Por capas, una carpeta por recurso | En memoria, interfaces por implementar, Eloquent (PostgreSQL, MySQL, MariaDB, SQLite) | Ninguna, clave de API, JWT con roles |
| Symfony 8.1 (PHP 8.4+) | Por capas, una carpeta por recurso | En memoria, interfaces por implementar, Doctrine ORM (PostgreSQL, MySQL, MariaDB, SQLite) | Ninguna, clave de API, JWT con roles |
| ASP.NET Core (.NET 10) | Por capas, una carpeta por recurso | En memoria, interfaces por implementar, Entity Framework Core (PostgreSQL, MySQL, MariaDB, SQLite) | Ninguna, clave de API, JWT con roles |
| Ktor 3 (Kotlin 2.4) | Por capas, una carpeta por recurso | En memoria, interfaces por implementar, Exposed (PostgreSQL, MySQL, MariaDB, SQLite) | Ninguna, clave de API, JWT con roles |
| Axum 0.8 (Rust 1.99) | Por capas, una carpeta por recurso | En memoria, traits por implementar, SeaORM (PostgreSQL, MySQL, MariaDB, SQLite) | Ninguna, clave de API, JWT con roles |
| Vapor 4 (Swift 6.4) | Por capas, una carpeta por recurso | En memoria, protocolos por implementar, Fluent (PostgreSQL, MySQL, MariaDB, SQLite) | Ninguna, clave de API, JWT con roles |

Cada proyecto incluye sus propias pruebas, que llaman a todos los endpoints. Todos los frameworks, almacenamientos, bases de datos y autenticaciones de la tabla se han verificado compilando, ejecutando y probando proyectos generados en Docker ([docs/verification.md](./docs/verification.md)).

Los proyectos generados se escriben en inglés. Son un punto de partida que hay que revisar, no la promesa de un servicio listo para producción.

## Versiones

- **Web**: React + TypeScript + Vite, en el navegador.
- **Escritorio**: Python + PySide6, la misma herramienta como aplicación instalable, comprobada con los mismos casos de `shared/test-cases/` ([desktop/README_es.md](./desktop/README_es.md)).

## Desarrollo

La versión web está en `web/`:

```bash
cd web
npm install
npm run dev      # servidor de desarrollo
npm run check    # tipos, lint, formato y tests
npm run build    # build de producción, servido desde /tools/Model2API/
```

Cómo está organizado el código, y por qué: [docs/architecture.md](./docs/architecture.md) y [docs/decisions.md](./docs/decisions.md). Cómo se verifican los proyectos generados: [docs/verification.md](./docs/verification.md).

## Sugerencias

Ideas de mejora, errores o un framework para el que te gustaría que Model2API escribiera: escribe a [contact.raulesteveza@gmail.com](mailto:contact.raulesteveza@gmail.com).

## Desarrollador

**Raul Estevez**

- [Web personal](https://raulesteveza.github.io/)
- [Perfil de LinkedIn](https://www.linkedin.com/in/raulesteveza/)

## Licencia

[MIT](./LICENSE)
