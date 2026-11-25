# DB2CRUD

DB2CRUD genera la capa de acceso a datos de una base de datos que ya tienes: entidades cuando faltan, repositorios y servicios, relacionados con los modelos de tu aplicación. No diseña la base de datos ni escribe migraciones (eso es [Model2DB](https://github.com/RaulEstevezA/Model2DB)), ni escribe controladores o endpoints. Todo ocurre en tu lado, en el navegador: lo que pegas o abres no se envía a ningún sitio, no se conecta a ninguna base de datos y el código se analiza, nunca se ejecuta.

**Pruébalo en la web:** [raulesteveza.github.io/tools/DB2CRUD](https://raulesteveza.github.io/tools/DB2CRUD/)

```text
Pegar o abrir la base de datos y los modelos  →  Revisar los repositorios y servicios propuestos  →  Elegir lenguaje y biblioteca  →  Descargar el código
```

## Qué hace

1. **Lee la base de datos**, con los tipos exactos de las columnas, claves, restricciones únicas, índices, claves foráneas y `CHECK`, desde cualquiera de las [entradas de abajo](#qué-lee).
2. **Lee los modelos de aplicación**, en cualquiera de los 23 formatos que lee Mapper: clases y DTOs en 12 lenguajes, JSON Schema, OpenAPI, GraphQL, Protocol Buffers o datos de ejemplo, con las validaciones que declara cada campo. También lee las correspondencias de un proyecto de Mapper.
3. **Propone los repositorios** con las consultas que permite el esquema: por clave primaria, por campos únicos, por campos con índice y por claves foráneas. En MongoDB, también añadir y quitar un elemento de una lista anidada.
4. **Propone los servicios**: conversiones entre modelos de aplicación y entidades en los dos sentidos, búsquedas que necesitan la base de datos (`categoryName` → `categoryId`), validación a partir de las restricciones y errores de dominio (`NotFound`, `Conflict`, `ValidationFailed`) sin códigos HTTP. Si un modelo y una columna no coinciden, muestra el conflicto.
5. **Escribe las entidades solo cuando faltan**, fieles a la base de datos: nombres exactos de tablas y columnas y tipos precisos.
6. **Nunca decide una ambigüedad**: transacciones, borrado lógico o físico, concurrencia, cascadas o campos sensibles esperan a que decidas, y el código generado deja un `TODO` donde va cada decisión.
7. **Escribe pruebas**: servicios con repositorios en memoria y repositorios contra una base de datos real. Una combinación de lenguaje, biblioteca y base de datos solo aparece como verificada cuando un proyecto generado con ella ha pasado sus pruebas en Docker.

### Qué lee

- **Proyectos de Model2DB**, relacionales o para MongoDB.
- **DDL de SQL** de PostgreSQL, MySQL, MariaDB y SQLite, también los volcados de `pg_dump --schema-only` y `mysqldump --no-data`.
- **Código de un ORM**: SQLAlchemy, SQLModel, Django y Tortoise; Prisma, TypeORM, Sequelize y Drizzle; JPA/Hibernate; EF Core; Doctrine; migraciones de Laravel con modelos de Eloquent.
- **MongoDB**: schemas de Mongoose, clases de Spring Data, documentos de Beanie, los validadores `$jsonSchema` de las colecciones, o documentos de ejemplo si no hay ni lo uno ni lo otro (`mongoexport`, Compass, mongosh).

### Qué escribe

| Lenguaje | Con un ORM | Sin ORM (SQL) | MongoDB |
|---|---|---|---|
| Python | SQLAlchemy 2, Django 5.2 | psycopg, MySQL Connector, sqlite3 | Beanie 2 |
| TypeScript | TypeORM 0.3, Prisma 7, Drizzle 0.45, Sequelize 6 | pg, mysql2, better-sqlite3 | Mongoose 8 |
| Java 21 | JPA (Hibernate 7) | JDBC | Spring Data MongoDB 5 |
| C# (.NET 10) | EF Core 9 | ADO.NET | MongoDB.Driver 3 |
| PHP 8.4 | Doctrine ORM 3, Eloquent 12 | PDO | mongodb/mongodb 2 |
| Kotlin (JVM), experimental | Exposed 1.6 | JDBC | MongoDB Kotlin driver 5 |
| Rust, experimental | SeaORM 2 | sqlx | MongoDB Rust driver 3 |
| Swift, experimental | Fluent (FluentKit 1) | SQLKit | MongoKitten 7 |

Kotlin, Rust y Swift son **experimentales**: funcionan y reciben correcciones, pero las funciones nuevas se escriben para los otros cinco lenguajes.

Los proyectos relacionales son para PostgreSQL, MySQL, MariaDB o SQLite. Todas las combinaciones se han verificado en Docker, en esas cuatro bases de datos o en MongoDB 8.

Todo lo que es cuestión de gusto es un ajuste: entidades o DTOs, cómo llegan los cambios, transacciones, páginas por desplazamiento o por cursor, carpetas por capa o por tabla, nombres y pruebas. Con modelos de aplicación en el lenguaje del proyecto, también se escriben las conversiones entre ellos y las filas o documentos.

## Versiones

- **Web**: React + TypeScript + Vite, en el navegador: [raulesteveza.github.io/tools/DB2CRUD](https://raulesteveza.github.io/tools/DB2CRUD/).
- **Escritorio**: Python + PySide6, la misma herramienta como aplicación instalable ([descarga](./desktop/README_es.md#descarga)), comprobada con los mismos casos de `shared/test-cases/` ([desktop/README_es.md](./desktop/README_es.md)).

## Desarrollo

La versión web está en `web/`:

```bash
cd web
npm install
npm run dev      # servidor de desarrollo
npm run check    # tipos, lint, formato y pruebas
npm run build    # build de producción, servido desde /tools/DB2CRUD/
```

Cómo está organizado el código, y por qué: [docs/architecture.md](./docs/architecture.md) y [docs/decisions.md](./docs/decisions.md). Cómo se verifica el código generado: [docs/verification.md](./docs/verification.md).

## Sugerencias

Ideas de mejora, errores o una biblioteca para la que te gustaría que DB2CRUD escribiera: escribe a [contact.raulesteveza@gmail.com](mailto:contact.raulesteveza@gmail.com).

## Desarrollador

**Raul Estevez**

- [Web personal](https://raulesteveza.github.io/)
- [Perfil de LinkedIn](https://www.linkedin.com/in/raulesteveza/)

## Licencia

[MIT](./LICENSE)
