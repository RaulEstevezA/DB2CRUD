/**
 * Enums and embedded objects shared by the resources.
 */



/** Values of Genre. */
export const GENRE = ['novel', 'essay', 'poetry', 'science'] as const
export type Genre = (typeof GENRE)[number]
