import { onScopeDispose, shallowReadonly, shallowRef } from "vue";
import { createCancellation, isHttpError } from "reqvia";
import type { CancellationSource } from "reqvia";
import type { User, UserService } from "@reqvia/example-domain";

/** 管理目录视图的查询、详情与退出时的取消 */
export function useUserDirectory(service: Pick<UserService, "list" | "find">) {
  const users = shallowRef<readonly User[]>([]);
  const loading = shallowRef(false);
  const error = shallowRef<unknown>(null);
  const notice = shallowRef("");
  const selectedId = shallowRef<string | null>(null);
  const selected = shallowRef<User | null>(null);
  const detailLoading = shallowRef(false);
  const detailError = shallowRef<unknown>(null);
  let listSource: CancellationSource | undefined;
  let detailSource: CancellationSource | undefined;
  let listVersion = 0;
  let detailVersion = 0;
  let active = true;

  function closeDetail() {
    detailVersion++;
    detailSource?.cancel("关闭详情");
    detailSource = undefined;
    selectedId.value = null;
    selected.value = null;
    detailLoading.value = false;
    detailError.value = null;
  }

  async function search(query: string) {
    if (!active) return;
    const version = ++listVersion;
    listSource?.cancel("查询条件已更新");
    closeDetail();
    const source = createCancellation();
    listSource = source;
    users.value = [];
    loading.value = true;
    error.value = null;
    notice.value = "";
    try {
      const result = await service.list(query, { cancellation: source.cancellation });
      // 服务可能忽略取消，提交结果时仍需确认当前视图与查询代次
      if (active && version === listVersion) users.value = result;
    } catch (cause) {
      if (!active || version !== listVersion) return;
      if (isHttpError(cause) && cause.kind === "CANCELLED") notice.value = "查询已取消";
      else error.value = cause;
    } finally {
      if (active && version === listVersion) {
        loading.value = false;
        listSource = undefined;
      }
    }
  }

  async function select(id: string) {
    if (!active) return;
    const version = ++detailVersion;
    detailSource?.cancel("已选择其他用户");
    const source = createCancellation();
    detailSource = source;
    selectedId.value = id;
    selected.value = null;
    detailLoading.value = true;
    detailError.value = null;
    try {
      const result = await service.find(id, { cancellation: source.cancellation });
      if (active && version === detailVersion) selected.value = result;
    } catch (cause) {
      if (active && version === detailVersion) detailError.value = cause;
    } finally {
      if (active && version === detailVersion) {
        detailLoading.value = false;
        detailSource = undefined;
      }
    }
  }

  function cancelSearch() {
    listVersion++;
    listSource?.cancel("用户取消查询");
    listSource = undefined;
    loading.value = false;
    notice.value = "查询已取消";
  }

  onScopeDispose(() => {
    active = false;
    listVersion++;
    detailVersion++;
    listSource?.cancel("离开用户目录");
    detailSource?.cancel("离开用户目录");
    listSource = undefined;
    detailSource = undefined;
  });

  return {
    users: shallowReadonly(users),
    loading: shallowReadonly(loading),
    error: shallowReadonly(error),
    notice: shallowReadonly(notice),
    selectedId: shallowReadonly(selectedId),
    selected: shallowReadonly(selected),
    detailLoading: shallowReadonly(detailLoading),
    detailError: shallowReadonly(detailError),
    search,
    select,
    closeDetail,
    cancelSearch,
  };
}
