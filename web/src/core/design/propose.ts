/**
 * Proposes an API design for a model schema: which models become resources, their keys, how related
 * models travel, what the client may send or read of each field, and the standard endpoints of each
 * resource. Every proposal carries its confidence and its reasons.
 *
 * Given the previous design, the proposal keeps every choice the user made where it still applies, so
 * editing the input or one decision never throws the rest of the review away (see `reconcile`).
 */
import { auditKind, analyzeModels, isSecretName, modelTarget, type ModelFacts } from '../analysis/models.ts'
import { nameWords, pluralize, toPascalCase } from '../model/naming.ts'
import { allFields, findModel, type FieldDef, type ModelDef, type ModelSchema, type TypeRef } from '../model/schema.ts'
import {
  CRUD_OPERATIONS,
  decision,
  reason,
  sameValue,
  type AccessChoice,
  type ApiDesign,
  type Decision,
  type Endpoint,
  type ExposeChoice,
  type FieldDesign,
  type HttpMethod,
  type KeyChoice,
  type RelationChoice,
  type ResourceDesign,
  type UnknownTypeChoice,
} from '../api/types.ts'

/** Keeps a decision the user made if the fresh proposal still offers that value. */
function keep<T>(fresh: Decision<T>, old: Decision<T> | undefined): Decision<T> {
  if (!old?.manual) return fresh
  return fresh.options.some((option) => sameValue(option, old.value))
    ? { ...fresh, value: old.value, status: 'active', manual: true }
    : fresh
}

function proposeExpose(facts: ModelFacts): Decision<ExposeChoice> {
  const options: ExposeChoice[] = ['resource', 'embedded']
  if (facts.declaredEntity) return decision<ExposeChoice>('resource', 'exact', [reason('entityDeclared')], options)
  const key = facts.declaredKey ?? facts.namedKey
  if (key) return decision<ExposeChoice>('resource', 'high', [reason('hasKey', { field: key })], options)
  const owner = facts.referencedBy[0]
  if (owner) return decision<ExposeChoice>('embedded', 'probable', [reason('valueObject', { model: owner.model })], options)
  return decision<ExposeChoice>('resource', 'probable', [reason('standalone')], options)
}

function proposeKey(facts: ModelFacts): Decision<KeyChoice> {
  const generated: KeyChoice[] = [
    { kind: 'generated', type: 'integer' },
    { kind: 'generated', type: 'uuid' },
  ]
  const options: KeyChoice[] = [...facts.keyCandidates.map((field): KeyChoice => ({ kind: 'field', field })), ...generated]
  if (facts.declaredKey) {
    const choice: KeyChoice = { kind: 'field', field: facts.declaredKey }
    return decision(choice, 'exact', [reason('keyDeclared', { field: facts.declaredKey })], withOption(options, choice))
  }
  if (facts.namedKey) {
    const choice: KeyChoice = { kind: 'field', field: facts.namedKey }
    return decision(choice, 'high', [reason('keyNamed', { field: facts.namedKey })], withOption(options, choice))
  }
  const reasons = [reason('keyMissing')]
  if (facts.keyCandidates.length > 0) reasons.push(reason('keyCandidates', { fields: facts.keyCandidates.join(', ') }))
  return decision<KeyChoice>(generated[0], 'review', reasons, options)
}

function withOption<T>(options: T[], value: T): T[] {
  return options.some((option) => sameValue(option, value)) ? options : [value, ...options]
}

/** The key field of a resource, when its key is one of its fields. */
export function keyField(resource: ResourceDesign | undefined): string | null {
  return resource?.expose.value === 'resource' && resource.key?.value.kind === 'field' ? resource.key.value.field : null
}

