/**
 * The resolved API: models, design and settings combined into one language-neutral description that the
 * OpenAPI contract and every generator read. Each decision is applied here once (key, relations, access,
 * types, protection, status codes), so the contract and the code of every framework cannot disagree.
 *
 * Pending decisions keep their suggested value and add a `todo` in English, which the generators write
 * as a `TODO` comment where the decision matters.
 */
import { auditKind, modelTarget } from '../analysis/models.ts'
import { readConstraints, type Constraints } from '../analysis/constraints.ts'
import type { ProjectSettings } from '../compatibility/stack.ts'
import { defaultResourcePath, keyParam } from '../design/propose.ts'
import { nameWords, singularize, uniqueName } from '../model/naming.ts'
import { allFields, findModel, type FieldDef, type Literal, type ModelSchema, type Primitive, type TypeRef } from '../model/schema.ts'
import { blockedEndpoints, pathParams, validateDesign, type DesignIssue } from '../validation/design.ts'
import type { AccessChoice, ApiDesign, CustomInput, CustomOutput, HttpMethod, Operation, ResourceDesign } from './types.ts'

/** A type as the API sees it. `object` names an entry of `objects`; `enum` an entry of `enums`. */
export type SpecType =
  | { kind: 'scalar'; scalar: Primitive; bits?: 8 | 16 | 32 | 64 }
  | { kind: 'array'; items: SpecType }
  | { kind: 'map'; value: SpecType }
  | { kind: 'object'; name: string }
  | { kind: 'enum'; name: string }

/** How the server fills a field the client cannot send. */
export type ServerValue = 'key' | 'created' | 'updated' | 'default' | 'pending'

export interface SpecField {
  /** Name in the input model, for identifiers in the code */
  name: string
  /** Name of the property in the JSON the API sends and receives */
  wire: string
  type: SpecType
  /** The client must send it when creating or replacing */
  required: boolean
  nullable: boolean
  defaultValue?: Literal
  access: AccessChoice
  constraints: Constraints
  /** The value is the key of this resource (or a list of keys, when `type` is an array) */
  reference?: string
  /** Only for read-only fields: how the server fills them */
  server?: ServerValue
  description?: string
  /** A decision still waiting for the user, in English, for a `TODO` comment */
  todo?: string
}

export interface SpecObject {
  name: string
  fields: SpecField[]
  description?: string
}

export interface SpecEnum {
  name: string
  values: (string | number)[]
  valueType: 'string' | 'integer'
}

export interface SpecKey {
  /** Name of the key field, in `fields` */
  field: string
  type: SpecType & { kind: 'scalar' }
  /** The server assigns it: `increment` for whole numbers, `uuid` for UUIDs and texts */
  generated: 'increment' | 'uuid' | null
  /** Name of the path parameter that identifies one item */
  param: string
}

export interface SpecParam {
  name: string
  type: SpecType & { kind: 'scalar' }
}

export interface SpecEndpoint {
  id: string
  operation: Operation
  method: HttpMethod
  path: string
  name: string
  summary: string
  access: 'public' | 'authenticated' | 'roles'
  roles: string[]
  /** Status of a successful response */
  status: number
  pathParams: SpecParam[]
  /** Lists only */
  pagination: boolean
  filters: string[]
  sort: string[]
  /** What the body carries and what the response returns */
  input: CustomInput
  output: CustomOutput
}

export interface SpecResource {
  name: string
  /** Words of the name, for texts: `order line` / `order lines` */
  singular: string
  plural: string
  /** First segment of its paths */
  path: string
  key: SpecKey
  fields: SpecField[]
  endpoints: SpecEndpoint[]
  description?: string
  todo?: string
}

export interface ApiSpec {
  title: string
  resources: SpecResource[]
  objects: SpecObject[]
  enums: SpecEnum[]
  auth: ProjectSettings['auth']
  /** Every role named by an endpoint */
  roles: string[]
  /** Problems found in the design; endpoints with an error are not in `resources` */
  issues: DesignIssue[]
}

