/**
 * Pydantic schemas of the FastAPI project: the base model and validators shared by every schema, the enums
 * and embedded objects, and the read, create and partial update schemas of each resource. They follow the
 * shapes of the OpenAPI contract (openapi/build.ts) field by field.
 */
import type { SpecField, SpecResource } from '../../../api/spec.ts'
import { toScreamingSnakeCase } from '../../../model/naming.ts'
import { alwaysInResponse, shapeFields } from '../../../openapi/build.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { PyImports, pyClass, pyDocstring, pyLiteral, pyString, pyType, type PyTypeNames } from '../../languages/python/python.ts'
import { attr, classes, type FastApiContext } from './context.ts'
import { pageClass } from './routes.ts'

/** The base schema and the validators of formats Pydantic has no plain type for. */
export function validatorsFile(): GeneratedFile {
  const content = lines(
    pyDocstring('Base schema and validators shared by every request and response schema.'),
    '',
    'from datetime import UTC, date, datetime, time',
    'from decimal import Decimal',
    'from typing import Annotated, Any, ClassVar',
    'from uuid import UUID',
    '',
    'from pydantic import AfterValidator, AnyUrl, BaseModel, ConfigDict, PlainSerializer, field_validator, model_validator',
    '',
    '',
    'class ApiModel(BaseModel):',
    '    """Base of every schema: fields are read by their JSON name or their Python name, unknown fields',
    '    are rejected, bytes travel as base64, and fields listed in `non_nullable` may be left out but never',
    '    sent as null."""',
    '',
    '    model_config = ConfigDict(populate_by_name=True, extra="forbid", ser_json_bytes="base64", val_json_bytes="base64")',
    '',
    '    non_nullable: ClassVar[frozenset[str]] = frozenset()',
    '',
    '    @model_validator(mode="after")',
    '    def reject_null(self) -> "ApiModel":',
    '        for name in self.non_nullable & self.model_fields_set:',
    '            if getattr(self, name) is None:',
    '                alias = type(self).model_fields[name].alias or name',
    '                raise ValueError(f"{alias} cannot be null")',
    '        return self',
    '',
    '',
    'class ResponseModel(BaseModel):',
    '    """Base of response schemas: built from stored values, which may hold more fields than the API shows."""',
    '',
    '    model_config = ConfigDict(populate_by_name=True, from_attributes=True, ser_json_bytes="base64", val_json_bytes="base64")',
    '',
    '    @field_validator("*", mode="after")',
    '    @classmethod',
    '    def utc(cls, value: Any) -> Any:',
    '        """Dates stored without a time zone (SQLite keeps none) were stored in UTC: every database answers alike."""',
    '        if isinstance(value, datetime) and value.tzinfo is None:',
    '            return value.replace(tzinfo=UTC)',
    '        return value',
    '',
    '',
    'def _check_url(value: str) -> str:',
    '    AnyUrl(value)',
    '    return value',
    '',
    '',
    'def _check_uuid(value: str) -> str:',
    '    return str(UUID(value))',
    '',
    '',
    'def _check_date(value: str) -> str:',
    '    date.fromisoformat(value)',
    '    return value',
    '',
    '',
    'def _check_datetime(value: str) -> str:',
    '    datetime.fromisoformat(value.replace("Z", "+00:00"))',
    '    return value',
    '',
    '',
    'def _check_time(value: str) -> str:',
    '    time.fromisoformat(value)',
    '    return value',
    '',
    '',
    '# Texts with a format, kept as text after the check',
    'UrlText = Annotated[str, AfterValidator(_check_url)]',
    'UuidText = Annotated[str, AfterValidator(_check_uuid)]',
    'DateText = Annotated[str, AfterValidator(_check_date)]',
    'DateTimeText = Annotated[str, AfterValidator(_check_datetime)]',
    'TimeText = Annotated[str, AfterValidator(_check_time)]',
    '',
    '# Exact numbers travel as JSON numbers, as the OpenAPI contract describes them',
    'DecimalNumber = Annotated[Decimal, PlainSerializer(float, return_type=float, when_used="json")]',
    '',
    '# Free JSON values',
    'JsonValue = Any',
  )
  return { path: 'app/validators.py', content: fileText(content) }
}

const FORMAT_TYPES: Record<string, string> = {
  uri: 'UrlText',
  uuid: 'UuidText',
  date: 'DateText',
  'date-time': 'DateTimeText',
  time: 'TimeText',
}

