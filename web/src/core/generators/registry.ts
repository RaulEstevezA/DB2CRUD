/**
 * Registry of the framework generators (Registry pattern). To support a new framework, write its
 * generator (common/types.ts), add it to `GENERATORS` and describe its options in compatibility/stack.ts.
 */
import type { ApiSpec } from '../api/spec.ts'
import type { FrameworkId, ProjectSettings } from '../compatibility/stack.ts'
import { openApiYaml } from '../openapi/build.ts'
import type { GeneratedFile, Generator } from './common/types.ts'
import { axumGenerator } from './frameworks/axum/index.ts'
import { aspNetCoreGenerator } from './frameworks/aspnetCore/index.ts'
import { djangoRestGenerator } from './frameworks/djangoRest/index.ts'
import { expressGenerator } from './frameworks/express/index.ts'
import { fastApiGenerator } from './frameworks/fastapi/index.ts'
import { ktorGenerator } from './frameworks/ktor/index.ts'
import { laravelGenerator } from './frameworks/laravel/index.ts'
import { nestJsGenerator } from './frameworks/nestjs/index.ts'
import { springBootGenerator } from './frameworks/springBoot/index.ts'
import { vaporGenerator } from './frameworks/vapor/index.ts'
import { symfonyGenerator } from './frameworks/symfony/index.ts'
import { compareText } from './common/text.ts'

const GENERATORS: Partial<Record<FrameworkId, Generator>> = {
  fastapi: fastApiGenerator,
  express: expressGenerator,
  springBoot: springBootGenerator,
  djangoRest: djangoRestGenerator,
  nestjs: nestJsGenerator,
  laravel: laravelGenerator,
  symfony: symfonyGenerator,
  aspnetCore: aspNetCoreGenerator,
  ktor: ktorGenerator,
  axum: axumGenerator,
  vapor: vaporGenerator,
}

/** The generator of a framework, or undefined while it is not written. */
export function findGenerator(framework: FrameworkId): Generator | undefined {
  return GENERATORS[framework]
}

/**
 * Writes the project of a resolved API with the chosen framework.
 *
 * @param spec The resolved API.
 * @param settings The project settings, already normalized.
 * @returns The files sorted by path, the OpenAPI contract included; empty when the framework has no generator.
 */
export function generateProject(spec: ApiSpec, settings: ProjectSettings): GeneratedFile[] {
  const generator = findGenerator(settings.framework)
  if (!generator) return []
  const openApi = openApiYaml(spec, generator.serverUrl)
  return generator.generate({ spec, settings, openApi }).sort((a, b) => compareText(a.path, b.path))
}
