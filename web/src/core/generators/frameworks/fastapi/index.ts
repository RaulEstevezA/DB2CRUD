/**
 * FastAPI generator: writes a Python project with FastAPI, Pydantic 2 and, when chosen, SQLAlchemy 2.
 * It composes the modules of this folder; each writes one kind of file.
 */
import type { GeneratedFile, Generator } from '../../common/types.ts'
import { configFile, databaseFile, dependenciesFile, errorsFile, mainFile, securityFile } from './app.ts'
import { createContext } from './context.ts'
import { modelFile, repositoryFile } from './persistence.ts'
import { envExampleFile, gitignoreFile, pyprojectFile, readmeFile, requirementsFiles } from './project.ts'
import { routerFile, serviceFile } from './routes.ts'
import { resourceSchemasFile, sharedSchemasFile, validatorsFile } from './schemas.ts'
import { testFiles } from './tests.ts'

/** Empty `__init__.py` files that make every folder of `app/` a package. */
function packages(files: GeneratedFile[]): GeneratedFile[] {
  const folders = new Set<string>()
  for (const file of files) {
    if (!file.path.startsWith('app/')) continue
    const parts = file.path.split('/').slice(0, -1)
    for (let index = 1; index <= parts.length; index++) folders.add(parts.slice(0, index).join('/'))
  }
  return [...folders].map((folder) => ({ path: `${folder}/__init__.py`, content: '' }))
}

export const fastApiGenerator: Generator = {
  framework: 'fastapi',
  serverUrl: 'http://localhost:8000',
  generate({ spec, settings, openApi }) {
    const context = createContext(spec, settings)
    const app: (GeneratedFile | null)[] = [
      mainFile(context),
      configFile(context),
      errorsFile(context),
      validatorsFile(),
      securityFile(context),
      databaseFile(context),
      dependenciesFile(context),
      sharedSchemasFile(context),
    ]
    for (const resource of spec.resources) {
      app.push(
        resourceSchemasFile(context, resource),
        modelFile(context, resource),
        repositoryFile(context, resource),
        serviceFile(context, resource),
        routerFile(context, resource),
      )
    }
    const code = app.filter((file): file is GeneratedFile => file !== null)
    return [
      readmeFile(context),
      ...requirementsFiles(context),
      pyprojectFile(context),
      envExampleFile(context),
      gitignoreFile(),
      { path: 'openapi.yaml', content: openApi },
      ...code,
      ...packages(code),
      ...testFiles(context),
    ]
  },
}
