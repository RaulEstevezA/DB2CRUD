/**
 * The CRUD design (docs/design.md, section 3): what will be generated for each table of a physical
 * schema. Repositories with the queries the schema allows, services with their operations, and per table
 * the decisions the schema cannot settle. Every proposal carries its confidence and its reasons.
 *
 * Names are language-neutral camelCase (`getById`, `listByCustomerId`); each generator writes them in its
 * language's convention. Designs are plain JSON values: edits return new designs.
 */
import type { Decision } from '../decisions/decision.ts'

export type QueryKind = 'getByKey' | 'findByUnique' | 'findAllBy' | 'listByParent' | 'list' | 'insert' | 'update' | 'delete'

export type QueryReturns = 'one' | 'optional' | 'many' | 'none'

export interface QueryDesign {
  /** Stable within the table: `getByKey`, `findByUnique:email`, `listByParent:fk_orders_customer` */
  id: string
  kind: QueryKind
  name: string
  columns: string[]
  returns: QueryReturns
  include: Decision<boolean>
}

export interface RepositoryDesign {
  table: string
  /** Class name of the entity: the input's, or the one generated */
  entity: string
  /** The input has no class for this table (DDL), so the entity is generated */
  entityMissing: boolean
  queries: QueryDesign[]
}

export type OperationKind = 'create' | 'get' | 'list' | 'update' | 'delete' | 'find' | 'listByParent' | 'link' | 'unlink'

/** What an operation checks before writing, in this order. */
export type OperationCheck = 'validate' | 'unique' | 'parentExists' | 'version' | 'children'

export type DomainError = 'NotFound' | 'Conflict' | 'ValidationFailed'

export interface OperationDesign {
  /** Stable within the service: `create`, `find:email`, `link:order_tags` */
  id: string
  kind: OperationKind
  name: string
  /** Columns it looks up by (find, listByParent) */
  columns: string[]
  /** For link and unlink: the join table */
  through?: string
  include: Decision<boolean>
  checks: OperationCheck[]
  errors: DomainError[]
}

export interface ServiceDesign {
  table: string
  /** `ProductService` */
  name: string
  operations: OperationDesign[]
}

export type TableRole = 'entity' | 'join' | 'readOnly'

export type DeleteMode = { mode: 'hard' } | { mode: 'soft'; column: string }

export type Concurrency = { mode: 'none' } | { mode: 'version'; column: string }

/** Children whose foreign key declares no ON DELETE: block the delete, or delete them first in code. */
export type ChildrenPolicy = 'block' | 'deleteFirst'

export interface TablePolicy {
  table: string
  role: Decision<TableRole>
  delete: Decision<DeleteMode>
  concurrency: Decision<Concurrency>
  /** null when no child table depends on this one without an ON DELETE action */
  children: Decision<ChildrenPolicy> | null
  /** Columns never returned by the services */
  hidden: Decision<string[]>
}

export interface CrudDesign {
  policies: TablePolicy[]
  repositories: RepositoryDesign[]
  services: ServiceDesign[]
}

export const POLICY_DECISIONS = ['role', 'delete', 'concurrency', 'children', 'hidden'] as const

export type PolicyDecisionKind = (typeof POLICY_DECISIONS)[number]

export function findPolicy(design: CrudDesign, table: string): TablePolicy | undefined {
  return design.policies.find((policy) => policy.table === table)
}

export function findRepository(design: CrudDesign, table: string): RepositoryDesign | undefined {
  return design.repositories.find((repository) => repository.table === table)
}

export function findService(design: CrudDesign, table: string): ServiceDesign | undefined {
  return design.services.find((service) => service.table === table)
}
