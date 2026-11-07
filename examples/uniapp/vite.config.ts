import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      build: {
        command:
          "vue-tsc --noEmit && uni build --config uni.config.ts && uni build --config uni.config.ts -p mp-weixin",
        dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
        cache: { output: ["dist/**"] },
      },
      dev: {
        command: "uni --config uni.config.ts --host 127.0.0.1",
        dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
        cache: false,
      },
      "dev:weixin": {
        command: "uni --config uni.config.ts -p mp-weixin",
        dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
        cache: false,
      },
      "open:weixin": {
        command: "node scripts/open-weixin.mjs",
        dependsOn: ["build"],
        cache: false,
      },
      "verify:weixin": {
        command: "node scripts/verify-weixin.mjs",
        dependsOn: ["build", { task: "build", from: "devDependencies" }],
        cache: false,
      },
      verify: {
        command: "node scripts/verify.mjs && node scripts/verify.mjs --dev",
        dependsOn: ["build", { task: "build", from: "devDependencies" }],
        cache: false,
      },
    },
  },
});
