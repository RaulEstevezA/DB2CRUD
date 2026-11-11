/**
 * Tests of the FastAPI project (pytest + TestClient). They call every enabled endpoint the way a client
 * would: create and read back, list and paginate, replace, update part, delete, missing items, invalid
 * bodies, missing credentials, missing roles, and business operations still to write.
 *
 * Bodies come from the language-neutral samples (common/samples.ts); references are filled by creating
 * the referenced items first.
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
  sampleKeysDiffer,
} from '../../common/testing.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { pyDocstring, pyLiteral, pyString } from '../../languages/python/python.ts'
import { names, type FastApiContext } from './context.ts'

/** A Python string for a path with a fixed key value: `"/customers/999999"`. */
function fixedUrl(endpoint: SpecEndpoint, resource: SpecResource, value: string): string {
  return pyString(fixedPath(endpoint, resource, value))
}

/** A Python f-string for a path with the key (and any other parameter) filled in. */
function url(endpoint: SpecEndpoint, resource: SpecResource, key: string): string {
  const path = pathWithKey(endpoint, resource).replace('{key}', `{${key}}`)
  return path.includes('{') ? `f${pyString(path)}` : pyString(path)
}

/** Python subscripts for a place in a body: `["lines"][0]["productId"]`. */
function subscript(path: SampleReference['path']): string {
  return path.map((part) => `[${typeof part === 'number' ? part : pyString(part)}]`).join('')
}

function helpersFile(context: FastApiContext): GeneratedFile {
  const blocks: string[] = []
  for (const resource of context.spec.resources) {
    if (!creatable(context.spec, resource)) continue
    const variable = names(resource)
    const create = findEndpoint(resource, 'create')!
    const first = sampleBody(context.spec, resource, 0).sample
    const second = sampleBody(context.spec, resource, 1).sample
    const fills = first.references.map((reference) => {
      const target = context.spec.resources.find((item) => item.name === reference.resource)!
      return `    body${subscript(reference.path)} = create_${names(target).one}(client, headers)[${pyString(keyWire(target))}]`
    })
    blocks.push(
      lines(
        `def ${variable.one}_payload(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:`,
        `    """A valid body to create ${article(resource.singular)}, with the items it refers to created first."""`,
        `    body: dict[str, Any] = ${pyLiteral(first.body as JsonValue)} if variant == 0 else ${pyLiteral(second.body as JsonValue)}`,
        fills,
        '    return body',
        '',
        '',
        `def create_${variable.one}(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:`,
        `    """Creates ${article(resource.singular)} and returns it as the API answers."""`,
        `    response = client.post(${pyString(create.path)}, json=${variable.one}_payload(client, headers, variant), headers=headers)`,
        `    assert response.status_code == ${create.status}, response.text`,
        '    return response.json()',
      ),
    )
  }
  const content = lines(
    pyDocstring('Builders of valid request bodies, and helpers that create items through the API.'),
    '',
    'from typing import Any',
    '',
    'from fastapi.testclient import TestClient',
    '',
    '',
    blocks.length > 0 ? blocks.join('\n\n\n') : '# No resource can be created through the API, so no helper is needed',
  )
  return { path: 'tests/helpers.py', content: fileText(content) }
}

function article(text: string): string {
  return /^[aeiou]/i.test(text) ? `an ${text}` : `a ${text}`
}

