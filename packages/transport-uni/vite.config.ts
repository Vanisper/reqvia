import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: { generator: "tsgo" },
    exports: true,
    platform: "neutral",
    target: "es2022",
  },
  run: {
    tasks: {
      test: {
        command: "vp test",
        dependsOn: [{ task: "build", from: ["dependencies", "peerDependencies"] }],
      },
      build: {
        command: "vp pack",
        dependsOn: [{ task: "build", from: ["dependencies", "peerDependencies"] }],
        cache: { output: ["dist/**"] },
      },
    },
  },
});
