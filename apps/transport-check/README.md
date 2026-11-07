# 浏览器传输验证

该应用由 `vp create vite` 的 Vanilla TypeScript 模板建立，消费各产品包的公开入口。相同的 `UserService` 和验收过程分别注入浏览器 Fetch 与官方 `@dcloudio/uni-h5` 的 `request` 导出。

```sh
vp run -F transport-check verify
```

任务先构建依赖包和应用，再启动只监听 `127.0.0.1` 临时端口的 HTTP 服务，并使用独立临时 Chrome profile 执行 20 项验证。使用真实时钟、原生 Fetch 和 XMLHttpRequest；取消与超时既检查外层错误，也检查服务端是否在完整响应前观察到连接关闭。进程、服务及临时 profile 会在结束时清理。

脚本查找 macOS 的 Chrome/Chromium、Linux PATH 中的同名命令及 Windows 常规安装目录，也可明确指定浏览器：

```sh
CHROME_BIN=/path/to/chrome vp run -F transport-check verify
```

验证包含中文文本、准确字节切片、JSON、空响应、404、损坏 JSON、正文中途断连、原生信号桥接取消和总超时。缺少浏览器或任一用例失败时返回非零状态。包含真实网络与浏览器的任务禁用缓存，不并入普通单元测试。

页面可用于交互查看结果：先构建产品依赖，再运行 `vp run -F transport-check dev`。开发服务使用同一组本地接口，刷新页面重新执行验证。

## 验证范围

Uni 运行时固定为 `3.0.0-alpha-5030620261106001`。应用直接消费官方运行时的 `request`，按该运行时要求将 `vue` 解析到同版本 `uni-h5-vue`；只提供请求器读取的 `networkTimeout` 配置。原生声明通过 `@dcloudio/types@3.4.32` 校验注入接口，主包不依赖这些类型。

此应用验证官方 Uni H5 请求运行时在所执行浏览器中的行为，不包含完整 Uni 编译链、页面生命周期、微信小程序或设备运行。受限方法、响应头、Cookie 和跨域仍遵循实际浏览器约束；当前接口为同源本地 HTTP。
