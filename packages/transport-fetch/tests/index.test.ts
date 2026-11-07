import { expect, test, vi } from "vite-plus/test";
import { createCancellation } from "reqvia";
import type { Cancellation, TransportRequest } from "reqvia";
import { createFetchTransport } from "../src/index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function request(overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    url: "https://api.example.test/items",
    method: "GET",
    headers: {},
    representation: "text",
    ...overrides,
  };
}

function observingCancellation() {
  const source = createCancellation();
  const release = vi.fn();
  const cancellation: Cancellation = {
    get cancelled() {
      return source.cancellation.cancelled;
    },
    get reason() {
      return source.cancellation.reason;
    },
    subscribe(listener) {
      const unsubscribe = source.cancellation.subscribe(listener);
      return () => {
        release();
        unsubscribe();
      };
    },
  };
  return { source, cancellation, release };
}

test("保留文本、HTTP 失败状态与真实响应地址", async () => {
  const response = new Response('{"message":"未找到"}', {
    status: 404,
    headers: { "content-type": "application/json", "x-request-id": "trace-42" },
  });
  Object.defineProperty(response, "url", { value: "https://api.example.test/final" });
  const sendFetch = vi.fn<typeof fetch>().mockResolvedValue(response);
  const transport = createFetchTransport({
    fetch: sendFetch,
    createAbortController: () => new AbortController(),
  });
  const control = observingCancellation();
  const result = await transport.send(request(), control);

  expect(result.status).toBe(404);
  expect(result.payload).toEqual({ kind: "text", value: '{"message":"未找到"}' });
  expect(result.headers.get("X-REQUEST-ID")).toBe("trace-42");
  expect(result.url).toBe("https://api.example.test/final");
  expect(control.release).toHaveBeenCalledTimes(1);
  expect(sendFetch).toHaveBeenCalledTimes(1);
});

test("字节正文只发送视图范围并按字节读取响应", async () => {
  const body = new Uint8Array([99, 0, 255, 42]).subarray(1, 3);
  const response = new Response(new Uint8Array([0, 128, 255]));
  const readText = vi.spyOn(response, "text");
  const sendFetch = vi.fn<typeof fetch>().mockResolvedValue(response);
  const transport = createFetchTransport({
    fetch: sendFetch,
    createAbortController: () => new AbortController(),
  });

  const result = await transport.send(
    request({
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: { kind: "bytes", value: body },
      representation: "bytes",
    }),
    createCancellation(),
  );

  const [url, init] = sendFetch.mock.calls[0]!;
  expect(url).toBe("https://api.example.test/items");
  expect(init?.method).toBe("POST");
  expect(init?.headers).toEqual({ "content-type": "application/octet-stream" });
  expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(new Uint8Array([0, 255]));
  expect(body).toEqual(new Uint8Array([0, 255]));
  expect(result.payload).toEqual({ kind: "bytes", value: new Uint8Array([0, 128, 255]) });
  expect(readText).not.toHaveBeenCalled();
});

test("文本请求正文不会被再次序列化", async () => {
  const sendFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const transport = createFetchTransport({
    fetch: sendFetch,
    createAbortController: () => new AbortController(),
  });
  const result = await transport.send(
    request({ method: "POST", body: { kind: "text", value: "a=1&b=林舟" } }),
    createCancellation(),
  );
  expect(sendFetch.mock.calls[0]![1]?.body).toBe("a=1&b=林舟");
  expect(result.payload).toEqual({ kind: "text", value: "" });
  expect(result).not.toHaveProperty("url");
});

test("重复 Set-Cookie 保留各自值且不会重复追加", async () => {
  const cookies = ["a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT", "b=2; Path=/"];
  const response = new Response("ok", {
    headers: cookies.map((value) => ["set-cookie", value]),
  });
  const transport = createFetchTransport({
    fetch: async () => response,
    createAbortController: () => new AbortController(),
  });
  const result = await transport.send(request(), createCancellation());
  expect(result.headers.getAll("set-cookie")).toEqual(cookies);
});

test.each(["CONNECT", "TRACE", "TRACK", "trace"])(
  "发送前拒绝 Fetch 禁止的方法 %s",
  async (method) => {
    const sendFetch = vi.fn<typeof fetch>();
    const transport = createFetchTransport({
      fetch: sendFetch,
      createAbortController: () => new AbortController(),
    });
    await expect(transport.send(request({ method }), createCancellation())).rejects.toMatchObject({
      kind: "UNSUPPORTED",
      capability: `method:${method}`,
    });
    expect(sendFetch).not.toHaveBeenCalled();
  },
);

