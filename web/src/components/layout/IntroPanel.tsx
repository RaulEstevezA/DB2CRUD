/**
 * Presentation of the tool: icon and name, what it does and the examples to start
 * from. Styled like the website's windows (personal_web_style layouts/tool-page.md).
 */
import { EXAMPLES, type ExampleId } from '../../examples/index.ts'
import { useI18n } from '../../i18n/useI18n.ts'
import './IntroPanel.css'

/** Window at the top of the page: the first thing a visitor reads. */
export function IntroPanel({ onExample }: { onExample: (id: ExampleId) => void }) {
  const { t } = useI18n()

  return (
    <section className="intro window" aria-labelledby="intro-title">
      <div className="intro__text">
        <div className="intro__title">
          <h1 id="intro-title" className="intro__name">
            {/* Decorative: the accessible name of the title is the tool's name */}
            <img className="intro__icon" src={`${import.meta.env.BASE_URL}favicon.svg`} width="32" height="32" alt="" />
            DB2CRUD
          </h1>
          <span className="intro__badge">{t.processedLocally}</span>
        </div>
        <p className="intro__subtitle">{t.tagline}</p>
        <p className="intro__description">{t.introDescription}</p>
      </div>
      <div className="intro__side">
        <div className="intro__examples" role="group" aria-labelledby="examples-label">
          <span id="examples-label" className="intro__examples-label">
            {t.examplesLabel}
          </span>
          <div className="intro__example-list">
            {EXAMPLES.map((example) => (
              <button
                key={example.id}
                type="button"
                className="button"
                title={t.exampleDescriptions[example.id]}
                onClick={() => onExample(example.id)}
              >
                {t.examples[example.id]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
