/**
 * Services and routes of the Axum project.
 *
 * The service of a resource holds its rules: items that must exist, keys that must not repeat, references that
 * must point to stored items, and the values the server fills. Business endpoints get a method that answers 501
 * where their logic goes. Presence, null and the declared validations are checked on the request body itself
 * (common/body.rs).
 *
 * The routes only translate HTTP to service calls: parameters, bodies, status codes and protection.
 */
import type { SpecEndpoint, SpecField, SpecResource } from '../../../api/spec.ts'
import { PAGE_SIZE, shapeFields } from '../../../openapi/build.ts'
import { innerObject, referencedResources } from '../../common/references.ts'
import type { JsonValue } from '../../common/samples.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { RsUses, rsDoc, rsHeader, rsName, rsPascal, rsString, rsType, rsTypeOf } from '../../languages/rust/rust.ts'
import { field as fieldName, keyField, keyType, modulePath, names, typeNames, type AxumContext } from './context.ts'
import { filterFields } from './persistence.ts'

/** The method of a service, and the handler, of an endpoint: `list_customers`. */
export function endpointFunction(endpoint: SpecEndpoint): string {
  return rsName(endpoint.name)
}

/** A default value written in Rust for the field's type, inside `Some`. */
function rsDefault(context: AxumContext, field: SpecField, uses: RsUses): string {
  const value = field.defaultValue
  if (value === null || value === undefined) return 'None'
  const type = field.type
  if (type.kind === 'enum') {
    uses.add(typeNames(context).shared(type.name))
    const item = context.spec.enums.find((entry) => entry.name === type.name)!
    const used = new Set<string>()
    const variants = item.values.map((entry) => {
      let base = rsPascal(String(entry))
      if (base.startsWith('_')) base = `Value${base.slice(1)}`
      let variant = base
      for (let n = 2; used.has(variant); n++) variant = `${base}${n}`
      used.add(variant)
      return variant
    })
    return `Some(${rsType(type.name)}::${variants[item.values.indexOf(value as string | number)]})`
  }
  if (type.kind === 'scalar') {
    switch (type.scalar) {
      case 'integer':
        return `Some(${value})`
      case 'float':
        return `Some(${Number.isInteger(value) ? `${value}.0` : value})`
      case 'decimal':
        uses.add('std::str::FromStr', 'rust_decimal::Decimal')
        return `Decimal::from_str(${rsString(String(value))}).ok()`
      case 'boolean':
        return `Some(${value})`
      case 'date':
        uses.add('chrono::NaiveDate')
        return `NaiveDate::parse_from_str(${rsString(String(value))}, "%Y-%m-%d").ok()`
      case 'datetime':
        uses.add('chrono::{DateTime, Utc}')
        return `DateTime::parse_from_rfc3339(${rsString(String(value))}).ok().map(|value| value.with_timezone(&Utc))`
      case 'uuid':
        uses.add('uuid::Uuid')
        return `Uuid::parse_str(${rsString(String(value))}).ok()`
      case 'any':
        break
      default:
        return `Some(${rsString(String(value))}.to_string())`
    }
  }
  // Lists, maps, objects and values of any shape: written in JSON
  const rustType = rsTypeOf(type, uses, typeNames(context))
  return `serde_json::from_str::<${rustType}>(${rsString(JSON.stringify(value as JsonValue))}).ok()`
}

/** The value the server gives a read-only field, or null when it gives none in this operation. */
function serverValue(context: AxumContext, field: SpecField, operation: 'create' | 'replace' | 'update', uses: RsUses): string | null {
  if (field.access !== 'readOnly' || field.server === 'key') return null
  const now = () => {
    uses.add('crate::common::clock')
    if (field.type.kind === 'scalar' && field.type.scalar === 'date') return 'Some(clock::today())'
    if (field.type.kind === 'scalar' && field.type.scalar === 'datetime') return 'Some(clock::now())'
    return 'Some(clock::text())'
  }
  if (field.server === 'updated') return now()
  if (operation !== 'create') return null
  if (field.server === 'created') return now()
  if (field.server === 'default') return rsDefault(context, field, uses)
  return null
}

