/**
 * P30 · 成员与系统接入管理。
 * 所有敏感写操作均先预览影响，提交期间锁定，取得服务端回执后才宣告完成。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AsyncState, Button, Overlay } from "@workloom/ui";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { FENCE_LEVEL_TEXT, MEMBER_ROLE_TEXT, dictText } from "../../lib/display";
import { operationFailure, toUiFailure } from "../../lib/ui-state";

interface Member { id: string; memberNo: string; name: string; role: string; status?: string }
interface Policy { action_class: string; fence_level: string; approver_rule: Record<string, unknown> }
interface ApiKey { id: string; name: string; key_prefix: string; capabilities: string[]; last_used_at: string | null; revoked_at: string | null }
interface Me { identity: { memberId?: string; memberNo: string; role: string } }

type PendingAction =
  | { kind: "invite"; name: string; phone: string; role: string }
  | { kind: "role"; member: Member; nextRole: string }
  | { kind: "remove"; member: Member }
  | { kind: "create-key"; name: string }
  | { kind: "revoke-key"; key: ApiKey };

const CLASS_LABEL: Record<string, string> = { daily: "日常执行", business: "经营敏感", finance: "资金相关", redline: "红线" };
const LEVEL_COLOR: Record<string, string> = { auto: "text-emerald-400", review: "text-amber-400", block: "text-red-400" };

export default function P30() {
  const [members, setMembers] = useState<Member[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error" | "forbidden">("loading");
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [loadMessage, setLoadMessage] = useState("");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("staff");
  const [inviteCode, setInviteCode] = useState("");
  const [newKey, setNewKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const admin = () => trpc.accounts.admin as unknown as {
    invite: { mutate: (i: { phone: string; name: string; role: string }) => Promise<{ inviteCode: string }> };
    remove: { mutate: (i: { memberId: string }) => Promise<{ ok: boolean }> };
    updateRole: { mutate: (i: { memberId: string; role: string }) => Promise<{ ok: boolean }> };
    approvalPolicies: { query: () => Promise<Policy[]> };
    apiKeys: { query: () => Promise<ApiKey[]> };
    createApiKey: { mutate: (i: { name: string; capabilities: string[] }) => Promise<{ plainKey: string }> };
    revokeApiKey: { mutate: (i: { keyId: string }) => Promise<{ ok: boolean }> };
  };
  const memberSvc = () => trpc.members as unknown as { list: { query: () => Promise<Member[]> }; me: { query: () => Promise<Me> } };

  const load = useCallback(async (background = false) => {
    if (!background) setLoadState("loading");
    try {
      await ensureDemoLogin();
      const [identity, memberRows, policyRows, keyRows] = await Promise.all([
        memberSvc().me.query(),
        memberSvc().list.query(),
        admin().approvalPolicies.query(),
        admin().apiKeys.query(),
      ]);
      setMe(identity);
      setMembers(memberRows.filter((item) => item.status !== "removed"));
      setPolicies(policyRows);
      setKeys(keyRows);
      setHasSnapshot(true);
      setLoadMessage("");
      setLoadState("ready");
    } catch (error) {
      console.warn("读取成员管理数据失败", error);
      const failure = toUiFailure(error);
      setLoadMessage(failure.message);
      setLoadState(failure.kind === "forbidden" ? "forbidden" : "error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const canManage = loadState === "ready" && ["owner", "manager"].includes(me?.identity.role ?? "readonly");
  const isOwner = me?.identity.role === "owner";

  const confirmPending = async () => {
    const action = pendingAction;
    if (!action || !canManage || busy) return;
    setBusy(action.kind);
    setNotice(null);
    try {
      if (action.kind === "invite") {
        const result = await admin().invite.mutate({ phone: action.phone, name: action.name, role: action.role });
        setInviteCode(result.inviteCode);
        setName("");
        setPhone("");
        setNotice({ tone: "success", text: "服务端已创建邀请；成员接受邀请前不会获得工作区权限。" });
      } else if (action.kind === "role") {
        await admin().updateRole.mutate({ memberId: action.member.id, role: action.nextRole });
        setNotice({ tone: "success", text: `服务端已确认：${action.member.name} 的角色已更新为${dictText(MEMBER_ROLE_TEXT, action.nextRole)}。` });
      } else if (action.kind === "remove") {
        await admin().remove.mutate({ memberId: action.member.id });
        setNotice({ tone: "success", text: `服务端已确认移除 ${action.member.name}，其工作区成员权限已撤销。` });
      } else if (action.kind === "create-key") {
        const result = await admin().createApiKey.mutate({ name: action.name, capabilities: ["read:*"] });
        setNewKey(result.plainKey);
        setKeySaved(false);
        setKeyName("");
        setNotice({ tone: "success", text: "服务端已签发只读接入密钥。明文仅显示一次，请立即安全保存。" });
      } else {
        await admin().revokeApiKey.mutate({ keyId: action.key.id });
        setNotice({ tone: "success", text: `服务端已确认吊销“${action.key.name}”，后续请求将不再通过认证。` });
      }
      setPendingAction(null);
      await load(true);
    } catch (error) {
      console.warn("成员管理操作失败", error);
      const label = action.kind === "invite" ? "成员邀请" : action.kind === "role" ? "角色更新" : action.kind === "remove" ? "成员移除" : action.kind === "create-key" ? "密钥签发" : "密钥吊销";
      setNotice({ tone: "error", text: operationFailure(error, label) });
    } finally {
      setBusy(null);
    }
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(newKey);
      setNotice({ tone: "success", text: "密钥已复制到剪贴板。请保存到受控的密钥管理工具中。" });
    } catch (error) {
      console.warn("复制接入密钥失败", error);
      setNotice({ tone: "error", text: "浏览器未允许复制，请手动选择密钥并安全保存。" });
    }
  };

  if (!hasSnapshot) {
    return <div className="mx-auto max-w-3xl px-6 py-16"><AsyncState status={loadState === "forbidden" ? "forbidden" : loadState === "error" ? "error" : "loading"} title={loadState === "loading" ? "正在读取成员与权限" : undefined} description={loadMessage || "权限确认完成前不会开放成员和密钥操作。"} onRetry={loadState === "error" ? () => void load() : undefined} /></div>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
      <h1 className="text-xl font-bold">成员管理</h1>
      {loadState !== "ready" && <Notice tone="warning">{loadMessage} 正在显示上一次成功快照，敏感操作已暂停。</Notice>}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <section className={card}>
        <h2 className={h2}>邀请成员</h2>
        {canManage ? <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_140px_auto]">
          <input className={inp} placeholder="姓名" value={name} disabled={Boolean(busy)} onChange={(event) => setName(event.target.value)} />
          <input className={inp} placeholder="手机号" value={phone} disabled={Boolean(busy)} onChange={(event) => setPhone(event.target.value)} />
          <select className={inp} value={role} disabled={Boolean(busy)} onChange={(event) => setRole(event.target.value)}>
            <option value="staff">成员</option><option value="readonly">只读成员</option>
            {isOwner && <><option value="manager">管理员</option><option value="owner">负责人</option></>}
          </select>
          <Button variant="primary" disabled={!name.trim() || phone.trim().length < 6 || Boolean(busy)} onClick={() => setPendingAction({ kind: "invite", name: name.trim(), phone: phone.trim(), role })}>预览邀请</Button>
        </div> : <p className="mt-2 text-body text-neutral-400">当前角色仅可查看成员，不能邀请或修改权限。</p>}
        {inviteCode && <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-900/20 p-3 text-body text-amber-300"><strong>一次性邀请码：</strong><span className="break-all">{inviteCode}</span><p className="mt-1 text-neutral-400">仅将其交给目标成员；生产环境应通过受控通知渠道传递。</p></div>}
      </section>

      <section className={card}>
        <h2 className={h2}>成员（{members.length}）</h2>
        {members.length === 0 ? <p className="mt-3 text-body text-neutral-400">当前工作区暂无可显示成员。</p> : members.map((member) => {
          const isSelf = member.memberNo === me?.identity.memberNo || member.id === me?.identity.memberId;
          return <div key={member.id} className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg bg-neutral-800/60 px-4 py-2 text-sm">
            <div className="min-w-0"><span className="font-medium break-words">{member.name}</span><span className="ml-2 text-body text-neutral-400">{dictText(MEMBER_ROLE_TEXT, member.role)}</span>{isSelf && <span className="ml-2 text-body text-emerald-400">当前账号</span>}</div>
            {isOwner && !isSelf && <div className="flex flex-wrap gap-3 text-body">
              <select className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1" value={member.role} disabled={Boolean(busy)} aria-label={`修改 ${member.name} 的角色`} onChange={(event) => setPendingAction({ kind: "role", member, nextRole: event.target.value })}>
                <option value="owner">负责人</option><option value="manager">管理员</option><option value="staff">成员</option><option value="readonly">只读成员</option>
              </select>
              <button disabled={Boolean(busy)} className="text-red-400 underline disabled:opacity-40" onClick={() => setPendingAction({ kind: "remove", member })}>移除</button>
            </div>}
          </div>;
        })}
      </section>

      <section className={card}>
        <h2 className={h2}>审批策略</h2>
        <p className="mt-2 text-body text-neutral-400">策略模板由当前行业包和配置引导提供；基座不内置或展示行业专属模板。</p>
        {policies.length === 0 ? <p className="mt-3 text-body text-neutral-500">尚未配置审批策略，请从配置引导完成装配。</p> : policies.map((policy) => (
          <div key={policy.action_class} className="mt-2 flex justify-between gap-4 border-b border-neutral-800 py-1.5 text-sm">
            <span>{dictText(CLASS_LABEL, policy.action_class)}</span>
            <span className={LEVEL_COLOR[policy.fence_level] ?? "text-neutral-300"}>{dictText(FENCE_LEVEL_TEXT, policy.fence_level)}</span>
          </div>
        ))}
      </section>

      <section className={card}>
        <h2 className={h2}>系统接入密钥</h2>
        {canManage && <div className="mt-2 flex flex-wrap gap-2">
          <input className={`${inp} min-w-0 flex-1`} placeholder="密钥名称（例如：经营系统只读对接）" value={keyName} disabled={Boolean(busy)} onChange={(event) => setKeyName(event.target.value)} />
          <Button variant="primary" disabled={!keyName.trim() || Boolean(busy)} onClick={() => setPendingAction({ kind: "create-key", name: keyName.trim() })}>签发只读密钥</Button>
        </div>}
        {newKey && <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-900/20 p-3 text-body text-amber-300"><p className="font-semibold">密钥明文仅显示一次</p><code className="mt-2 block select-all break-all rounded bg-neutral-950 p-2">{newKey}</code><div className="mt-2 flex flex-wrap gap-2"><Button onClick={() => void copyKey()}>复制密钥</Button><label className="flex items-center gap-2 text-neutral-300"><input type="checkbox" checked={keySaved} onChange={(event) => setKeySaved(event.target.checked)} />我已存入安全位置</label><Button variant="quiet" disabled={!keySaved} onClick={() => { setNewKey(""); setKeySaved(false); }}>完成并隐藏</Button></div></div>}
        {keys.length === 0 ? <p className="mt-3 text-body text-neutral-500">暂无系统接入密钥。</p> : keys.map((key) => (
          <div key={key.id} className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg bg-neutral-800/60 px-4 py-2 text-sm">
            <div className="min-w-0"><span className="font-medium break-words">{key.name}</span><span className="ml-2 text-body text-neutral-400">前缀 {key.key_prefix}… · {key.last_used_at ? `最近使用 ${formatDate(key.last_used_at)}` : "尚未使用"}</span>{key.revoked_at && <span className="ml-2 text-body text-red-300">已吊销</span>}</div>
            {canManage && !key.revoked_at && <button disabled={Boolean(busy)} className="text-body text-red-400 underline disabled:opacity-40" onClick={() => setPendingAction({ kind: "revoke-key", key })}>吊销</button>}
          </div>
        ))}
      </section>

      <Overlay
        open={pendingAction !== null}
        title={pendingAction ? actionTitle(pendingAction) : "确认操作"}
        description="提交期间将锁定重复操作，只有服务端确认后页面才会显示完成。"
        onClose={() => { if (!busy) setPendingAction(null); }}
        dismissOnBackdrop={!busy}
        dismissOnEscape={!busy}
        footer={<><Button variant="quiet" disabled={Boolean(busy)} onClick={() => setPendingAction(null)}>取消</Button><Button variant={pendingAction?.kind === "remove" || pendingAction?.kind === "revoke-key" ? "danger" : "primary"} busy={Boolean(busy)} onClick={() => void confirmPending()}>确认提交</Button></>}
      >
        {pendingAction && <ActionImpact action={pendingAction} />}
      </Overlay>
    </div>
  );
}

function actionTitle(action: PendingAction): string {
  if (action.kind === "invite") return "确认创建成员邀请";
  if (action.kind === "role") return "确认修改成员角色";
  if (action.kind === "remove") return "确认移除成员";
  if (action.kind === "create-key") return "确认签发系统接入密钥";
  return "确认吊销系统接入密钥";
}

function ActionImpact({ action }: { action: PendingAction }) {
  if (action.kind === "invite") return <p>将邀请“{action.name}”以{dictText(MEMBER_ROLE_TEXT, action.role)}身份加入当前工作区，通知目标为 {maskPhone(action.phone)}。接受邀请前不会获得权限。</p>;
  if (action.kind === "role") return <p>成员“{action.member.name}”将从{dictText(MEMBER_ROLE_TEXT, action.member.role)}变更为{dictText(MEMBER_ROLE_TEXT, action.nextRole)}；可见数据和可执行操作会随角色立即变化。</p>;
  if (action.kind === "remove") return <p>成员“{action.member.name}”将失去当前工作区访问权限。历史事件与审计记录不会删除。</p>;
  if (action.kind === "create-key") return <p>将签发名为“{action.name}”的只读密钥。它可以读取获准数据，但不能执行经营写操作；明文只显示一次。</p>;
  return <p>密钥“{action.key.name}”将立即失效，正在使用该密钥的系统对接可能中断；历史调用记录会保留。</p>;
}

function maskPhone(value: string): string {
  if (value.length < 7) return "已填写的联系方式";
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间待确认" : date.toLocaleDateString("zh-CN");
}

function Notice({ tone, children }: { tone: "success" | "error" | "warning"; children: ReactNode }) {
  const cls = tone === "success" ? "border-emerald-500/40 bg-emerald-950/30 text-emerald-300" : tone === "error" ? "border-red-500/50 bg-red-950/30 text-red-300" : "border-amber-500/40 bg-amber-950/30 text-amber-300";
  return <div className={`rounded-lg border px-3 py-2 text-sm ${cls}`} role={tone === "error" ? "alert" : "status"}>{children}</div>;
}

const card = "rounded-xl border border-neutral-800 bg-neutral-900 p-5";
const h2 = "text-sm font-bold text-neutral-200";
const inp = "max-w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100";
