import uniModule from "@dcloudio/vite-plugin-uni";
import type { ViteDevServer } from "vite-plus";

// 官方插件以 CommonJS 导出，ESM 配置加载器可能保留 default 包装
const uni = "default" in uniModule ? uniModule.default : uniModule;
if (typeof uni !== "function") throw new TypeError("Uni 编译插件未提供可调用的默认导出");

// Uni 编译器使用其官方 Vite 版本，工作区任务由旁边的 VP 配置调度
export default {
  // 小程序模块包装器遮蔽 URL，自由引用需指向应用入口补齐的全局构造器
  define: process.env.UNI_PLATFORM === "mp-weixin" ? { URL: "globalThis.URL" } : {},
  plugins: [
    uni(),
    {
      name: "reqvia-example-api",
      async configureServer(server: ViteDevServer) {
        const { createExampleApi } = await import("@reqvia/example-server");
        const api = createExampleApi();
        server.middlewares.use((request, response, next) => {
          void api.handle(request, response).then((handled) => {
            if (!handled) next();
          }, next);
        });
        server.httpServer?.once("close", () => api.close());
      },
    },
  ],
  server: { host: "127.0.0.1", port: 4179 },
};
