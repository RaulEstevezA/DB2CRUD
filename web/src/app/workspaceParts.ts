/**
 * Parts of the workspace, in the order of the flow. Only the input for now: the CRUD design and the
 * generated project are added back with the new core (ROADMAP).
 */

/** The parts, in order; below 1100px each one is a tab. */
export const WORKSPACE_PARTS = ['models'] as const

export type WorkspacePart = (typeof WORKSPACE_PARTS)[number]
