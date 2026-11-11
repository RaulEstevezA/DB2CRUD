/**
 * Django REST Framework generator: writes a Python project with Django, Django REST Framework and the
 * Django ORM. It composes the modules of this folder; each writes one kind of file.
 */
import type { Generator } from '../../common/types.ts'
import { Modules, createContext } from './context.ts'
import { enumBlocks, modelBlocks } from './models.ts'
import { configFiles, envExampleFile, gitignoreFile, readmeFile, requirementsFiles } from './project.ts'
import { serializerBlocks } from './serializers.ts'
import { testFiles } from './tests.ts'
import { serviceAndViewBlocks } from './views.ts'

export const djangoRestGenerator: Generator = {
  framework: 'djangoRest',
  serverUrl: 'http://localhost:8000',
  generate({ spec, settings, openApi }) {
    const context = createContext(spec, settings)
    const modules = new Modules()
    enumBlocks(context, modules)
    modelBlocks(context, modules)
    serializerBlocks(context, modules)
    const urls = serviceAndViewBlocks(context, modules)
    return [
      readmeFile(context),
      ...requirementsFiles(context),
      envExampleFile(context),
      gitignoreFile(),
      { path: 'openapi.yaml', content: openApi },
      ...configFiles(context),
      ...modules.files(),
      ...urls,
      ...testFiles(context),
    ]
  },
}
