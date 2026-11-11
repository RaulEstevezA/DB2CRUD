/**
 * Parts of the workspace, in the order of the flow: the database, its CRUD design, then the project.
 */

/** The three parts, in order; below 1100px each one is a tab. */
export const WORKSPACE_PARTS = ['database', 'design', 'project'] as const

export type WorkspacePart = (typeof WORKSPACE_PARTS)[number]
