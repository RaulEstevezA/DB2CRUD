import type { FieldDef, ModelDef } from '../model/schema.ts'
import type { SchemaContext, Shape } from './analysis.ts'
import type { Decision, EnumDesign, KeyChoice, RelationChoice, StorageTarget } from './types.ts'

/** What changes from one kind of database to another when proposing a design. Each kind is one
 * implementation, registered in design/propose.ts; the rest of the proposal is shared. */
export interface DesignStrategy {
  target: StorageTarget
  /** New keys the database can add, the first one being the suggestion */
  surrogateKeys: KeyChoice[]
  /** The key when no field identifies the model */
  keyWithoutField(model: ModelDef, fields: FieldDef[], options: KeyChoice[]): Decision<KeyChoice>
  /** How a field holding a model, a list, a map or a free value is stored */
  relation(context: SchemaContext, model: ModelDef, field: FieldDef, shape: Shape): Decision<RelationChoice>
  /** Whether scalar fields named after another model (`customerId`) are proposed as foreign keys */
  foreignKeys: boolean
  /** Whether numbers without a size named like counts (`quantity`) are proposed as whole numbers */
  wholeNumbers: boolean
  /** How each enum is stored; null when the database has a single way */
  enum(name: string): EnumDesign | null
}
