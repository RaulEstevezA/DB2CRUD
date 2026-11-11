/**
 * NestJS generator: writes a TypeScript project with NestJS 11, class-validator and, when chosen, TypeORM.
 * It composes the modules of this folder; each writes one kind of file.
 */
import type { GeneratedFile, Generator } from '../../common/types.ts'
import { appModuleFile, commonFiles, databaseFile, mainFile, setupFile } from './app.ts'
import { createContext } from './context.ts'
import { dtoFile, sharedFile } from './dto.ts'
import { envExampleFile, gitignoreFile, packageFile, readmeFile, tsconfigFiles } from './project.ts'
import { controllerFile, moduleFile, repositoryFile, serviceFile } from './resource.ts'
import { testFiles } from './tests.ts'
import { entityFile } from './typeorm.ts'

export const nestJsGenerator: Generator = {
  framework: 'nestjs',
  serverUrl: 'http://localhost:3000',
  generate({ spec, settings, openApi }) {
    const context = createContext(spec, settings)
    const code: (GeneratedFile | null)[] = [
      mainFile(),
      setupFile(),
      appModuleFile(context),
      databaseFile(context),
      ...commonFiles(context),
      sharedFile(context),
    ]
    for (const resource of spec.resources) {
      code.push(
        dtoFile(context, resource),
        entityFile(context, resource),
        repositoryFile(context, resource),
        serviceFile(context, resource),
        controllerFile(context, resource),
        moduleFile(context, resource),
      )
    }
    return [
      readmeFile(context),
      packageFile(context),
      ...tsconfigFiles(),
      envExampleFile(context),
      gitignoreFile(),
      { path: 'openapi.yaml', content: openApi },
      ...code.filter((file): file is GeneratedFile => file !== null),
      ...testFiles(context),
    ]
  },
}
