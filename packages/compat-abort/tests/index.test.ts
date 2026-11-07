import { afterEach, describe, expect, expectTypeOf, it, vi } from "vite-plus/test";
import { createCancellation, createHttpClient, createHeaderFields, text } from "reqvia";
import type { Cancellation } from "reqvia";
import { fromAbortSignal, toAbortSignal } from "../src/index.ts";
import type { AbortSignalLike } from "../src/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function trackedSource() {
  const source = createCancellation();
  const release = vi.fn();
  const subscribe = vi.fn((listener: () => void) => {
    const unsubscribe = source.cancellation.subscribe(listener);
    return () => {
      release();
      unsubscribe();
    };
  });
  const cancellation: Cancellation = {
    get cancelled() {
      return source.cancellation.cancelled;
    },
    get reason() {
      return source.cancellation.reason;
    },
    subscribe,
  };
  return { cancellation, cancel: (reason?: unknown) => source.cancel(reason), release, subscribe };
}

describe("fromAbortSignal", () => {
  it("立即转换已取消信号，保留原因且不新增监听", () => {
    const reason = { kind: "navigation" };
    const signal = AbortSignal.abort(reason);
    const add = vi.spyOn(signal, "addEventListener");
    const remove = vi.spyOn(signal, "removeEventListener");
    const binding = fromAbortSignal(signal);
    const listener = vi.fn();

    binding.cancellation.subscribe(listener);
    expect(binding.cancellation.cancelled).toBe(true);
    expect(binding.cancellation.reason).toBe(reason);
    expect(listener).toHaveBeenCalledExactlyOnceWith();
    expect(add).not.toHaveBeenCalled();
    binding.dispose();
    binding.dispose();
    expect(remove).not.toHaveBeenCalled();
  });

  it("原生取消只转换一次，并在通知使用者前释放监听", () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const binding = fromAbortSignal(controller.signal);
    const reason = new Error("离开页面");
    const releases: number[] = [];
    binding.cancellation.subscribe(() => releases.push(remove.mock.calls.length));

    controller.abort(reason);
    controller.abort("第二次原因");
    binding.dispose();

    expect(binding.cancellation.reason).toBe(reason);
    expect(releases).toEqual([1]);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("dispose 幂等，只断开监听而不取消任一端", () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const binding = fromAbortSignal(controller.signal);
    const listener = vi.fn();
    binding.cancellation.subscribe(listener);

    binding.dispose();
    binding.dispose();
    expect(controller.signal.aborted).toBe(false);
    expect(binding.cancellation.cancelled).toBe(false);
    controller.abort("晚到取消");

    expect(binding.cancellation.cancelled).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("同一信号的多个绑定独立释放", () => {
    const controller = new AbortController();
    const first = fromAbortSignal(controller.signal);
    const second = fromAbortSignal(controller.signal);

    first.dispose();
    controller.abort("取消剩余绑定");

    expect(first.cancellation.cancelled).toBe(false);
    expect(second.cancellation.cancelled).toBe(true);
    expect(second.cancellation.reason).toBe("取消剩余绑定");
  });

  it("取消后的 dispose 不撤销状态与原因", () => {
    const controller = new AbortController();
    const binding = fromAbortSignal(controller.signal);

    controller.abort(null);
    binding.dispose();

    expect(binding.cancellation.cancelled).toBe(true);
    expect(binding.cancellation.reason).toBeNull();
  });

  it("不把手动派发但未改变状态的 abort 事件视为取消", () => {
    const controller = new AbortController();
    const binding = fromAbortSignal(controller.signal);

    controller.signal.dispatchEvent(new Event("abort"));
    expect(binding.cancellation.cancelled).toBe(false);
    controller.abort("真实取消");
    expect(binding.cancellation.reason).toBe("真实取消");
  });

  it("兼容缺少 reason 的结构化信号，不读取全局原生实现", () => {
    vi.stubGlobal("AbortController", undefined);
    vi.stubGlobal("AbortSignal", undefined);
    const binding = fromAbortSignal({
      aborted: true,
      addEventListener() {},
      removeEventListener() {},
    });

    expect(binding.cancellation.cancelled).toBe(true);
    expect(binding.cancellation.reason).toBeUndefined();
  });

  it("注册监听期间同步取消，仍释放注册完成后的监听", () => {
    let attached = false;
    const remove = vi.fn(() => {
      attached = false;
    });
    const signal: AbortSignalLike & { aborted: boolean } = {
      aborted: false,
      reason: "注册期间取消",
      addEventListener(_type, listener) {
        this.aborted = true;
        listener();
        attached = true;
      },
      removeEventListener: remove,
    };

    const binding = fromAbortSignal(signal);

    expect(binding.cancellation.reason).toBe("注册期间取消");
    expect(attached).toBe(false);
    binding.dispose();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("注册前后状态变化且事件错过时补读取消状态", () => {
    const remove = vi.fn();
    const signal: AbortSignalLike & { aborted: boolean } = {
      aborted: false,
      reason: "已经取消",
      addEventListener() {
        this.aborted = true;
      },
      removeEventListener: remove,
    };

    const binding = fromAbortSignal(signal);

    expect(binding.cancellation.cancelled).toBe(true);
    expect(binding.cancellation.reason).toBe("已经取消");
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("使用者监听抛错不影响原生取消与资源释放", () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const binding = fromAbortSignal(controller.signal);
    const other = vi.fn();
    binding.cancellation.subscribe(() => {
      throw new Error("观察者失败");
    });
    binding.cancellation.subscribe(other);

    controller.abort("结束");

    expect(other).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("toAbortSignal", () => {
  it("已取消状态立即映射，工厂返回的原生信号类型不丢失", () => {
    const source = trackedSource();
    const reason = { kind: "replaced" };
    source.cancel(reason);
    const controller = new AbortController();
    const factory = vi.fn(() => controller);

    const binding = toAbortSignal(source.cancellation, factory);

    expectTypeOf(binding.signal).toEqualTypeOf<AbortSignal>();
    expect(binding.signal).toBe(controller.signal);
    expect(binding.signal.aborted).toBe(true);
    expect(binding.signal.reason).toBe(reason);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(source.subscribe).not.toHaveBeenCalled();
  });

  it("后续取消保留第一次原因，先退订再触发原生事件", () => {
    const source = trackedSource();
    const controller = new AbortController();
    const abort = vi.spyOn(controller, "abort");
    const binding = toAbortSignal(source.cancellation, () => controller);
    const releases: number[] = [];
    binding.signal.addEventListener("abort", () => releases.push(source.release.mock.calls.length));

    source.cancel("第一次取消");
    source.cancel("第二次取消");
    binding.dispose();

    expect(binding.signal.reason).toBe("第一次取消");
    expect(abort).toHaveBeenCalledExactlyOnceWith("第一次取消");
    expect(releases).toEqual([1]);
    expect(source.release).toHaveBeenCalledTimes(1);
  });

  it("dispose 只释放取消订阅，不主动取消源或原生信号", () => {
    const source = trackedSource();
    const controller = new AbortController();
    const binding = toAbortSignal(source.cancellation, () => controller);

    binding.dispose();
    binding.dispose();
    expect(source.cancellation.cancelled).toBe(false);
    expect(binding.signal.aborted).toBe(false);
    source.cancel("晚到取消");

    expect(binding.signal.aborted).toBe(false);
    expect(source.release).toHaveBeenCalledTimes(1);
  });

  it("独立绑定不会因另一个绑定释放而停止通知", () => {
    const source = createCancellation();
    const first = toAbortSignal(source.cancellation, () => new AbortController());
    const second = toAbortSignal(source.cancellation, () => new AbortController());

    first.dispose();
    source.cancel("结束");

    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(true);
  });

  it("订阅期间同步取消后释放刚返回的退订函数", () => {
    let cancelled = false;
    const release = vi.fn();
    const cancellation: Cancellation = {
      get cancelled() {
        return cancelled;
      },
      reason: "订阅期间取消",
      subscribe(listener) {
        cancelled = true;
        listener();
        return release;
      },
    };

    const binding = toAbortSignal(cancellation, () => new AbortController());

    expect(binding.signal.reason).toBe("订阅期间取消");
    expect(release).toHaveBeenCalledTimes(1);
    binding.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("订阅前后状态变化但没有收到通知时补读状态", () => {
    let cancelled = false;
    const release = vi.fn();
    const cancellation: Cancellation = {
      get cancelled() {
        return cancelled;
      },
      reason: "已经取消",
      subscribe() {
        cancelled = true;
        return release;
      },
    };

    const binding = toAbortSignal(cancellation, () => new AbortController());

    expect(binding.signal.reason).toBe("已经取消");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("undefined 原因遵循原生控制器的默认取消原因", () => {
    const source = createCancellation();
    const binding = toAbortSignal(source.cancellation, () => new AbortController());

    source.cancel();

    expect(binding.signal.aborted).toBe(true);
    expect(binding.signal.reason).toMatchObject({ name: "AbortError" });
  });

  it("显式 null 原因不替换为平台默认值", () => {
    const source = createCancellation();
    const binding = toAbortSignal(source.cancellation, () => new AbortController());

    source.cancel(null);

    expect(binding.signal.reason).toBeNull();
  });

  it("工厂同步失败原样传播，不建立取消订阅", () => {
    const source = trackedSource();
    const error = new Error("控制器不可用");

    expect(() =>
      toAbortSignal(source.cancellation, () => {
        throw error;
      }),
    ).toThrow(error);
    expect(source.subscribe).not.toHaveBeenCalled();
  });

  it("不依赖全局控制器，并保留结构化信号的附加类型", () => {
    vi.stubGlobal("AbortController", undefined);
    vi.stubGlobal("AbortSignal", undefined);
    const source = createCancellation();
    const signal = {
      aborted: false,
      reason: undefined as unknown,
      tag: "custom" as const,
      addEventListener() {},
      removeEventListener() {},
    };
    const binding = toAbortSignal(source.cancellation, () => ({
      signal,
      abort(reason) {
        signal.aborted = true;
        signal.reason = reason;
      },
    }));

    source.cancel("自定义控制器");

    expectTypeOf(binding.signal.tag).toEqualTypeOf<"custom">();
    expect(binding.signal.reason).toBe("自定义控制器");
  });
});

describe("客户端组合", () => {
  it("已有原生取消通过绑定阻止发送，并保留原始原因", async () => {
    const reason = { kind: "stale" };
    const binding = fromAbortSignal(AbortSignal.abort(reason));
    const send = vi.fn();
    const client = createHttpClient({ transport: { send } });

    try {
      await expect(
        client.request({ url: "https://example.test" }, text(), {
          cancellation: binding.cancellation,
        }),
      ).rejects.toMatchObject({ kind: "CANCELLED", reason });
    } finally {
      binding.dispose();
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("请求正常结束后释放桥接，之后的原生取消不改变结果", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const binding = fromAbortSignal(controller.signal);
    const client = createHttpClient({
      transport: {
        async send() {
          return {
            status: 200,
            headers: createHeaderFields([]),
            payload: { kind: "text", value: "完成" },
          };
        },
      },
    });

    const response = await client
      .request({ url: "https://example.test" }, text(), {
        cancellation: binding.cancellation,
      })
      .finally(() => binding.dispose());
    controller.abort("完成后的取消");

    expect(response.data).toBe("完成");
    expect(binding.cancellation.cancelled).toBe(false);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
