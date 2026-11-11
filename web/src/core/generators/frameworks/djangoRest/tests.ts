/**
 * Tests of the Django REST Framework project (APITestCase: a clean database for every test). They call
 * every enabled endpoint the way a client would, with the same cases as every other framework
 * (common/testing.ts).
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
import { pyClass, pyLiteral, pyString } from '../../languages/python/python.ts'
import { names, type DjangoContext } from './context.ts'

function url(endpoint: SpecEndpoint, resource: SpecResource): string {
  const path = pathWithKey(endpoint, resource)
  return path.includes('{key}') ? `f${pyString(path)}` : pyString(path)
}

function subscript(path: SampleReference['path']): string {
  return path.map((part) => `[${typeof part === 'number' ? part : pyString(part)}]`).join('')
}

function helpersFile(context: DjangoContext): GeneratedFile {
  const { auth } = context.settings
  const blocks: string[] = []
  for (const resource of context.spec.resources) {
    if (!creatable(context.spec, resource)) continue
    const name = names(resource)
    const create = findEndpoint(resource, 'create')!
    const first = sampleBody(context.spec, resource, 0).sample
    const second = sampleBody(context.spec, resource, 1).sample
    const fills = first.references.map((reference) => {
      const target = context.spec.resources.find((item) => item.name === reference.resource)!
      return `    body${subscript(reference.path)} = create_${names(target).one}(client)[${pyString(keyWire(target))}]`
    })
    blocks.push(
      lines(
        `def ${name.one}_payload(client: APIClient, variant: int = 0) -> dict[str, Any]:`,
        `    """A valid body to create one ${resource.singular}, with the items it refers to created first."""`,
        `    body: dict[str, Any] = ${pyLiteral(first.body as JsonValue)} if variant == 0 else ${pyLiteral(second.body as JsonValue)}`,
        fills,
        '    return body',
        '',
        '',
        `def create_${name.one}(client: APIClient, variant: int = 0) -> dict[str, Any]:`,
        `    """Creates one ${resource.singular} and returns it as the API answers."""`,
        `    response = client.post(${pyString(create.path)}, ${name.one}_payload(client, variant), format="json")`,
        `    assert response.status_code == ${create.status}, response.content`,
        '    return response.json()',
      ),
    )
  }
  const content = lines(
    '"""Credentials for the tests, builders of valid request bodies, and helpers that create items through the API."""',
    '',
    'from typing import Any',
    auth === 'jwt' && 'from datetime import UTC, datetime, timedelta',
    '',
    auth === 'jwt' && 'import jwt',
    'from django.test import override_settings',
    'from rest_framework.test import APIClient',
    '',
    auth === 'none' && ['# The settings every test runs with', 'TEST_SETTINGS = override_settings()'],
    auth === 'apiKey' && [`TEST_API_KEY = ${pyString(TEST_API_KEY)}`, 'TEST_SETTINGS = override_settings(API_KEYS=[TEST_API_KEY])'],
    auth === 'jwt' && [
      `TEST_JWT_SECRET = ${pyString(TEST_JWT_SECRET)}`,
      'TEST_SETTINGS = override_settings(JWT_SECRET=TEST_JWT_SECRET, JWT_ALGORITHM="HS256", JWT_AUDIENCE=None, JWT_ISSUER=None)',
      '',
      '',
      'def token(roles: list[str]) -> str:',
      '    """A token signed with the test secret, valid for one hour."""',
      '    claims = {"sub": "tests", "roles": roles, "exp": datetime.now(UTC) + timedelta(hours=1)}',
      '    return jwt.encode(claims, TEST_JWT_SECRET, algorithm="HS256")',
    ],
    '',
    '',
    'def authorize(client: APIClient, roles: list[str] | None = None) -> APIClient:',
    '    """Gives the client the credentials to call every endpoint (or, with roles, only those roles)."""',
    auth === 'apiKey' && '    client.credentials(HTTP_X_API_KEY=TEST_API_KEY)',
    auth === 'jwt' &&
      `    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token(roles if roles is not None else [${context.spec.roles.map(pyString).join(', ')}])}")`,
    '    return client',
    blocks.length > 0 && ['', '', blocks.join('\n\n\n')],
  )
  return { path: 'tests/helpers.py', content: fileText(content) }
}

function resourceTests(context: DjangoContext, resource: SpecResource): GeneratedFile {
  const name = names(resource)
  const key = keyWire(resource)
  const tests: string[] = []
  const helpers = new Set<string>(['TEST_SETTINGS', 'authorize'])
  const canCreate = creatable(context.spec, resource)
  const problem = sampleBody(context.spec, resource, 0).problem
  const get = findEndpoint(resource, 'get')
  const create = findEndpoint(resource, 'create')
  const list = findEndpoint(resource, 'list')
  const test = (method: string, body: (string | false | null | undefined | string[])[]) =>
    tests.push(lines(`    def test_${method}(self) -> None:`, ...body))
  if (create && !canCreate)
    tests.push(
      lines(
        `    @skip(${pyString(problem ?? 'An item it refers to cannot be created through the API.')})`,
        `    def test_create_${name.one}(self) -> None:`,
        `        # TODO: ${problem ?? 'write a body with the items it refers to'}`,
        '        pass',
      ),
    )
  if (canCreate) {
    helpers.add(`create_${name.one}`)
    helpers.add(`${name.one}_payload`)
    const sent = sampleBody(context.spec, resource, 0).sample.body
    test(`create_${name.one}`, [
      `        payload = ${name.one}_payload(self.client)`,
      `        response = self.client.post(${pyString(create!.path)}, payload, format="json")`,
      `        self.assertEqual(response.status_code, ${create!.status}, response.content)`,
      '        created = response.json()',
      `        self.assertIsNotNone(created[${pyString(key)}])`,
      comparableFields(resource, sent).map((wire) => `        self.assertEqual(created[${pyString(wire)}], payload[${pyString(wire)}])`),
    ])
    const required = requiredField(resource)
    if (required) {
      test(`create_${name.one}_without_${snakeWords(required.wire)}`, [
        `        payload = ${name.one}_payload(self.client)`,
        `        del payload[${pyString(required.wire)}]`,
        `        response = self.client.post(${pyString(create!.path)}, payload, format="json")`,
        '        self.assertEqual(response.status_code, 400)',
        '        error = response.json()["error"]',
        '        self.assertEqual(error["code"], "validation_error")',
        `        self.assertTrue(any(detail["field"] == ${pyString(required.wire)} for detail in error["details"]))`,
      ])
    }
    if (resource.key.generated === null) {
      test(`create_${name.one}_twice`, [
        `        created = create_${name.one}(self.client)`,
        `        payload = ${name.one}_payload(self.client)`,
        `        payload[${pyString(key)}] = created[${pyString(key)}]`,
        `        response = self.client.post(${pyString(create!.path)}, payload, format="json")`,
        '        self.assertEqual(response.status_code, 409)',
      ])
    }
  }
  if (get) {
    if (canCreate) {
      test(`get_${name.one}`, [
        `        created = create_${name.one}(self.client)`,
        `        key = created[${pyString(key)}]`,
        `        response = self.client.get(${url(get, resource)})`,
        '        self.assertEqual(response.status_code, 200, response.content)',
        '        self.assertEqual(response.json(), created)',
      ])
    }
    test(`get_missing_${name.one}`, [
      `        response = self.client.get(${pyString(fixedPath(get, resource, missingKey(resource)))})`,
      '        self.assertEqual(response.status_code, 404)',
      '        self.assertEqual(response.json()["error"]["code"], "not_found")',
    ])
  }
  if (list) {
    const distinct = sampleKeysDiffer(context.spec, resource)
    const count = canCreate ? (distinct ? 2 : 1) : 0
    test(snakeWords(list.name), [
      canCreate && `        create_${name.one}(self.client)`,
      canCreate && distinct && `        create_${name.one}(self.client, variant=1)`,
      `        response = self.client.get(${pyString(list.path)})`,
      '        self.assertEqual(response.status_code, 200, response.content)',
      list.pagination
        ? [`        self.assertEqual(response.json()["total"], ${count})`, '        self.assertEqual(response.json()["page"], 1)']
        : `        self.assertEqual(len(response.json()), ${count})`,
    ])
    if (list.pagination && canCreate && distinct) {
      test(`${snakeWords(list.name)}_by_page`, [
        `        create_${name.one}(self.client)`,
        `        create_${name.one}(self.client, variant=1)`,
        `        response = self.client.get(${pyString(list.path)}, {"page": 2, "size": 1})`,
        '        self.assertEqual(response.status_code, 200, response.content)',
        '        self.assertEqual(response.json()["total"], 2)',
        '        self.assertEqual(len(response.json()["items"]), 1)',
      ])
    }
    if (list.pagination) {
      test(`${snakeWords(list.name)}_rejects_a_bad_page`, [
        `        response = self.client.get(${pyString(list.path)}, {"page": 0})`,
        '        self.assertEqual(response.status_code, 400)',
      ])
    }
  }
  const replace = findEndpoint(resource, 'replace')
  if (replace && canCreate) {
    test(`replace_${name.one}`, [
      `        created = create_${name.one}(self.client)`,
      `        key = created[${pyString(key)}]`,
      `        payload = ${name.one}_payload(self.client, variant=1)`,
      resource.key.generated === null && `        payload[${pyString(key)}] = key`,
      `        response = self.client.put(${url(replace, resource)}, payload, format="json")`,
      '        self.assertEqual(response.status_code, 200, response.content)',
      comparableFields(resource, sampleBody(context.spec, resource, 1).sample.body)
        .filter((wire) => wire !== key)
        .map((wire) => `        self.assertEqual(response.json()[${pyString(wire)}], payload[${pyString(wire)}])`),
    ])
  }
  const update = findEndpoint(resource, 'update')
  const field = updatableField(resource)
  if (update && canCreate && field) {
    const value = sampleBody(context.spec, resource, 1).sample.body[field.wire] ?? null
    test(`update_${name.one}`, [
      `        created = create_${name.one}(self.client)`,
      `        key = created[${pyString(key)}]`,
      `        response = self.client.patch(${url(update, resource)}, {${pyString(field.wire)}: ${pyLiteral(value)}}, format="json")`,
      '        self.assertEqual(response.status_code, 200, response.content)',
      `        self.assertEqual(response.json()[${pyString(field.wire)}], ${pyLiteral(value)})`,
    ])
    if (!field.nullable) {
      test(`update_${name.one}_rejects_null`, [
        `        created = create_${name.one}(self.client)`,
        `        key = created[${pyString(key)}]`,
        `        response = self.client.patch(${url(update, resource)}, {${pyString(field.wire)}: None}, format="json")`,
        '        self.assertEqual(response.status_code, 400)',
      ])
    }
  }
  const remove = findEndpoint(resource, 'delete')
  if (remove && canCreate) {
    test(`delete_${name.one}`, [
      `        created = create_${name.one}(self.client)`,
      `        key = created[${pyString(key)}]`,
      `        response = self.client.delete(${url(remove, resource)})`,
      `        self.assertEqual(response.status_code, ${remove.status}, response.content)`,
      get && `        self.assertEqual(self.client.get(${url(get, resource)}).status_code, 404)`,
    ])
  }
  for (const endpoint of resource.endpoints.filter((item) => item.operation === 'custom')) {
    const needsItem = endpoint.pathParams.some((param) => param.name === resource.key.param)
    if ((needsItem || endpoint.input === 'resource') && !canCreate) continue
    const payload = endpoint.input === 'none' ? null : endpoint.input === 'partial' ? '{}' : `${name.one}_payload(self.client)`
    const target = needsItem ? url(endpoint, resource) : pyString(fixedPath(endpoint, resource, 'sample'))
    const send = payload ? `, json.dumps(${payload}), content_type="application/json"` : ''
    test(`${snakeWords(endpoint.name)}_is_pending`, [
      needsItem && [`        created = create_${name.one}(self.client)`, `        key = created[${pyString(key)}]`],
      '        # TODO: replace this test when the operation is written',
      `        response = self.client.generic(${pyString(endpoint.method)}, ${target}${send})`,
      '        self.assertEqual(response.status_code, 501)',
    ])
  }
  const guarded = protectedEndpoint(resource, context.settings.auth)
  if (guarded) {
    test(`${snakeWords(guarded.name)}_needs_credentials`, [
      '        self.client.credentials()',
      `        response = self.client.get(${pyString(fixedPath(guarded, resource, missingKey(resource)))})`,
      '        self.assertEqual(response.status_code, 401)',
      '        self.assertEqual(response.json()["error"]["code"], "unauthorized")',
    ])
  }
  const withRoles = roleEndpoint(resource, context.settings.auth)
  if (withRoles) {
    test(`${snakeWords(withRoles.name)}_needs_a_role`, [
      '        authorize(self.client, roles=[])',
      `        response = self.client.get(${pyString(fixedPath(withRoles, resource, missingKey(resource)))})`,
      '        self.assertEqual(response.status_code, 403)',
    ])
  }
  const body = tests.join('\n\n')
  const content = lines(
    `"""Tests of the ${resource.plural} endpoints."""`,
    '',
    body.includes('json.dumps') && 'import json',
    body.includes('@skip') && 'from unittest import skip',
    '',
    'from rest_framework.test import APITestCase',
    '',
    `from tests.helpers import ${[...helpers].sort().join(', ')}`,
    '',
    '',
    '@TEST_SETTINGS',
    `class ${pyClass(resource.plural.replace(/ /g, '_'))}Tests(APITestCase):`,
    `    """Every test starts with an empty database and a client allowed to call every endpoint."""`,
    '',
    '    def setUp(self) -> None:',
    '        authorize(self.client)',
    '',
    body.length > 0 ? body : '    def test_has_no_endpoints(self) -> None:\n        pass',
  )
  return { path: `tests/test_${name.many}.py`, content: fileText(content) }
}

export function testFiles(context: DjangoContext): GeneratedFile[] {
  return [
    { path: 'tests/__init__.py', content: '' },
    helpersFile(context),
    ...context.spec.resources.map((resource) => resourceTests(context, resource)),
  ]
}
