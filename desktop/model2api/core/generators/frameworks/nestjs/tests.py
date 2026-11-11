"""Tests of the NestJS project (Jest + Supertest, end to end on the real application module). They are the tests of
the Express project with the NestJS flavor: the same cases, another runner and application setup. Mirrors
web/src/core/generators/frameworks/nestjs/tests.ts.
"""

from ..express.tests import TestFlavor
from ..express.tests import test_files as typescript_test_files
from .context import NestContext

NEST_FLAVOR = TestFlavor(
    folder="test",
    local="",
    client="server",
    client_type="Server",
    client_import="import type { Server } from 'node:http'",
    status="expect(response.status)",
    helper_imports=(),
    setup_first=("process.env.NODE_ENV = 'test'",),
    setup_export=True,
    test_imports=(
        "import type { Server } from 'node:http'",
        "import type { INestApplication } from '@nestjs/common'",
        "import { Test } from '@nestjs/testing'",
        "import request from 'supertest'",
        "import { AppModule } from '../src/app.module'",
        "import { configure } from '../src/app.setup'",
    ),
    test_declarations=("  let app: INestApplication", "  let server: Server"),
    test_hooks=(
        "  beforeEach(async () => {",
        "    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()",
        "    app = configure(moduleRef.createNestApplication())",
        "    await app.init()",
        "    server = app.getHttpServer()",
        "  })",
        "",
        "  afterEach(async () => {",
        "    await app.close()",
        "  })",
    ),
    test_suffix=".e2e-spec.ts",
)


def test_files(context: NestContext) -> list[dict]:
    return typescript_test_files(context, NEST_FLAVOR)