/** Python names of the shared enums and objects, imported from the shared module. */
function typeNames(context: FastApiContext, imports: PyImports, here: string): PyTypeNames {
  const shared = context.layout.shared().module
  return {
    object: (name) => {
      const className = pyClass(name)
      if (shared !== here) imports.add(shared, className)
      return className
    },
    enum: (name) => {
      const className = pyClass(name)
      if (shared !== here) imports.add(shared, className)
      return className
    },
  }
}

/** The Python type of a field, with its format and exact-number serialization. */
function fieldType(field: SpecField, imports: PyImports, names: PyTypeNames): string {
  if (field.type.kind === 'scalar' && field.type.scalar === 'string' && field.constraints.format) {
    if (field.constraints.format === 'email') {
      imports.add('pydantic', 'EmailStr')
      return 'EmailStr'
    }
    const name = FORMAT_TYPES[field.constraints.format]
    imports.add('app.validators', name)
    return name
  }
  const text = pyType(field.type, imports, names)
  if (text.includes('Decimal')) {
    imports.add('app.validators', 'DecimalNumber')
    return text.replace(/\bDecimal\b/g, 'DecimalNumber')
  }
  return text
}

/** Arguments of `Field(...)` for the validations, the JSON name and the description. */
function fieldArgs(field: SpecField): string[] {
  const args: string[] = []
  const name = attr(field)
  if (name !== field.wire) args.push(`alias=${pyString(field.wire)}`)
  const c = field.constraints
  const text = field.type.kind === 'scalar' && field.type.scalar === 'string'
  const list = field.type.kind === 'array'
  if (text || list) {
    const min = list ? c.minItems : c.minLength
    const max = list ? c.maxItems : c.maxLength
    if (min !== undefined) args.push(`min_length=${min}`)
    if (max !== undefined) args.push(`max_length=${max}`)
  }
  if (c.minimum !== undefined) args.push(`ge=${c.minimum}`)
  if (c.maximum !== undefined) args.push(`le=${c.maximum}`)
  if (c.exclusiveMinimum !== undefined) args.push(`gt=${c.exclusiveMinimum}`)
  if (c.exclusiveMaximum !== undefined) args.push(`lt=${c.exclusiveMaximum}`)
  if (text && c.pattern !== undefined) args.push(`pattern=${pyString(c.pattern)}`)
  if (field.description) args.push(`description=${pyString(field.description)}`)
  return args
}

type Shape = 'create' | 'update' | 'read' | 'object'

/** One field declaration: `name: str = Field(..., min_length=2)`. */
function declaration(field: SpecField, shape: Shape, imports: PyImports, names: PyTypeNames): string {
  const type = fieldType(field, imports, names)
  const args = fieldArgs(field)
  let optional: boolean
  let defaultText: string
  if (shape === 'update') {
    optional = true
    defaultText = 'None'
  } else if (shape === 'read') {
    optional = field.nullable || !alwaysInResponse(field)
    defaultText = optional ? 'None' : '...'
  } else {
    optional = field.nullable || !field.required
    defaultText = field.required ? '...' : field.defaultValue !== undefined ? pyLiteral(field.defaultValue) : 'None'
  }
  const annotation = optional ? `${type} | None` : type
  if (args.length === 0) return defaultText === '...' ? `${attr(field)}: ${annotation}` : `${attr(field)}: ${annotation} = ${defaultText}`
  imports.add('pydantic', 'Field')
  const defaultArg = defaultText === '...' ? '...' : `default=${defaultText}`
  return `${attr(field)}: ${annotation} = Field(${[defaultArg, ...args].join(', ')})`
}

/** Fields that may be left out but never sent as null, for `ApiModel.non_nullable`. */
function nonNullable(fields: SpecField[]): string[] {
  return fields.filter((field) => !field.nullable).map(attr)
}

