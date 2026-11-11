/**
 * Vapor generator: writes a Swift project with Vapor 4, authentication (API key or JWT) and Fluent when it is
 * chosen, built with the Swift Package Manager. It composes the modules of this folder; each writes one kind of
 * file.
 */
import type { GeneratedFile, Generator } from '../../common/types.ts'
import { commonFiles, configureFile, databaseFile, entrypointFile, securityFile } from './common.ts'
import { createContext } from './context.ts'
import { domainFile, dtoFile, sharedFiles } from './model.ts'
import { recordFile, repositoryFile } from './persistence.ts'
import { envExampleFile, gitignoreFile, packageFile, readmeFile } from './project.ts'
import { testFiles } from './tests.ts'
import { controllerFile, serviceFile } from './web.ts'

export const vaporGenerator: Generator = {
  framework: 'vapor',
  serverUrl: 'http://localhost:8080',
  generate({ spec, settings, openApi }) {
    const context = createContext(spec, settings)
    const code: GeneratedFile[] = [entrypointFile(), configureFile(context), ...commonFiles(context), ...sharedFiles(context)]
    for (const file of [securityFile(context), databaseFile(context)]) if (file) code.push(file)
    for (const resource of spec.resources) {
      const record = recordFile(context, resource)
      code.push(
        domainFile(context, resource),
        dtoFile(context, resource),
        ...(record ? [record] : []),
        repositoryFile(context, resource),
        serviceFile(context, resource),
        controllerFile(context, resource),
      )
    }
    return [
      readmeFile(context),
      envExampleFile(context),
      gitignoreFile(),
      { path: 'openapi.yaml', content: openApi },
      packageFile(context),
      ...code,
      ...testFiles(context),
    ]
  },
}