/** Status of a successful response of each operation, unless the endpoint sets another. */
function defaultStatus(operation: Operation, output: CustomOutput): number {
  if (operation === 'create') return 201
  if (operation === 'delete') return 204
  if (operation === 'custom' && output === 'none') return 204
  return 200
}

/** Input and output of each standard operation. */
const STANDARD_IO: Record<Exclude<Operation, 'custom'>, { input: CustomInput; output: CustomOutput }> = {
  list: { input: 'none', output: 'list' },
  get: { input: 'none', output: 'resource' },
  create: { input: 'resource', output: 'resource' },
  replace: { input: 'resource', output: 'resource' },
  update: { input: 'partial', output: 'resource' },
  delete: { input: 'none', output: 'none' },
}

function scalar(name: Primitive, bits?: 8 | 16 | 32 | 64): SpecType & { kind: 'scalar' } {
  return bits ? { kind: 'scalar', scalar: name, bits } : { kind: 'scalar', scalar: name }
}

/** `customer` → `customerId`, `order_line` → `order_line_id`, `tags` → `tagIds`. */
function referenceWire(name: string, many: boolean): string {
  const base = many ? singularize(name) : name
  if (name.includes('_')) return `${base}_${many ? 'ids' : 'id'}`
  return `${base}${many ? 'Ids' : 'Id'}`
}

interface Context {
  schema: ModelSchema
  design: ApiDesign
  objects: Map<string, SpecObject>
  keys: Map<string, SpecKey>
}

function resourceOf(design: ApiDesign, model: string): ResourceDesign | undefined {
  return design.resources.find((item) => item.model === model)
}

/** The key of a resource: one of its fields, or a new `id` field the server fills. */
function resolveKey(resource: ResourceDesign, schema: ModelSchema): { key: SpecKey; extra: SpecField | null } {
  const model = findModel(schema, resource.model)!
  const choice = resource.key?.value ?? { kind: 'generated', type: 'integer' }
  const param = keyParam(resource)
  if (choice.kind === 'field') {
    const field = allFields(schema, model).find((item) => item.name === choice.field)
    // A key is a whole number even where the language has a single number type (TypeScript's `number`)
    const declared = field && field.type.kind === 'primitive' ? field.type : null
    const type = !declared
      ? scalar('string')
      : declared.name === 'float' && !declared.bits
        ? scalar('integer')
        : scalar(declared.name, declared.bits)
    const access = resource.fields.find((item) => item.field === choice.field)?.access.value
    const generated = access === 'readOnly' ? (type.scalar === 'integer' ? 'increment' : 'uuid') : null
    return { key: { field: choice.field, type, generated, param }, extra: null }
  }
  const used = new Set(allFields(schema, model).map((field) => field.name))
  const name = uniqueName('id', used)
  const type = choice.type === 'uuid' ? scalar('uuid') : scalar('integer', 64)
  const extra: SpecField = {
    name,
    wire: name,
    type,
    required: false,
    nullable: false,
    access: 'readOnly',
    constraints: {},
    server: 'key',
  }
  return { key: { field: name, type, generated: choice.type === 'uuid' ? 'uuid' : 'increment', param }, extra }
}

/** The API type of a model type, following the relation decision of the field. */
function resolveType(type: TypeRef, field: FieldDef, resource: ResourceDesign, context: Context): SpecType {
  switch (type.kind) {
    case 'primitive':
      return scalar(type.name, type.bits)
    case 'enum':
      return { kind: 'enum', name: type.name }
    case 'unknown': {
      const choice = resource.fields.find((item) => item.field === field.name)?.unknownType?.value ?? 'any'
      return scalar(choice === 'string' ? 'string' : 'any')
    }
    case 'array':
      return { kind: 'array', items: resolveType(type.items, field, resource, context) }
    case 'map':
      return { kind: 'map', value: resolveType(type.value, field, resource, context) }
    case 'model': {
      const relation = resource.fields.find((item) => item.field === field.name)?.relation?.value
      const key = context.keys.get(type.name)
      if (relation === 'reference' && key) return key.type
      return { kind: 'object', name: objectFor(type.name, context) }
    }
  }
}

