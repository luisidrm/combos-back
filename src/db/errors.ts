// Postgres SQLSTATE 23505. Drizzle wraps the driver error, so the code can
// sit on the error itself or on its `cause` depending on the version/path.
export function isUniqueViolation(err: unknown): boolean {
  const code = (candidate: unknown): unknown =>
    typeof candidate === 'object' && candidate !== null ? (candidate as { code?: unknown }).code : undefined;
  return code(err) === '23505' || code((err as { cause?: unknown } | null)?.cause) === '23505';
}
