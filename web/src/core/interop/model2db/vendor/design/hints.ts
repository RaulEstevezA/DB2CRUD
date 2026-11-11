import type { Annotation, FieldDef, ModelDef } from '../model/schema.ts'
import { annotationArg } from '../parsers/code/annotations.ts'

/** What the input already says about persistence: keys, relations, uniqueness and sizes declared with
 * annotations, decorators or schema attributes (JPA, Hibernate, TypeORM, EF Core, Django, SQLAlchemy,
 * Prisma). A declared fact becomes an exact proposal; everything else is inferred. */

const simple = (name: string) =>
  name
    .split(/\.|::|\\/)
    .pop()!
    .replace(/Attribute$/, '')
    .toLowerCase()

function annotationsOf(item: { annotations?: Annotation[] }): Annotation[] {
  return item.annotations ?? []
}

function find(item: { annotations?: Annotation[] }, names: readonly string[]): Annotation | undefined {
  return annotationsOf(item).find((annotation) => names.includes(simple(annotation.name)))
}

/** `unique = true`, `unique=True`, `IsUnique = true`, `unique: true` inside the arguments. */
function argIsTrue(annotation: Annotation, name: string): boolean {
  return new RegExp(`(?:^|[\\s,({])${name}\\s*[:=]\\s*(true|True)\\b`).test(annotation.args ?? '')
}

const KEY_ANNOTATIONS = ['id', 'key', 'primarykey', 'primarycolumn', 'primarygeneratedcolumn', 'objectidcolumn', 'embeddedid']

export function declaresKey(field: FieldDef): boolean {
  if (field.metadata?.primaryKey === true) return true
  if (find(field, KEY_ANNOTATIONS)) return true
  return annotationsOf(field).some((annotation) => argIsTrue(annotation, 'primary_key') || argIsTrue(annotation, 'primary'))
}

export function declaresUnique(field: FieldDef): boolean {
  if (field.metadata?.unique === true) return true
  if (find(field, ['unique'])) return true
  return annotationsOf(field).some((annotation) => argIsTrue(annotation, 'unique') || argIsTrue(annotation, 'IsUnique'))
}

/** A text filled with a new UUID: Prisma's `@default(uuid())`, JPA's `@GeneratedValue(strategy =
 * GenerationType.UUID)` and Hibernate's `@UuidGenerator`. */
export function declaresUuidDefault(field: FieldDef): boolean {
  return annotationsOf(field).some((annotation) => {
    const name = simple(annotation.name)
    if (name === 'default') return /^\s*uuid\(/.test(annotation.args ?? '')
    if (name === 'generatedvalue') return /\bGenerationType\.UUID\b/.test(annotation.args ?? '')
    return name === 'uuidgenerator'
  })
}

export type DeclaredRelation = 'manyToOne' | 'oneToOne' | 'oneToMany' | 'manyToMany' | 'embedded' | 'elementCollection'

const RELATIONS: Record<string, DeclaredRelation> = {
  manytoone: 'manyToOne',
  foreignkey: 'manyToOne',
  onetoone: 'oneToOne',
  onetoonefield: 'oneToOne',
  onetomany: 'oneToMany',
  manytomany: 'manyToMany',
  manytomanyfield: 'manyToMany',
  embedded: 'embedded',
  embeddedid: 'embedded',
  elementcollection: 'elementCollection',
}

/** The kind of relation an annotation declares on a field (`@ManyToOne`, `models.ForeignKey`). Prisma's
 * `@relation(fields: [...])` marks the side that holds the foreign key. */
export function declaredRelation(field: FieldDef): DeclaredRelation | null {
  for (const annotation of annotationsOf(field)) {
    const relation = RELATIONS[simple(annotation.name)]
    if (relation) return relation
    if (simple(annotation.name) === 'relation' && /fields\s*:/.test(annotation.args ?? '')) return 'manyToOne'
  }
  return null
}

/** `@Embeddable` (JPA), `[Owned]` (EF Core), `[ComplexType]`: a value object without its own table. */
export function declaresEmbeddable(model: ModelDef): boolean {
  return find(model, ['embeddable', 'owned', 'complextype']) !== undefined
}

/** A declared maximum length: `@Size(max = 80)`, `@Column(length = 80)`, `[MaxLength(80)]`,
 * `@MaxLength(80)`, `max_length=80`, `String(80)`, `@db.VarChar(80)`. */
export function declaredLength(field: FieldDef): number | undefined {
  for (const annotation of annotationsOf(field)) {
    const name = simple(annotation.name)
    // SQLAlchemy and Prisma write the size inside a type: Column(String(50)), @db.VarChar(50)
    const typed = /\b(?:String|VARCHAR|VarChar|Varchar|CHAR|Char)\((\d+)\)/.exec(annotation.args ?? '')?.[1]
    if (typed) return Number(typed)
    const named = annotationArg(annotation, 'length') ?? annotationArg(annotation, 'max_length') ?? annotationArg(annotation, 'max')
    const value =
      named ??
      (['maxlength', 'stringlength', 'varchar', 'char', 'string', 'length'].includes(name) || name === 'db.varchar'
        ? /^\s*(\d+)/.exec(annotation.args ?? '')?.[1]
        : undefined)
    const length = value === undefined ? NaN : Number(value)
    if (Number.isInteger(length) && length > 0) return length
  }
  return undefined
}

/** A declared precision and scale for decimals: `@Column(precision = 10, scale = 2)`,
 * `DecimalField(max_digits=10, decimal_places=2)`, `Numeric(10, 2)`, `@db.Decimal(10, 2)`. */
export function declaredPrecision(field: FieldDef): { precision: number; scale: number } | undefined {
  for (const annotation of annotationsOf(field)) {
    const name = simple(annotation.name)
    const precision = Number(annotationArg(annotation, 'precision') ?? annotationArg(annotation, 'max_digits'))
    const scale = Number(annotationArg(annotation, 'scale') ?? annotationArg(annotation, 'decimal_places') ?? 0)
    if (Number.isInteger(precision) && precision > 0 && Number.isInteger(scale)) return { precision, scale }
    if (['numeric', 'decimal', 'precision'].includes(name)) {
      const match = /^\s*(\d+)\s*,\s*(\d+)/.exec(annotation.args ?? '')
      if (match) return { precision: Number(match[1]), scale: Number(match[2]) }
    }
  }
  return undefined
}
