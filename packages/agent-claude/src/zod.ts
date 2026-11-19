/**
 * The Zod instance tool schemas must use.
 *
 * The Claude Code SDK validates tool arguments with its own Zod (v4, declared
 * as a peer dependency); a second major in the process would make every call
 * fail validation. Importing Zod from this package keeps tool schemas on the
 * SDK's instance by construction, instead of by convention.
 */
export { z } from 'zod';

/** A Zod raw shape, as `tool()` expects. */
export type RawShape = import('zod').ZodRawShape;
