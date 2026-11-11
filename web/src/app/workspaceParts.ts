/**
 * Parts of the workspace, in the order of the flow: models, then their endpoints, then the project.
 */

/** The three parts, in order; below 1100px each one is a tab. */
export const WORKSPACE_PARTS = ['models', 'endpoints', 'project'] as const

/** One part of the workspace. */
export type WorkspacePart = (typeof WORKSPACE_PARTS)[number]
