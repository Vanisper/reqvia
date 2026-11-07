import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createCancellation, createHttpClient, isHttpError, json, text } from "reqvia";
import type { Cancellation, TransportRequest } from "reqvia";
import { createUniTransport } from "../src/index.ts";
import type {
  UniRequestMethod,
  UniRequestOptions,
  UniRequestResponse,
  UniTransportCapabilities,
  UniTransportOptions,
} from "../src/index.ts";

function request(overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    url: "https://api.example.test/items",
    method: "GET",
    headers: {},
    representation: "text",
    ...overrides,
  };
}

function response(overrides: Partial<UniRequestResponse> = {}): UniRequestResponse {
  return { statusCode: 200, data: "ok", header: {}, ...overrides };
}

function adapter(
  sendRequest: UniTransportOptions["request"],
  capabilities: Partial<UniTransportCapabilities> = {},
) {
  return createUniTransport({
    request: sendRequest,
    capabilities: {
      methods: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
      requestBytes: true,
      responseBytes: true,
      ...capabilities,
    },
  });
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("参数与响应映射", () => {
  test("保留 JSON 原始文本并关闭平台解析，不补造最终 URL", async () => {
    const abort = vi.fn();
    const sendRequest = vi.fn<UniTransportOptions["request"]>((options) => {
      options.success(response({ data: '{"name":"林舟"}', header: { "X-Trace": "42" } }));
      return { abort };
    });
    const headers = { authorization: "token" };
    const control = observingCancellation();
    const result = await adapter(sendRequest).send(request({ headers }), control);

    const [options] = sendRequest.mock.calls[0]!;
    expect(options).toMatchObject({
      url: "https://api.example.test/items",
      method: "GET",
      header: { authorization: "token" },
      dataType: "text",
      responseType: "text",
    });
    expect(options).not.toHaveProperty("data");
    expect(options.header).not.toBe(headers);
    expect(result.payload).toEqual({ kind: "text", value: '{"name":"林舟"}' });
    expect(result.headers.get("x-trace")).toBe("42");
    expect(result).not.toHaveProperty("url");
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(control.release).toHaveBeenCalledTimes(1);
    control.source.cancel();
    expect(abort).not.toHaveBeenCalled();
  });

  test("文本请求正文原样发送，空正文仍属于显式 data", async () => {
    const sendRequest = vi.fn<UniTransportOptions["request"]>((options) => {
      options.success(response({ statusCode: 204, data: "" }));
      return { abort() {} };
    });
    const transport = adapter(sendRequest);
    for (const value of ["a=1&name=林舟", ""]) {
      const result = await transport.send(
        request({ method: "POST", body: { kind: "text", value } }),
        createCancellation(),
      );
      expect(sendRequest.mock.lastCall?.[0].data).toBe(value);
      expect(result.payload).toEqual({ kind: "text", value: "" });
    }
  });

  test("字节请求只复制视图范围，响应交付后不受原始缓冲区修改影响", async () => {
    const buffer = new Uint8Array([99, 0, 255, 88]);
    const body = buffer.subarray(1, 3);
    const received = new Uint8Array([0, 128, 255]);
    let complete!: UniRequestOptions["success"];
    const sendRequest = vi.fn<UniTransportOptions["request"]>((options) => {
      complete = options.success;
      return { abort() {} };
    });
    const pending = adapter(sendRequest).send(
      request({ method: "POST", body: { kind: "bytes", value: body }, representation: "bytes" }),
      createCancellation(),
    );
    body.fill(42);
    const options = sendRequest.mock.calls[0]![0];
    expect(options.responseType).toBe("arraybuffer");
    expect(options.data).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(options.data as ArrayBuffer)).toEqual(new Uint8Array([0, 255]));
    complete(response({ data: received.buffer }));
    received.fill(42);
    expect((await pending).payload).toEqual({
      kind: "bytes",
      value: new Uint8Array([0, 128, 255]),
    });
  });

  test.each([400, 404, 500, 503])("HTTP %i 交付完整报文，由核心判断状态", async (statusCode) => {
    const result = await adapter((options) => {
      options.success(response({ statusCode, data: '{"error":"failed"}' }));
      return { abort() {} };
    }).send(request(), createCancellation());
    expect(result.status).toBe(statusCode);
    expect(result.payload).toEqual({ kind: "text", value: '{"error":"failed"}' });
  });

  test("响应头保留重复值并隔离平台容器的后续修改", async () => {
    const cookies = ["session=a; Path=/", "pref=b; Path=/"];
    const header = { "Set-Cookie": cookies, "X-Trace": "original" };
    const result = await adapter((options) => {
      options.success(response({ header }));
      cookies.push("late=c");
      header["X-Trace"] = "changed";
      return { abort() {} };
    }).send(request(), createCancellation());
    expect(result.headers.getAll("set-cookie")).toEqual(["session=a; Path=/", "pref=b; Path=/"]);
    expect(result.headers.get("x-trace")).toBe("original");
  });

  test.each([
    ["text", { already: "parsed" }],
    ["text", new ArrayBuffer(0)],
    ["bytes", "re-encoding is not allowed"],
    ["bytes", new Uint8Array([1, 2])],
  ] as const)("%s 响应拒绝不符合表示的原生数据 %#", async (representation, data) => {
    await expect(
      adapter((options) => {
        options.success(response({ data }));
        return { abort() {} };
      }).send(request({ representation }), createCancellation()),
    ).rejects.toMatchObject({ kind: "ADAPTER" });
  });

  test.each([0, 199, 600, 200.5, Number.NaN])("拒绝无效状态码 %s", async (statusCode) => {
    await expect(
      adapter((options) => {
        options.success(response({ statusCode }));
        return { abort() {} };
      }).send(request(), createCancellation()),
    ).rejects.toMatchObject({ kind: "ADAPTER" });
  });

  test.each([
    null,
    [],
    "headers",
    { "x-number": 42 },
    { "x-list": ["ok", 42] },
    { "bad name": "x" },
    { x: "a\r\nb" },
  ])("无效响应头归为适配器错误 %#", async (header) => {
    await expect(
      adapter((options) => {
        options.success(response({ header: header as object }));
        return { abort() {} };
      }).send(request(), createCancellation()),
    ).rejects.toMatchObject({ kind: "ADAPTER" });
  });

  test.each(["throw", "fail"])("原生 %s 失败保留原始 cause", async (mode) => {
    const cause = { errMsg: "request:fail timeout", errno: 600002 };
    const control = observingCancellation();
    await expect(
      adapter((options) => {
        if (mode === "throw") throw cause;
        options.fail(cause);
        return { abort() {} };
      }).send(request(), control),
    ).rejects.toMatchObject({ kind: "TRANSPORT", cause });
    expect(control.release).toHaveBeenCalledTimes(1);
  });

  test("未返回可取消任务时拒绝挂起调用", async () => {
    const sendRequest = (() => undefined) as unknown as UniTransportOptions["request"];
    await expect(adapter(sendRequest).send(request(), createCancellation())).rejects.toMatchObject({
      kind: "ADAPTER",
    });
  });
});

