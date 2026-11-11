/**
 * The files of a generated project, as plain data: what the file tree shows, what is copied and what the
 * .zip holds.
 */

/** One file of a generated project, with its path relative to the project folder. */
export interface GeneratedFile {
  path: string
  content: string
}
