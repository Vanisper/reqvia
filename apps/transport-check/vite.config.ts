import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { createApiHandler } from "./scripts/server.mjs";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^vue$/,
        replacement: fileURLToPath(
          import.meta.resolve("@dcloudio/uni-h5-vue/dist/vue.runtime.esm.js"),
        ),
      },
    ],
  },
  plugins: [
    {
      name: "reqvia-local-http",
      configureServer(server) {
        const handle = createApiHandler();
        server.middlewares.use((request, response, next) => {
          void handle(request, response).then((handled) => {
            if (!handled) next();
          }, next);
        });
      },
    },
  ],
  run: {
    tasks: {
      build: {
        command: "tsc && vp build",
        dependsOn: [{ task: "build", from: "dependencies" }],
        cache: { output: ["dist/**"] },
      },
      verify: {
        command: "node scripts/verify.mjs",
        dependsOn: ["build"],
        cache: false,
      },
    },
  },
});
