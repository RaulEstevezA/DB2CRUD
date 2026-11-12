# DB2CRUD

DB2CRUD genera la capa de acceso a datos de una base de datos que ya tienes: entidades ORM cuando faltan, repositorios y servicios, relacionados con los modelos de tu aplicación. No diseña la base de datos ni escribe migraciones (eso es [Model2DB](https://github.com/RaulEstevezA/Model2DB)), ni escribe controladores o endpoints. Todo ocurre en tu lado, en el navegador: lo que pegas o abres no se envía a ningún sitio, no se conecta a ninguna base de datos y el código se analiza, nunca se ejecuta.

> [!IMPORTANT]
> DB2CRUD está en desarrollo y todavía no se ha publicado en la web. Hoy lee proyectos de Model2DB y escribe proyectos Python (SQLAlchemy 2, Django 5.2) y TypeScript (TypeORM 0.3, Prisma 7), verificados en Docker en PostgreSQL, MySQL, MariaDB y SQLite; el DDL de SQL, el código ORM, los modelos de aplicación y los demás lenguajes se están escribiendo. Lo que ya funciona está en el [registro de cambios](./CHANGELOG.md).

```text
Pegar o abrir la base de datos y los modelos  →  Revisar los repositorios y servicios propuestos  →  Elegir lenguaje y ORM  →  Descargar el código
```

## Qué hará

1. **Lee la base de datos**: un proyecto de Model2DB, código ORM (SQLAlchemy, Django, TypeORM, Prisma, JPA, EF Core, Doctrine, Eloquent…) o DDL de SQL (PostgreSQL, MySQL, MariaDB, SQLite), con los tipos exactos de las columnas, claves, restricciones únicas, índices, claves foráneas y `CHECK`.
2. **Lee los modelos de aplicación**: clases y DTOs en Python, TypeScript, JavaScript, Java, C#, Kotlin y Dart, JSON, JSON Schema y OpenAPI, o cualquiera de los 23 formatos que lee Mapper, con las validaciones que declara cada campo. También lee las correspondencias de un proyecto de Mapper.
3. **Propone los repositorios** con las consultas que permite el esquema: por clave primaria, por campos únicos, por campos con índice y por claves foráneas.
4. **Propone los servicios**: conversiones entre modelos de aplicación y entidades en los dos sentidos, búsquedas que necesitan la base de datos (`categoryName` → `categoryId`), validación a partir de las restricciones y errores de dominio (`NotFound`, `Conflict`, `ValidationFailed`) sin códigos HTTP. Si un modelo y una columna no coinciden, muestra el conflicto.
5. **Escribe las entidades ORM solo cuando faltan**, fieles a la base de datos: nombres exactos de tablas y columnas y tipos precisos.
6. **Nunca decide una ambigüedad**: transacciones, borrado lógico o físico, concurrencia, cascadas o campos sensibles esperan a que decidas, y el código generado deja un `TODO` donde va cada decisión.
7. **Escribe pruebas**: servicios con repositorios en memoria y repositorios contra una base de datos real. Una combinación de lenguaje, ORM y base de datos solo aparece como verificada cuando un proyecto generado con ella ha pasado sus pruebas en Docker.

El primer stack que se recorrió de principio a fin fue Python + SQLAlchemy 2 + PostgreSQL; después vinieron Django, TypeORM y Prisma.

## Versiones

- **Web**: React + TypeScript + Vite, en el navegador.
- **Escritorio**: Python + PySide6, la misma herramienta como aplicación instalable, comprobada con los mismos casos de `shared/test-cases/` ([desktop/README_es.md](./desktop/README_es.md)).

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

Ideas de mejora, errores o un ORM para el que te gustaría que DB2CRUD escribiera: escribe a [contact.raulesteveza@gmail.com](mailto:contact.raulesteveza@gmail.com).

## Desarrollador

**Raul Estevez**

- [Web personal](https://raulesteveza.github.io/)
- [Perfil de LinkedIn](https://www.linkedin.com/in/raulesteveza/)

## Licencia

[MIT](./LICENSE)
