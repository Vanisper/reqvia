import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    vue(),
    {
      name: "reqvia-example-api",
      async configureServer(server) {
        const { createExampleApi } = await import("@reqvia/example-server");
        const api = createExampleApi();
        server.httpServer?.once("close", () => api.close());
        server.middlewares.use((request, response, next) => {
          void api.handle(request, response).then((handled) => {
            if (!handled) next();
          }, next);
        });
      },
    },
  ],
  run: {
    tasks: {
      dev: {
        command: "vp dev",
        dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
        cache: false,
      },
      build: {
        command: "vue-tsc --noEmit && vp build",
        dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
        cache: { output: ["dist/**"] },
      },
      test: {
        command: "vp test",
        dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
      },
      verify: {
        command: "node scripts/verify.mjs",
        dependsOn: ["build"],
        cache: false,
      },
    },
  },
});