/** Rust statements that check every reference of an item, nested objects included. */
function referenceChecks(
  context: AxumContext,
  resource: SpecResource,
  fields: SpecField[],
  source: string,
  label: string,
  depth: number,
  counter: { next: number },
): string[] {
  const checks: string[] = []
  for (const field of fields) {
    const value = `${source}.${fieldName(field)}`
    const where = label ? `${label}.${field.wire}` : field.wire
    if (field.reference) {
      const target = context.spec.resources.find((item) => item.name === field.reference)!
      const repository = field.reference === resource.name ? 'self.repository' : `self.${names(target).one}_repository`
      const variable = `reference${counter.next++}`
      const failure = `return Err(ApiError::invalid(${rsString(where)}, ${rsString(`No ${field.reference} has this key`)}));`
      if (field.type.kind === 'array')
        checks.push(
          `for ${variable} in ${value}.iter().flatten() {`,
          `    if ${repository}.get(${variable}.clone()).await?.is_none() {`,
          `        ${failure}`,
          '    }',
          '}',
        )
      else
        checks.push(
          `if let Some(${variable}) = &${value}`,
          `    && ${repository}.get(${variable}.clone()).await?.is_none()`,
          '{',
          `    ${failure}`,
          '}',
        )
      continue
    }
    const inner = innerObject(field.type)
    const object = inner ? context.spec.objects.find((item) => item.name === inner) : undefined
    if (!object || depth > 3 || field.type.kind === 'map') continue
    const variable = `item${depth}`
    const nested = referenceChecks(context, resource, object.fields, variable, where, depth + 1, counter)
    if (nested.length === 0) continue
    if (field.type.kind === 'array')
      checks.push(`for ${variable} in ${value}.iter().flatten() {`, ...nested.map((line) => `    ${line}`), '}')
    else if (field.type.kind === 'object')
      checks.push(`if let Some(${variable}) = &${value} {`, ...nested.map((line) => `    ${line}`), '}')
  }
  return checks
}

