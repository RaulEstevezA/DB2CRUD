/**
 * Links window under the workspace: the desktop download for the visitor's system, the source code and the
 * other tools (personal_web_style layouts/tool-page.md, "Enlaces finales").
 */
import { useEffect, useState } from 'react'
import { detectArchitecture, detectPlatform, downloadUrl, hasArchitectureChoice, type Architecture } from '../../app/desktopDownload.ts'
import { RELEASES_URL, SOURCE_URL, TOOLS_URL } from '../../app/links.ts'
import { useI18n } from '../../i18n/useI18n.ts'
import './LinksPanel.css'

// Read once: the system does not change while the page is open
const platform = detectPlatform(navigator)
const ARCHITECTURE_NAMES: Record<Architecture, string> = { x64: 'x64', arm64: 'ARM64' }

/** Download, source code and all tools, with a note on the unsigned desktop version. */
export function LinksPanel() {
  const { t } = useI18n()
  // x64 until the browser says otherwise; the note always links the other one in case it guessed wrong
  const [architecture, setArchitecture] = useState<Architecture>('x64')
  const choice = platform !== null && hasArchitectureChoice(platform)
  const otherArchitecture: Architecture = architecture === 'x64' ? 'arm64' : 'x64'

  useEffect(() => {
    if (!choice) return
    let active = true
    void detectArchitecture(navigator).then((detected) => {
      if (active && detected) setArchitecture(detected)
    })
    return () => {
      active = false
    }
  }, [choice])

  return (
    <section className="links window" aria-label={t.linksLabel}>
      <div className="actions">
        {platform ? (
          <a className="button" href={downloadUrl(platform, architecture)}>
            {t.downloadFor(architecture === 'arm64' && choice ? `${platform} ${ARCHITECTURE_NAMES.arm64}` : platform)}
          </a>
        ) : (
          <a className="button" href={RELEASES_URL} target="_blank" rel="noopener">
            {t.downloadDesktop}
          </a>
        )}
        <a className="button" href={SOURCE_URL} target="_blank" rel="noopener">
          {t.sourceCode}
        </a>
        <a className="button" href={TOOLS_URL}>
          {t.allTools}
        </a>
      </div>
      <p className="links__note">
        {t.downloadNote}{' '}
        <a href={t.howToOpenUrl} target="_blank" rel="noopener">
          {t.howToOpen}
        </a>
        {platform && choice && (
          <>
            {' · '}
            <a href={downloadUrl(platform, otherArchitecture)}>{t.otherArchitecture(ARCHITECTURE_NAMES[otherArchitecture])}</a>
          </>
        )}
        {platform && (
          <>
            {' · '}
            <a href={RELEASES_URL} target="_blank" rel="noopener">
              {t.otherPlatforms}
            </a>
          </>
        )}
      </p>
    </section>
  )
}