function proposeAccess(field: FieldDef, isKey: boolean, facts: ModelFacts): Decision<AccessChoice> {
  const options: AccessChoice[] = ['readWrite', 'readOnly', 'writeOnly']
  if (isKey) {
    if (facts.declaredKey === field.name && facts.declaredKeyGenerated)
      return decision<AccessChoice>('readOnly', 'exact', [reason('keyGenerated')], options)
    if (field.name.toLowerCase() === 'id') return decision<AccessChoice>('readOnly', 'probable', [reason('keyGenerated')], options)
    return decision<AccessChoice>('readWrite', 'probable', [reason('keyFromClient')], options)
  }
  if (field.generated) return decision<AccessChoice>('readOnly', 'exact', [reason('generatedValue')], options)
  if (isSecretName(field.name)) return decision<AccessChoice>('writeOnly', 'probable', [reason('secretNamed')], options)
  const temporal = field.type.kind === 'primitive' && (field.type.name === 'datetime' || field.type.name === 'date')
  if (temporal && auditKind(field.name)) return decision<AccessChoice>('readOnly', 'probable', [reason('auditNamed')], options)
  return decision<AccessChoice>('readWrite', 'high', [reason('plainField')], options)
}

function proposeRelation(
  model: ModelDef,
  target: { model: string; many: boolean },
  exposeOf: (model: string) => ExposeChoice | undefined,
): Decision<RelationChoice> {
  if (exposeOf(target.model) !== 'resource') {
    return decision<RelationChoice>('embedded', 'exact', [reason('targetIsValue', { model: target.model })], ['embedded'])
  }
  const options: RelationChoice[] = ['reference', 'embedded']
  if (target.model === model.name) return decision<RelationChoice>('reference', 'high', [reason('selfReference')], options)
  if (target.many) return decision<RelationChoice>('reference', 'probable', [reason('listOfResources', { model: target.model })], options)
  return decision<RelationChoice>('reference', 'high', [reason('targetIsResource', { model: target.model })], options)
}

/** The type name a field leaves undefined, directly or as the items of a list. */
function unknownName(type: TypeRef): string | null {
  if (type.kind === 'unknown') return type.name
  if (type.kind === 'array') return unknownName(type.items)
  if (type.kind === 'map') return unknownName(type.value)
  return null
}

/** Words of a model name, for paths and summaries: `OrderLine` → `order line`. */
function words(model: string): string[] {
  return nameWords(model)
}

/** Default first segment of the paths of a resource: `OrderLine` → `order-lines`. */
export function defaultResourcePath(model: string): string {
  const parts = words(model)
  if (parts.length === 0) return model.toLowerCase()
  parts[parts.length - 1] = pluralize(parts[parts.length - 1])
  return parts.join('-')
}

/** Name of the path parameter that identifies one item: the key field, or `id` for a generated key. */
export function keyParam(resource: ResourceDesign): string {
  return keyField(resource) ?? 'id'
}

function article(text: string): string {
  return /^[aeiou]/i.test(text) ? `an ${text}` : `a ${text}`
}

/** The standard endpoint of an operation, with its derived method, path, name and summary. */
export function standardEndpoint(resource: ResourceDesign, operation: (typeof CRUD_OPERATIONS)[number]): Endpoint {
  const base = `/${resource.path ?? defaultResourcePath(resource.model)}`
  const item = `${base}/{${keyParam(resource)}}`
  const singular = words(resource.model).join(' ')
  const plural = defaultResourcePath(resource.model).replace(/-/g, ' ')
  const pascal = toPascalCase(resource.model)
  const pluralPascal = toPascalCase(plural)
  const shapes: Record<(typeof CRUD_OPERATIONS)[number], { method: HttpMethod; path: string; name: string; summary: string }> = {
    list: { method: 'GET', path: base, name: `list${pluralPascal}`, summary: `List ${plural}` },
    get: { method: 'GET', path: item, name: `get${pascal}`, summary: `Get ${article(singular)}` },
    create: { method: 'POST', path: base, name: `create${pascal}`, summary: `Create ${article(singular)}` },
    replace: { method: 'PUT', path: item, name: `replace${pascal}`, summary: `Replace ${article(singular)}` },
    update: { method: 'PATCH', path: item, name: `update${pascal}`, summary: `Update part of ${article(singular)}` },
    delete: { method: 'DELETE', path: item, name: `delete${pascal}`, summary: `Delete ${article(singular)}` },
  }
  const shape = shapes[operation]
  const endpoint: Endpoint = { id: `${resource.model}.${operation}`, operation, enabled: true, ...shape, access: 'default', roles: [] }
  if (operation === 'list') return { ...endpoint, pagination: true, filters: [], sort: [] }
  return endpoint
}