/** The object schema of a model embedded in others; created once per model. */
function objectFor(model: string, context: Context): string {
  const existing = context.objects.get(model)
  if (existing) return existing.name
  const target = resourceOf(context.design, model)!
  const name = target.expose.value === 'resource' ? `${model}Object` : model
  const object: SpecObject = { name, fields: [] }
  context.objects.set(model, object)
  const definition = findModel(context.schema, model)
  if (definition?.description) object.description = definition.description
  object.fields = resolveFields(target, context, null).filter((field) => field.access !== 'writeOnly' || target.expose.value !== 'resource')
  return name
}

function todoOf(resource: ResourceDesign, field: string): string | undefined {
  const design = resource.fields.find((item) => item.field === field)
  if (!design) return undefined
  if (design.unknownType?.status === 'pending')
    return `Decide the type of "${field}": the input does not define it, so it accepts any JSON value.`
  if (design.relation?.status === 'pending') return `Decide whether "${field}" holds the key of the related item or the whole item.`
  if (design.access.status === 'pending') return `Decide whether clients may send or read "${field}".`
  return undefined
}

/** The fields of a model as the API sees them, the key first. */
function resolveFields(resource: ResourceDesign, context: Context, key: SpecKey | null): SpecField[] {
  const model = findModel(context.schema, resource.model)!
  const used = new Set<string>()
  const fields: SpecField[] = []
  for (const field of allFields(context.schema, model)) {
    const design = resource.fields.find((item) => item.field === field.name)
    if (design && !design.include) continue
    const access = design?.access.value ?? 'readWrite'
    const target = modelTarget(field.type)
    const isReference = design?.relation?.value === 'reference' && target !== null && context.keys.has(target.model)
    const declared = field.serializedName ?? field.name
    let wire = isReference ? referenceWire(declared, target!.many) : declared
    // A field already named like the reference (`customer` next to `customerId`) keeps its own name
    if (isReference && allFields(context.schema, model).some((other) => other.name === wire)) wire = declared
    const spec: SpecField = {
      name: field.name,
      wire: uniqueName(wire, used),
      type: resolveType(field.type, field, resource, context),
      required: !field.optional && !field.nullable && field.defaultValue === undefined,
      nullable: field.nullable,
      access,
      constraints: readConstraints(field, context.schema.origin?.language).constraints,
    }
    if (field.defaultValue !== undefined) spec.defaultValue = field.defaultValue
    if (isReference) spec.reference = target!.model
    // The first item of a tree has no parent: a single reference to its own model is never required
    if (isReference && !target!.many && target!.model === resource.model) {
      spec.required = false
      spec.nullable = true
    }
    if (key?.field === field.name) {
      // The key is always in a response, and keeps the type resolved for the key
      spec.nullable = false
      spec.type = key.type
    }
    if (field.description) spec.description = field.description
    if (access === 'readOnly') {
      const audit = field.type.kind === 'primitive' && ['date', 'datetime'].includes(field.type.name) ? auditKind(field.name) : null
      spec.server = key?.field === field.name ? 'key' : audit ? audit : field.defaultValue !== undefined ? 'default' : 'pending'
      // Nothing fills it yet: it can be empty in responses until the developer does
      if (spec.server === 'pending') spec.nullable = true
    }
    const todo = todoOf(resource, field.name)
    if (todo) spec.todo = todo
    else if (spec.server === 'pending') spec.todo = `Fill "${field.name}" on the server: clients cannot send it.`
    fields.push(spec)
  }
  return fields
}

