import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://buku:buku@localhost:5432/buku_test",
      // lib/db.ts prefers these over DATABASE_URL; blank them so a shell with hosted URLs can't redirect the DB tests (tests/helpers.ts).
      POSTGRES_PRISMA_URL: "",
      POSTGRES_URL: "",
      POSTGRES_URL_NON_POOLING: "",
      DIRECT_URL: "",
      AI_API_KEY: "",
      AI_MODEL: "",
    },
  },
});
