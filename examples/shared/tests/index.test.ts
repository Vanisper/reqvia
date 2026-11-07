import { expect, test } from "vite-plus/test";
import { createHeaderFields, createHttpClient } from "reqvia";
import { DomainValidationError, parseUser, parseUsers, UserService } from "../src/index.ts";

test("领域校验拒绝不完整记录，并复制合法字段", () => {
  expect(() => parseUser({ id: "42", name: "林舟" })).toThrow(DomainValidationError);
  expect(() => parseUsers([{ id: "42", name: "林舟", role: "开发" }, null])).toThrow(
    DomainValidationError,
  );
  expect(parseUser({ id: "42", name: "林舟", role: "开发", internal: true })).toEqual({
    id: "42",
    name: "林舟",
    role: "开发",
  });
});

test("Service 透传调用控制，列表和详情都实际经过领域解码", async () => {
  const urls: string[] = [];
  const user = { id: "a/b", name: "林舟", role: "开发" };
  const service = new UserService(
    createHttpClient({
      baseURL: "https://example.test/api/",
      transport: {
        async send(request) {
          urls.push(request.url);
          return {
            status: 200,
            headers: createHeaderFields([]),
            payload: {
              kind: "text",
              value: JSON.stringify(request.url.includes("?") ? [user] : user),
            },
          };
        },
      },
    }),
  );
  expect(await service.list("林 & 舟", { timeoutMs: 0 })).toEqual([user]);
  expect(await service.find("a/b")).toEqual(user);
  expect(urls).toEqual([
    "https://example.test/api/users?query=%E6%9E%97%20%26%20%E8%88%9F",
    "https://example.test/api/users/a%2Fb",
  ]);
});