export function serviceFile(context: AxumContext, resource: SpecResource): GeneratedFile {
  const name = names(resource)
  const dto = `crate::${context.layout.resource(resource, 'dto')}`
  const uses = new RsUses().add(
    'std::sync::Arc',
    'crate::common::error::ApiError',
    `crate::${context.layout.resource(resource, 'model')}::${name.type}`,
  )
  const key = keyType(resource)
  if (key === 'Uuid') uses.add('uuid::Uuid')
  const keyName = fieldName(keyField(resource))
  const keyWire = keyField(resource).wire
  const needs = referencedResources(context, resource)
  const repositories = [
    `crate::${context.layout.resource(resource, 'repository')}::${name.repository}`,
    ...needs.map((item) => `crate::${context.layout.resource(item, 'repository')}::${names(item).repository}`),
  ]
  uses.add(...repositories)
  const checks = referenceChecks(context, resource, resource.fields, 'item', '', 0, { next: 0 })
  const clientKey = resource.key.generated === null
  const operations = new Set(resource.endpoints.map((endpoint) => endpoint.operation))
  const customWithKey = resource.endpoints.some(
    (endpoint) => endpoint.operation === 'custom' && endpoint.pathParams.some((param) => param.name === resource.key.param),
  )
  const usesFind =
    ['get', 'replace', 'update', 'delete'].some((operation) => operations.has(operation as SpecEndpoint['operation'])) || customWithKey
  const usesApply = operations.has('create') || operations.has('replace')
  const usesChanges = operations.has('update')
  const usesChecks = checks.length > 0 && (usesApply || usesChanges)
  const methods: string[] = []
  if (usesFind)
    methods.push(
      lines(
        `    async fn find(&self, key: ${key}) -> Result<${name.type}, ApiError> {`,
        `        self.repository.get(key).await?.ok_or_else(|| ApiError::not_found(${rsString(resource.singular)}))`,
        '    }',
      ),
    )
  if (usesChecks)
    methods.push(
      lines(
        '    /// Every reference must point to a stored item.',
        `    async fn check_references(&self, item: &${name.type}) -> Result<(), ApiError> {`,
        checks.map((line) => `        ${line}`),
        '        Ok(())',
        '    }',
      ),
    )
  if (usesApply || usesChanges) uses.add('crate::common::body::Body')
  if (usesApply) {
    uses.add(`${dto}::${name.create}`)
    methods.push(
      lines(
        '    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.',
        `    fn apply(item: &mut ${name.type}, body: &Body<${name.create}>) {`,
        '        let data = &body.value;',
        shapeFields(resource.fields, 'create')
          .filter((field) => field.name !== resource.key.field || clientKey)
          .map((field) => {
            const prop = fieldName(field)
            if (field.name === resource.key.field) return `        item.${prop} = data.${prop}.clone().unwrap_or_default();`
            if (field.defaultValue !== undefined)
              return `        item.${prop} = if body.has(${rsString(field.wire)}) { data.${prop}.clone() } else { ${rsDefault(context, field, uses)} };`
            return `        item.${prop} = data.${prop}.clone();`
          }),
        '    }',
      ),
    )
  }
  if (usesChanges) {
    uses.add(`${dto}::${name.update}`)
    methods.push(
      lines(
        '    /// Sets the fields a partial change carries; the others stay as they are.',
        `    fn apply_changes(item: &mut ${name.type}, body: &Body<${name.update}>) {`,
        '        let data = &body.value;',
        shapeFields(resource.fields, 'update')
          .filter((field) => field.name !== resource.key.field)
          .map((field) => [
            `        if body.has(${rsString(field.wire)}) {`,
            `            item.${fieldName(field)} = data.${fieldName(field)}.clone();`,
            '        }',
          ]),
        '    }',
      ),
    )
  }
  const server = (operation: 'create' | 'replace' | 'update') =>
    resource.fields.flatMap((field) => {
      const value = serverValue(context, field, operation, uses)
      if (value !== null) return [`        item.${fieldName(field)} = ${value};`]
      if (operation === 'create' && field.access === 'readOnly' && field.server === 'pending')
        return [`        // TODO: ${field.todo ?? `fill "${field.name}"`}`]
      return []
    })
  const check = usesChecks && '        self.check_references(&item).await?;'
  for (const endpoint of resource.endpoints) {
    const fn = endpointFunction(endpoint)
    const doc = `    /// ${endpoint.summary}.`
    switch (endpoint.operation) {
      case 'list':
        uses.add(
          'crate::common::list::{ListQuery, ListResult}',
          `crate::${context.layout.resource(resource, 'repository')}::${name.filters}`,
        )
        methods.push(
          lines(
            doc,
            `    pub async fn ${fn}(&self, query: ListQuery<${name.filters}>) -> Result<ListResult<${name.type}>, ApiError> {`,
            '        self.repository.list(&query).await',
            '    }',
          ),
        )
        break
      case 'get':
        methods.push(
          lines(
            doc,
            `    pub async fn ${fn}(&self, key: ${key}) -> Result<${name.type}, ApiError> {`,
            '        self.find(key).await',
            '    }',
          ),
        )
        break
      case 'create':
        methods.push(
          lines(
            doc,
            `    pub async fn ${fn}(&self, body: Body<${name.create}>) -> Result<${name.type}, ApiError> {`,
            `        let mut item = ${name.type}::default();`,
            '        Self::apply(&mut item, &body);',
            clientKey && [
              `        if self.repository.get(item.${keyName}.clone()).await?.is_some() {`,
              `            return Err(ApiError::conflict(${rsString(`A ${resource.singular} with this key already exists`)}));`,
              '        }',
            ],
            check,
            server('create'),
            '        self.repository.add(item).await',
            '    }',
          ),
        )
        break
      case 'replace':
        methods.push(
          lines(
            `    /// ${endpoint.summary}: every field the client may send takes the value of the body.`,
            `    pub async fn ${fn}(&self, key: ${key}, body: Body<${name.create}>) -> Result<${name.type}, ApiError> {`,
            clientKey && [
              `        if body.value.${keyName}.as_ref() != Some(&key) {`,
              `            return Err(ApiError::invalid(${rsString(keyWire)}, "The key cannot change"));`,
              '        }',
            ],
            '        let mut item = self.find(key).await?;',
            '        Self::apply(&mut item, &body);',
            check,
            server('replace'),
            '        self.repository.update(item).await',
            '    }',
          ),
        )
        break
      case 'update': {
        const changesKey = clientKey && keyField(resource).access !== 'readOnly'
        methods.push(
          lines(
            `    /// ${endpoint.summary}: only the fields in the body change.`,
            `    pub async fn ${fn}(&self, key: ${key}, body: Body<${name.update}>) -> Result<${name.type}, ApiError> {`,
            changesKey && [
              `        if body.has(${rsString(keyWire)}) && body.value.${keyName}.as_ref() != Some(&key) {`,
              `            return Err(ApiError::invalid(${rsString(keyWire)}, "The key cannot change"));`,
              '        }',
            ],
            '        let mut item = self.find(key).await?;',
            '        Self::apply_changes(&mut item, &body);',
            check,
            server('update'),
            '        self.repository.update(item).await',
            '    }',
          ),
        )
        break
      }
      case 'delete':
        methods.push(
          lines(
            doc,
            `    pub async fn ${fn}(&self, key: ${key}) -> Result<(), ApiError> {`,
            '        self.find(key.clone()).await?;',
            '        self.repository.delete(key).await',
            '    }',
          ),
        )
        break
      case 'custom': {
        const hasKey = endpoint.pathParams.some((param) => param.name === resource.key.param)
        const bodyClass = endpoint.input === 'resource' ? name.create : endpoint.input === 'partial' ? name.update : null
        if (bodyClass) uses.add(`${dto}::${bodyClass}`, 'crate::common::body::Body')
        const params = ['&self', hasKey ? `key: ${key}` : null, bodyClass ? `_body: Body<${bodyClass}>` : null].filter(Boolean)
        const returns = endpoint.output === 'none' ? '()' : endpoint.output === 'list' ? `Vec<${name.type}>` : name.type
        methods.push(
          lines(
            doc,
            `    pub async fn ${fn}(${params.join(', ')}) -> Result<${returns}, ApiError> {`,
            hasKey && '        self.find(key).await?;',
            `        // TODO: write the logic of "${endpoint.summary}" (${endpoint.method} ${endpoint.path}).`,
            `        Err(ApiError::not_implemented(${rsString(`${endpoint.summary} is not written yet`)}))`,
            '    }',
          ),
        )
        break
      }
    }
  }
  const fields = [
    `    repository: Arc<dyn ${name.repository}>,`,
    ...needs.map((item) => `    ${names(item).one}_repository: Arc<dyn ${names(item).repository}>,`),
  ]
  const parameters = [
    `repository: Arc<dyn ${name.repository}>`,
    ...needs.map((item) => `${names(item).one}_repository: Arc<dyn ${names(item).repository}>`),
  ]
  const content = lines(
    ...rsHeader(`Rules of ${resource.plural}: what each operation checks and changes.`, uses),
    rsDoc(`Rules of ${resource.plural}.`),
    `pub struct ${name.service} {`,
    fields,
    '}',
    '',
    `impl ${name.service} {`,
    `    pub fn new(${parameters.join(', ')}) -> Self {`,
    `        Self { ${['repository', ...needs.map((item) => `${names(item).one}_repository`)].join(', ')} }`,
    '    }',
    '',
    methods.join('\n\n'),
    '}',
  )
  return { path: modulePath(context.layout.resource(resource, 'service')), content: fileText(content) }
}

