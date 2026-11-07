import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/cli.ts"],
    dts: false,
    exports: false,
    platform: "node",
    target: "node22",
  },
  run: {
    tasks: {
      build: {
        command: "vp pack",
        dependsOn: [{ task: "build", from: "dependencies" }],
        cache: { output: ["dist/**"] },
      },
      start: {
        command: "node dist/cli.mjs",
        dependsOn: ["build"],
        cache: false,
      },
      test: {
        command: "vp test",
        dependsOn: ["build"],
        cache: false,
      },
    },
  },
});
