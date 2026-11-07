import { afterEach, expect, test, vi } from "vite-plus/test";
import { effectScope } from "vue";
import type { EffectScope } from "vue";
import type { CallOptions } from "reqvia";
import type { User, UserService } from "@reqvia/example-domain";
import { DomainValidationError } from "@reqvia/example-domain";
import { useUserDirectory } from "../src/composables/useUserDirectory.ts";

const lin: User = { id: "42", name: "林舟", role: "设计师" };
const chen: User = { id: "43", name: "陈希", role: "工程师" };
const scopes: EffectScope[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(service: Pick<UserService, "list" | "find">) {
  const scope = effectScope();
  scopes.push(scope);
  const directory = scope.run(() => useUserDirectory(service))!;
  return { scope, directory };
}

afterEach(() => {
  for (const scope of scopes) scope.stop();
  scopes.length = 0;
});

test("查询和详情分别保存领域结果", async () => {
  const { directory } = setup({ list: async () => [lin, chen], find: async () => lin });
  await directory.search("");
  expect(directory.users.value).toEqual([lin, chen]);
  expect(directory.loading.value).toBe(false);
  await directory.select("42");
  expect(directory.selected.value).toEqual(lin);
  expect(directory.selectedId.value).toBe("42");
  expect(directory.detailLoading.value).toBe(false);
});

test("更换查询会取消旧调用，忽略不响应取消的迟到结果", async () => {
  const old = deferred<readonly User[]>();
  let firstOptions: CallOptions | undefined;
  const { directory } = setup({
    list: async (query, options) => {
      if (query === "slow") {
        firstOptions = options;
        return old.promise;
      }
      return [chen];
    },
    find: async () => lin,
  });
  const pending = directory.search("slow");
  await directory.search("fast");
  expect(firstOptions?.cancellation?.cancelled).toBe(true);
  old.resolve([lin]);
  await pending;
  expect(directory.users.value).toEqual([chen]);
  expect(directory.error.value).toBeNull();
});

test("旧查询的失败与 finally 不影响新查询的加载状态", async () => {
  const old = deferred<readonly User[]>();
  const current = deferred<readonly User[]>();
  const { directory } = setup({
    list: (query) => (query === "old" ? old.promise : current.promise),
    find: async () => lin,
  });
  const first = directory.search("old");
  const second = directory.search("new");
  old.reject(new Error("旧查询失败"));
  await first;
  expect(directory.error.value).toBeNull();
  expect(directory.loading.value).toBe(true);
  current.resolve([chen]);
  await second;
  expect(directory.users.value).toEqual([chen]);
  expect(directory.loading.value).toBe(false);
});

test("领域校验错误保留原值供页面展示", async () => {
  const failure = new DomainValidationError();
  const { directory } = setup({
    list: async () => {
      throw failure;
    },
    find: async () => lin,
  });
  await directory.search("invalid");
  expect(directory.error.value).toBe(failure);
  expect(directory.loading.value).toBe(false);
});

test("手动取消立即结束界面等待并拒绝迟到提交", async () => {
  const late = deferred<readonly User[]>();
  let options: CallOptions | undefined;
  const { directory } = setup({
    list: (_query, input) => {
      options = input;
      return late.promise;
    },
    find: async () => lin,
  });
  const pending = directory.search("hang");
  directory.cancelSearch();
  expect(options?.cancellation?.cancelled).toBe(true);
  expect(directory.loading.value).toBe(false);
  expect(directory.notice.value).toBe("查询已取消");
  late.resolve([lin]);
  await pending;
  expect(directory.users.value).toEqual([]);
});

test("关闭详情会取消详情请求并丢弃迟到结果", async () => {
  const late = deferred<User>();
  let options: CallOptions | undefined;
  const { directory } = setup({
    list: async () => [lin],
    find: (_id, input) => {
      options = input;
      return late.promise;
    },
  });
  const pending = directory.select("42");
  directory.closeDetail();
  expect(options?.cancellation?.cancelled).toBe(true);
  late.resolve(lin);
  await pending;
  expect(directory.selected.value).toBeNull();
  expect(directory.selectedId.value).toBeNull();
  expect(directory.detailLoading.value).toBe(false);
});

test("快速切换详情不会被较早的用户结果覆盖", async () => {
  const old = deferred<User>();
  const { directory } = setup({
    list: async () => [lin, chen],
    find: (id) => (id === "42" ? old.promise : Promise.resolve(chen)),
  });
  const pending = directory.select("42");
  await directory.select("43");
  old.resolve(lin);
  await pending;
  expect(directory.selectedId.value).toBe("43");
  expect(directory.selected.value).toEqual(chen);
});

test("新查询关闭上一次查询的详情", async () => {
  const { directory } = setup({ list: async () => [lin], find: async () => lin });
  await directory.select("42");
  await directory.search("another");
  expect(directory.selectedId.value).toBeNull();
  expect(directory.selected.value).toBeNull();
});

test("视图卸载取消两类调用，之后的结果和操作均不能提交", async () => {
  const list = deferred<readonly User[]>();
  const detail = deferred<User>();
  let listOptions: CallOptions | undefined;
  let detailOptions: CallOptions | undefined;
  const service = {
    list: vi.fn((_query?: string, options?: CallOptions) => {
      listOptions = options;
      return list.promise;
    }),
    find: vi.fn((_id: string, options?: CallOptions) => {
      detailOptions = options;
      return detail.promise;
    }),
  };
  const { scope, directory } = setup(service);
  const listPending = directory.search("hang");
  const detailPending = directory.select("42");
  scope.stop();
  expect(listOptions?.cancellation?.cancelled).toBe(true);
  expect(detailOptions?.cancellation?.cancelled).toBe(true);
  list.resolve([lin]);
  detail.resolve(lin);
  await Promise.all([listPending, detailPending]);
  await directory.search("");
  await directory.select("43");
  expect(service.list).toHaveBeenCalledTimes(1);
  expect(service.find).toHaveBeenCalledTimes(1);
  expect(directory.users.value).toEqual([]);
  expect(directory.selected.value).toBeNull();
});
