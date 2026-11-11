/**
 * Storage of each resource in the FastAPI project: the repository interface the service depends on
 * (a `Protocol`), and the implementation of the chosen persistence:
 * - `memory`: a dictionary, to run the API without a database
 * - `none`: every method raises "not implemented", with a TODO where the storage goes
 * - `sqlalchemy`: a SQLAlchemy 2 table and a repository on a session
 *
 * Repositories store and return plain dictionaries keyed by the Python names of the fields, so services
 * never depend on how the data is kept.
 */
import type { SpecField, SpecResource, SpecType } from '../../../api/spec.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { PyImports, pyDocstring, pyString } from '../../languages/python/python.ts'
import { attr, classes, keyField, tableName, type FastApiContext } from './context.ts'

/** The Python type of a key, for signatures. */
function keyType(resource: SpecResource, imports: PyImports): string {
  const type = resource.key.type.scalar
  if (type === 'uuid') {
    imports.add('uuid', 'UUID')
    return 'UUID'
  }
  return type === 'integer' ? 'int' : 'str'
}

function protocolBlock(resource: SpecResource, key: string): string {
  const name = classes(resource)
  return lines(
    `class ${name.repository}(Protocol):`,
    `    """Where ${resource.plural} are kept. The service depends only on this interface."""`,
    '',
    '    def list(self, filters: dict[str, Any], sort: tuple[str, bool] | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:',
    '        """Items equal to every filter, sorted by (field, descending), from `offset`, at most `limit`; and how many match."""',
    '        ...',
    '',
    `    def get(self, key: ${key}) -> dict[str, Any] | None:`,
    '        """The item with this key, or None."""',
    '        ...',
    '',
    '    def add(self, values: dict[str, Any]) -> dict[str, Any]:',
    '        """Stores a new item; a key the server generates is assigned here. Returns the stored item."""',
    '        ...',
    '',
    `    def update(self, key: ${key}, values: dict[str, Any]) -> dict[str, Any]:`,
    '        """Changes the given fields of an existing item and returns it."""',
    '        ...',
    '',
    `    def delete(self, key: ${key}) -> None:`,
    '        """Removes an existing item."""',
    '        ...',
  )
}

function memoryBlock(resource: SpecResource, key: string, imports: PyImports): string {
  const name = classes(resource)
  const keyAttr = attr(keyField(resource))
  imports.add('copy', 'deepcopy')
  let assign: string[] = []
  if (resource.key.generated === 'increment')
    assign = [`        values[${pyString(keyAttr)}] = self._next_key`, '        self._next_key += 1']
  if (resource.key.generated === 'uuid') {
    imports.add('uuid', 'uuid4')
    assign = [`        values[${pyString(keyAttr)}] = ${resource.key.type.scalar === 'uuid' ? 'uuid4()' : 'str(uuid4())'}`]
  }
  return lines(
    `class ${name.memory}:`,
    `    """Keeps ${resource.plural} in memory: they are lost when the application stops. Use it to try the API."""`,
    '',
    '    def __init__(self) -> None:',
    `        self._items: dict[${key}, dict[str, Any]] = {}`,
    resource.key.generated === 'increment' && '        self._next_key = 1',
    '',
    '    def list(self, filters: dict[str, Any], sort: tuple[str, bool] | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:',
    '        items = [item for item in self._items.values() if all(item.get(name) == value for name, value in filters.items())]',
    '        if sort is not None:',
    '            name, descending = sort',
    '            # Items without a value go last, whatever the order',
    '            present = sorted((item for item in items if item.get(name) is not None), key=lambda item: item[name], reverse=descending)',
    '            items = present + [item for item in items if item.get(name) is None]',
    '        end = None if limit is None else offset + limit',
    '        return [deepcopy(item) for item in items[offset:end]], len(items)',
    '',
    `    def get(self, key: ${key}) -> dict[str, Any] | None:`,
    '        item = self._items.get(key)',
    '        return deepcopy(item) if item is not None else None',
    '',
    '    def add(self, values: dict[str, Any]) -> dict[str, Any]:',
    '        values = deepcopy(values)',
    assign,
    `        self._items[values[${pyString(keyAttr)}]] = values`,
    '        return deepcopy(values)',
    '',
    `    def update(self, key: ${key}, values: dict[str, Any]) -> dict[str, Any]:`,
    '        self._items[key].update(deepcopy(values))',
    '        return deepcopy(self._items[key])',
    '',
    `    def delete(self, key: ${key}) -> None:`,
    '        del self._items[key]',
  )
}

