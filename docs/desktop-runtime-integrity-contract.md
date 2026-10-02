# 桌面载荷完整性与本次运行身份

本契约用于公共桌面引导、安装验收和行业原生构建器。产品身份来自受保护的 `product.manifest.json`，行业命令由该产品的运行契约提供。公共代码不判断行业仓名称。

## 载荷索引

`apps/desktop/electron/payload-integrity.cjs` 仅依赖 Node 内置模块，提供两个同步入口：

```js
generatePayloadIntegrity(payloadDir, { expectedProductId, expectedVersion });
verifyPayloadIntegrity(payloadDir, { expectedProductId, expectedVersion });
```

两个期望字段均可省略。提供时必须与实际产品身份和版本完全一致，否则抛出校验失败。ESM 入口 `scripts/payload-integrity.mjs` 复用同一个 CJS 实现：

```bash
node scripts/payload-integrity.mjs generate --payload-dir dist-payload
node scripts/payload-integrity.mjs verify --payload-dir dist-payload
```

索引位于载荷根目录的 `payload-integrity.json`，其格式为：

```json
{
  "schemaVersion": "workloom.payload-integrity/v1",
  "productId": "fixture-industry",
  "payloadVersion": "v-fixture",
  "immutableRoots": ["nats", "node", "pg", "runtime"],
  "mutablePaths": ["runtime/.env"],
  "files": [
    { "path": "VERSION", "bytes": 10, "sha256": "64位小写十六进制摘要" }
  ],
  "links": [
    { "path": "python/bin/python3", "target": "python3.12" }
  ]
}
```

以上是字段示意，不能作为可启动载荷。实际索引的 `files` 必须包含全部受控普通文件；`links` 必须存在，没有链接时为 `[]`。两个列表按路径排序。固定组件为 `runtime`、`node`、`pg`、`nats`，行业运行契约要求或载荷携带 Python 时还包含 `python`。

根目录 `VERSION`、`PAYLOAD_VERSION` 和 `runtime/VERSION` 必须存在、内容非空且一致。索引必须覆盖产品清单、`.env.defaults`、数据库引导 helper、Node、PostgreSQL 和 NATS 入口。Windows 与 POSIX 入口布局分别识别，不以验证机器的宿主平台猜测载荷目标。

校验重新枚举受控组件，不跟随目录链接。普通文件校验实际长度和 SHA-256，同时检查打开前后的文件类型、inode 和修改状态。链接校验原始相对目标；最终目标必须位于受控不可变组件内，并且对应已索引的普通文件或目录。绝对、外部、悬空、循环链接及未索引目标会失败。内部相对链接可以保留，例如 Python 的 `python3 -> python3.12`。

唯一可变排除项是精确路径 `runtime/.env`，它存在时必须是普通文件。校验器不读取其内容。扩大排除范围、删除或增加受控文件、改变文件字节或链接目标、错产品、错版本、缺少或替换索引都会拒绝通过。

校验结果包含 `schemaVersion`、`productId`、`payloadVersion`、`productManifestSha256`、`payloadIntegritySha256`、`immutableRoots`、`fileCount`、`linkCount`。产品清单摘要和索引摘要来自实际文件字节，重新排版索引也会改变索引摘要。

这个索引验证受控组件的字节和链接；业务数据、日志、数据库目录以及不可变组件之外的额外根文件不在该摘要范围。执行权限、可执行文件的系统签名和原生可运行性仍需分别验证。

## 打包与安装顺序

普通 Electron 载荷和 Mac/Windows 应急包都在扩展装配、自检和最终版本标记完成后生成、验证索引，再制作归档。行业构建器通过 `desktop.industryPacker` 声明扩展入口，路径必须是受控普通 `scripts/*.mjs` 文件。公共打包器不内置某个行业的脚本名。

如果行业构建器在公共打包步骤之后更新 Bundle、签名清单或其他载荷文件，必须在这些最终字节完成后重新生成、验证索引，再制作归档。前一个索引不能证明重新封装后的内容。

`--structure-only` 应急包装配使用占位组件，并明确不生成可通过引导的完整索引。这类产物用于结构检查，不能作为可运行发行包。