function conftestFile(context: FastApiContext): GeneratedFile {
  const { auth } = context.settings
  const roles = context.spec.roles
  const content = lines(
    pyDocstring('Fixtures shared by the tests: a fresh application per test, and the credentials to call it.'),
    '',
    'import os',
    auth === 'jwt' && 'from datetime import UTC, datetime, timedelta',
    'from collections.abc import Iterator',
    '',
    auth === 'jwt' && 'import jwt',
    'import pytest',
    'from fastapi.testclient import TestClient',
    '',
    'from app.main import create_app',
    context.sql && 'from app.db import Base',
    '',
    auth === 'apiKey' && `TEST_API_KEY = ${pyString(TEST_API_KEY)}`,
    auth === 'jwt' && `TEST_JWT_SECRET = ${pyString(TEST_JWT_SECRET)}`,
    auth === 'jwt' && `ALL_ROLES = [${roles.map(pyString).join(', ')}]`,
    '',
    '',
    '@pytest.fixture',
    'def client(tmp_path, monkeypatch) -> Iterator[TestClient]:',
    '    """The application with empty storage and test credentials."""',
    auth === 'apiKey' && '    monkeypatch.setenv("API_KEYS", TEST_API_KEY)',
    auth === 'jwt' && [
      '    monkeypatch.setenv("JWT_SECRET", TEST_JWT_SECRET)',
      '    monkeypatch.delenv("JWT_AUDIENCE", raising=False)',
      '    monkeypatch.delenv("JWT_ISSUER", raising=False)',
    ],
    context.sql && [
      '    # TEST_DATABASE_URL runs the tests on a real database; by default, a SQLite file per test',
      '    url = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{tmp_path / \'test.db\'}"',
      '    monkeypatch.setenv("DATABASE_URL", url)',
    ],
    '    app = create_app()',
    '    with TestClient(app) as test_client:',
    '        yield test_client',
    context.sql && ['    Base.metadata.drop_all(app.state.engine)', '    app.state.engine.dispose()'],
    '',
    '',
    auth === 'jwt' && [
      'def token(roles: list[str]) -> str:',
      '    """A token signed with the test secret, valid for one hour."""',
      '    claims = {"sub": "tests", "roles": roles, "exp": datetime.now(UTC) + timedelta(hours=1)}',
      '    return jwt.encode(claims, TEST_JWT_SECRET, algorithm="HS256")',
      '',
      '',
    ],
    '@pytest.fixture',
    'def headers() -> dict[str, str]:',
    '    """Headers of a client allowed to call every endpoint."""',
    auth === 'none' && '    return {}',
    auth === 'apiKey' && '    return {"X-API-Key": TEST_API_KEY}',
    auth === 'jwt' && '    return {"Authorization": f"Bearer {token(ALL_ROLES)}"}',
    auth === 'jwt' && [
      '',
      '',
      '@pytest.fixture',
      'def headers_without_roles() -> dict[str, str]:',
      '    """Headers of a client with a valid token but no role."""',
      '    return {"Authorization": f"Bearer {token([])}"}',
    ],
  )
  // os is only needed for the database URL
  const text = context.sql ? content : content.replace('import os\n', '')
  return { path: 'tests/conftest.py', content: fileText(text) }
}