/** The expression that reads a filter of the query string with the type of its field. */
function filterRead(context: AxumContext, field: SpecField, uses: RsUses): string {
  const wire = rsString(field.wire)
  const helper = (fn: string) => {
    uses.add(`crate::common::query::${fn}`)
    return fn
  }
  if (field.reference) {
    const target = context.spec.resources.find((item) => item.name === field.reference)!
    const key = keyType(target)
    if (key === 'i64') return `filter(&query, ${wire}, |text| text.parse().ok())?`
    if (key === 'Uuid') return `filter(&query, ${wire}, ${helper('parse_uuid')})?`
    return `filter(&query, ${wire}, |text| Some(text.to_string()))?`
  }
  const type = field.type
  if (type.kind === 'enum') {
    const item = context.spec.enums.find((entry) => entry.name === type.name)!
    uses.add(typeNames(context).shared(type.name))
    const enumType = rsType(type.name)
    return item.valueType === 'integer'
      ? `filter(&query, ${wire}, |text| text.parse().ok().and_then(${enumType}::from_value))?`
      : `filter(&query, ${wire}, ${enumType}::from_value)?`
  }
  if (type.kind === 'scalar') {
    switch (type.scalar) {
      case 'integer':
      case 'float':
      case 'decimal':
        return `filter(&query, ${wire}, |text| text.parse().ok())?`
      case 'boolean':
        return `filter(&query, ${wire}, |text| match text { "true" => Some(true), "false" => Some(false), _ => None })?`
      case 'date':
        return `filter(&query, ${wire}, ${helper('parse_date')})?`
      case 'datetime':
        return `filter(&query, ${wire}, ${helper('parse_date_time')})?`
      case 'uuid':
        return `filter(&query, ${wire}, ${helper('parse_uuid')})?`
    }
  }
  return `filter(&query, ${wire}, |text| Some(text.to_string()))?`
}

