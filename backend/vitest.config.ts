import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "src/**/*.test.ts", 
      "tests/api/**/*.test.ts", 
      "tests/durable-object/trading-bot.test.ts",
      "tests/durable-object/index.test.ts",
      "tests/stress/**/*.test.ts",
      "tests/reliability/**/*.test.ts"
    ],
    exclude: ["dist/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60,
      },
    },
  },
});