function schemaClass(
  name: string,
  base: string,
  docstring: string,
  fields: SpecField[],
  shape: Shape,
  imports: PyImports,
  names: PyTypeNames,
): string {
  const body = fields.map((field) => {
    const todo = field.todo ? `    # TODO: ${field.todo}\n` : ''
    return `${todo}    ${declaration(field, shape, imports, names)}`
  })
  const guarded =
    shape === 'read'
      ? []
      : nonNullable(fields).filter((name) => {
          const field = fields.find((item) => attr(item) === name)!
          return shape === 'update' || !field.required
        })
  if (guarded.length > 0) {
    imports.add('typing', 'ClassVar')
    body.push('', `    non_nullable: ClassVar[frozenset[str]] = frozenset({${guarded.map(pyString).join(', ')}})`)
  }
  return lines(`class ${name}(${base}):`, `    ${pyDocstring(docstring)}`, '', body.length > 0 ? body : ['    pass'])
}

/** Enum member names: `in progress` → `IN_PROGRESS`, `2` → `VALUE_2`. */
function memberName(value: string | number, used: Set<string>): string {
  let name = toScreamingSnakeCase(String(value)) || 'VALUE'
  if (/^[0-9]/.test(name)) name = `VALUE_${name}`
  let unique = name
  for (let n = 2; used.has(unique); n++) unique = `${name}_${n}`
  used.add(unique)
  return unique
}

/** The shared module: enums and embedded objects. */
export function sharedSchemasFile(context: FastApiContext): GeneratedFile | null {
  const { spec } = context
  if (spec.enums.length === 0 && spec.objects.length === 0) return null
  const imports = new PyImports()
  const here = context.layout.shared().module
  const names = typeNames(context, imports, here)
  const blocks: string[] = []
  for (const item of spec.enums) {
    const base = item.valueType === 'integer' ? 'IntEnum' : 'str, Enum'
    imports.add('enum', item.valueType === 'integer' ? 'IntEnum' : 'Enum')
    const used = new Set<string>()
    blocks.push(
      lines(
        `class ${pyClass(item.name)}(${base}):`,
        `    ${pyDocstring(`Values of ${item.name}.`)}`,
        '',
        item.values.map((value) => `    ${memberName(value, used)} = ${pyLiteral(value)}`),
      ),
    )
  }
  if (spec.objects.length > 0) imports.add('app.validators', 'ApiModel')
  for (const object of spec.objects) {
    blocks.push(
      schemaClass(
        pyClass(object.name),
        'ApiModel',
        object.description ?? `${object.name}, embedded in the resources that hold it.`,
        object.fields,
        'object',
        imports,
        names,
      ),
    )
  }
  const content = lines(
    pyDocstring('Enums and embedded objects shared by the resources.'),
    '',
    imports.render(),
    '',
    '',
    blocks.join('\n\n\n'),
  )
  return { path: context.layout.shared().file, content: fileText(content) }
}

/** Read, create and partial update schemas of a resource. */
export function resourceSchemasFile(context: FastApiContext, resource: SpecResource): GeneratedFile {
  const imports = new PyImports()
  const location = context.layout.resource(resource, 'schemas')
  const names = typeNames(context, imports, location.module)
  const names_ = classes(resource)
  const blocks: string[] = []
  const writes = resource.endpoints.some((endpoint) => endpoint.input !== 'none')
  if (writes) {
    imports.add('app.validators', 'ApiModel')
    blocks.push(
      schemaClass(
        names_.create,
        'ApiModel',
        `Body of a request that creates or replaces ${article(resource.singular)}.`,
        shapeFields(resource.fields, 'create'),
        'create',
        imports,
        names,
      ),
      schemaClass(
        names_.update,
        'ApiModel',
        `Body of a request that changes part of ${article(resource.singular)}: only the fields sent change.`,
        shapeFields(resource.fields, 'update'),
        'update',
        imports,
        names,
      ),
    )
  }
  imports.add('app.validators', 'ResponseModel')
  blocks.push(
    schemaClass(
      names_.read,
      'ResponseModel',
      `${capitalize(article(resource.singular))} as the API returns it.`,
      shapeFields(resource.fields, 'read'),
      'read',
      imports,
      names,
    ),
  )
  const page = pageClass(resource)
  if (page) {
    imports.add('pydantic', 'BaseModel')
    blocks.push(page)
  }
  const todo = resource.todo ? `# TODO: ${resource.todo}\n\n` : ''
  const content = lines(
    pyDocstring(`Request and response schemas of ${resource.plural}.`),
    '',
    imports.render(),
    '',
    '',
    todo + blocks.join('\n\n\n'),
  )
  return { path: location.file, content: fileText(content) }
}

export function article(text: string): string {
  return /^[aeiou]/i.test(text) ? `an ${text}` : `a ${text}`
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
