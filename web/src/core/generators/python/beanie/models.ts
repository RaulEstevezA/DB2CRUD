/**
 * `app/models.py`: the Beanie document of every collection and the models of the documents inside it, as the database has
 * them (stored names and types). The repositories turn them into the project's entities.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { isObjectId } from '../../../schema/documents.ts'
import type { DbColumn, DbType } from '../../../schema/types.ts'
import { lines, type Line } from '../../types.ts'
import { Imports, pyLiteral, snakeName } from '../python.ts'
import { pyType, type Context, type TableInfo } from '../common/context.ts'
import { innerFirst, nestedTypes, type NestedType } from '../common/documents.ts'

export const documentClass = (info: TableInfo) => `${info.entity}Document`
export const modelClass = (type: NestedType) => `${type.name}Model`

/** The models of the nested documents of a collection, by column. */
export const modelsOf = (info: TableInfo) => nestedTypes(info.table.columns, info.entity)

/** Names a Beanie document or a Pydantic model uses for something else */
const TAKEN = new Set(
  (
    'add_child aggregate all avg bulk_writer construct copy count create current_date delete delete_all dict distinct ' +
    'fetch_all_links fetch_link fill_back_refs find find_all find_many find_one from_orm get get_bson_encoders get_changes ' +
    'get_collection_name get_link_fields get_model_type get_previous_changes get_previous_saved_state get_pymongo_collection ' +
    'get_saved_state get_settings has_changed id inc insert insert_many insert_one inspect_collection is_changed json lazy_parse ' +
    'link_from_id max min model_computed_fields model_config model_construct model_copy model_dump model_dump_json model_extra ' +
    'model_fields model_fields_set model_json_schema model_parametrized_name model_post_init model_rebuild model_validate ' +
    'model_validate_json model_validate_strings parse_file parse_obj parse_raw parse_store replace replace_many revision_id ' +
    'rollback save save_changes schema schema_json set set_collection set_collection_name set_database settings ' +
    'state_management_replace_objects state_management_save_previous sum sync to_ref update update_all update_forward_refs ' +
    'use_state_management validate validate_self Any Decimal Field bool bytes datetime float int list str'
  ).split(' '),
)

/** The type of a value as the database keeps it. */
function storedType(type: DbType, nested: NestedType | null, imports: Imports): string {
  switch (type.kind) {
    case 'array':
      return `list[${storedType(type.items, nested, imports)}]`
    case 'json':
      return type.fields && nested ? modelClass(nested) : pyType(type, imports)
    case 'text':
      if (!isObjectId(type)) return 'str'
      imports.from('beanie', 'PydanticObjectId')
      return 'PydanticObjectId'
    case 'integer':
      return type.bits === 64 ? 'Long' : 'int'
    case 'decimal':
      imports.from('beanie', 'DecimalAnnotation')
      return 'DecimalAnnotation'
    default:
      return pyType(type, imports)
  }
}

/** Beanie takes only a class as the type of an identifier. */
const keyType = (type: DbType, imports: Imports) => (isObjectId(type) ? storedType(type, null, imports) : pyType(type, imports))

function fieldLine(column: DbColumn, nested: NestedType | null, taken: Set<string>, imports: Imports): string {
  let attr = snakeName(column.name)
  while (TAKEN.has(attr) || taken.has(attr)) attr += '_'
  taken.add(attr)
  // Every field may be missing: the services check what must be there, and the documents that are stored are read as they are
  const value = attr === column.name ? 'None' : `Field(default=None, alias=${pyLiteral(column.name)})`
  if (attr !== column.name) imports.from('pydantic', 'Field')
  return `    ${attr}: ${storedType(column.type, nested, imports)} | None = ${value}`
}

function nestedBlock(type: NestedType, imports: Imports): Line[] {
  const taken = new Set<string>()
  return [
    '',
    '',
    `class ${modelClass(type)}(BaseModel):`,
    '    """A document inside another. Fields it does not name are kept."""',
    '',
    '    model_config = ConfigDict(extra="allow", protected_namespaces=())',
    '',
    ...type.fields.map(({ column, nested }) => fieldLine(column, nested, taken, imports)),
  ]
}

function documentBlock(info: TableInfo, imports: Imports): Line[] {
  const types = modelsOf(info)
  const taken = new Set<string>()
  const nullable = (columns: string[]) => columns.every((name) => info.table.columns.find((column) => column.name === name)?.nullable)
  const index = (columns: string[], options: string[]) =>
    `            IndexModel([${columns.map((name) => `(${pyLiteral(name)}, 1)`).join(', ')}]${options.map((item) => `, ${item}`).join('')}),`
  const named = (name: string | undefined) => (name ? [`name=${pyLiteral(name)}`] : [])
  const indexes = [
    ...info.table.uniques.map((item) =>
      index(item.columns, [...named(item.name), 'unique=True', ...(nullable(item.columns) ? ['sparse=True'] : [])]),
    ),
    ...info.table.indexes.map((item) => index(item.columns, named(item.name))),
  ]
  if (indexes.length > 0) imports.from('pymongo', 'IndexModel')
  return [
    ...[...types.values()].flatMap(innerFirst).flatMap((type) => nestedBlock(type, imports)),
    '',
    '',
    `class ${documentClass(info)}(Document):`,
    `    """A document of the "${info.name}" collection${info.table.comment ? `: ${info.table.comment}` : ''}."""`,
    '',
    '    model_config = ConfigDict(populate_by_name=False, protected_namespaces=())',
    '',
    ...info.columns.map(({ column }) =>
      column.name === '_id'
        ? `    id: ${keyType(column.type, imports)} | None = Field(default=None, alias="_id")`
        : fieldLine(column, types.get(column.name) ?? null, taken, imports),
    ),
    '',
    '    class Settings:',
    `        name = ${pyLiteral(info.name)}`,
    '        keep_nulls = False',
    ...(indexes.length > 0
      ? [
          '        # Only the tests create them: in the application the database already has its own',
          '        indexes = [',
          ...indexes,
          '        ]',
        ]
      : []),
  ]
}

export function modelsFile(context: Context): GeneratedFile {
  const imports = new Imports()
    .from('beanie', 'Document')
    .from('pydantic', 'BaseModel', 'ConfigDict', 'Field', 'PlainValidator')
    .from('bson.int64', 'Int64')
    .from('typing', 'Annotated')
  const blocks = context.tables.flatMap((info) => documentBlock(info, imports))
  return {
    path: 'app/models.py',
    content: lines(
      '"""The Beanie document of every collection, as the database has them."""',
      '',
      imports.write('app'),
      '',
      'Long = Annotated[int, PlainValidator(Int64)]',
      '"""A whole number of 64 bits, stored as one whatever its value."""',
      ...blocks,
      '',
      '',
      `DOCUMENTS: list[type[Document]] = [${context.tables.map(documentClass).join(', ')}]`,
      '"""Every document, for `init_beanie`."""',
      '',
    ),
  }
}
