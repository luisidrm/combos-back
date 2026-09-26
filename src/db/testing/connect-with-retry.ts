import postgres from 'postgres';

// Windows Docker Desktop's WSL2 port-forwarding can lag behind a
// testcontainer reporting itself ready — by a variable, sometimes large
// amount. A single long connect_timeout isn't reliable (confirmed: the
// same container connection failed at both 30s and 60s on different runs,
// then succeeded immediately on a bare retry). Retrying the first real
// query a handful of times is more robust than trusting one big timeout.
// Used by every *.rls.test.ts file's beforeAll.
export async function connectWithRetry(
  connectionUri: string,
  { attempts = 10, delayMs = 3000 }: { attempts?: number; delayMs?: number } = {},
): Promise<postgres.Sql> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const sql = postgres(connectionUri, { connect_timeout: 10 });
    try {
      await sql`SELECT 1`;
      return sql;
    } catch (err) {
      lastError = err;
      await sql.end({ timeout: 1 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
