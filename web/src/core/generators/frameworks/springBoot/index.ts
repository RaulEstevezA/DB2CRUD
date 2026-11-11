/**
 * Spring Boot generator: writes a Java 21 project with Spring Boot, Bean Validation, Spring Security (when
 * authentication is chosen) and Spring Data JPA (when JPA is chosen). It composes the modules of this
 * folder; each writes one kind of file.
 */
import type { GeneratedFile, Generator } from '../../common/types.ts'
import { applicationFile, commonFiles, propertiesFiles, securityFiles } from './common.ts'
import { createContext } from './context.ts'
import { domainFile, dtoFiles, payloadFile, sharedFiles } from './model.ts'
import { repositoryFiles } from './persistence.ts'
import { envExampleFile, gitignoreFile, pomFile, readmeFile } from './project.ts'
import { testFiles } from './tests.ts'
import { controllerFile, serviceFile } from './web.ts'

export const springBootGenerator: Generator = {
  framework: 'springBoot',
  serverUrl: 'http://localhost:8080',
  generate({ spec, settings, openApi }) {
    const context = createContext(spec, settings)
    const code: GeneratedFile[] = [
      applicationFile(context),
      payloadFile(context),
      ...commonFiles(context),
      ...securityFiles(context),
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
      pomFile(context),
      envExampleFile(context),
      gitignoreFile(),
      { path: 'openapi.yaml', content: openApi },
      ...code,
      ...propertiesFiles(context),
      ...testFiles(context),
    ]
  },
}
