/**
 * How resources refer to each other through their fields, embedded objects included. Every generator that
 * checks references before storing an item reads them the same way.
 */
import type { ApiSpec, SpecField, SpecResource } from '../../api/spec.ts'

/** Resources a resource refers to, directly or inside its embedded objects, other than itself. */
export function referencedResources(project: { spec: ApiSpec }, resource: SpecResource): SpecResource[] {
  const found = new Set<string>()
  const visit = (fields: SpecField[], seen: Set<string>) => {
    for (const field of fields) {
      if (field.reference) found.add(field.reference)
      const inner = innerObject(field.type)
      if (inner && !seen.has(inner)) {
        const object = project.spec.objects.find((item) => item.name === inner)
        if (object) visit(object.fields, new Set([...seen, inner]))
      }
    }
  }
  visit(resource.fields, new Set())
  found.delete(resource.name)
  return project.spec.resources.filter((item) => found.has(item.name))
}

/** The embedded object a type holds, directly or as the items of a list or map. */
export function innerObject(type: SpecField['type']): string | null {
  if (type.kind === 'object') return type.name
  if (type.kind === 'array') return innerObject(type.items)
  if (type.kind === 'map') return innerObject(type.value)
  return null
}
