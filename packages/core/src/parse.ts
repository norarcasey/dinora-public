import type { z } from 'zod';

/**
 * The one way untyped data enters the domain: a network response, a storage read, a file
 * someone dropped in. The type comes from the schema, so there is one description of the
 * shape rather than a hand-written type and a validator that drift apart while both compile.
 *
 * A failure is a value rather than a throw so the caller has to say what it does with one.
 * The alternative that loses is `schema.parse` in a try with an empty catch, which turns
 * "the data was not what we thought" into "there was no data" — an absence that reads as a
 * pass.
 */
export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };

export function parse<S extends z.ZodType>(schema: S, input: unknown): Parsed<z.output<S>> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map(
      (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}
