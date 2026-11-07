import { UserService } from "@reqvia/example-domain";
import { createUniTransport } from "@reqvia/transport-uni";
import { createHttpClient } from "reqvia";

/** 检查客户端所需标准能力，缺失时在发起请求前给出原因 */
export function assertRuntimeSupport(): void {
  const missing = [];
  if (typeof URL !== "function") missing.push("URL");
  if (typeof performance === "undefined" || typeof performance.now !== "function")
    missing.push("performance.now()");
  if (missing.length > 0) throw new Error(`当前环境缺少标准能力：${missing.join("、")}`);
  const resolved = new URL("users", "https://example.test/api/");
  if (resolved.href !== "https://example.test/api/users" || !Number.isFinite(performance.now())) {
    throw new Error("当前环境的 URL 或单调时钟行为不符合要求");
  }
}

/** 在应用组装处选择原生请求器，业务 Service 不持有 UniApp 对象 */
export function createUsers(): UserService {
  assertRuntimeSupport();
  const baseURL =
    import.meta.env.VITE_API_BASE_URL ||
    (typeof location === "undefined" ? "http://127.0.0.1:4178/api/" : `${location.origin}/api/`);
  return new UserService(
    createHttpClient({
      baseURL,
      timeoutMs: 5_000,
      transport: createUniTransport({
        request: (options) => uni.request(options),
        capabilities: {
          methods: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
          requestBytes: true,
          responseBytes: true,
        },
      }),
    }),
  );
}
