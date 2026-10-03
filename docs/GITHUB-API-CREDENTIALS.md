# GitHub 仓库脉搏：数据源与凭据目的地

`apps/server/src/service/aipm.ts` 的 `githubPulse` 使用工作区 GitHub 凭据读取仓库事实。凭据读取仍经过可信租户/工作区作用域与数据库 RLS。返回结构中的 `mock` 含义保持原有规则：仓库读取失败时对应 pulse 标为 mock；模型未配置时顶层也标为 mock。

## 配置

| 配置 | 默认与作用 |
| --- | --- |
| `GITHUB_API_BASE` | 默认依次尝试 `https://api.github.com`、`https://gh-proxy.com/https://api.github.com`；逗号分隔的 URL 可替换整条数据源链。企业 API 的路径（例如 `/api/v3`）保留。 |
| `GITHUB_TRUSTED_API_ORIGINS` | 逗号分隔的额外 HTTPS origin。默认凭据目的地始终只有 `https://api.github.com`；该项可额外授权明确的企业 API origin。配置数据源本身不会授予凭据权限。 |

这两项在模块装载时读取；修改服务环境配置后重启服务生效。以下只展示地址配置，不包含凭据：

```dotenv
GITHUB_API_BASE=https://github.example.invalid/api/v3,https://mirror.example.invalid/https://api.github.com
GITHUB_TRUSTED_API_ORIGINS=https://github.example.invalid
```

受信任项必须是 HTTPS origin，允许末尾根斜杠，不允许用户名、密码、业务路径、查询或片段。无效项被忽略，不会授予权限或影响其他有效项。主机大小写与默认 HTTPS 端口由 URL 解析器规范化；不同主机、子域名或非默认端口是不同 origin。上面的镜像即使路径中含 GitHub API 地址，也保持匿名。

工作区没有可用 GitHub 凭据时，所有数据源均匿名。原有服务器环境凭据回退方式保持原状；本文件不要求写入、复制或分享任何凭据。

## 请求与重定向

每个数据源重新构造请求 headers。只有初始请求的解析后 origin 属于受信任集合，且当前工作区读取到凭据时，才附加 `Authorization`。

所有请求使用手动重定向，支持 `301/302/303/307/308`。一条数据源请求链最多跟随 5 次重定向，初始请求加重定向最多发出 6 次请求。每条链共享原来的 12 秒超时信号，避免每跳重新获得完整超时。

- 同 origin 重定向保留原有授权状态。
- 跨 origin 重定向立即去除授权；随后整条链持续匿名，包括目标也在受信任集合、或再次返回初始 origin 的情况。
- 初始匿名请求不会因重定向到受信任 origin 而新增授权。
- HTTPS 降级到 HTTP、URL 用户信息、非 HTTP(S) 目标，在发送下一个请求前拒绝。
- 初始 HTTP 数据源可以读取公开事实，但任何受信任声明都不能授权 HTTP。

超出重定向上限、缺少 `Location`、不安全目标、传输失败、超时、非成功 HTTP 状态或 JSON 解析失败，均使该数据源失败并尝试下一数据源。错误响应与重定向的 body 被取消；错误 body、凭据和目标 URL 不会进入 pulse 的返回内容。全部来源失败时保留既有通用 mock 结果。

HTTP 状态和重定向的依据见 [GitHub REST API：Follow redirects](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#follow-redirects)；跨 origin 去除授权的原则见 [Fetch Standard：HTTP-redirect fetch](https://fetch.spec.whatwg.org/#http-redirect-fetch)。5 跳上限、独立 origin 白名单与 HTTPS 降级拒绝是本产品的显式安全边界。

## 验证与边界

原生断言位于 `apps/server/src/service/aipm.github.test.ts`，覆盖默认与企业 origin、未知镜像、端口/相似主机、错误配置、失败回退、重定向与通用失败返回。租户与运行时作用域继续由原有 scope、events 与 tRPC 测试保护。

任务级独立回归同时验证真实 loopback HTTP 请求、独占 Unix PostgreSQL 的真实非特权角色、双租户并发凭据隔离、历史凭据和事件保留、数据库验链与进程清理。HTTPS 请求使用明确的传输替身；它能验证 headers 和重定向决策，不能证明真实 TLS、GitHub 服务或企业 GitHub 已接通。测试只使用合成标记，不访问真实账户或付费模型。

该修复限制 GitHub HTTP 凭据可达范围；不承担连接器通用 SSRF 防护、秘密存储加密升级、RSS/竞品抓取策略、竞品快照修复或生产账户验收。公共修复在基座维护；子仓仅定向同步该 GitHub 片段、原生断言和本配置文档，并实际运行自己的验证。