引导先验证应用资源或解压缓存的实际索引。升级时，在支持目录内暂存组件和元数据，保留安全内部链接，验证暂存内容后交换组件；安装失败按已有备份恢复组件、索引、版本标记和引导标记。静态载荷检查和行业离线自检完成后才提交载荷事务，随后进入持久数据库状态变更。事务提交后的清理失败保留待清理备份，不恢复可能已经不兼容新数据库凭据的旧载荷。

同版本启动仍会重新验证已安装文件，并要求已安装索引摘要与当前应用资源一致。缓存目录存在、文件数量相同或版本字符串相同，都不能单独跳过实际字节校验。

归档资源在每次启动时验证普通文件类型、完整归档 SHA-256 和读取前后的文件身份，并用系统 tar 读取当前归档的唯一索引。缓存复用还需匹配 `.payload-cache/.source-archive.json` 中的归档摘要、索引摘要和版本，再对缓存全量执行载荷验证。旧缓存缺少该 stamp、版本或任一摘要变化时重新解包；新 stamp 只在解包、全量校验及源归档稳定检查通过后写入。重复或缺少索引、索引格式错误、归档损坏、链接形式的归档及校验过程中的源替换都会失败。stamp 和摘要仍不是发行来源签名。

应急启动器与正式 Electron 均需要 `bootstrap.cjs` 的直接公共依赖：`diagnostic-redaction.cjs`、`industry-runtime.cjs`、`payload-integrity.cjs` 和 `product-surface.cjs`。根级验收工具通过 `requiredRootAssets` 获取独立的完整性和页面标记 helper；行业代码路径前缀不会改变这些根级依赖的位置。

## 本次运行身份

每次引导产生新的随机 `instanceId`。只有实际安装验证完成、本次派生服务仍存活、健康响应匹配后，才写入 `install-state.json` 的 `status=complete`、`phase=ready`，以及：

```json
{
  "schemaVersion": "workloom.client-runtime-identity/v1",
  "instanceId": "本次启动UUID",
  "supportDir": "实际支持目录的绝对realpath",
  "productId": "实际产品ID",
  "productManifestSha256": "实际产品清单SHA256",
  "payloadVersion": "实际载荷版本",
  "payloadIntegritySha256": "实际索引SHA256",
  "ports": { "server": 8787, "web": 5173 }
}
```

示意端口不代表所有产品固定使用同一端口。实际身份记录本次已配置且互不冲突的 server/web 端口。

服务端 `/health` 必须返回 HTTP 成功状态、`ok === true`、`service === "workloom-im-server"` 和本次 UUID。工作台同时需要匹配 `x-workloom-instance-id`、`x-workloom-product-id` 和受控 head 内唯一的精确产品 meta。HTTP 重定向、错误或过大响应不能用于就绪；服务 JSON 上限为 64,000 字节，工作台正文上限为 2,000,000 字节，单次读取超时为 4 秒。

`product-surface.cjs` 的 `hasControlledProductMarker(html, productId)` 是共享的受控页面识别函数，不依赖 Electron、文件系统、网络或行业代码。它只接受当前 Vite 生成的精确 meta 语法，并忽略注释、脚本、样式、标题、模板和属性值中的示例文字；head 外提前形成正文的内容不能冒充 head 内身份。它不承诺接受所有合法 HTML 写法，调用方应复用受控 Vite 输出和同一 helper。

端口被其他进程占用时，引导在载荷或数据库装配前拒绝启动。HTTP 200 不能替代产品、服务和本次实例身份，也不能替代当前派生进程存活。

停止流程先写非 ready 状态，再等待本次子进程回收并复验 PostgreSQL 所有权后停止自有数据库。子进程异常退出也立即撤销 ready；仍存活的服务走同一清理流程，并在 SIGTERM 后按既有 3 秒期限升级为 SIGKILL。重复停止请求等待同一个清理过程。锁在清理后释放，最终正常停止状态为 `status=stopped`、`phase=stopped`。历史身份可保留用于诊断，但非 ready 状态不能用于安装验收。

