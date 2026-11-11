/**
 * Enums and embedded objects shared by the resources.
 */

import { z } from 'zod'

/** Values of Genre. */
export const Genre = z.enum(['novel', 'essay', 'poetry', 'science'])
export type Genre = z.infer<typeof Genre>
