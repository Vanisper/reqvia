import { onUnmounted, readonly, shallowRef } from "vue";
import { createCancellation, isHttpError } from "reqvia";
import type { CancellationSource } from "reqvia";
import { DomainValidationError } from "@reqvia/example-domain";
import type { User, UserService } from "@reqvia/example-domain";
import { createUsers } from "../services/users.ts";

/** 页面查询状态；只有当前查询代次可以提交界面结果 */
export function useUsers() {
  const users = shallowRef<readonly User[]>([]);
  const status = shallowRef<"idle" | "loading" | "ready" | "cancelled" | "error">("idle");
  const error = shallowRef("");
  const errorKind = shallowRef("");
  let service: UserService | undefined;
  let active: CancellationSource | undefined;
  let generation = 0;

  const cancel = () => {
    generation++;
    active?.cancel("页面离开或调用方取消");
    active = undefined;
    if (status.value === "loading") status.value = "cancelled";
  };
  const search = async (query = "") => {
    cancel();
    const version = generation;
    const source = createCancellation();
    active = source;
    status.value = "loading";
    error.value = "";
    errorKind.value = "";
    try {
      service ??= createUsers();
      const next = await service.list(query, { cancellation: source.cancellation });
      // 取消用于释放资源，代次检查负责阻止旧结果写入页面状态
      if (version !== generation) return;
      users.value = next;
      status.value = "ready";
    } catch (cause) {
      if (version !== generation) return;
      status.value = "error";
      error.value = cause instanceof Error ? cause.message : String(cause);
      errorKind.value =
        cause instanceof DomainValidationError
          ? "DomainValidationError"
          : isHttpError(cause)
            ? cause.kind
            : "RUNTIME";
    } finally {
      if (version === generation) active = undefined;
    }
  };

  onUnmounted(cancel);
  return {
    users: readonly(users),
    status: readonly(status),
    error: readonly(error),
    errorKind: readonly(errorKind),
    search,
    cancel,
  };
}
