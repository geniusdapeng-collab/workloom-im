# @workloom/industry-contract

WorkLoom IM 发布的行业 Bundle 与三端投影契约。它固定行业包的版本、基座/UI 兼容范围、语义导航、首页插槽、C 端身份策略、品牌覆盖白名单、实验回退信息和数字员工岗位契约。

行业巡检没有基座默认业务规则。Bundle 只有显式声明 `ui.inspection.enabled=true` 和受控 `adapterId`，且通过完整性/签名校验后，才能选择随服务端制品审核的行业巡检适配器；价格、渠道、评价等对象、阈值和用户文案必须留在对应行业适配器内。

行业仓只提交符合本契约的 Bundle 资产，不得覆盖公共组件、风险色、焦点、字号、布局层级或基础导航。生产发布还必须由基座治理脚本校验摘要与签名。

`WorkforcePresetSchema` 是岗位 YAML 的唯一公共 Schema。`coverage`、`readonly`、`night_shift`、`high_risk`、围栏绑定和工具权限都必须显式声明；同一 Bundle 内岗位标识与事件前缀不得重复。治理门禁、运行时装配和种子入口必须消费该 Schema，禁止各自维护宽松副本或猜测默认值。