function pendingBlock(resource: SpecResource, key: string): string {
  const name = classes(resource)
  const message = pyString(`The storage of ${resource.plural} is not written yet`)
  const method = (signature: string) => [
    `    def ${signature}:`,
    `        # TODO: store ${resource.plural} in your database`,
    `        raise NotImplementedError(${message})`,
  ]
  return lines(
    `class ${name.pendingRepository}:`,
    `    """Storage of ${resource.plural} to write: every method answers 501 until it is implemented."""`,
    '',
    method(
      'list(self, filters: dict[str, Any], sort: tuple[str, bool] | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]',
    ),
    '',
    method(`get(self, key: ${key}) -> dict[str, Any] | None`),
    '',
    method('add(self, values: dict[str, Any]) -> dict[str, Any]'),
    '',
    method(`update(self, key: ${key}, values: dict[str, Any]) -> dict[str, Any]`),
    '',
    method(`delete(self, key: ${key}) -> None`),
  )
}

/** Whether a field is stored as JSON: embedded objects, lists, maps and free values. */
function storedAsJson(field: SpecField): boolean {
  return field.type.kind !== 'scalar' && field.type.kind !== 'enum' ? true : field.type.kind === 'scalar' && field.type.scalar === 'any'
}

function sqlBlock(resource: SpecResource, key: string, context: FastApiContext, imports: PyImports): string {
  const name = classes(resource)
  imports.add('sqlalchemy', 'func', 'select')
  imports.add('sqlalchemy.orm', 'Session')
  imports.add('enum', 'Enum')
  imports.add(context.layout.resource(resource, 'models').module, name.model)
  const json = resource.fields.filter(storedAsJson).map(attr)
  if (json.length > 0) imports.add('fastapi.encoders', 'jsonable_encoder')
  const keyAttr = attr(keyField(resource))
  return lines(
    'def _plain(value: Any) -> Any:',
    '    """The stored form of a value: enums by their value."""',
    '    return value.value if isinstance(value, Enum) else value',
    '',
    '',
    `class ${name.sqlRepository}:`,
    `    """Keeps ${resource.plural} in the "${tableName(resource)}" table."""`,
    '',
    json.length > 0 && `    _json_fields = frozenset({${json.map(pyString).join(', ')}})`,
    json.length > 0 && '',
    '    def __init__(self, session: Session) -> None:',
    '        self._session = session',
    '',
    `    def _to_dict(self, row: ${name.model}) -> dict[str, Any]:`,
    '        return {column.key: getattr(row, column.key) for column in row.__table__.columns}',
    '',
    '    def _storable(self, values: dict[str, Any]) -> dict[str, Any]:',
    json.length > 0
      ? '        return {name: jsonable_encoder(value) if name in self._json_fields else _plain(value) for name, value in values.items()}'
      : '        return {name: _plain(value) for name, value in values.items()}',
    '',
    '    def list(self, filters: dict[str, Any], sort: tuple[str, bool] | None, offset: int, limit: int | None) -> tuple[list[dict[str, Any]], int]:',
    `        query = select(${name.model})`,
    '        for field, value in filters.items():',
    `            query = query.where(getattr(${name.model}, field) == _plain(value))`,
    '        total = self._session.scalar(select(func.count()).select_from(query.subquery())) or 0',
    '        if sort is not None:',
    `            column = getattr(${name.model}, sort[0])`,
    '            query = query.order_by(column.desc() if sort[1] else column.asc())',
    `        query = query.order_by(${name.model}.${keyAttr}).offset(offset)`,
    '        if limit is not None:',
    '            query = query.limit(limit)',
    '        return [self._to_dict(row) for row in self._session.scalars(query)], total',
    '',
    `    def get(self, key: ${key}) -> dict[str, Any] | None:`,
    `        row = self._session.get(${name.model}, key)`,
    '        return self._to_dict(row) if row is not None else None',
    '',
    '    def add(self, values: dict[str, Any]) -> dict[str, Any]:',
    `        row = ${name.model}(**self._storable(values))`,
    '        self._session.add(row)',
    '        self._session.commit()',
    '        # Read back what the database stored, so a response shows the same values as a later read',
    '        self._session.refresh(row)',
    '        return self._to_dict(row)',
    '',
    `    def update(self, key: ${key}, values: dict[str, Any]) -> dict[str, Any]:`,
    `        row = self._session.get_one(${name.model}, key)`,
    '        for field, value in self._storable(values).items():',
    '            setattr(row, field, value)',
    '        self._session.commit()',
    '        self._session.refresh(row)',
    '        return self._to_dict(row)',
    '',
    `    def delete(self, key: ${key}) -> None:`,
    `        self._session.delete(self._session.get_one(${name.model}, key))`,
    '        self._session.commit()',
  )
}

export function repositoryFile(context: FastApiContext, resource: SpecResource): GeneratedFile {
  const imports = new PyImports()
  imports.add('typing', 'Any', 'Protocol')
  const key = keyType(resource, imports)
  const blocks = [protocolBlock(resource, key)]
  if (context.sql) blocks.push(sqlBlock(resource, key, context, imports))
  else if (context.pending) blocks.push(pendingBlock(resource, key))
  else blocks.push(memoryBlock(resource, key, imports))
  const content = lines(pyDocstring(`Storage of ${resource.plural}.`), '', imports.render(), '', '', blocks.join('\n\n\n'))
  return { path: context.layout.resource(resource, 'repository').file, content: fileText(content) }
}

