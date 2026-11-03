import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "services/**/*.test.ts", "agents/**/*.test.ts"],
    environment: "node",
  },
});
