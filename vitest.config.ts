import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30000,
    // testcontainers on Windows Docker Desktop is noticeably slower to
    // spin up a fresh Postgres than on native Linux — 30s wasn't enough.
    hookTimeout: 120000,
    // Each *.rls.test.ts spins up its own real Postgres container. Running
    // multiple of those concurrently overloads Docker Desktop's WSL2
    // networking on Windows enough that port-forwarding can time out
    // entirely (confirmed: the same test passes reliably alone, fails
    // when run alongside another testcontainers-based suite). One
    // module's RLS test more, and this stops being a maybe.
    fileParallelism: false,
  },
});
