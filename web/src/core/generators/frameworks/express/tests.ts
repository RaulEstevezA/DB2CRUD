/**
 * Tests of the Express project (Vitest + Supertest). They call every enabled endpoint the way a client
 * would, with the same cases as every other framework (common/testing.ts).
 */
import type { SpecEndpoint, SpecResource } from '../../../api/spec.ts'
import { sampleBody, updatableField, type JsonValue, type SampleReference } from '../../common/samples.ts'
import {
  TEST_API_KEY,
  TEST_JWT_SECRET,
  comparableFields,
  creatable,
  findEndpoint,
  fixedPath,
  keyWire,
  missingKey,
  pathWithKey,
  protectedEndpoint,
  requiredField,
  roleEndpoint,
  sampleKeysDiffer,
  snakeWords,
} from '../../common/testing.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { tsAccess, tsDoc, tsLiteral, tsString } from '../../languages/typescript/typescript.ts'
import { names, type ExpressContext } from './context.ts'

/** A template literal for a path whose key is the variable `key`. */
function url(endpoint: SpecEndpoint, resource: SpecResource): string {
  return `\`${pathWithKey(endpoint, resource).replace('{key}', '${key}')}\``
}

function subscript(path: SampleReference['path']): string {
  return path.map((part) => `[${typeof part === 'number' ? part : tsString(part)}]`).join('')
}

function helpersFile(context: ExpressContext): GeneratedFile {
  const blocks: string[] = []
  for (const resource of context.spec.resources) {
    if (!creatable(context.spec, resource)) continue
    const name = names(resource)
    const create = findEndpoint(resource, 'create')!
    const first = sampleBody(context.spec, resource, 0).sample
    const second = sampleBody(context.spec, resource, 1).sample
    const fills = first.references.map((reference) => {
      const target = context.spec.resources.find((item) => item.name === reference.resource)!
      return `  body${subscript(reference.path)} = (await create${names(target).type}(app, headers))[${tsString(keyWire(target))}]`
    })
    blocks.push(
      lines(
        `/** A valid body to create ${article(resource.singular)}, with the items it refers to created first. */`,
        `export async function ${name.one}Payload(app: Express, headers: Headers, variant = 0): Promise<Body> {`,
        `  const body: Body = variant === 0 ? ${tsLiteral(first.body as JsonValue)} : ${tsLiteral(second.body as JsonValue)}`,
        fills,
        '  return body',
        '}',
        '',
        `/** Creates ${article(resource.singular)} and returns it as the API answers. */`,
        `export async function create${name.type}(app: Express, headers: Headers, variant = 0): Promise<Body> {`,
        `  const response = await request(app).post(${tsString(create.path)}).set(headers).send(await ${name.one}Payload(app, headers, variant))`,
        `  expect(response.status, response.text).toBe(${create.status})`,
        '  return response.body',
        '}',
      ),
    )
  }
  const { auth } = context.settings
  const content = lines(
    tsDoc('Credentials for the tests, builders of valid request bodies, and helpers that create items through the API.'),
    '',
    "import type { Express } from 'express'",
    auth === 'jwt' && "import jwt from 'jsonwebtoken'",
    "import request from 'supertest'",
    "import { expect } from 'vitest'",
    '',
    '// eslint-disable-next-line @typescript-eslint/no-explicit-any',
    'export type Body = Record<string, any>',
    'export type Headers = Record<string, string>',
    '',
    auth === 'apiKey' && `export const TEST_API_KEY = ${tsString(TEST_API_KEY)}`,
    auth === 'jwt' && [
      `export const TEST_JWT_SECRET = ${tsString(TEST_JWT_SECRET)}`,
      '',
      '/** A token signed with the test secret, valid for one hour. */',
      'export function token(roles: string[]): string {',
      "  return jwt.sign({ sub: 'tests', roles }, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })",
      '}',
    ],
    '',
    '/** Headers of a client allowed to call every endpoint. */',
    auth === 'none' && 'export const headers: Headers = {}',
    auth === 'apiKey' && "export const headers: Headers = { 'X-API-Key': TEST_API_KEY }",
    auth === 'jwt' && [
      `export const headers: Headers = { Authorization: \`Bearer \${token([${context.spec.roles.map(tsString).join(', ')}])}\` }`,
      '',
      '/** Headers of a client with a valid token but no role. */',
      'export const headersWithoutRoles: Headers = { Authorization: `Bearer ${token([])}` }',
    ],
    '',
    blocks.join('\n\n'),
  )
  return { path: 'tests/helpers.ts', content: fileText(content) }
}