describe("显式能力", () => {
  test.each(["PATCH", "TRACE", "GETTING", "get"])("方法 %s 不会被平台静默替换", async (method) => {
    const sendRequest = vi.fn<UniTransportOptions["request"]>();
    const control = observingCancellation();
    await expect(adapter(sendRequest).send(request({ method }), control)).rejects.toMatchObject({
      kind: "UNSUPPORTED",
      capability: `method:${method}`,
    });
    expect(sendRequest).not.toHaveBeenCalled();
    expect(control.release).not.toHaveBeenCalled();
  });

  test.each(["request", "response"])(
    "目标未声明字节 %s 能力时不启动原生请求",
    async (direction) => {
      const sendRequest = vi.fn<UniTransportOptions["request"]>();
      const transport = adapter(sendRequest, {
        requestBytes: direction !== "request",
        responseBytes: direction !== "response",
      });
      const input =
        direction === "request"
          ? request({ method: "POST", body: { kind: "bytes", value: new Uint8Array(0) } })
          : request({ representation: "bytes" });
      await expect(transport.send(input, createCancellation())).rejects.toMatchObject({
        kind: "UNSUPPORTED",
        capability: `${direction}:bytes`,
      });
      expect(sendRequest).not.toHaveBeenCalled();
    },
  );

  test("创建时固定方法、二进制能力与请求函数", async () => {
    const methods: UniRequestMethod[] = ["GET", "POST"];
    const capabilities = { methods, requestBytes: true, responseBytes: true };
    const original = vi.fn<UniTransportOptions["request"]>((options) => {
      options.success(response({ data: new Uint8Array([9]).buffer }));
      return { abort() {} };
    });
    const options = { request: original, capabilities };
    const transport = createUniTransport(options);
    methods.splice(0, methods.length, "TRACE");
    capabilities.requestBytes = false;
    capabilities.responseBytes = false;
    options.request = vi.fn();
    const result = await transport.send(
      request({
        method: "POST",
        body: { kind: "bytes", value: new Uint8Array([1]) },
        representation: "bytes",
      }),
      createCancellation(),
    );
    expect(result.payload).toEqual({ kind: "bytes", value: new Uint8Array([9]) });
    await expect(
      transport.send(request({ method: "TRACE" }), createCancellation()),
    ).rejects.toMatchObject({
      kind: "UNSUPPORTED",
    });
    expect(original).toHaveBeenCalledTimes(1);
    expect(options.request).not.toHaveBeenCalled();
  });
});