test.each(["opaque", "opaqueredirect"])("拒绝无法观察报文的 %s 响应", async (type) => {
  const response = new Response("hidden");
  Object.defineProperties(response, { type: { value: type }, status: { value: 0 } });
  const readText = vi.spyOn(response, "text");
  const transport = createFetchTransport({
    fetch: async () => response,
    createAbortController: () => new AbortController(),
  });
  await expect(transport.send(request(), createCancellation())).rejects.toMatchObject({
    kind: "UNSUPPORTED",
    capability: "observable-response",
  });
  expect(readText).not.toHaveBeenCalled();
});

test.each(["factory", "fetch", "body"])("%s 阶段异常保留原因并归为传输失败", async (stage) => {
  const cause = new Error("原生失败");
  const response = new Response("partial");
  if (stage === "body") vi.spyOn(response, "text").mockRejectedValue(cause);
  const control = observingCancellation();
  const transport = createFetchTransport({
    fetch: () => {
      if (stage === "fetch") throw cause;
      return Promise.resolve(response);
    },
    createAbortController: () => {
      if (stage === "factory") throw cause;
      return new AbortController();
    },
  });
  await expect(transport.send(request(), control)).rejects.toMatchObject({
    kind: "TRANSPORT",
    cause,
  });
  expect(control.release).toHaveBeenCalledTimes(stage === "factory" ? 0 : 1);
});

test("发送前取消不会创建原生任务", async () => {
  const source = createCancellation();
  source.cancel("结束");
  const sendFetch = vi.fn<typeof fetch>();
  const createAbortController = vi.fn(() => new AbortController());
  const transport = createFetchTransport({ fetch: sendFetch, createAbortController });

  await expect(transport.send(request(), source)).rejects.toMatchObject({
    kind: "TRANSPORT",
    cause: "结束",
  });
  expect(sendFetch).not.toHaveBeenCalled();
  expect(createAbortController).not.toHaveBeenCalled();
});

test("取消独立结束不响应中断的 Fetch 并消费迟到拒绝", async () => {
  const waiting = deferred<Response>();
  const controller = new AbortController();
  const transport = createFetchTransport({
    fetch: () => waiting.promise,
    createAbortController: () => controller,
  });
  const control = observingCancellation();
  const pending = transport.send(request(), control);
  const rejected = expect(pending).rejects.toMatchObject({ kind: "TRANSPORT", cause: "取消等待" });

  control.source.cancel("取消等待");
  await rejected;
  expect(controller.signal.aborted).toBe(true);
  expect(controller.signal.reason).toBe("取消等待");
  expect(control.release).toHaveBeenCalledTimes(1);

  waiting.reject(new Error("迟到的网络错误"));
  await Promise.resolve();
  await Promise.resolve();
});

test("正文读取悬挂时取消仍会结束等待并释放监听", async () => {
  const reading = deferred<void>();
  const body = deferred<string>();
  const response = new Response("unread");
  vi.spyOn(response, "text").mockImplementation(() => {
    reading.resolve();
    return body.promise;
  });
  const controller = new AbortController();
  const transport = createFetchTransport({
    fetch: async () => response,
    createAbortController: () => controller,
  });
  const control = observingCancellation();
  const pending = transport.send(request(), control);
  const rejected = expect(pending).rejects.toMatchObject({ kind: "TRANSPORT" });

  await reading.promise;
  control.source.cancel();
  await rejected;
  expect(controller.signal.aborted).toBe(true);
  expect(control.release).toHaveBeenCalledTimes(1);

  body.reject(new Error("迟到的正文错误"));
  await Promise.resolve();
  await Promise.resolve();
});

test("取消后迟到的响应会释放尚未读取的正文", async () => {
  const waiting = deferred<Response>();
  const releaseBody = vi.fn();
  const response = new Response(new ReadableStream({ cancel: releaseBody }));
  const source = createCancellation();
  const transport = createFetchTransport({
    fetch: () => waiting.promise,
    createAbortController: () => new AbortController(),
  });
  const pending = transport.send(request(), source);
  const rejected = expect(pending).rejects.toMatchObject({ kind: "TRANSPORT" });
  source.cancel();
  await rejected;

  waiting.resolve(response);
  await Promise.resolve();
  await Promise.resolve();
  expect(releaseBody).toHaveBeenCalledTimes(1);
});

test("订阅期间同步发生取消也会释放刚取得的监听", async () => {
  const release = vi.fn();
  const sendFetch = vi.fn<typeof fetch>();
  const controller = new AbortController();
  const cancellation: Cancellation = {
    cancelled: false,
    subscribe(listener) {
      listener();
      return release;
    },
  };
  const transport = createFetchTransport({
    fetch: sendFetch,
    createAbortController: () => controller,
  });
  await expect(transport.send(request(), { cancellation })).rejects.toMatchObject({
    kind: "TRANSPORT",
  });
  expect(release).toHaveBeenCalledTimes(1);
  expect(sendFetch).not.toHaveBeenCalled();
  expect(controller.signal.aborted).toBe(true);
});
