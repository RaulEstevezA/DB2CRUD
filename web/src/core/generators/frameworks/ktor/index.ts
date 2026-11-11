/**
 * Ktor generator: writes a Kotlin project with Ktor 3, kotlinx.serialization, authentication (API key or JWT) and
 * Exposed when it is chosen, built with Gradle. It composes the modules of this folder; each writes one kind of
 * file.
 */
import type { GeneratedFile, Generator } from '../../common/types.ts'
import { applicationFile, commonFiles, databaseFiles, securityFiles } from './common.ts'
import { createContext } from './context.ts'
import { domainFile, dtoFiles, sharedFiles } from './model.ts'
import { repositoryFiles } from './persistence.ts'
import { buildFiles, envExampleFile, gitignoreFile, readmeFile } from './project.ts'
import { testFiles } from './tests.ts'
import { routesFile, serviceFile } from './web.ts'

export const ktorGenerator: Generator = {
  framework: 'ktor',
  serverUrl: 'http://localhost:8080',
  generate({ spec, settings, openApi }) {
    const context = createContext(spec, settings)
    const code: GeneratedFile[] = [
      applicationFile(context),
      ...commonFiles(context),
      ...securityFiles(context),
      ...databaseFiles(context),
      ...sharedFiles(context),
    ]
    for (const resource of spec.resources) {
      code.push(
        domainFile(context, resource),
        ...dtoFiles(context, resource),
        ...repositoryFiles(context, resource),
        serviceFile(context, resource),
        routesFile(context, resource),
      )
    }
    return [
      readmeFile(context),
      envExampleFile(context),
      gitignoreFile(),
      { path: 'openapi.yaml', content: openApi },
      ...buildFiles(context),
      ...code,
      ...testFiles(context),
    ]
  },
}