describe("取消与资源释放", () => {
  test("发送前取消不会调用原生请求", async () => {
    const source = createCancellation();
    const reason = { action: "leave" };
    source.cancel(reason);
    const sendRequest = vi.fn<UniTransportOptions["request"]>();
    await expect(adapter(sendRequest).send(request(), source)).rejects.toMatchObject({
      kind: "TRANSPORT",
      cause: reason,
    });
    expect(sendRequest).not.toHaveBeenCalled();
  });

  test("原生请求永不回调时取消仍结束等待，并忽略迟到的成功与失败", async () => {
    let callbacks!: UniRequestOptions;
    const abort = vi.fn();
    const control = observingCancellation();
    const pending = adapter((options) => {
      callbacks = options;
      return { abort };
    }).send(request(), control);
    const reason = { action: "cancel" };
    const rejected = expect(pending).rejects.toMatchObject({ kind: "TRANSPORT", cause: reason });
    control.source.cancel(reason);
    await rejected;
    callbacks.success(response());
    callbacks.fail(new Error("迟到失败"));
    control.source.cancel("second");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(control.release).toHaveBeenCalledTimes(1);
    await expect(pending).rejects.toMatchObject({ kind: "TRANSPORT", cause: reason });
  });

  test("request 返回前同步取消时，在拿到任务后补发一次 abort", async () => {
    const control = observingCancellation();
    const abort = vi.fn();
    const pending = adapter(() => {
      control.source.cancel("request 内取消");
      return { abort };
    }).send(request(), control);
    await expect(pending).rejects.toMatchObject({ kind: "TRANSPORT", cause: "request 内取消" });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(control.release).toHaveBeenCalledTimes(1);
  });

  test.each(["fail", "throw"])("abort 同步 %s 不改变已经确定的取消原因", async (mode) => {
    const control = observingCancellation();
    const abort = vi.fn();
    const pending = adapter((options) => {
      abort.mockImplementation(() => {
        if (mode === "throw") throw new Error("原生任务无法中断");
        options.fail({ errMsg: "request:fail abort" });
      });
      return { abort };
    }).send(request(), control);
    const rejected = expect(pending).rejects.toMatchObject({
      kind: "TRANSPORT",
      cause: "用户原因",
    });
    expect(() => control.source.cancel("用户原因")).not.toThrow();
    await rejected;
    expect(abort).toHaveBeenCalledTimes(1);
    expect(control.release).toHaveBeenCalledTimes(1);
  });

  test("成功后重复回调或取消不会改变结果，也不会中断已完成任务", async () => {
    let callbacks!: UniRequestOptions;
    const abort = vi.fn();
    const control = observingCancellation();
    const pending = adapter((options) => {
      callbacks = options;
      return { abort };
    }).send(request(), control);
    callbacks.success(response({ data: "first" }));
    callbacks.fail("late failure");
    callbacks.success(response({ data: "second" }));
    control.source.cancel("late cancellation");
    expect((await pending).payload).toEqual({ kind: "text", value: "first" });
    expect(abort).not.toHaveBeenCalled();
    expect(control.release).toHaveBeenCalledTimes(1);
  });

  test("订阅期间同步通知取消也会释放返回的监听", async () => {
    const release = vi.fn();
    const cancellation: Cancellation = {
      cancelled: false,
      reason: "同步取消",
      subscribe(listener) {
        listener();
        return release;
      },
    };
    const sendRequest = vi.fn<UniTransportOptions["request"]>();
    await expect(adapter(sendRequest).send(request(), { cancellation })).rejects.toMatchObject({
      kind: "TRANSPORT",
      cause: "同步取消",
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  test("退订函数抛错不妨碍响应交付", async () => {
    const cancellation: Cancellation = {
      cancelled: false,
      subscribe: () => () => {
        throw new Error("退订失败");
      },
    };
    const result = await adapter((options) => {
      options.success(response());
      return { abort() {} };
    }).send(request(), { cancellation });
    expect(result.payload).toEqual({ kind: "text", value: "ok" });
  });
});

describe("客户端联动", () => {
  test("JSON 由核心解析，状态失败保留完整文本", async () => {
    let statusCode = 200;
    const http = createHttpClient({
      baseURL: "https://api.example.test/",
      transport: adapter((options) => {
        options.success(response({ statusCode, data: '{"name":"林舟"}' }));
        return { abort() {} };
      }),
    });
    expect((await http.request({ url: "users" }, json())).data).toEqual({ name: "林舟" });
    statusCode = 400;
    await expect(http.request({ url: "users" }, json())).rejects.toMatchObject({
      kind: "STATUS",
      response: { status: 400, payload: { kind: "text", value: '{"name":"林舟"}' } },
    });
  });

  test("用户取消保持 CANCELLED 和原因引用，并请求原生任务中断", async () => {
    const abort = vi.fn();
    const source = createCancellation();
    const reason = { action: "leave-page" };
    const http = createHttpClient({ transport: adapter(() => ({ abort })) });
    const pending = http.request({ url: "https://api.example.test/users" }, text(), {
      cancellation: source.cancellation,
    });
    const rejected = expect(pending).rejects.toMatchObject({ kind: "CANCELLED", reason });
    source.cancel(reason);
    await rejected;
    const failure = await pending.catch((error: unknown) => error);
    if (!isHttpError(failure) || failure.kind !== "CANCELLED") {
      throw new Error("调用没有返回取消错误");
    }
    expect(failure.reason).toBe(reason);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  test("总预算到期会结束挂起请求并调用 abort，平台 fail 不覆盖 TIMEOUT", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const abort = vi.fn();
    const http = createHttpClient({
      timeoutMs: 40,
      transport: adapter((options) => {
        abort.mockImplementation(() => options.fail({ errMsg: "request:fail abort" }));
        return { abort };
      }),
    });
    const pending = http.request({ url: "https://api.example.test/users" }, text());
    const rejected = expect(pending).rejects.toMatchObject({ kind: "TIMEOUT", timeoutMs: 40 });
    await vi.advanceTimersByTimeAsync(40);
    await rejected;
    expect(abort).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("平台自行超时仍归为 TRANSPORT，不伪装成总预算到期", async () => {
    const cause = { errMsg: "request:fail timeout" };
    const http = createHttpClient({
      timeoutMs: 0,
      transport: adapter((options) => {
        options.fail(cause);
        return { abort() {} };
      }),
    });
    await expect(
      http.request({ url: "https://api.example.test/users" }, text()),
    ).rejects.toMatchObject({
      kind: "TRANSPORT",
      cause,
    });
  });
});
