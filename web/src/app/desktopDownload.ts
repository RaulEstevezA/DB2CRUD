/**
 * Chooses the desktop download for the visitor's system.
 *
 * Only the browser's own information is read; nothing is requested from GitHub until the visitor clicks.
 */
import { RELEASES_URL } from './links.ts'

/** Systems with a desktop build. */
export type DesktopPlatform = 'macOS' | 'Windows' | 'Linux'

/** Processor architectures with a desktop build. */
export type Architecture = 'x64' | 'arm64'

/** Release asset of each build. macOS has a single build, for Apple Silicon. */
const ASSETS: Record<DesktopPlatform, Partial<Record<Architecture, string>>> = {
  macOS: { arm64: 'Model2API-macOS.dmg' },
  Windows: { x64: 'Model2API-Windows.zip', arm64: 'Model2API-Windows-ARM64.zip' },
  Linux: { x64: 'Model2API-Linux.tar.gz', arm64: 'Model2API-Linux-ARM64.tar.gz' },
}

/**
 * Tells whether a system has one build per architecture, so the visitor may need to pick one.
 *
 * @param platform The visitor's system.
 * @returns `true` when there is more than one build.
 */
export function hasArchitectureChoice(platform: DesktopPlatform): boolean {
  return Object.keys(ASSETS[platform]).length > 1
}

/**
 * Builds the download address of a build in the latest release.
 *
 * @param platform The system.
 * @param architecture The architecture; a system with a single build ignores it.
 * @returns The address of the release asset.
 */
export function downloadUrl(platform: DesktopPlatform, architecture: Architecture = 'x64'): string {
  const assets = ASSETS[platform]
  return `${RELEASES_URL}/download/${assets[architecture] ?? Object.values(assets)[0]}`
}

/** The parts of `navigator` the detection reads, so tests can pass their own. */
export interface NavigatorInfo {
  userAgent: string
  platform?: string
  maxTouchPoints?: number
  /** User-Agent Client Hints: only in Chromium browsers (Chrome, Edge…). */
  userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }> }
}

/**
 * Detects the visitor's desktop system.
 *
 * @param navigator The browser's information.
 * @returns The system, or `null` on phones, tablets and anything unknown.
 */
export function detectPlatform({ userAgent, platform = '', maxTouchPoints = 0 }: NavigatorInfo): DesktopPlatform | null {
  const text = `${platform} ${userAgent}`
  if (/android|iphone|ipad|ipod|mobile/i.test(text)) return null
  // iPadOS presents itself as a Mac; a touch screen gives it away
  if (/mac/i.test(text)) return maxTouchPoints > 1 ? null : 'macOS'
  if (/win/i.test(text)) return 'Windows'
  if (/linux|x11/i.test(text) && !/cros/i.test(text)) return 'Linux'
  return null
}

/**
 * Detects the processor architecture.
 *
 * Windows browsers always claim x64 in the user agent, so only Client Hints can tell an ARM laptop;
 * Firefox on Linux names it in the user agent. Safari and Firefox on Windows do not give it at all.
 *
 * @param navigator The browser's information.
 * @returns The architecture, or `null` when the browser does not tell.
 */
export async function detectArchitecture({ userAgent, platform = '', userAgentData }: NavigatorInfo): Promise<Architecture | null> {
  if (/aarch64|arm64/i.test(`${platform} ${userAgent}`)) return 'arm64'
  try {
    const { architecture } = (await userAgentData?.getHighEntropyValues(['architecture'])) ?? {}
    if (architecture === 'arm') return 'arm64'
    if (architecture === 'x86') return 'x64'
  } catch {
    // The browser refused the hint: same as not knowing
  }
  return null
}
