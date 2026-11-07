# 示例服务与浏览器验收工具

私有工具包为三端示例提供同一份本地 API，支持搜索、详情、延迟、错误和持续等待。`startExampleServer()` 只监听 `127.0.0.1`，返回服务地址、请求观察记录和异步关闭方法；调用方在 `finally` 中关闭。`createExampleApi()` 可挂载到开发服务器中。

```sh
vp run -F @reqvia/example-server start
```

默认 API 为 `http://127.0.0.1:4178/api/`，请求记录通过 `/__state` 查询。服务保存测试数据并允许跨域访问，仅用于本地示例和验收。

`@reqvia/example-server/browser` 的 `withBrowser()` 启动独立的无头 Chrome，提供页面操作与条件等待，结束时关闭进程并移除临时配置。浏览器路径可通过 `CHROME_BIN` 指定。
