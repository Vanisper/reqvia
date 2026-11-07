import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const users = [
  { id: "42", name: "林舟", role: "工程师" },
  { id: "43", name: "陈希", role: "设计师" },
];

/** 本地示例后端的请求观察值 */
export interface RequestObservation {
  readonly query: string;
  readonly path: string;
  completed: boolean;
  aborted: boolean;
}

/** 可挂载到 Vite 或独立 HTTP 服务的示例 API */
export interface ExampleApi {
  /** 返回是否已处理该路径，未知非 API 路径留给页面服务 */
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  /** 释放延迟响应与未完成的连接 */
  close(): void;
  /** 仅供本地验收观察，不返回到业务接口 */
  readonly requests: readonly RequestObservation[];
}

/**
 * 创建用户列表与详情的本地示例后端
 *
 * @description 特殊查询 slow、fast、invalid、error、hang 用于演示并发、领域错误与取消
 */
export function createExampleApi(): ExampleApi {
  const requests: RequestObservation[] = [];
  const pending = new Set<ServerResponse>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  return {
    requests,
    async handle(request, response) {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!url.pathname.startsWith("/api/") && url.pathname !== "/__state") return false;
      // 三个本地消费端可以使用不同开发端口，接口不使用凭据或真实用户数据
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("access-control-allow-methods", "GET, OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type");
      if (request.method === "OPTIONS") {
        response.writeHead(204).end();
        return true;
      }
      if (url.pathname === "/__state") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ requests }));
        return true;
      }
      const query = url.searchParams.get("query") ?? "";
      const observation: RequestObservation = {
        query,
        path: url.pathname,
        completed: false,
        aborted: false,
      };
      requests.push(observation);
      pending.add(response);
      response.on("finish", () => {
        observation.completed = true;
      });
      response.on("close", () => {
        observation.aborted = !observation.completed;
        pending.delete(response);
      });
      const respond = (status: number, value: unknown) => {
        if (response.destroyed) return;
        response.writeHead(status, { "content-type": "application/json;charset=utf-8" });
        response.end(JSON.stringify(value));
      };
      const respondAfter = (delay: number, status: number, value: unknown) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          respond(status, value);
        }, delay);
        timers.add(timer);
        response.once("close", () => {
          clearTimeout(timer);
          timers.delete(timer);
        });
      };
      if (request.method !== "GET") {
        respond(405, { message: "method not allowed" });
        return true;
      }
      if (url.pathname === "/api/users") {
        if (query === "hang") return true;
        if (query === "error") {
          respond(503, { message: "示例服务暂不可用" });
          return true;
        }
        const result =
          query === "invalid"
            ? { invalid: true }
            : query === "slow"
              ? [users[0]]
              : query === "fast"
                ? [users[1]]
                : users.filter(
                    (user) => !query || `${user.id} ${user.name} ${user.role}`.includes(query),
                  );
        const delay = query === "slow" ? 400 : query === "fast" ? 20 : 0;
        if (delay) respondAfter(delay, 200, result);
        else respond(200, result);
      } else if (url.pathname.startsWith("/api/users/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/users/".length));
        if (id === "slow") respondAfter(2_000, 200, users[0]);
        else if (id === "invalid") respond(200, { id, name: 42 });
        else {
          const user = users.find((entry) => entry.id === id);
          respond(user ? 200 : 404, user ?? { message: "用户不存在" });
        }
      } else respond(404, { message: "接口不存在" });
      return true;
    },
    close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const response of pending) response.destroy();
      pending.clear();
    },
  };
}

/** 独立本地后端的启动选项 */
export interface ExampleServerOptions {
  /** 缺省使用空闲临时端口；始终只监听 127.0.0.1 */
  readonly port?: number;
  /** 同时托管构建产物，支持应用内路由刷新 */
  readonly serveDirectory?: string;
}

/** 运行中的本地示例服务 */
export interface ExampleServer {
  readonly origin: string;
  readonly baseURL: string;
  readonly requests: readonly RequestObservation[];
  /** 幂等停止服务并释放所有连接 */
  close(): Promise<void>;
}

/** 启动可供三个消费端及验收脚本共用的本地 HTTP 服务 */
export async function startExampleServer(
  options: ExampleServerOptions = {},
): Promise<ExampleServer> {
  const api = createExampleApi();
  const directory =
    options.serveDirectory === undefined ? undefined : resolve(options.serveDirectory);
  const server = createServer((request, response) => {
    void (async () => {
      if (await api.handle(request, response)) return;
      if (!directory) {
        response.writeHead(404).end();
        return;
      }
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      const filename = resolve(directory, `.${pathname === "/" ? "/index.html" : pathname}`);
      if (!filename.startsWith(`${directory}${sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const mime: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
      };
      try {
        const content = await readFile(filename);
        response.setHeader("content-type", mime[extname(filename)] ?? "application/octet-stream");
        response.end(content);
      } catch {
        if (extname(filename)) {
          response.writeHead(404).end();
          return;
        }
        response.setHeader("content-type", "text/html");
        response.end(await readFile(resolve(directory, "index.html")));
      }
    })().catch((error: unknown) => {
      if (error instanceof Error) response.destroy(error);
      else response.destroy();
    });
  });
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListening();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法取得示例服务端口");
  const origin = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  return {
    origin,
    baseURL: `${origin}/api/`,
    requests: api.requests,
    close() {
      closing ??= new Promise<void>((resolveClosed, reject) => {
        api.close();
        server.close((error) => (error ? reject(error) : resolveClosed()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