/** The SQLAlchemy column type of a field. */
function columnType(field: SpecField, context: FastApiContext, imports: PyImports, isKeyLike: boolean): string {
  const type: SpecType = field.type
  if (storedAsJson(field)) {
    imports.add('sqlalchemy', 'JSON')
    return 'JSON'
  }
  if (type.kind === 'enum') {
    const values = context.spec.enums.find((item) => item.name === type.name)?.values ?? []
    if (values.every((value) => typeof value === 'number')) {
      imports.add('sqlalchemy', 'Integer')
      return 'Integer'
    }
    imports.add('sqlalchemy', 'String')
    return `String(${Math.max(1, ...values.map((value) => String(value).length))})`
  }
  if (type.kind !== 'scalar') return 'JSON'
  switch (type.scalar) {
    case 'string': {
      const max = field.constraints.maxLength
      if (max !== undefined || isKeyLike) {
        imports.add('sqlalchemy', 'String')
        return `String(${max ?? 255})`
      }
      imports.add('sqlalchemy', 'Text')
      return 'Text'
    }
    case 'integer':
      if (type.bits === 64) {
        imports.add('sqlalchemy', 'BigInteger')
        return 'BigInteger'
      }
      imports.add('sqlalchemy', 'Integer')
      return 'Integer'
    case 'float':
      imports.add('sqlalchemy', 'Float')
      return 'Float'
    case 'decimal':
      imports.add('sqlalchemy', 'Numeric')
      // A fixed size: MySQL and MariaDB would otherwise keep no decimals
      return 'Numeric(18, 4)'
    case 'boolean':
      imports.add('sqlalchemy', 'Boolean')
      return 'Boolean'
    case 'date':
      imports.add('sqlalchemy', 'Date')
      return 'Date'
    case 'datetime':
      imports.add('sqlalchemy', 'DateTime')
      return 'DateTime(timezone=True)'
    case 'time':
      imports.add('sqlalchemy', 'Time')
      return 'Time'
    case 'duration':
      imports.add('sqlalchemy', 'Interval')
      return 'Interval'
    case 'uuid':
      imports.add('sqlalchemy', 'Uuid')
      return 'Uuid'
    case 'binary':
      imports.add('sqlalchemy', 'LargeBinary')
      return 'LargeBinary'
    default:
      imports.add('sqlalchemy', 'JSON')
      return 'JSON'
  }
}

/** The SQLAlchemy table of a resource. */
export function modelFile(context: FastApiContext, resource: SpecResource): GeneratedFile | null {
  if (!context.sql) return null
  const imports = new PyImports()
  imports.add('typing', 'Any')
  imports.add('sqlalchemy.orm', 'Mapped', 'mapped_column')
  imports.add('app.db', 'Base')
  const name = classes(resource)
  const columns = resource.fields.map((field) => {
    const isKey = field.name === resource.key.field
    const target =
      field.reference && field.type.kind === 'scalar' ? context.spec.resources.find((item) => item.name === field.reference) : undefined
    let type = columnType(field, context, imports, isKey || target !== undefined)
    const args: string[] = []
    if (isKey) {
      if (resource.key.generated === 'increment') {
        // SQLite only numbers a column declared exactly as INTEGER PRIMARY KEY
        imports.add('sqlalchemy', 'Integer')
        if (type === 'BigInteger') type = 'BigInteger().with_variant(Integer, "sqlite")'
        args.push('primary_key=True', 'autoincrement=True')
      } else if (resource.key.generated === 'uuid') {
        // The server assigns a new UUID when the client sends none
        imports.add('uuid', 'uuid4')
        args.push('primary_key=True', resource.key.type.scalar === 'uuid' ? 'default=uuid4' : 'default=lambda: str(uuid4())')
      } else args.push('primary_key=True')
    }
    if (target) {
      imports.add('sqlalchemy', 'ForeignKey')
      args.push(`ForeignKey(${pyString(`${tableName(target)}.${attr(keyField(target))}`)})`)
    }
    const nullable = !isKey && (field.nullable || !field.required) && field.server !== 'created' && field.server !== 'updated'
    if (!isKey) args.push(`nullable=${nullable ? 'True' : 'False'}`)
    const column = `mapped_column(${[type, ...args.filter((arg) => arg.startsWith('ForeignKey')), ...args.filter((arg) => !arg.startsWith('ForeignKey'))].join(', ')})`
    return `    ${attr(field)}: Mapped[Any] = ${column}`
  })
  const content = lines(
    pyDocstring(`Table of ${resource.plural}. Embedded objects and lists are stored as JSON.`),
    '',
    imports.render(),
    '',
    '',
    `class ${name.model}(Base):`,
    `    """A row of the "${tableName(resource)}" table."""`,
    '',
    `    __tablename__ = ${pyString(tableName(resource))}`,
    '',
    columns,
  )
  return { path: context.layout.resource(resource, 'models').file, content: fileText(content) }
}
