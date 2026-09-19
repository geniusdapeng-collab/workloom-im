# vendor/dsh-im · 多平台 IM 机器人接入插件锁定信息（D14 / B11）

| 项 | 值 |
|---|---|
| 包 | `@xmanrui/dsh-im`（dsh 宿主插件；inject: `connection` / `credentials` / `webServer` 全文档化 seam） |
| 锁定版本 | `4.21.2`（npm 发布时间 2026-09-16T17:13Z） |
| 来源 | `https://registry.npmjs.org/@xmanrui/dsh-im/-/dsh-im-4.21.2.tgz` |
| integrity | `sha512-rHwHzbj8eYrYl10NHPdGRLoKr93wkdf/PXhkDSMhx3AYHutDqaDL8s5pd9YueKmu+mLNeNL2o88Huzy5OyVDFw==`（tarball 实测 sha512 与 registry 元数据逐字符一致 ✅） |
| License | MIT（可自由使用和二次开发） |
| 上游仓库 | `github.com/xmanrui/dsh-im` |
| engines | node >= 22.19（本项目 Node 24 LTS 满足） |
| 关键依赖 | dingtalk-stream 2.1.4 / @wecom/aibot-node-sdk 1.0.7 / @tencent-connect/qqbot-nodejs 1.0.4 / @tencent-connect/qqbot-connector 1.2.0 / qrcode 1.5.4 / undici 7.29.0 |
| 入库日期 | 2026-08-17（0.2.2）；2026-09-19 升级 4.21.2 |
| 入库方式 | 文档锁定（不 vendored 源码）；安装走 `scripts/install-im-channels.sh`（pin 版本 + integrity 校验） |

## 上游兼容矩阵（4.21.2 自述，升级必读）

- `package.json#dsh.compatibility.dsh` = `0.1.2-alpha.4 || 0.1.2-alpha.5 || 0.1.2-rc.1 || 0.1.3-alpha.1 || 0.1.5-alpha.1`；README 同步声明「Web profile 已验证兼容」这五个版本。
- 本仓 dsh 锁定为 `0.1.5-rc.2`（同 0.1.5 线，晚于上游已验证的 0.1.5-alpha.1，**不在上游自述清单内**）。该矩阵在插件运行时未被强制校验（仅元数据）；本次升级以「插件挂载 + Host 启动」冒烟为准，真实通道端到端需凭据，列入停车场。
- 旧 pin `0.2.2` 早于 4.17.1 的「DSH 0.1.5 管理接口兼容修复」，在 dsh 0.1.5-rc.2 上反而更不可信。

## 接入边界（D14）

- **首批启用三官方通道**：钉钉（dingtalk-stream）、企业微信（aibot-node-sdk）、飞书 —— 与 `approvals.channel` 枚举对账（packages/base/im-channels/registry.ts）。
- **观察名单不启用**：微信（iLink 长轮询，非官方协议）、WhatsApp（baileys，非官方协议）——合规风险，待官方 API 方案。
- **Slack**：枚举位保留（DDL 已含）；dsh-im 4.21.2 已覆盖 slack 渠道实现，但本产品 registry 仍为 `status=planned`（未启用，启用需产品裁决 + 通道契约测试）。
- **上游新增渠道（本产品未启用，仅登记）**：4.x 线陆续新增 telegram / discord / qq / imessage / wecom-app 与公网 AI Office；本产品 `approvals.channel` 枚举不随之扩张。
- 微信扫码/凭据双接入方式、流式输出（微信除外）由 dsh-im 提供；流式语义本项目首版不接（审批卡片为一次性消息，F5.5）。

## 纪律（同 vendor/dsh 口径）

- 锁版本 + integrity 校验入库；升级前对照 registry 元数据 diff，并跑 im-channels 契约测试全绿。
- 凭据单向提交本机 Host（dsh 设置页），RPC 不回传 Secret，管理 RPC 默认仅回环 —— 与本项目 L7.3（凭据永不经事件明文）口径一致。
- 通道核心逻辑（注册表/入站幂等/卡片出站/手势回调）在 `packages/base/im-channels`（自研护城河，D12 双轨纪律）；dsh-im 只做 L1 通道适配。
- 版本纪律（2026-09-19 更新）：上游已进入 4.x 稳定快发线（20+ releases / 月），本仓按「锁版 + 升级前对照 registry 元数据 diff + 挂载冒烟」跟版；本次由 0.2.2 升到 4.21.2，同时补记上游自述兼容矩阵（见上节）。

## 安装

```bash
bash scripts/install-im-channels.sh        # pin 0.2.2 + integrity 校验 + dsh profile 挂载
IM_DRIVER=mock                              # 默认 mock 驱动（无凭据全流程可跑，D4 同纪律）
```
