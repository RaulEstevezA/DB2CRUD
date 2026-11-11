/**
 * Express generator: writes a TypeScript project with Express 5 and Zod 4. It composes the modules of this
 * folder; each writes one kind of file.
 */
import type { GeneratedFile, Generator } from '../../common/types.ts'
import { appFile, configFile, errorsFile, listingFile, securityFile, serverFile } from './app.ts'
import { createContext } from './context.ts'
import { repositoryFile } from './persistence.ts'
import { envExampleFile, gitignoreFile, packageFile, readmeFile, tsconfigFiles, vitestConfigFile } from './project.ts'
import { routesFile, serviceFile } from './routes.ts'
import { resourceSchemasFile, sharedFile } from './schemas.ts'
import { testFiles } from './tests.ts'

export const expressGenerator: Generator = {
  framework: 'express',
  serverUrl: 'http://localhost:3000',
  generate({ spec, settings, openApi }) {
    const context = createContext(spec, settings)
    const code: (GeneratedFile | null)[] = [
      appFile(context),
      serverFile(),
      configFile(context),
      errorsFile(),
      listingFile(),
      securityFile(context),
      sharedFile(context),
    ]
    for (const resource of spec.resources) {
      code.push(
        resourceSchemasFile(context, resource),
        repositoryFile(context, resource),
        serviceFile(context, resource),
        routesFile(context, resource),
      )
    }
    return [
      readmeFile(context),
      packageFile(context),
      ...tsconfigFiles(),
      vitestConfigFile(),
      envExampleFile(context),
      gitignoreFile(),
      { path: 'openapi.yaml', content: openApi },
      ...code.filter((file): file is GeneratedFile => file !== null),
      ...testFiles(context),
    ]
  },
}
