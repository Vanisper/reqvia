import assert from "node:assert/strict";
import { startExampleServer } from "@reqvia/example-server";
import { connectWeixin, openWeixin } from "./weixin.mjs";

const server = await startExampleServer({ port: 4178 });
let connection;
let checks = 0;
const selector = (id) => `[data-testid="${id}"]`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 8_000;
  let lastError;
  while (true) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) throw new Error(`微信验证超时：${label}`, { cause: lastError });
    await delay(40);
  }
}

try {
  connection = await connectWeixin(await openWeixin(true));
  const send = connection.send;
  const environment = await send("Tool.getInfo");
  // 官方 automator 在 launch 后同样等待运行层完成注入
  await delay(5_000);
  const currentPage = () => send("App.getCurrentPage");
  async function element(id, component) {
    const { pageId } = await currentPage();
    if (!component)
      return { pageId, ...(await send("Page.getElement", { pageId, selector: selector(id) })) };
    const parent = await send("Page.getElement", { pageId, selector: selector(component) });
    const child = await send("Element.getElement", { pageId, ...parent, selector: selector(id) });
    return { pageId, ...child };
  }
  const attribute = async (id, name) =>
    (
      await send("Element.getAttributes", {
        ...(await element(id)),
        names: [name],
      })
    ).attributes[0];
  const text = async (id, component) =>
    (
      await send("Element.getDOMProperties", {
        ...(await element(id, component)),
        names: ["innerText"],
      })
    ).properties[0];
  const tap = async (id, component = "search-form") =>
    send("Element.tap", await element(id, component));
  const ready = () =>
    waitFor(async () => {
      const state = await attribute("status", "data-state");
      if (state === "error") throw new Error(await text("error"));
      return state === "ready";
    }, "用户列表加载");

  await send("App.callWxMethod", { method: "reLaunch", args: [{ url: "/pages/users/index" }] });
  await waitFor(async () => (await currentPage()).path === "pages/users/index", "进入列表页");
  await ready();
  assert.equal(await text("user-name", "user-list"), "林舟");
  checks++;

  await tap("detail-42", "user-list");
  await waitFor(async () => (await currentPage()).path === "pages/detail/index", "进入详情页");
  await waitFor(async () => (await text("detail-name")) === "林舟", "详情加载");
  checks++;
  await tap("back", null);
  await waitFor(async () => (await currentPage()).path === "pages/users/index", "返回列表页");
  await ready();

  const beforeDetail = server.requests.length;
  await send("App.callWxMethod", {
    method: "navigateTo",
    args: [{ url: "/pages/detail/index?id=slow" }],
  });
  await waitFor(async () => (await currentPage()).path === "pages/detail/index", "进入慢详情页");
  const detailPageId = (await currentPage()).pageId;
  const detailRequests = () =>
    server.requests.slice(beforeDetail).filter((request) => request.path === "/api/users/slow");
  await waitFor(() => detailRequests().length > 0, "详情请求到达服务端");
  assert.equal(detailRequests().length, 1, "详情首次显示只请求一次");
  assert.equal(detailRequests()[0].completed, false, "隐藏前详情请求必须仍在途");
  await send("App.callWxMethod", {
    method: "navigateTo",
    args: [{ url: "/pages/users/index" }],
  });
  await waitFor(async () => (await currentPage()).path === "pages/users/index", "覆盖并隐藏详情页");
  await waitFor(() => detailRequests()[0].aborted, "隐藏详情页取消请求");
  await send("App.callWxMethod", { method: "navigateBack", args: [{ delta: 1 }] });
  await waitFor(
    async () => (await currentPage()).pageId === detailPageId,
    "恢复同一个详情页面实例",
  );
  await waitFor(async () => (await text("detail-name")) === "林舟", "恢复后的详情重新加载");
  assert.equal(detailRequests().length, 2, "隐藏恢复前后恰好请求两次");
  assert.equal(detailRequests()[0].completed, false);
  assert.equal(detailRequests()[1].completed, true);
  assert.equal(detailRequests()[1].aborted, false);
  checks++;
  await send("App.callWxMethod", { method: "navigateBack", args: [{ delta: 1 }] });
  await waitFor(async () => (await currentPage()).path === "pages/users/index", "返回原用户列表");
  await ready();

  const beforeSlow = server.requests.length;
  await tap("slow");
  await waitFor(
    () => server.requests.slice(beforeSlow).some((request) => request.query === "slow"),
    "慢查询到达服务端",
  );
  await tap("fast");
  await waitFor(
    () =>
      server.requests
        .slice(beforeSlow)
        .some((request) => request.query === "slow" && request.aborted),
    "旧查询实际中止",
  );
  await ready();
  await delay(500);
  assert.equal(await text("user-name", "user-list"), "陈希");
  checks++;
  await tap("invalid");
  await waitFor(
    async () => (await attribute("error", "data-kind")) === "DomainValidationError",
    "业务校验失败",
  );
  checks++;
  await tap("failure");
  await waitFor(async () => (await attribute("error", "data-kind")) === "STATUS", "HTTP 错误");
  checks++;

  for (const leave of [false, true]) {
    const index = server.requests.length;
    await tap("hang");
    await waitFor(
      () => server.requests.slice(index).some((request) => request.query === "hang"),
      "挂起请求到达服务端",
    );
    await tap(leave ? "leave" : "cancel");
    await waitFor(
      () =>
        server.requests.slice(index).some((request) => request.query === "hang" && request.aborted),
      "请求实际中止",
    );
    if (leave)
      await waitFor(async () => (await currentPage()).path === "pages/detail/index", "卸载列表页");
    else assert.equal(await attribute("status", "data-state"), "cancelled");
    checks++;
  }
  console.log(
    `UniApp 微信开发者工具消费验证通过：${checks} 项（模拟器，非真机），开发工具 ${environment.version}，基础库 ${environment.SDKVersion}`,
  );
} finally {
  await connection?.close();
  await server.close();
}