function resolveEndpoints(
  resource: ResourceDesign,
  key: SpecKey,
  fields: SpecField[],
  settings: ProjectSettings,
  blocked: Set<string>,
): SpecEndpoint[] {
  const wireOf = (name: string) => fields.find((field) => field.name === name)?.wire ?? name
  return resource.endpoints
    .filter((endpoint) => endpoint.enabled && !blocked.has(endpoint.id))
    .map((endpoint): SpecEndpoint => {
      const io =
        endpoint.operation === 'custom'
          ? { input: endpoint.input ?? 'none', output: endpoint.output ?? 'resource' }
          : STANDARD_IO[endpoint.operation]
      const access =
        settings.auth === 'none'
          ? 'public'
          : endpoint.access === 'default'
            ? settings.defaultAccess
            : endpoint.access === 'roles' && settings.auth === 'apiKey'
              ? 'authenticated'
              : endpoint.access
      return {
        id: endpoint.id,
        operation: endpoint.operation,
        method: endpoint.method,
        path: endpoint.path,
        name: endpoint.name,
        summary: endpoint.summary,
        access,
        roles: access === 'roles' ? endpoint.roles : [],
        status: endpoint.status ?? defaultStatus(endpoint.operation, io.output),
        pathParams: pathParams(endpoint.path).map((name) => ({ name, type: name === key.param ? key.type : scalar('string') })),
        pagination: endpoint.operation === 'list' && endpoint.pagination === true,
        filters: endpoint.operation === 'list' ? (endpoint.filters ?? []).map(wireOf) : [],
        sort: endpoint.operation === 'list' ? (endpoint.sort ?? []).map(wireOf) : [],
        input: io.input,
        output: io.output,
      }
    })
}

/**
 * Resolves the API of a design.
 *
 * @param schema The models as the importer read them.
 * @param design The reviewed design.
 * @param settings The project settings (authentication and title).
 * @returns The resolved API, with the issues of the design and without the endpoints they block.
 */
export function resolveApi(schema: ModelSchema, design: ApiDesign, settings: ProjectSettings): ApiSpec {
  const issues = validateDesign(design, schema, settings)
  const blocked = blockedEndpoints(issues)
  const context: Context = { schema, design, objects: new Map(), keys: new Map() }
  const resourceDesigns = design.resources.filter((item) => item.expose.value === 'resource' && findModel(schema, item.model))

  // Keys first: a reference to a resource takes the type of its key
  const extras = new Map<string, SpecField | null>()
  for (const resource of resourceDesigns) {
    const { key, extra } = resolveKey(resource, schema)
    context.keys.set(resource.model, key)
    extras.set(resource.model, extra)
  }

  const resources = resourceDesigns.map((resource): SpecResource => {
    const key = context.keys.get(resource.model)!
    const extra = extras.get(resource.model)
    const fields = [...(extra ? [extra] : []), ...resolveFields(resource, context, key)]
    // The key goes first in every schema
    fields.sort((a, b) => Number(b.name === key.field) - Number(a.name === key.field))
    const words = nameWords(resource.model)
    const spec: SpecResource = {
      name: resource.model,
      singular: words.join(' '),
      plural: defaultResourcePath(resource.model).replace(/-/g, ' '),
      path: resource.path ?? defaultResourcePath(resource.model),
      key,
      fields,
      endpoints: resolveEndpoints(resource, key, fields, settings, blocked),
    }
    const description = findModel(schema, resource.model)?.description
    if (description) spec.description = description
    if (resource.key?.status === 'pending') {
      spec.todo =
        resource.key.value.kind === 'generated'
          ? `Decide the key of ${resource.model}: the input declares none, so the server assigns a generated "${key.field}".`
          : `Decide the key of ${resource.model}.`
    }
    return spec
  })

  const enums = schema.enums.map((item) => {
    const values = item.values.map((value) => value.value ?? value.name)
    return { name: item.name, values, valueType: values.every((value) => typeof value === 'number') ? 'integer' : 'string' } as SpecEnum
  })
  const roles = [...new Set(resources.flatMap((resource) => resource.endpoints.flatMap((endpoint) => endpoint.roles)))].sort()
  return {
    title: settings.name,
    resources,
    objects: [...context.objects.values()],
    enums,
    auth: settings.auth,
    roles,
    issues,
  }
}
