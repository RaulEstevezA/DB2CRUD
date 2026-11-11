import type { Todo } from '../physical/types.ts'

/** The comment written for a decision still pending, in English like the rest of the generated code.
 * `kind` names what the database stores models in: tables, collections of documents, or Redis hashes. */
export function todoText(todo: Todo, model: string, kind: 'table' | 'collection' | 'hash'): string {
  const { params } = todo
  const key = kind === 'table' ? 'primary key' : kind === 'collection' ? '_id' : 'key'
  switch (todo.code) {
    case 'relationPending':
      return `TODO: decide how "${model}.${params.field}" is stored (pending in the design).`
    case 'keyPending':
      return `TODO: choose the ${key} of "${params.model}".`
    case 'targetNotStored':
      return `TODO: "${model}.${params.field}" points to "${params.model}", which has no ${kind} of its own.`
    case 'foreignKeyTargetNotStored':
      return `TODO: "${params.column}" refers to "${params.model}", whose ${key} is not decided yet.`
  }
}