function setupFile(context: ExpressContext): GeneratedFile {
  const { auth } = context.settings
  const content = lines(
    tsDoc('Test environment: the credentials the API accepts while the tests run.'),
    '',
    auth === 'apiKey' && ["import { TEST_API_KEY } from './helpers.js'", '', 'process.env.API_KEYS = TEST_API_KEY'],
    auth === 'jwt' && [
      "import { TEST_JWT_SECRET } from './helpers.js'",
      '',
      'process.env.JWT_SECRET = TEST_JWT_SECRET',
      'delete process.env.JWT_AUDIENCE',
      'delete process.env.JWT_ISSUER',
    ],
    auth === 'none' && 'export {}',
  )
  return { path: 'tests/setup.ts', content: fileText(content) }
}

function article(text: string): string {
  return /^[aeiou]/i.test(text) ? `an ${text}` : `a ${text}`
}

function resourceTests(context: ExpressContext, resource: SpecResource): GeneratedFile {
  const name = names(resource)
  const key = keyWire(resource)
  const tests: string[] = []
  const used = new Set<string>(['headers'])
  const canCreate = creatable(context.spec, resource)
  const problem = sampleBody(context.spec, resource, 0).problem
  const get = findEndpoint(resource, 'get')
  const create = findEndpoint(resource, 'create')
  const list = findEndpoint(resource, 'list')
  const test = (title: string, body: (string | false | null | undefined | string[])[]) =>
    tests.push(lines(`  it(${tsString(title)}, async () => {`, ...body, '  })'))

  if (context.pending) {
    for (const endpoint of [list, get].filter(Boolean) as SpecEndpoint[]) {
      test(`${snakeWords(endpoint.name).replace(/_/g, ' ')} answers 501 until the storage is written`, [
        `    const response = await request(app).get(${tsString(fixedPath(endpoint, resource, missingKey(resource)))}).set(headers)`,
        '    expect(response.status).toBe(501)',
        "    expect(response.body.error.code).toBe('not_implemented')",
      ])
    }
  } else {
    if (create && !canCreate) {
      tests.push(
        lines(
          `  it.skip(${tsString(`creates ${article(resource.singular)}`)}, () => {`,
          `    // TODO: ${problem ?? 'write a body with the items it refers to'}`,
          '  })',
        ),
      )
    }
    if (canCreate) {
      used.add(`create${name.type}`)
      used.add(`${name.one}Payload`)
      const sent = sampleBody(context.spec, resource, 0).sample.body
      test(`creates ${article(resource.singular)}`, [
        `    const payload = await ${name.one}Payload(app, headers)`,
        `    const response = await request(app).post(${tsString(create!.path)}).set(headers).send(payload)`,
        `    expect(response.status, response.text).toBe(${create!.status})`,
        `    expect(${tsAccess('response.body', key)}).toBeDefined()`,
        comparableFields(resource, sent).map(
          (wire) => `    expect(${tsAccess('response.body', wire)}).toEqual(${tsAccess('payload', wire)})`,
        ),
      ])
      const required = requiredField(resource)
      if (required) {
        test(`rejects ${article(resource.singular)} without ${required.wire}`, [
          `    const payload = await ${name.one}Payload(app, headers)`,
          `    delete payload[${tsString(required.wire)}]`,
          `    const response = await request(app).post(${tsString(create!.path)}).set(headers).send(payload)`,
          '    expect(response.status).toBe(400)',
          "    expect(response.body.error.code).toBe('validation_error')",
          `    expect(response.body.error.details.some((detail: { field: string }) => detail.field === ${tsString(required.wire)})).toBe(true)`,
        ])
      }
      if (resource.key.generated === null) {
        test(`rejects a second ${resource.singular} with the same key`, [
          `    const created = await create${name.type}(app, headers)`,
          `    const payload = await ${name.one}Payload(app, headers)`,
          `    payload[${tsString(key)}] = created[${tsString(key)}]`,
          `    const response = await request(app).post(${tsString(create!.path)}).set(headers).send(payload)`,
          '    expect(response.status).toBe(409)',
        ])
      }
    }
    if (get) {
      if (canCreate) {
        test(`gets ${article(resource.singular)}`, [
          `    const created = await create${name.type}(app, headers)`,
          `    const key = created[${tsString(key)}]`,
          `    const response = await request(app).get(${url(get, resource)}).set(headers)`,
          '    expect(response.status, response.text).toBe(200)',
          '    expect(response.body).toEqual(created)',
        ])
      }
      test(`answers 404 for a missing ${resource.singular}`, [
        `    const response = await request(app).get(${tsString(fixedPath(get, resource, missingKey(resource)))}).set(headers)`,
        '    expect(response.status).toBe(404)',
        "    expect(response.body.error.code).toBe('not_found')",
      ])
    }
    if (list) {
      const distinct = sampleKeysDiffer(context.spec, resource)
      const count = canCreate ? (distinct ? 2 : 1) : 0
      test(`lists ${resource.plural}`, [
        canCreate && `    await create${name.type}(app, headers)`,
        canCreate && distinct && `    await create${name.type}(app, headers, 1)`,
        `    const response = await request(app).get(${tsString(list.path)}).set(headers)`,
        '    expect(response.status, response.text).toBe(200)',
        list.pagination
          ? [`    expect(response.body.total).toBe(${count})`, '    expect(response.body.page).toBe(1)']
          : `    expect(response.body).toHaveLength(${count})`,
      ])
      if (list.pagination && canCreate && distinct) {
        test(`lists ${resource.plural} by page`, [
          `    await create${name.type}(app, headers)`,
          `    await create${name.type}(app, headers, 1)`,
          `    const response = await request(app).get(${tsString(list.path)}).query({ page: 2, size: 1 }).set(headers)`,
          '    expect(response.status, response.text).toBe(200)',
          '    expect(response.body.total).toBe(2)',
          '    expect(response.body.items).toHaveLength(1)',
          '    expect(response.body.page).toBe(2)',
        ])
      }
      if (list.pagination) {
        test('rejects a page that does not exist', [
          `    const response = await request(app).get(${tsString(list.path)}).query({ page: 0 }).set(headers)`,
          '    expect(response.status).toBe(400)',
        ])
      }
    }
    const replace = findEndpoint(resource, 'replace')
    if (replace && canCreate) {
      test(`replaces ${article(resource.singular)}`, [
        `    const created = await create${name.type}(app, headers)`,
        `    const key = created[${tsString(key)}]`,
        `    const payload = await ${name.one}Payload(app, headers, 1)`,
        resource.key.generated === null && `    payload[${tsString(key)}] = key`,
        `    const response = await request(app).put(${url(replace, resource)}).set(headers).send(payload)`,
        '    expect(response.status, response.text).toBe(200)',
        comparableFields(resource, sampleBody(context.spec, resource, 1).sample.body)
          .filter((wire) => wire !== key)
          .map((wire) => `    expect(${tsAccess('response.body', wire)}).toEqual(${tsAccess('payload', wire)})`),
      ])
    }
    const update = findEndpoint(resource, 'update')
    const field = updatableField(resource)
    if (update && canCreate && field) {
      const value = sampleBody(context.spec, resource, 1).sample.body[field.wire] ?? null
      test(`updates part of ${article(resource.singular)}`, [
        `    const created = await create${name.type}(app, headers)`,
        `    const key = created[${tsString(key)}]`,
        `    const response = await request(app).patch(${url(update, resource)}).set(headers).send({ ${tsString(field.wire)}: ${tsLiteral(value)} })`,
        '    expect(response.status, response.text).toBe(200)',
        `    expect(${tsAccess('response.body', field.wire)}).toEqual(${tsLiteral(value)})`,
      ])
      if (!field.nullable) {
        test(`rejects null for ${field.wire}`, [
          `    const created = await create${name.type}(app, headers)`,
          `    const key = created[${tsString(key)}]`,
          `    const response = await request(app).patch(${url(update, resource)}).set(headers).send({ ${tsString(field.wire)}: null })`,
          '    expect(response.status).toBe(400)',
        ])
      }
    }
    const remove = findEndpoint(resource, 'delete')
    if (remove && canCreate) {
      test(`deletes ${article(resource.singular)}`, [
        `    const created = await create${name.type}(app, headers)`,
        `    const key = created[${tsString(key)}]`,
        `    const response = await request(app).delete(${url(remove, resource)}).set(headers)`,
        `    expect(response.status, response.text).toBe(${remove.status})`,
        get && `    expect((await request(app).get(${url(get, resource)}).set(headers)).status).toBe(404)`,
      ])
    }
    for (const endpoint of resource.endpoints.filter((item) => item.operation === 'custom')) {
      const needsItem = endpoint.pathParams.some((param) => param.name === resource.key.param)
      if ((needsItem || endpoint.input === 'resource') && !canCreate) continue
      const send =
        endpoint.input === 'none' ? '' : endpoint.input === 'partial' ? '.send({})' : `.send(await ${name.one}Payload(app, headers))`
      test(`${snakeWords(endpoint.name).replace(/_/g, ' ')} answers 501 until it is written`, [
        needsItem && [`    const created = await create${name.type}(app, headers)`, `    const key = created[${tsString(key)}]`],
        `    const response = await request(app).${endpoint.method.toLowerCase()}(${needsItem ? url(endpoint, resource) : tsString(fixedPath(endpoint, resource, 'sample'))}).set(headers)${send}`,
        '    // TODO: replace this test when the operation is written',
        '    expect(response.status).toBe(501)',
      ])
    }
  }
  const guarded = protectedEndpoint(resource, context.settings.auth)
  if (guarded) {
    test(`${snakeWords(guarded.name).replace(/_/g, ' ')} needs credentials`, [
      `    const response = await request(app).get(${tsString(fixedPath(guarded, resource, missingKey(resource)))})`,
      '    expect(response.status).toBe(401)',
      "    expect(response.body.error.code).toBe('unauthorized')",
    ])
  }
  const withRoles = roleEndpoint(resource, context.settings.auth)
  if (withRoles) {
    used.add('headersWithoutRoles')
    test(`${snakeWords(withRoles.name).replace(/_/g, ' ')} needs a role`, [
      `    const response = await request(app).get(${tsString(fixedPath(withRoles, resource, missingKey(resource)))}).set(headersWithoutRoles)`,
      '    expect(response.status).toBe(403)',
    ])
  }
  const content = lines(
    tsDoc(`Tests of the ${resource.plural} endpoints.`),
    '',
    "import type { Express } from 'express'",
    "import request from 'supertest'",
    "import { beforeEach, describe, expect, it } from 'vitest'",
    "import { createApp } from '../src/app.js'",
    `import { ${[...used].sort().join(', ')} } from './helpers.js'`,
    '',
    `describe(${tsString(resource.plural)}, () => {`,
    '  let app: Express',
    '',
    '  // A new application per test: every test starts with empty storage',
    '  beforeEach(() => {',
    '    app = createApp()',
    '  })',
    '',
    tests.length > 0 ? tests.join('\n\n') : "  it('has no endpoints', () => {})",
    '})',
  )
  return { path: `tests/${name.many.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}.test.ts`, content: fileText(content) }
}

export function testFiles(context: ExpressContext): GeneratedFile[] {
  return [setupFile(context), helpersFile(context), ...context.spec.resources.map((resource) => resourceTests(context, resource))]
}
