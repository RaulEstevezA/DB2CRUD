/**
 * ASP.NET Core generator: writes a .NET 10 project with controllers, DataAnnotations validation, authentication
 * (API key or JWT bearer) and Entity Framework Core when it is chosen, with an xUnit test project. It composes
 * the modules of this folder; each writes one kind of file.
 */
import type { GeneratedFile, Generator } from '../../common/types.ts'
import { commonFiles, dataFiles, programFile, securityFiles } from './common.ts'
import { createContext } from './context.ts'
import { domainFile, dtoFiles, sharedFiles } from './model.ts'
import { repositoryFiles } from './persistence.ts'
import { gitignoreFile, projectFiles, readmeFile } from './project.ts'
import { testFiles } from './tests.ts'
import { controllerFile, serviceFile } from './web.ts'

export const aspNetCoreGenerator: Generator = {
  framework: 'aspnetCore',
  serverUrl: 'http://localhost:5000',
  generate({ spec, settings, openApi }) {
    const context = createContext(spec, settings)
    const code: GeneratedFile[] = [
      programFile(context),
      ...commonFiles(context),
      ...securityFiles(context),
      ...dataFiles(context),
      ...sharedFiles(context),
    ]
    for (const resource of spec.resources) {
      code.push(
        domainFile(context, resource),
        ...dtoFiles(context, resource),
        ...repositoryFiles(context, resource),
        serviceFile(context, resource),
        controllerFile(context, resource),
      )
    }
    return [
      readmeFile(context),
      gitignoreFile(),
      { path: 'openapi.yaml', content: openApi },
      ...projectFiles(context),
      ...code,
      ...testFiles(context),
    ]
  },
}
