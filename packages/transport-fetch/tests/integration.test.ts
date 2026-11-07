import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vite-plus/test";
import {
  bytes,
  bytesBody,
  createCancellation,
  createHeaderFields,
  createHttpClient,
  empty,
  json,
  text,
} from "reqvia";
import type { CallOptions, HttpExecutor, Transport } from "reqvia";
import { createFetchTransport } from "../src/index.ts";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const user = { id: "42", name: "林舟" };
const binary = new Uint8Array([0, 128, 255, 13, 10]);
const slowClosed = new Map<string, ReturnType<typeof signal>>();
let baseURL: string;

afterEach(() => vi.restoreAllMocks());

async function handle(request: IncomingMessage, response: ServerResponse) {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  switch (path) {
    case "/users/42":
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(user));
      break;
    case "/unicode":
      response.setHeader("content-type", "text/plain;charset=utf-8");
      response.end("林舟 🌿");
      break;
    case "/bytes":
      response.setHeader("content-type", "application/octet-stream");
      response.end(binary);
      break;
    case "/echo": {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk as Uint8Array);
      response.setHeader("content-type", "application/octet-stream");
      response.end(Buffer.concat(chunks));
      break;
    }
    case "/empty":
      response.writeHead(204);
      response.end();
      break;
    case "/invalid":
      response.setHeader("content-type", "application/json");
      response.end("{");
      break;
    case "/missing":
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"message":"missing"}');
      break;
    case "/disconnect":
      request.socket.destroy();
      break;
    case "/slow-cancel":
    case "/slow-timeout":
      response.once("close", () => slowClosed.get(path)?.resolve());
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("正文尚未结束");
      break;
    default:
      response.writeHead(404);
      response.end();
  }
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    response.destroy(error instanceof Error ? error : new Error(String(error)));
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("测试服务地址无效");
  baseURL = `http://127.0.0.1:${address.port}/`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function nativeTransport(): Transport {
  return createFetchTransport({ fetch, createAbortController: () => new AbortController() });
}

function nativeClient() {
  return createHttpClient({ baseURL, transport: nativeTransport() });
}

test("真实 HTTP 请求读取 UTF-8 文本并交付最终地址", async () => {
  const response = await nativeClient().request({ url: "unicode" }, text());
  expect(response.data).toBe("林舟 🌿");
  expect(response.status).toBe(200);
  expect(response.url).toBe(`${baseURL}unicode`);
});

test("真实 HTTP 请求收发未经文本转换的字节", async () => {
  const client = nativeClient();
  const downloaded = await client.request({ url: "bytes" }, bytes());
  expect(downloaded.data).toEqual(binary);

  const uploaded = await client.request(
    { url: "echo", method: "POST", body: bytesBody(binary.subarray(1, 4)) },
    bytes(),
  );
  expect(uploaded.data).toEqual(new Uint8Array([128, 255, 13]));
});

test("204 响应遵循显式空正文解码", async () => {
  const response = await nativeClient().request({ url: "empty" }, empty());
  expect(response.status).toBe(204);
  expect(response.data).toBeNull();
});

test("真实 HTTP 状态失败保留正文而不执行成功解码", async () => {
  await expect(nativeClient().request({ url: "missing" }, json())).rejects.toMatchObject({
    kind: "STATUS",
    response: {
      status: 404,
      payload: { kind: "text", value: '{"message":"missing"}' },
    },
  });
});

test("真实响应中的非法 JSON 产生解码错误", async () => {
  await expect(nativeClient().request({ url: "invalid" }, json())).rejects.toMatchObject({
    kind: "DECODE",
  });
});

test("服务端断开连接产生传输失败", async () => {
  await expect(nativeClient().request({ url: "disconnect" }, text())).rejects.toMatchObject({
    kind: "TRANSPORT",
  });
});

function observedClient() {
  const reading = signal();
  const controller = new AbortController();
  const observedFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const readText = response.text.bind(response);
    vi.spyOn(response, "text").mockImplementation(() => {
      reading.resolve();
      return readText();
    });
    return response;
  };
  const http = createHttpClient({
    baseURL,
    transport: createFetchTransport({
      fetch: observedFetch,
      createAbortController: () => controller,
    }),
  });
  return { http, reading, controller };
}

test("收到响应头后取消能够中断尚未结束的真实正文", async () => {
  const { http, reading, controller } = observedClient();
  const source = createCancellation();
  const closed = signal();
  slowClosed.set("/slow-cancel", closed);
  const pending = http.request({ url: "slow-cancel" }, text(), {
    cancellation: source.cancellation,
  });
  const rejected = expect(pending).rejects.toMatchObject({ kind: "CANCELLED", reason: "页面关闭" });

  await reading.promise;
  source.cancel("页面关闭");
  await rejected;
  expect(controller.signal.aborted).toBe(true);
  await closed.promise;
});

test("总预算包含真实正文读取并通知底层取消", async () => {
  const { http, reading, controller } = observedClient();
  const closed = signal();
  slowClosed.set("/slow-timeout", closed);
  const pending = http.request({ url: "slow-timeout" }, text(), { timeoutMs: 1_000 });
  const rejected = expect(pending).rejects.toMatchObject({ kind: "TIMEOUT", timeoutMs: 1_000 });

  await reading.promise;
  await rejected;
  expect(controller.signal.aborted).toBe(true);
  await closed.promise;
});

interface User {
  id: string;
  name: string;
}

function parseUser(value: unknown): User {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("name" in value) ||
    typeof value.name !== "string"
  ) {
    throw new TypeError("用户响应格式无效");
  }
  return { id: value.id, name: value.name };
}

class UserService {
  constructor(private readonly http: HttpExecutor) {}

  async find(id: string, options?: CallOptions): Promise<User> {
    const response = await this.http.request(
      { url: `users/${encodeURIComponent(id)}` },
      json(parseUser),
      options,
    );
    return response.data;
  }
}

test("同一个 Service 可替换内存传输与真实 Fetch 传输", async () => {
  const memory: Transport = {
    async send(request) {
      expect(request.url).toBe(`${baseURL}users/42`);
      return {
        status: 200,
        headers: createHeaderFields([["content-type", "application/json"]]),
        payload: { kind: "text", value: JSON.stringify(user) },
      };
    },
  };

  for (const transport of [memory, nativeTransport()]) {
    const service = new UserService(createHttpClient({ baseURL, transport }));
    expect(await service.find("42")).toEqual(user);
  }
});
