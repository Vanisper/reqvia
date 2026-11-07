import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/browser.ts"],
    dts: { generator: "tsc" },
    exports: true,
    platform: "node",
    target: "node22",
  },
  run: {
    tasks: {
      build: { command: "vp pack", cache: { output: ["dist/**"] } },
      test: { command: "vp test", cache: false },
      start: { command: "node scripts/start.mjs", dependsOn: ["build"], cache: false },
    },
  },
});
