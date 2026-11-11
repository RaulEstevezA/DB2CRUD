/**
 * Fields of a model in the endpoints pane: whether each one is in the API, what the client can do with it,
 * how related models travel, the type of fields the input leaves undefined, and the validations it
 * declares.
 */
import { decisionElementId } from '../../app/review.ts'
import { readConstraints } from '../../core/analysis/constraints.ts'
import type { ApiDesign, ResourceDesign } from '../../core/api/types.ts'
import { decide, setFieldInclude } from '../../core/design/edit.ts'
import { allFields, describeType, findModel, type ModelSchema } from '../../core/model/schema.ts'
import { useI18n } from '../../i18n/useI18n.ts'
import { DecisionControl } from '../common/DecisionControl.tsx'

export interface FieldTableProps {
  schema: ModelSchema
  resource: ResourceDesign
  keyField: string | null
  change: (edit: (design: ApiDesign) => ApiDesign) => void
}

export function FieldTable({ schema, resource, keyField, change }: FieldTableProps) {
  const { t } = useI18n()
  const model = findModel(schema, resource.model)
  if (!model) return null
  const definitions = new Map(allFields(schema, model).map((field) => [field.name, field]))
  return (
    <div className="field-table">
      <table>
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">{t.fieldInclude}</span>
            </th>
            <th scope="col">{t.fieldName}</th>
            <th scope="col">{t.fieldAccess}</th>
            <th scope="col">{t.fieldTravels}</th>
            <th scope="col">{t.fieldValidations}</th>
          </tr>
        </thead>
        <tbody>
          {resource.fields.map((field) => {
            const definition = definitions.get(field.field)
            const isKey = field.field === keyField
            const constraints = definition ? readConstraints(definition, schema.origin?.language) : null
            const subject = `${resource.model}.${field.field}`
            return (
              <tr key={field.field} className={field.include ? undefined : 'field-table__excluded'}>
                <td>
                  <input
                    type="checkbox"
                    checked={field.include}
                    disabled={isKey}
                    aria-label={t.includeField(field.field)}
                    title={isKey ? t.keyAlwaysIncluded : undefined}
                    onChange={(event) => change((design) => setFieldInclude(design, resource.model, field.field, event.target.checked))}
                  />
                </td>
                <td>
                  <span className="field-table__name">{field.field}</span>
                  {isKey && <span className="badge badge--accent">{t.keyBadge}</span>}
                  {definition && <span className="field-table__type">{definition.originalType ?? describeType(definition.type)}</span>}
                </td>
                <td>
                  <DecisionControl
                    compact
                    id={decisionElementId({ kind: 'access', model: resource.model, field: field.field })}
                    subject={t.accessSubject(subject)}
                    decision={field.access}
                    optionLabel={(value) => t.accessOptions[value]}
                    onChoose={(value) =>
                      change((design) => decide(design, { kind: 'access', model: resource.model, field: field.field }, value))
                    }
                    onAccept={() => change((design) => decide(design, { kind: 'access', model: resource.model, field: field.field }))}
                  />
                </td>
                <td>
                  {field.relation && (
                    <DecisionControl
                      compact
                      id={decisionElementId({ kind: 'relation', model: resource.model, field: field.field })}
                      subject={t.relationSubject(subject)}
                      decision={field.relation}
                      optionLabel={(value) => t.relationOptions[value]}
                      onChoose={(value) =>
                        change((design) => decide(design, { kind: 'relation', model: resource.model, field: field.field }, value))
                      }
                      onAccept={() => change((design) => decide(design, { kind: 'relation', model: resource.model, field: field.field }))}
                    />
                  )}
                  {field.unknownType && (
                    <DecisionControl
                      compact
                      id={decisionElementId({ kind: 'unknownType', model: resource.model, field: field.field })}
                      subject={t.unknownTypeSubject(subject)}
                      decision={field.unknownType}
                      optionLabel={(value) => t.unknownTypeOptions[value]}
                      onChoose={(value) =>
                        change((design) => decide(design, { kind: 'unknownType', model: resource.model, field: field.field }, value))
                      }
                      onAccept={() =>
                        change((design) => decide(design, { kind: 'unknownType', model: resource.model, field: field.field }))
                      }
                    />
                  )}
                  {!field.relation && !field.unknownType && <span className="field-table__plain">{t.travelsAsValue}</span>}
                </td>
                <td>
                  {constraints && constraints.sources.length > 0 ? (
                    <span className="field-table__validations" title={constraints.sources.join('\n')}>
                      {t.describeConstraints(constraints.constraints)}
                    </span>
                  ) : (
                    <span className="field-table__plain">—</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
