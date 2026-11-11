/**
 * Axum generator: writes a Rust project with Axum 0.8, serde, authentication (API key or JWT) and SeaORM when it
 * is chosen, built with Cargo. It composes the modules of this folder; each writes one kind of file. The module
 * declarations (`mod.rs`, `lib.rs`) are derived last, from the paths of the source files written.
 */
import type { GeneratedFile, Generator } from '../../common/types.ts'
import { commonFiles, databaseFile, mainFile, moduleFiles, securityFile } from './common.ts'
import { createContext } from './context.ts'
import { domainFile, dtoFile, sharedFiles } from './model.ts'
import { entityFile, repositoryFile } from './persistence.ts'
import { cargoFile, envExampleFile, gitignoreFile, readmeFile } from './project.ts'
import { testFiles } from './tests.ts'
import { routesFile, serviceFile } from './web.ts'

export const axumGenerator: Generator = {
  framework: 'axum',
  serverUrl: 'http://localhost:8080',
  generate({ spec, settings, openApi }) {
    const context = createContext(spec, settings)
    const code: GeneratedFile[] = [mainFile(context), ...commonFiles(context), ...sharedFiles(context)]
    for (const file of [securityFile(context), databaseFile(context)]) if (file) code.push(file)
    for (const resource of spec.resources) {
      const entity = entityFile(context, resource)
      code.push(
        domainFile(context, resource),
        dtoFile(context, resource),
        ...(entity ? [entity] : []),
        repositoryFile(context, resource),
        serviceFile(context, resource),
        routesFile(context, resource),
      )
    }
    code.push(
      ...moduleFiles(
        context,
        code.map((file) => file.path),
      ),
    )
    return [
      readmeFile(context),
      envExampleFile(context),
      gitignoreFile(),
      { path: 'openapi.yaml', content: openApi },
      cargoFile(context),
      ...code,
      ...testFiles(context),
    ]
  },
}
