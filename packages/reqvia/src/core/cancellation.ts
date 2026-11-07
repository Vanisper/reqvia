import type { CancellationSource } from "./types.ts";

/**
 * 创建独立的取消源
 *
 * @description 首次取消固定原因；监听者异常不影响其他通知，取消订阅可重复调用
 */
export function createCancellation(): CancellationSource {
  let cancelled = false;
  let reason: unknown;
  const listeners = new Set<() => void>();

  const cancellation = Object.freeze({
    get cancelled() {
      return cancelled;
    },
    get reason() {
      return reason;
    },
    subscribe(listener: () => void) {
      // 每次订阅有自己的身份，同一个函数可以独立订阅和取消订阅
      const notify = () => {
        try {
          listener();
        } catch {
          // 取消通知不把观察者异常传播到发起取消的调用链
        }
      };
      if (cancelled) {
        notify();
      } else {
        listeners.add(notify);
      }
      return () => {
        listeners.delete(notify);
      };
    },
  });

  return Object.freeze({
    cancellation,
    cancel(value?: unknown) {
      if (cancelled) return;
      cancelled = true;
      reason = value;
      for (const listener of listeners) {
        if (listeners.delete(listener)) listener();
      }
    },
  });
}
