# 消费示例

三个消费端复用 `@reqvia/example-domain` 的 `UserService` 与领域校验，分别组装 Fetch 或 UniApp 传输。请求通过产品包的公共导出调用，应用负责自己的状态、生命周期和交互。

在工作区根目录安装依赖：

```sh
vp install --frozen-lockfile
```

| 示例                       | 启动命令                                          | 主要行为                                       |
| -------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| [Node](node/README.md)     | `vp run -F @reqvia/example-node start -- find 42` | JSON 输出、错误分类、超时、进程信号取消        |
| [Web](web/README.md)       | `vp run -F @reqvia/example-web dev`               | 搜索、详情、查询代次、视图与页面退出取消       |
| [UniApp](uniapp/README.md) | `vp run -F @reqvia/example-uniapp dev`            | 标准 UniApp 页面、列表与详情、页面生命周期取消 |

Node 默认自行启动并关闭本地 API。Web 与 UniApp H5 开发服务内置同一 API，直接启动即可使用。微信开发者工具连接独立服务：

```sh
vp run -F @reqvia/example-server start
vp run -F @reqvia/example-uniapp dev:weixin
```

API 默认端口为 4178。微信 AppID、本地环境变量和编译产物不纳入 Git；微信工具运行方式与环境要求见 [UniApp 说明](uniapp/README.md)。

## 可复现的请求行为

本地数据包含两位示例成员，支持按姓名、角色或编号搜索。以下关键词用于观察不同状态：

| 查询            | 服务行为                           |
| --------------- | ---------------------------------- |
| `slow` / `fast` | 分别延迟 400 / 20 毫秒返回不同成员 |
| `invalid`       | 返回合法 JSON，但不满足领域模型    |
| `error`         | 返回 HTTP 503                      |
| `hang`          | 保持请求，等待取消或超时           |

这些控制值属于示例后端，不进入业务 Service 的契约。页面在取消旧查询之外，还在状态写入处检查代次，防止迟到的成功或失败覆盖当前状态。

详情端点 `users/slow` 延迟返回用户 42，用于验证详情页隐藏时取消、重新显示时恢复请求。

## 验证

```sh
vp run ready
vp run verify:browser
vp run verify:examples
```

`ready` 包含所有工作区构建、静态检查、单元与 Node 子进程测试，以及四个产品包的独立安装验证。UniApp 构建同时生成 H5 和微信小程序产物。两项浏览器任务需要 Chrome 或 Chromium，可通过 `CHROME_BIN` 指定路径；验收既检查页面结果，也检查服务端是否观察到连接关闭。具体平台证据见[兼容性记录](../docs/compatibility.md)。