/** The endpoints of a resource: the previous ones where the user changed them, fresh ones otherwise.
 * A standard endpoint whose path the user did not write follows a new key or resource path. */
function proposeEndpoints(resource: ResourceDesign, previous: ResourceDesign | undefined): Endpoint[] {
  const fresh = CRUD_OPERATIONS.map((operation) => standardEndpoint(resource, operation))
  if (!previous || previous.expose.value !== 'resource') return fresh
  const kept = previous.endpoints.map((old) => {
    if (old.operation === 'custom' || old.pathEdited) return old
    return { ...old, path: fresh.find((item) => item.operation === old.operation)!.path }
  })
  // A standard operation missing from the previous design (an older project file) is added back
  for (const endpoint of fresh) if (!kept.some((old) => old.id === endpoint.id)) kept.push(endpoint)
  return kept
}

/**
 * Proposes the API design of a schema.
 *
 * @param schema The models as the importer read them.
 * @param previous The current design, whose manual choices and endpoint edits are kept where they apply.
 * @returns A new design; the previous one is not modified.
 */
export function proposeDesign(schema: ModelSchema, previous: ApiDesign | null = null): ApiDesign {
  const facts = analyzeModels(schema)
  const previousOf = (model: string) => previous?.resources.find((item) => item.model === model)

  // Exposure first: relations depend on whether their target is a resource
  const expose = new Map<string, Decision<ExposeChoice>>()
  for (const model of schema.models) expose.set(model.name, keep(proposeExpose(facts.get(model.name)!), previousOf(model.name)?.expose))
  const exposeOf = (model: string) => expose.get(model)?.value

  const resources = schema.models.map((model): ResourceDesign => {
    const modelFacts = facts.get(model.name)!
    const old = previousOf(model.name)
    const exposed = expose.get(model.name)!
    const key = exposed.value === 'resource' ? keep(proposeKey(modelFacts), old?.key) : undefined
    const keyName = key?.value.kind === 'field' ? key.value.field : null
    const fields = allFields(schema, model).map((field): FieldDesign => {
      const was = old?.fields.find((item) => item.field === field.name)
      const design: FieldDesign = {
        field: field.name,
        include: was?.include ?? true,
        access: keep(proposeAccess(field, field.name === keyName, modelFacts), was?.access),
      }
      const target = modelTarget(field.type)
      if (target && findModel(schema, target.model)) design.relation = keep(proposeRelation(model, target, exposeOf), was?.relation)
      const unknown = unknownName(field.type)
      if (unknown) {
        const fresh = decision<UnknownTypeChoice>('any', 'review', [reason('unknownType', { type: unknown })], ['any', 'string'])
        design.unknownType = keep(fresh, was?.unknownType)
      }
      // The key always travels: it can never be left out
      if (field.name === keyName) design.include = true
      return design
    })
    const resource: ResourceDesign = { model: model.name, expose: exposed, fields, endpoints: [] }
    if (key) resource.key = key
    if (old?.path) resource.path = old.path
    resource.endpoints = exposed.value === 'resource' ? proposeEndpoints(resource, old) : []
    return resource
  })
  return { resources }
}

/** The same proposal with the user's choices kept: used whenever the input or a decision changes. */
export function reconcile(previous: ApiDesign | null, schema: ModelSchema): ApiDesign {
  return proposeDesign(schema, previous)
}
