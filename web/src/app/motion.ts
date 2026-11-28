/**
 * Fallback of the animation of the collapsible lists (personal_web_style patterns/fade-in.md, "Listas
 * desplegables"). Where the browser has `interpolate-size`, the CSS does it (styles/fade-in.css); elsewhere this
 * animates the height of a `<details>` when its summary is clicked, with the same duration and curve. It listens on
 * the document, so it also works for the lists React renders later. It switches itself off where the CSS can do it,
 * and can be deleted once every browser can.
 */

/** Same values as --fade-details (styles/tokens/shadows.css). */
const DURATION = 260
const EASING = 'cubic-bezier(0.2, 0, 0, 1)'

/** The animation running on each list, to cancel it when the list is clicked again. */
const running = new WeakMap<HTMLDetailsElement, Animation>()

/**
 * Opens or closes a list animating its height; at the end it leaves the native state.
 *
 * @param details The list whose summary was clicked.
 */
function toggle(details: HTMLDetailsElement): void {
  const target = details.dataset.motionTarget
  const opening = target ? target === 'closed' : !details.open
  const start = details.offsetHeight
  running.get(details)?.cancel()
  // Both states are measured without painting anything in between
  details.open = false
  const closed = details.offsetHeight
  details.open = true
  const open = details.offsetHeight
  details.dataset.motionTarget = opening ? 'open' : 'closed'
  const animation = details.animate({ height: [`${start}px`, `${opening ? open : closed}px`] }, { duration: DURATION, easing: EASING })
  running.set(details, animation)
  animation.onfinish = () => {
    details.open = opening
    delete details.dataset.motionTarget
    running.delete(details)
  }
}

/** Starts the fallback, unless the browser animates the lists itself. */
export function installMotion(): void {
  if (typeof CSS !== 'undefined' && CSS.supports?.('interpolate-size', 'allow-keywords')) return
  document.addEventListener('click', (event) => {
    const summary = (event.target as Element | null)?.closest?.('summary')
    const details = summary?.parentElement
    if (!(details instanceof HTMLDetailsElement) || typeof details.animate !== 'function') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    event.preventDefault()
    toggle(details)
  })
}
