/**
 * The files of the generated project as a tree of folders, to choose the one the viewer shows.
 */
import type { GeneratedFile } from '../../core/export/files.ts'
import { useI18n } from '../../i18n/useI18n.ts'

interface Folder {
  name: string
  folders: Map<string, Folder>
  files: GeneratedFile[]
}

/** Folders first, then files, each in alphabetical order. */
function buildTree(files: GeneratedFile[]): Folder {
  const root: Folder = { name: '', folders: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let folder = root
    for (const part of parts.slice(0, -1)) {
      if (!folder.folders.has(part)) folder.folders.set(part, { name: part, folders: new Map(), files: [] })
      folder = folder.folders.get(part)!
    }
    folder.files.push(file)
  }
  return root
}

export interface FileTreeProps {
  files: GeneratedFile[]
  selected: string | null
  onSelect: (path: string) => void
}

export function FileTree({ files, selected, onSelect }: FileTreeProps) {
  const { t } = useI18n()
  const tree = buildTree(files)

  function renderFolder(folder: Folder) {
    const folders = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name))
    const own = [...folder.files].sort((a, b) => a.path.localeCompare(b.path))
    return (
      <ul className="file-tree__list">
        {folders.map((child) => (
          <li key={child.name}>
            <details open>
              <summary className="file-tree__folder">{child.name}/</summary>
              {renderFolder(child)}
            </details>
          </li>
        ))}
        {own.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className="file-tree__file"
              aria-current={file.path === selected ? 'true' : undefined}
              title={file.path}
              onClick={() => onSelect(file.path)}
            >
              {file.path.split('/').pop()}
            </button>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <nav className="file-tree" aria-label={t.fileTreeLabel}>
      {renderFolder(tree)}
    </nav>
  )
}