POSIX 清理观察整个本次派生进程组，已退出的组长不能让仍存活的后代跳过 SIGKILL 升级。主框架页面加载失败会销毁失败窗口，保留当前运行句柄并等待同一个停止流程；等待期间重试不会再拉起另一组服务。退出停止失败返回退出码 1，并记录固定诊断，不把原始停止异常写入输出。这些行为的本地回归不能替代 Windows 原生进程树与 GUI 验证。

## 原生冒烟观察握手

普通 `WORKLOOM_APP_SMOKE=1` 仍在引导通过后停止并退出。原生验收若需要在应用仍运行时核对安装、健康响应和索引，显式启用：

```text
WORKLOOM_APP_SMOKE=1
WORKLOOM_APP_SMOKE_TEST=1
WORKLOOM_APP_SMOKE_WAIT_MS=30000
```

渲染冒烟可以使用 `WORKLOOM_RENDER_SMOKE=1` 与同一个观察开关。它先完成实际渲染检查，再发布观察就绪。源码模式不能提供该正式安装身份握手。

应用先绑定 stdin 释放监听器，再在 stdout 输出一行：

```text
WORKLOOM_APP_SMOKE_READY {"schemaVersion":"workloom.app-smoke-ready/v1","runtimeIdentity":{...}}
```

观察者在当前进程仍存活时独立核对支持目录、安装状态、全量载荷索引和 server/web 响应。READY 包只携带公开运行身份，不携带环境、子进程原始输出或凭据。观察者完成后发送一行 JSON：

```json
{"schemaVersion":"workloom.app-smoke-release/v1","instanceId":"READY包中的本次UUID"}
```

释放消息只允许上述两个字段，最多 4096 字节，支持分片和 CRLF。超时配置只能为 1000 至 60000 的十进制整数毫秒，默认 30000。匹配释放消息后应用等待停止完成并退出 0；错误 JSON、额外字段、同包多条内容、错 UUID、过大输入、EOF、超时或停止失败都会停止当前运行并退出 1。原始释放输入不进入错误日志。

观察者还需在退出后复核状态已经非 ready。READY 输出本身只是观察协议，不能单独作为当前运行、原生可运行或平台签名证据。

## 诊断与验证边界

应用错误、checkpoint 和诊断导出使用同一文本/结构脱敏规则，涵盖敏感键、认证串、URL userinfo、编码模式和私钥块。引导在内存中收集自身托管配置的已知秘密值，对无标签的已知值也作过滤。子进程 stdout/stderr 按完整行缓冲后写入，跨行私钥块不会逐行泄漏；超长行丢弃其后续尾段。引导传播给外层 Electron/CLI 的失败也使用已知值过滤后的新 Error，不传播原始 cause/stack。

已知值过滤还覆盖 percent 大小写、全量 percent、JSON 字符串转义和长度不少于 8 的 base64/base64url 形式；短旧值只在完整 token 边界替换，避免把 `workloom-im` 这类公开身份子串改写。普通 percent 路径在没有命中敏感模式或已知值时保留原字节。超长行只保留最多 128 个已丢弃尾字符用于识别跨边界的 PEM header，该丢弃正文不会持久化。

诊断导出只读取当前普通日志文件，跳过链接和截断的首行，再次脱敏。它不会读取其他用户配置以猜测秘密值。这个边界不等于对任意未知、无标签敏感正文作语义识别。

摘要校验与发行包可信来源、Bundle 签名以及 macOS/Windows 平台签名是不同证据。SHA-256 索引不能代替平台签名、公证或真实原生安装。当前 macOS entitlements 保留 `allow-jit`；签名身份、公证及发行策略由原生发布门禁验证。Electron 的版本条件应以 [electron/notarize 官方前置说明](https://github.com/electron/notarize#prerequisites) 为准。

`test:desktop-bootstrap` 包含实际 Node 进程、真实回环 HTTP、安装回滚、内部链接、身份撤销、诊断和观察协议回归。其中生命周期 fixture 的 PostgreSQL 引导命令是明确的测试替身，不构成真实 PostgreSQL、Electron、Windows 或 macOS 原生验收。原生构建器必须继续对最终安装产物执行独立验证。