export function routesFile(context: AxumContext, resource: SpecResource): GeneratedFile {
  const name = names(resource)
  const dto = `crate::${context.layout.resource(resource, 'dto')}`
  const uses = new RsUses().add(
    'axum::Router',
    'axum::extract::State',
    'axum::response::IntoResponse',
    'crate::AppState',
    'crate::common::error::{ApiError, status}',
    `${dto}::${name.response}`,
  )
  const keyRead = () => {
    const fn = resource.key.type.scalar === 'integer' ? 'long_key' : resource.key.type.scalar === 'uuid' ? 'uuid_key' : 'text_key'
    uses.add(`crate::common::query::${fn}`)
    return `let key = ${fn}(&params, ${rsString(resource.key.param)})?;`
  }
  const filterStruct = filterFields(resource)
  const handlers = resource.endpoints.map((endpoint) => {
    const fn = endpointFunction(endpoint)
    const params: string[] = ['State(state): State<AppState>']
    const body: string[] = []
    const protectedRoute = context.security && endpoint.access !== 'public'
    if (protectedRoute) {
      uses.add('crate::security::Authenticated')
      if (endpoint.access === 'roles' && context.settings.auth === 'jwt') {
        params.push('auth: Authenticated')
        body.push(`auth.require_roles(&[${endpoint.roles.map(rsString).join(', ')}])?;`)
      } else params.push('_auth: Authenticated')
    }
    const hasKey = endpoint.pathParams.some((param) => param.name === resource.key.param)
    if (endpoint.pathParams.length > 0) {
      uses.add('axum::extract::Path', 'crate::common::query::Params')
      params.push(`Path(${hasKey ? '' : '_'}params): Path<Params>`)
      if (hasKey) body.push(keyRead())
    }
    const status = `status(${endpoint.status})`
    const service = `state.${name.state}.${fn}`
    if (endpoint.operation === 'list') {
      uses.add('axum::Json', 'crate::common::list::ListQuery', `crate::${context.layout.resource(resource, 'repository')}::${name.filters}`)
      const readsQuery = endpoint.pagination || endpoint.filters.length > 0 || endpoint.sort.length > 0
      if (readsQuery) {
        uses.add('axum::extract::Query', 'crate::common::query::Params')
        params.push('Query(query): Query<Params>')
      }
      if (endpoint.pagination) {
        uses.add('crate::common::query::int_query', 'crate::common::list::PageResponse')
        body.push(
          'let page = int_query(&query, "page", 1, 1, None)?;',
          `let size = int_query(&query, "size", ${PAGE_SIZE.default}, 1, Some(${PAGE_SIZE.max}))?;`,
        )
      }
      const own = resource.fields.filter((field) => endpoint.filters.includes(field.wire) && filterStruct.includes(field))
      if (own.length > 0) {
        uses.add('crate::common::query::filter')
        body.push(
          `let filters = ${name.filters} {`,
          ...own.map((field) => `    ${fieldName(field)}: ${filterRead(context, field, uses)},`),
          own.length < filterStruct.length ? '    ..Default::default()' : '',
          '};',
        )
      } else body.push(`let filters = ${name.filters}::default();`)
      if (endpoint.sort.length > 0) {
        uses.add('crate::common::query::choice_query')
        const choices = endpoint.sort.flatMap((wire) => [rsString(wire), rsString(`-${wire}`)]).join(', ')
        body.push(`let sort = choice_query(&query, "sort", &[${choices}])?;`)
      }
      const sort = endpoint.sort.length > 0 ? 'sort' : 'None'
      if (endpoint.pagination)
        body.push(
          `let result = ${service}(ListQuery::new(filters, ${sort}, (page - 1) * size, Some(size))).await?;`,
          `let items = result.items.into_iter().map(${name.response}::from).collect();`,
          `Ok((${status}, Json(PageResponse { items, total: result.total, page, size })))`,
        )
      else
        body.push(
          `let result = ${service}(ListQuery::new(filters, ${sort}, 0, None)).await?;`,
          `Ok((${status}, Json(result.items.into_iter().map(${name.response}::from).collect::<Vec<_>>())))`,
        )
    } else {
      if (endpoint.input !== 'none') {
        const bodyClass = endpoint.input === 'partial' ? name.update : name.create
        uses.add('axum::body::Bytes', 'crate::common::body::read_body', `${dto}::${bodyClass}`)
        params.push('body: Bytes')
        body.push(`let body = read_body::<${bodyClass}>(&body, ${bodyClass}::rules)?;`)
      }
      const args = (...items: (string | null)[]) => items.filter(Boolean).join(', ')
      switch (endpoint.operation) {
        case 'get':
          uses.add('axum::Json')
          body.push(`Ok((${status}, Json(${name.response}::from(${service}(key).await?))))`)
          break
        case 'create':
          uses.add('axum::Json')
          body.push(`Ok((${status}, Json(${name.response}::from(${service}(body).await?))))`)
          break
        case 'replace':
        case 'update':
          uses.add('axum::Json')
          body.push(`Ok((${status}, Json(${name.response}::from(${service}(key, body).await?))))`)
          break
        case 'delete':
          body.push(`${service}(key).await?;`, `Ok(${status})`)
          break
        case 'custom': {
          const call = `${service}(${args(hasKey ? 'key' : null, endpoint.input !== 'none' ? 'body' : null)}).await?`
          if (endpoint.output === 'none' || endpoint.status === 204) body.push(`${call};`, `Ok(${status}.into_response())`)
          else if (endpoint.output === 'list') {
            uses.add('axum::Json')
            body.push(`Ok((${status}, Json(${call}.into_iter().map(${name.response}::from).collect::<Vec<_>>())).into_response())`)
          } else {
            uses.add('axum::Json')
            body.push(`Ok((${status}, Json(${name.response}::from(${call}))).into_response())`)
          }
          break
        }
      }
    }
    return lines(
      `/// ${endpoint.summary}.`,
      `async fn ${fn}(${params.join(', ')}) -> Result<impl IntoResponse, ApiError> {`,
      body.filter((line) => line !== '').map((line) => `    ${line}`),
      '}',
    )
  })
  // Endpoints of the same path share a route, one method each
  const paths: string[] = []
  const methods = new Map<string, string[]>()
  for (const endpoint of resource.endpoints) {
    if (!methods.has(endpoint.path)) {
      paths.push(endpoint.path)
      methods.set(endpoint.path, [])
    }
    methods.get(endpoint.path)!.push(`${endpoint.method.toLowerCase()}(${endpointFunction(endpoint)})`)
  }
  const routes = paths.map((path) => {
    const [first, ...rest] = methods.get(path)!
    uses.add(`axum::routing::${first.slice(0, first.indexOf('('))}`)
    return `        .route(${rsString(path)}, ${[first, ...rest].join('.')})`
  })
  const content = lines(
    ...rsHeader(`Routes of ${resource.plural}: HTTP in, service calls, HTTP out.`, uses),
    rsDoc(`The routes of ${resource.plural}.`),
    'pub fn router() -> Router<AppState> {',
    '    Router::new()',
    routes,
    '}',
    '',
    handlers.join('\n\n'),
  )
  return { path: modulePath(context.layout.resource(resource, 'routes')), content: fileText(content) }
}
