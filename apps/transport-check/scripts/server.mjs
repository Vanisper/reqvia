/** 创建仅用于本地传输验收的 HTTP 路由与请求状态 */
export function createApiHandler() {
  const states = new Map();

  return async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/__state") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(states.get(url.searchParams.get("id")) ?? {}));
      return true;
    }
    if (!url.pathname.startsWith("/api/")) return false;

    switch (url.pathname) {
      case "/api/users/42":
        response.setHeader("content-type", "application/json;charset=UTF-8");
        response.end('{"id":"42","name":"林舟"}');
        break;
      case "/api/echo": {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        response.setHeader(
          "content-type",
          request.headers["content-type"] ?? "application/octet-stream",
        );
        response.end(Buffer.concat(chunks));
        break;
      }
      case "/api/empty":
        response.writeHead(204);
        response.end();
        break;
      case "/api/bad-json":
        response.setHeader("content-type", "application/json");
        response.end("{");
        break;
      case "/api/disconnect":
        response.writeHead(200, { "content-type": "text/plain", "content-length": "100" });
        response.write("partial");
        setTimeout(() => response.destroy(), 30);
        break;
      case "/api/slow": {
        const state = { opened: true, aborted: false, completed: false };
        states.set(url.searchParams.get("id"), state);
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.write("start");
        const timer = setTimeout(() => {
          state.completed = true;
          response.end("end");
        }, 3_000);
        // 服务端 close 早于完整发送，证明底层连接也结束，不能只依据外层 Promise
        response.on("close", () => {
          clearTimeout(timer);
          state.aborted = !state.completed;
        });
        break;
      }
      default:
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
    }
    return true;
  };
}
