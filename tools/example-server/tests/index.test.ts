import { expect, test } from "vite-plus/test";
import { startExampleServer } from "../src/index.ts";

test("同一后端提供三端需要的列表、详情与可复现失败", async () => {
  const server = await startExampleServer();
  try {
    const list = await fetch(`${server.baseURL}users`);
    expect(await list.json()).toEqual([
      { id: "42", name: "林舟", role: "工程师" },
      { id: "43", name: "陈希", role: "设计师" },
    ]);
    expect(list.headers.get("access-control-allow-origin")).toBe("*");
    expect(await (await fetch(`${server.baseURL}users/42`)).json()).toMatchObject({ id: "42" });
    expect((await fetch(`${server.baseURL}users/missing`)).status).toBe(404);
    expect((await fetch(`${server.baseURL}users?query=error`)).status).toBe(503);
    expect(await (await fetch(`${server.baseURL}users?query=invalid`)).json()).toEqual({
      invalid: true,
    });
  } finally {
    await server.close();
  }
});

test("挂起调用的连接关闭可观察，服务退出幂等", async () => {
  const server = await startExampleServer();
  const controller = new AbortController();
  try {
    const request = fetch(`${server.baseURL}users?query=hang`, { signal: controller.signal });
    const rejected = expect(request).rejects.toBe("结束等待");
    await expect.poll(() => server.requests.length).toBe(1);
    controller.abort("结束等待");
    await rejected;
    await expect.poll(() => server.requests[0].aborted).toBe(true);
    expect(server.requests[0].completed).toBe(false);
  } finally {
    controller.abort();
    await server.close();
    await server.close();
  }
});
