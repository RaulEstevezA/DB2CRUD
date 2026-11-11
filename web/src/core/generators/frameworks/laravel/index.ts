/**
 * Laravel generator: writes a PHP project with Laravel 13, its own validation (Form Requests), and Eloquent
 * when it is chosen. It composes the modules of this folder; each writes one kind of file.
 */
import type { GeneratedFile, Generator } from '../../common/types.ts'
import { apiRequestFile, blankStringRuleFile, bootstrapFiles, configFile, errorRendererFile, providerFile, securityFiles } from './app.ts'
import { createContext } from './context.ts'
import { valuesFile } from '../../languages/php/storage.ts'
import { exceptionFiles, listingFiles } from '../../languages/php/support.ts'
import { migrationFile, modelFile, repositoryFiles } from './persistence.ts'
import { composerFile, envExampleFile, gitignoreFile, phpunitFile, readmeFile } from './project.ts'
import { enumFiles } from '../../languages/php/model.ts'
import { requestFiles } from './requests.ts'
import { testFiles } from './tests.ts'
import { serviceFile } from '../../languages/php/service.ts'
import { baseControllerFile, controllerFile, resourceFile, routesFile } from './web.ts'

export const laravelGenerator: Generator = {
  framework: 'laravel',
  serverUrl: 'http://localhost:8000',
  generate({ spec, settings, openApi }) {
    const context = createContext(spec, settings)
    const code: (GeneratedFile | null)[] = [
      ...bootstrapFiles(context),
      configFile(context),
      ...exceptionFiles(context),
      errorRendererFile(),
      ...listingFiles(context),
      valuesFile(context),
      apiRequestFile(),
      blankStringRuleFile(),
      ...securityFiles(context),
      providerFile(context),
      baseControllerFile(),
      routesFile(context),
      ...enumFiles(context, context.layout.enums()),
      migrationFile(context),
    ]
    for (const resource of spec.resources) {
      code.push(
        ...requestFiles(context, resource),
        resourceFile(context, resource),
        modelFile(context, resource),
        ...repositoryFiles(context, resource),
        serviceFile(context, resource),
        controllerFile(context, resource),
      )
    }
    return [
      readmeFile(context),
      composerFile(context),
      phpunitFile(context),
      envExampleFile(context),
      gitignoreFile(),
      { path: 'openapi.yaml', content: openApi },
      ...code.filter((file): file is GeneratedFile => file !== null),
      ...testFiles(context),
    ]
  },
}
