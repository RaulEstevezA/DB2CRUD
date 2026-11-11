/**
 * Pane: one column of the workspace, with a title bar, a body that scrolls inside and an optional footer
 * (personal_web_style components/cards.md, "Pane").
 */
import type { ReactNode } from 'react'
import './Pane.css'

/** What a pane shows. */
export interface PaneProps {
  /** Title of the pane; also its accessible name. */
  title: string
  /** Buttons or selects in the title bar. */
  actions?: ReactNode
  /** Status or actions under the body. */
  footer?: ReactNode
  /** Content of the body. */
  children: ReactNode
}

/** A workspace column that fills the height it is given; its body scrolls, not the page. */
export function Pane({ title, actions, footer, children }: PaneProps) {
  return (
    <section className="pane" aria-label={title}>
      <div className="pane__header">
        <h2 className="pane__title">{title}</h2>
        {actions && <div className="pane__actions">{actions}</div>}
      </div>
      <div className="pane__body">{children}</div>
      {footer && <div className="pane__footer">{footer}</div>}
    </section>
  )
}
