/** 已认证的双作用域只在当前异步调用链内传递；后台入口须绑定已有可信作用域。 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface ServiceScope { tenantId: string; workspaceId: string }

const scopes = new AsyncLocalStorage<Readonly<ServiceScope>>();

export function validatedServiceScope(scope: ServiceScope): Readonly<ServiceScope> {
  if (typeof scope?.tenantId !== "string" || !scope.tenantId.trim()
      || typeof scope?.workspaceId !== "string" || !scope.workspaceId.trim()) {
    throw new Error("service scope: 必须提供非空 tenantId 与 workspaceId");
  }
  // 拷贝并冻结，调用方修改原身份对象不能改变在途事务的作用域。
  return Object.freeze({ tenantId: scope.tenantId, workspaceId: scope.workspaceId });
}

/** run 在回调退出后恢复外层上下文，并隔离并发请求；禁止进程级 enterWith。 */
export function runWithServiceScope<T>(scope: ServiceScope, fn: () => T): T {
  return scopes.run(validatedServiceScope(scope), fn);
}

/** 不查属主、不推导 tenant；只消费认证链或内部入口明确传入的双作用域。 */
export function requireServiceScope(workspaceId: string, explicit?: ServiceScope): Readonly<ServiceScope> {
  const current = scopes.getStore();
  const scope = explicit ? validatedServiceScope(explicit) : current;
  if (!scope || scope.workspaceId !== workspaceId
      || current && (scope.tenantId !== current.tenantId || scope.workspaceId !== current.workspaceId)) {
    throw new Error("service scope: 缺少可信双作用域或请求作用域不匹配");
  }
  return scope;
}
