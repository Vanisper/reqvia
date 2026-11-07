import { createCancellation } from "reqvia";
import type { Cancellation } from "reqvia";

/** 可观察原生取消状态与 abort 事件的最小接口 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  /** 首次取消的原因；不提供原因的平台可以省略 */
  readonly reason?: unknown;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/** 持有信号并能够发出原生取消的控制对象 */
export interface AbortControllerLike<TSignal extends AbortSignalLike = AbortSignalLike> {
  readonly signal: TSignal;
  /** 原因直接传入原生实现；undefined 可能由平台转换为默认取消原因 */
  abort(reason?: unknown): void;
}

/** 从原生信号建立的只读取消绑定 */
export interface CancellationBinding {
  readonly cancellation: Cancellation;
  /** 幂等释放监听，不主动取消，也不撤销已经发生的取消 */
  dispose(): void;
}

/** 从 Reqvia 取消状态建立的原生信号绑定 */
export interface AbortSignalBinding<TSignal extends AbortSignalLike = AbortSignalLike> {
  readonly signal: TSignal;
  /** 幂等释放订阅，不主动 abort，也不撤销已经发生的取消 */
  dispose(): void;
}

/**
 * 将原生信号转换为 Reqvia 取消状态
 *
 * @description 已取消时立即同步原因；后续取消只通知一次并释放监听，正常结束时由调用方 dispose
 */
export function fromAbortSignal(signal: AbortSignalLike): CancellationBinding {
  const source = createCancellation();
  let active = true;
  let release = () => {};

  const dispose = () => {
    if (!active) return;
    active = false;
    release();
  };
  const abort = () => {
    if (!active || !signal.aborted) return;
    const reason = signal.reason;
    dispose();
    source.cancel(reason);
  };

  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort);
    release = () => signal.removeEventListener("abort", abort);
    // 自定义信号可能在注册过程中取消，退订函数就绪后补做清理
    if (!active) release();
    else if (signal.aborted) abort();
  }

  return Object.freeze({ cancellation: source.cancellation, dispose });
}

/**
 * 将 Reqvia 取消状态转换为工厂创建的原生信号
 *
 * @description 工厂每次返回独立且未取消的控制器；已取消时同步 abort，正常结束时由调用方 dispose
 */
export function toAbortSignal<TSignal extends AbortSignalLike>(
  cancellation: Cancellation,
  createAbortController: () => AbortControllerLike<TSignal>,
): AbortSignalBinding<TSignal> {
  const controller = createAbortController();
  let active = true;
  let release = () => {};

  const dispose = () => {
    if (!active) return;
    active = false;
    release();
  };
  const abort = () => {
    if (!active || !cancellation.cancelled) return;
    const reason = cancellation.reason;
    dispose();
    controller.abort(reason);
  };

  if (cancellation.cancelled) {
    abort();
  } else {
    release = cancellation.subscribe(abort);
    // subscribe 可以同步通知，返回的退订函数仍需被释放
    if (!active) release();
    else if (cancellation.cancelled) abort();
  }

  return Object.freeze({ signal: controller.signal, dispose });
}
