/**
 * What PHP generators write the same about the data (Laravel and Symfony): the backed enums of the API, and the
 * statements that give the fields a body leaves out their default values.
 */
import type { SpecField, SpecObject, SpecType } from '../../../api/spec.ts'
import type { JsonValue } from '../../common/samples.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { PhpImports, phpClass, phpDoc, phpHeader, phpLiteral, phpString } from './php.ts'
import type { PhpProject } from './project.ts'

/** The PHP enum of a spec enum, with a case per value. */
export function enumFiles(context: PhpProject, namespace: string): GeneratedFile[] {
  return context.spec.enums.map((item) => {
    const used = new Set<string>()
    const cases = item.values.map((value) => {
      const base = phpClass(String(value))
      let name = base
      for (let n = 2; used.has(name); n++) name = `${base}${n}`
      used.add(name)
      return `    case ${name} = ${item.valueType === 'integer' ? value : phpString(String(value))};`
    })
    const content = lines(
      ...phpHeader(namespace, new PhpImports(namespace)),
      phpDoc(`Values of ${item.name}, with the value each one has in JSON.`),
      `enum ${phpClass(item.name)}: ${item.valueType === 'integer' ? 'int' : 'string'}`,
      '{',
      cases,
      '}',
    )
    return { path: context.classPath(namespace, phpClass(item.name)), content: fileText(content) }
  })
}

/** PHP statements that give the fields left out of an object their defaults, nested objects included. */
export function fieldDefaults(
  context: Pick<PhpProject, 'spec'>,
  fields: SpecField[],
  target: string,
  depth: number,
  top: boolean,
): string[] {
  const statements: string[] = []
  for (const field of fields) {
    const access = `${target}[${phpString(field.wire)}]`
    if (top && field.defaultValue !== undefined && !field.required)
      statements.push(
        `if (! array_key_exists(${phpString(field.wire)}, ${target})) {`,
        `    ${access} = ${phpLiteral(field.defaultValue as JsonValue)};`,
        '}',
      )
    if (depth > 2 || field.reference) continue
    const inner = (type: SpecType): SpecObject | undefined =>
      type.kind === 'object' ? context.spec.objects.find((item) => item.name === type.name) : undefined
    const object = inner(field.type)
    if (object) {
      const nested = fieldDefaults(context, object.fields, access, depth + 1, true)
      if (nested.length > 0) statements.push(`if (isset(${access}) && is_array(${access})) {`, ...nested.map((line) => `    ${line}`), '}')
    }
    const items = field.type.kind === 'array' ? inner(field.type.items) : undefined
    if (items) {
      const index = `$index${depth}`
      const nested = fieldDefaults(context, items.fields, `${access}[${index}]`, depth + 1, true)
      if (nested.length > 0)
        statements.push(
          `foreach (array_keys(${access} ?? []) as ${index}) {`,
          `    if (is_array(${access}[${index}])) {`,
          ...nested.map((line) => `        ${line}`),
          '    }',
          '}',
        )
    }
  }
  return statements
}
