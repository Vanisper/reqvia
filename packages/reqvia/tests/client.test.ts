import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  bytes,
  bytesBody,
  createCancellation,
  createHeaderFields,
  createHttpClient,
  createHttpError,
  json,
  text,
} from "../src/index.ts";
import type { Cancellation, HttpMessage, ResponseDecoder, Transport } from "../src/index.ts";

function message(value = "ok", status = 200): HttpMessage {
  return { status, headers: createHeaderFields([]), payload: { kind: "text", value } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function controlled() {
  const pending = deferred<HttpMessage>();
  let cancellation!: Cancellation;
  const send = vi.fn<Transport["send"]>((_request, control) => {
    cancellation = control.cancellation;
    return pending.promise;
  });
  const http = createHttpClient({ transport: { send }, baseURL: "https://example.test/v1/" });
  return {
    pending,
    send,
    http,
    get cancellation() {
      return cancellation;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("单次执行", () => {
  test("同一 Promise 重复等待不会再次发送，独立调用各自发送", async () => {
    const { http, pending, send } = controlled();
    const result = http.request({ url: "users" }, text());
    pending.resolve(message());
    expect((await result).data).toBe("ok");
    expect((await result).data).toBe("ok");
    expect(send).toHaveBeenCalledTimes(1);
    await http.request({ url: "users" }, text());
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("调用时固定正文、头、query 与解码函数", async () => {
    const { http, pending, send } = controlled();
    const content = new Uint8Array([1, 2]);
    const headers = { "X-Version": "first" };
    const query = { tag: ["first"] };
    const decoder = {
      representation: "text" as const,
      decode: (value: string) => `first:${value}`,
    };
    const result = http.request(
      { url: "users", method: "POST", body: bytesBody(content), headers, query },
      decoder,
    );
    content[0] = 99;
    headers["X-Version"] = "later";
    query.tag.push("later");
    decoder.decode = () => "later";
    pending.resolve(message());
    expect((await result).data).toBe("first:ok");
    expect(send.mock.calls[0]![0]).toMatchObject({
      url: "https://example.test/v1/users?tag=first",
      headers: { "x-version": "first" },
      body: { kind: "bytes", value: new Uint8Array([1, 2]) },
    });
  });

  test("派生实例独立合并配置并保持父实例不变", async () => {
    const send = vi.fn<Transport["send"]>(async () => message());
    const input = { authorization: "token", "x-name": "parent" };
    const http = createHttpClient({
      transport: { send },
      baseURL: "https://example.test/",
      headers: input,
    });
    const child = http.derive({ headers: { authorization: undefined, "X-Name": "child" } });
    input.authorization = "changed";
    await http.request({ url: "users" }, text());
    await child.request({ url: "users" }, text());
    expect(send.mock.calls[0]![0].headers).toEqual({ authorization: "token", "x-name": "parent" });
    expect(send.mock.calls[1]![0].headers).toEqual({ "x-name": "child" });
  });

  test("状态失败保留正文且不调用成功解码器", async () => {
    const decode = vi.fn(() => "unused");
    const http = createHttpClient({
      transport: { send: async () => message('{"error":"missing"}', 404) },
    });
    await expect(
      http.request({ url: "https://example.test/" }, { representation: "text", decode }),
    ).rejects.toMatchObject({
      kind: "STATUS",
      response: { status: 404, payload: { value: '{"error":"missing"}' } },
    });
    expect(decode).not.toHaveBeenCalled();
    const response = await http.request({ url: "https://example.test/" }, json(), {
      acceptStatus: (status) => status === 404,
    });
    expect(response.data).toEqual({ error: "missing" });
  });

  test("状态判断和异步解码抛出的任意值原样传播", async () => {
    const http = createHttpClient({ transport: { send: async () => message() } });
    const reason = { business: "failure" };
    await expect(
      http.request({ url: "https://example.test/" }, text(), {
        acceptStatus() {
          throw reason;
        },
      }),
    ).rejects.toBe(reason);
    await expect(
      http.request(
        { url: "https://example.test/" },
        {
          representation: "text",
          async decode() {
            throw reason;
          },
        },
      ),
    ).rejects.toBe(reason);
  });

  test("请求配置失败经 Promise 拒绝，创建与派生配置失败同步抛错", async () => {
    const { http, send } = controlled();
    await expect(http.request({ url: "https://other.test/" }, text())).rejects.toMatchObject({
      kind: "CONFIG",
    });
    await expect(
      http.request({ url: "users" }, text(), { timeoutMs: null as unknown as number }),
    ).rejects.toMatchObject({ kind: "CONFIG" });
    expect(() => http.derive({ timeoutMs: -1 })).toThrow();
    expect(() => createHttpClient({ transport: {} as Transport })).toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  test.each(["UNSUPPORTED", "TRANSPORT", "ADAPTER"] as const)(
    "保留适配器允许的 %s 错误",
    async (kind) => {
      const error =
        kind === "UNSUPPORTED"
          ? createHttpError({ kind, capability: "bytes" })
          : createHttpError({ kind });
      const http = createHttpClient({
        transport: {
          async send() {
            throw error;
          },
        },
      });
      await expect(http.request({ url: "https://example.test/" }, text())).rejects.toBe(error);
    },
  );

  test("原生传输失败保留 cause，越权错误归为 ADAPTER", async () => {
    const cause = new Error("offline");
    const http = createHttpClient({
      transport: {
        send() {
          throw cause;
        },
      },
    });
    await expect(http.request({ url: "https://example.test/" }, text())).rejects.toMatchObject({
      kind: "TRANSPORT",
      cause,
    });
    const other = createHttpClient({
      transport: {
        async send() {
          throw createHttpError({ kind: "TIMEOUT", timeoutMs: 1 });
        },
      },
    });
    await expect(other.request({ url: "https://example.test/" }, text())).rejects.toMatchObject({
      kind: "ADAPTER",
    });
  });

  test("无效响应表示与状态在解码前拒绝", async () => {
    const wrongRepresentation = createHttpClient({ transport: { send: async () => message() } });
    await expect(
      wrongRepresentation.request({ url: "https://example.test/" }, bytes()),
    ).rejects.toMatchObject({ kind: "ADAPTER" });
    const wrongStatus = createHttpClient({ transport: { send: async () => message("", 0) } });
    await expect(
      wrongStatus.request({ url: "https://example.test/" }, text()),
    ).rejects.toMatchObject({ kind: "ADAPTER" });
  });
});

describe("取消与总预算", () => {
  test("提前取消不发送", async () => {
    const { http, send } = controlled();
    const source = createCancellation();
    source.cancel("leave");
    await expect(
      http.request({ url: "users" }, text(), { cancellation: source.cancellation }),
    ).rejects.toMatchObject({ kind: "CANCELLED", reason: "leave" });
    expect(send).not.toHaveBeenCalled();
  });

  test("底层永不返回时取消仍结束等待，并通知物理取消", async () => {
    const context = controlled();
    const source = createCancellation();
    const result = context.http.request({ url: "users" }, text(), {
      cancellation: source.cancellation,
    });
    source.cancel("leave");
    await expect(result).rejects.toMatchObject({ kind: "CANCELLED", reason: "leave" });
    expect(context.cancellation.cancelled).toBe(true);
  });

  test("挂起传输到期后结束且不留下计时器", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const context = controlled();
    const result = context.http.request({ url: "users" }, text(), { timeoutMs: 50 });
    const assertion = expect(result).rejects.toMatchObject({ kind: "TIMEOUT", timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(context.cancellation.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(["cancel", "timeout"])("异步解码永不结束时仍响应 %s", async (mode) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const entered = deferred<void>();
    const source = createCancellation();
    const http = createHttpClient({ transport: { send: async () => message() } });
    const decoder: ResponseDecoder<string> = {
      representation: "text",
      decode() {
        entered.resolve();
        return new Promise(() => {});
      },
    };
    const result = http.request({ url: "https://example.test/" }, decoder, {
      timeoutMs: 50,
      cancellation: source.cancellation,
    });
    const assertion = expect(result).rejects.toMatchObject({
      kind: mode === "cancel" ? "CANCELLED" : "TIMEOUT",
    });
    await entered.promise;
    if (mode === "cancel") source.cancel();
    else await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  test("同步解码越过期限时不会抢先提交成功", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const http = createHttpClient({ transport: { send: async () => message() } });
    const result = http.request(
      { url: "https://example.test/" },
      {
        representation: "text",
        decode() {
          now = 60;
          return "late";
        },
      },
      { timeoutMs: 50 },
    );
    await expect(result).rejects.toMatchObject({ kind: "TIMEOUT" });
  });

  test("期限已到时取消得到 TIMEOUT，已经提交的取消不再变化", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const context = controlled();
    const source = createCancellation();
    const result = context.http.request({ url: "users" }, text(), {
      timeoutMs: 50,
      cancellation: source.cancellation,
    });
    now = 50;
    source.cancel();
    await expect(result).rejects.toMatchObject({ kind: "TIMEOUT" });
    now = 0;
    const second = createCancellation();
    const cancelled = context.http.request({ url: "users" }, text(), {
      timeoutMs: 50,
      cancellation: second.cancellation,
    });
    second.cancel();
    now = 100;
    await expect(cancelled).rejects.toMatchObject({ kind: "CANCELLED" });
  });

  test("成功后释放外部订阅，后续取消不改变结果", async () => {
    const source = createCancellation();
    const dispose = vi.fn();
    const cancellation: Cancellation = {
      get cancelled() {
        return source.cancellation.cancelled;
      },
      subscribe(listener) {
        const release = source.cancellation.subscribe(listener);
        return () => {
          dispose();
          release();
        };
      },
    };
    const http = createHttpClient({ transport: { send: async () => message() } });
    const pending = http.request({ url: "https://example.test/" }, text(), { cancellation });
    await pending;
    source.cancel();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((await pending).data).toBe("ok");
  });

  test("订阅期间同步取消也释放刚返回的订阅", async () => {
    const source = createCancellation();
    const dispose = vi.fn();
    const cancellation: Cancellation = {
      get cancelled() {
        return source.cancellation.cancelled;
      },
      subscribe(listener) {
        source.cancel();
        listener();
        return dispose;
      },
    };
    const { http, send } = controlled();
    await expect(http.request({ url: "users" }, text(), { cancellation })).rejects.toMatchObject({
      kind: "CANCELLED",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  test("取消后消费迟到的传输与解码拒绝", async () => {
    const context = controlled();
    const source = createCancellation();
    const result = context.http.request({ url: "users" }, text(), {
      cancellation: source.cancellation,
    });
    source.cancel();
    await expect(result).rejects.toMatchObject({ kind: "CANCELLED" });
    context.pending.reject(new Error("late transport"));
    const decoded = deferred<string>();
    const entered = deferred<void>();
    const other = createCancellation();
    const http = createHttpClient({ transport: { send: async () => message() } });
    const waiting = http.request(
      { url: "https://example.test/" },
      {
        representation: "text",
        decode() {
          entered.resolve();
          return decoded.promise;
        },
      },
      { cancellation: other.cancellation },
    );
    await entered.promise;
    other.cancel();
    await expect(waiting).rejects.toMatchObject({ kind: "CANCELLED" });
    decoded.reject(new Error("late decode"));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  test("零预算禁用计时，长预算不会溢出为立即超时", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const zero = controlled();
    const result = zero.http.request({ url: "users" }, text(), { timeoutMs: 0 });
    expect(vi.getTimerCount()).toBe(0);
    zero.pending.resolve(message());
    await result;
    const long = controlled();
    const second = long.http.request({ url: "users" }, text(), { timeoutMs: 2_147_483_648 });
    await vi.advanceTimersByTimeAsync(1);
    long.pending.resolve(message());
    expect((await second).data).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("取消源", () => {
  test("原因固定，监听者异常不阻断其他通知", () => {
    const source = createCancellation();
    source.cancellation.subscribe(() => {
      throw new Error("observer");
    });
    const listener = vi.fn();
    source.cancellation.subscribe(listener);
    source.cancel("first");
    source.cancel("second");
    expect(source.cancellation.reason).toBe("first");
    expect(listener).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    source.cancellation.subscribe(late)();
    expect(late).toHaveBeenCalledTimes(1);
  });

  test("同一函数的多次订阅可独立退订", () => {
    const source = createCancellation();
    const listener = vi.fn();
    const release = source.cancellation.subscribe(listener);
    source.cancellation.subscribe(listener);
    release();
    release();
    source.cancel();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