function resourceTests(context: FastApiContext, resource: SpecResource): GeneratedFile {
  const variable = names(resource)
  const key = keyWire(resource)
  const tests: string[] = []
  const canCreate = creatable(context.spec, resource)
  const helpers = new Set<string>()
  const problem = sampleBody(context.spec, resource, 0).problem
  const get = findEndpoint(resource, 'get')
  const create = findEndpoint(resource, 'create')
  const list = findEndpoint(resource, 'list')

  if (context.pending) {
    for (const endpoint of [list, get].filter(Boolean) as SpecEndpoint[]) {
      tests.push(
        lines(
          `def test_${pyNameOf(endpoint)}_storage_is_pending(client: TestClient, headers: dict[str, str]) -> None:`,
          `    response = client.get(${fixedUrl(endpoint, resource, missingKey(resource))}, headers=headers)`,
          '    assert response.status_code == 501',
          '    assert response.json()["error"]["code"] == "not_implemented"',
        ),
      )
    }
  } else {
    if (create && !canCreate) {
      tests.push(
        lines(
          `@pytest.mark.skip(reason=${pyString(problem ?? 'An item it refers to cannot be created through the API.')})`,
          `def test_create_${variable.one}() -> None:`,
          `    # TODO: ${problem ?? 'write a body with the items it refers to'}`,
          '    pass',
        ),
      )
    }
    if (canCreate) {
      helpers.add(`create_${variable.one}`)
      helpers.add(`${variable.one}_payload`)
      const sent = sampleBody(context.spec, resource, 0).sample.body
      const checks = comparableFields(resource, sent).map((wire) => `    assert created[${pyString(wire)}] == payload[${pyString(wire)}]`)
      tests.push(
        lines(
          `def test_create_${variable.one}(client: TestClient, headers: dict[str, str]) -> None:`,
          `    payload = ${variable.one}_payload(client, headers)`,
          `    response = client.post(${pyString(create!.path)}, json=payload, headers=headers)`,
          `    assert response.status_code == ${create!.status}, response.text`,
          '    created = response.json()',
          `    assert created[${pyString(key)}] is not None`,
          checks,
        ),
      )
      const required = resource.fields.find((field) => field.required && field.access !== 'readOnly' && !field.reference)
      if (required) {
        tests.push(
          lines(
            `def test_create_${variable.one}_without_${pyNameOfWire(required.wire)}(client: TestClient, headers: dict[str, str]) -> None:`,
            `    payload = ${variable.one}_payload(client, headers)`,
            `    del payload[${pyString(required.wire)}]`,
            `    response = client.post(${pyString(create!.path)}, json=payload, headers=headers)`,
            '    assert response.status_code == 400',
            '    error = response.json()["error"]',
            '    assert error["code"] == "validation_error"',
            `    assert any(detail["field"] == ${pyString(required.wire)} for detail in error["details"])`,
          ),
        )
      }
      if (resource.key.generated === null) {
        tests.push(
          lines(
            `def test_create_${variable.one}_twice(client: TestClient, headers: dict[str, str]) -> None:`,
            `    created = create_${variable.one}(client, headers)`,
            `    payload = ${variable.one}_payload(client, headers)`,
            `    payload[${pyString(key)}] = created[${pyString(key)}]`,
            `    response = client.post(${pyString(create!.path)}, json=payload, headers=headers)`,
            '    assert response.status_code == 409',
          ),
        )
      }
    }
    if (get) {
      if (canCreate) {
        tests.push(
          lines(
            `def test_get_${variable.one}(client: TestClient, headers: dict[str, str]) -> None:`,
            `    created = create_${variable.one}(client, headers)`,
            `    key = created[${pyString(key)}]`,
            `    response = client.get(${url(get, resource, 'key')}, headers=headers)`,
            '    assert response.status_code == 200, response.text',
            '    assert response.json() == created',
          ),
        )
      }
      tests.push(
        lines(
          `def test_get_missing_${variable.one}(client: TestClient, headers: dict[str, str]) -> None:`,
          `    response = client.get(${fixedUrl(get, resource, missingKey(resource))}, headers=headers)`,
          '    assert response.status_code == 404',
          '    assert response.json()["error"]["code"] == "not_found"',
        ),
      )
    }
    if (list) {
      const distinct = sampleKeysDiffer(context.spec, resource)
      tests.push(
        lines(
          `def test_${pyNameOf(list)}(client: TestClient, headers: dict[str, str]) -> None:`,
          canCreate && `    create_${variable.one}(client, headers)`,
          canCreate && distinct && `    create_${variable.one}(client, headers, variant=1)`,
          `    response = client.get(${pyString(list.path)}, headers=headers)`,
          '    assert response.status_code == 200, response.text',
          list.pagination
            ? [
                '    page = response.json()',
                `    assert page["total"] == ${canCreate ? (distinct ? 2 : 1) : 0}`,
                '    assert page["page"] == 1',
              ]
            : `    assert len(response.json()) == ${canCreate ? (distinct ? 2 : 1) : 0}`,
        ),
      )
      if (list.pagination && canCreate && distinct) {
        tests.push(
          lines(
            `def test_${pyNameOf(list)}_by_page(client: TestClient, headers: dict[str, str]) -> None:`,
            `    create_${variable.one}(client, headers)`,
            `    create_${variable.one}(client, headers, variant=1)`,
            `    response = client.get(${pyString(list.path)}, params={"page": 2, "size": 1}, headers=headers)`,
            '    assert response.status_code == 200, response.text',
            '    page = response.json()',
            '    assert page["total"] == 2',
            '    assert len(page["items"]) == 1',
            '    assert page["page"] == 2',
          ),
        )
      }
      if (list.pagination) {
        tests.push(
          lines(
            `def test_${pyNameOf(list)}_rejects_a_bad_page(client: TestClient, headers: dict[str, str]) -> None:`,
            `    response = client.get(${pyString(list.path)}, params={"page": 0}, headers=headers)`,
            '    assert response.status_code == 400',
          ),
        )
      }
    }
    const replace = findEndpoint(resource, 'replace')
    if (replace && canCreate) {
      tests.push(
        lines(
          `def test_replace_${variable.one}(client: TestClient, headers: dict[str, str]) -> None:`,
          `    created = create_${variable.one}(client, headers)`,
          `    key = created[${pyString(key)}]`,
          `    payload = ${variable.one}_payload(client, headers, variant=1)`,
          resource.key.generated === null && `    payload[${pyString(key)}] = key`,
          `    response = client.put(${url(replace, resource, 'key')}, json=payload, headers=headers)`,
          '    assert response.status_code == 200, response.text',
          comparableFields(resource, sampleBody(context.spec, resource, 1).sample.body)
            .filter((wire) => wire !== key)
            .map((wire) => `    assert response.json()[${pyString(wire)}] == payload[${pyString(wire)}]`),
        ),
      )
    }
    const update = findEndpoint(resource, 'update')
    const field = updatableField(resource)
    if (update && canCreate && field) {
      const value = sampleBody(context.spec, resource, 1).sample.body[field.wire] ?? null
      tests.push(
        lines(
          `def test_update_${variable.one}(client: TestClient, headers: dict[str, str]) -> None:`,
          `    created = create_${variable.one}(client, headers)`,
          `    key = created[${pyString(key)}]`,
          `    response = client.patch(${url(update, resource, 'key')}, json={${pyString(field.wire)}: ${pyLiteral(value)}}, headers=headers)`,
          '    assert response.status_code == 200, response.text',
          `    assert response.json()[${pyString(field.wire)}] == ${pyLiteral(value)}`,
        ),
      )
      if (!field.nullable) {
        tests.push(
          lines(
            `def test_update_${variable.one}_rejects_null(client: TestClient, headers: dict[str, str]) -> None:`,
            `    created = create_${variable.one}(client, headers)`,
            `    key = created[${pyString(key)}]`,
            `    response = client.patch(${url(update, resource, 'key')}, json={${pyString(field.wire)}: None}, headers=headers)`,
            '    assert response.status_code == 400',
          ),
        )
      }
    }
    const remove = findEndpoint(resource, 'delete')
    if (remove && canCreate) {
      tests.push(
        lines(
          `def test_delete_${variable.one}(client: TestClient, headers: dict[str, str]) -> None:`,
          `    created = create_${variable.one}(client, headers)`,
          `    key = created[${pyString(key)}]`,
          `    response = client.delete(${url(remove, resource, 'key')}, headers=headers)`,
          `    assert response.status_code == ${remove.status}, response.text`,
          get && [`    assert client.get(${url(get, resource, 'key')}, headers=headers).status_code == 404`],
        ),
      )
    }
    for (const endpoint of resource.endpoints.filter((item) => item.operation === 'custom')) {
      const needsItem = endpoint.pathParams.some((param) => param.name === resource.key.param)
      if (needsItem && !canCreate) continue
      const body =
        endpoint.input === 'none' ? '' : endpoint.input === 'partial' ? ', json={}' : `, json=${variable.one}_payload(client, headers)`
      if (endpoint.input === 'resource' && !canCreate) continue
      tests.push(
        lines(
          `def test_${pyNameOf(endpoint)}_is_pending(client: TestClient, headers: dict[str, str]) -> None:`,
          needsItem && [`    created = create_${variable.one}(client, headers)`, `    key = created[${pyString(key)}]`],
          `    response = client.request(${pyString(endpoint.method)}, ${url(endpoint, resource, 'key')}${body}, headers=headers)`,
          '    # TODO: replace this test when the operation is written',
          '    assert response.status_code == 501',
        ),
      )
    }
  }
  // Protection, checked on the first endpoint that has it
  const protectedEndpoint = resource.endpoints.find((endpoint) => endpoint.access !== 'public')
  if (protectedEndpoint && context.settings.auth !== 'none' && protectedEndpoint.method === 'GET' && protectedEndpoint.input === 'none') {
    tests.push(
      lines(
        `def test_${pyNameOf(protectedEndpoint)}_needs_credentials(client: TestClient) -> None:`,
        `    response = client.get(${fixedUrl(protectedEndpoint, resource, missingKey(resource))})`,
        '    assert response.status_code == 401',
        '    assert response.json()["error"]["code"] == "unauthorized"',
      ),
    )
  }
  const withRoles = resource.endpoints.find(
    (endpoint) => endpoint.access === 'roles' && endpoint.method === 'GET' && endpoint.input === 'none',
  )
  if (withRoles && context.settings.auth === 'jwt') {
    tests.push(
      lines(
        `def test_${pyNameOf(withRoles)}_needs_a_role(client: TestClient, headers_without_roles: dict[str, str]) -> None:`,
        `    response = client.get(${fixedUrl(withRoles, resource, missingKey(resource))}, headers=headers_without_roles)`,
        '    assert response.status_code == 403',
      ),
    )
  }
  const usesSkip = tests.some((test) => test.startsWith('@pytest.mark.skip'))
  const importsHelpers = [...helpers].sort()
  const content = lines(
    pyDocstring(`Tests of the ${resource.plural} endpoints.`),
    '',
    usesSkip && 'import pytest',
    'from fastapi.testclient import TestClient',
    importsHelpers.length > 0 && ['', `from tests.helpers import ${importsHelpers.join(', ')}`],
    '',
    '',
    tests.length > 0 ? tests.join('\n\n\n') : `def test_${variable.many}_have_no_endpoints() -> None:\n    pass`,
  )
  return { path: `tests/test_${variable.many}.py`, content: fileText(content) }
}

function pyNameOf(endpoint: SpecEndpoint): string {
  return endpoint.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

function pyNameOfWire(wire: string): string {
  return wire.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

export function testFiles(context: FastApiContext): GeneratedFile[] {
  const files = [conftestFile(context), helpersFile(context), { path: 'tests/__init__.py', content: '' }]
  for (const resource of context.spec.resources) files.push(resourceTests(context, resource))
  return files
}
