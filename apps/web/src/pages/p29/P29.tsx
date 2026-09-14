/**
 * P29 · 我的（PRD §6.2 客户域个人中心：资料/待办/权限/设备会话/安全设置/登录日志/伙伴授权）
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { capabilityText, dictText } from "../../lib/display";
import { AsyncState, Button } from "@workloom/ui";

interface Session { id: string; device_name: string; device_trusted: boolean; ip: string; ua: string; issued_at: string }
interface LoginEvent { kind: string; workspace_id: string | null; ip: string; device: string; created_at: string }
interface Grant { id: string; tenant_name: string; capabilities: string[]; expires_at: string }

const KIND_LABEL: Record<string, string> = {
  "login.ok": "登录成功", "login.fail": "登录失败", "login.locked": "账号锁定",
  logout: "登出", "session.revoked": "会话下线", "invite.accept": "接受邀请", "activate.ok": "开通激活",
};

export default function P29() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState("");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");

  const svc = () => trpc.accounts.my as unknown as {
    sessions: { query: () => Promise<Session[]> };
    loginEvents: { query: () => Promise<LoginEvent[]> };
    myPartnerGrants: { query: () => Promise<Grant[]> };
    revokeSession: { mutate: (i: { sessionId: string }) => Promise<{ ok: boolean }> };
    revokeAllSessions: { mutate: () => Promise<{ ok: boolean }> };
    setQuickPin: { mutate: (i: { pin: string }) => Promise<{ ok: boolean }> };
  };

  async function load() {
    setLoadState("loading");
    try {
      await ensureDemoLogin();
      const [s, e, g] = await Promise.all([
        svc().sessions.query(),
        svc().loginEvents.query(),
        svc().myPartnerGrants.query(),
      ]);
      setSessions(s); setEvents(e); setGrants(g);
      setLoadState("ready");
    } catch (error) {
      console.warn("个人中心加载失败", error);
      setLoadState("error");
    }
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
      <h1 className="text-xl font-bold">我的</h1>
      {msg && <p className="text-sm text-emerald-400">{msg}</p>}

      {loadState !== "ready" && (
        <AsyncState
          status={loadState}
          title={loadState === "loading" ? "正在加载个人信息" : "个人信息暂时无法加载"}
          description={loadState === "loading" ? "正在核对设备、登录记录与授权。" : "这不是空数据；请检查连接后重试。"}
          onRetry={() => void load()}
        />
      )}

      {loadState === "ready" && <><section className={card}>
        <h2 className={h2}>设备与会话（{sessions.length}）</h2>
        {sessions.length === 0 && <p className={dim}>账号体系启用后，这里列出您的全部登录设备</p>}
        {sessions.map((s) => (
          <div key={s.id} className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-neutral-800/60 px-4 py-2 text-sm">
            <div>
              <span className="font-medium">{s.device_name || "未命名设备"}</span>
              {s.device_trusted && <span className="ml-2 rounded bg-emerald-600/20 px-1.5 text-body text-emerald-400">信任</span>}
              <div className="text-body text-neutral-400">{s.ip} · {new Date(s.issued_at).toLocaleString("zh-CN")}</div>
            </div>
            <Button variant="quiet"
              onClick={() => void svc().revokeSession.mutate({ sessionId: s.id }).then(() => { setMsg("已下线该设备"); void load(); }).catch((error) => { console.warn("设备下线失败", error); setMsg("暂时无法下线该设备，请稍后重试。"); })}
            >下线</Button>
          </div>
        ))}
        {sessions.length > 1 && (
          <Button variant="danger" className="mt-3"
            onClick={() => void svc().revokeAllSessions.mutate().then(() => { setMsg("已全部下线，请重新登录"); }).catch((error) => { console.warn("全部设备下线失败", error); setMsg("暂时无法下线全部设备，请稍后重试。"); })}>
            全部设备下线
          </Button>
        )}
      </section>

      <section className={card}>
        <h2 className={h2}>安全设置</h2>
        <div className="mt-2 grid grid-cols-1 items-end gap-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto]">
          <label className="text-neutral-300">前台快切码（4–6 位数字，适合轮班共用电脑）
          <input className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-2 text-sm" value={pin}
            onChange={(e) => setPin(e.target.value)} placeholder="输入新的快切码" inputMode="numeric" maxLength={6} /></label>
          <Button variant="primary"
            onClick={() => void svc().setQuickPin.mutate({ pin }).then(() => setMsg("快切码已更新")).catch((e) => { console.warn("更新快捷码失败", e); setMsg("更新失败，请检查输入后重试。"); })}>
            设置
          </Button>
        </div>
      </section>

      <section className={card}>
        <h2 className={h2}>登录日志（近 20 条）</h2>
        {events.length === 0 && <p className={dim}>暂无记录</p>}
        {events.map((e, i) => (
          <div key={i} className="mt-1 flex flex-wrap justify-between gap-2 border-b border-neutral-800 py-1.5 text-body text-neutral-300">
            <span>{dictText(KIND_LABEL, e.kind)}</span>
            <span className="text-neutral-500">{e.ip} · {new Date(e.created_at).toLocaleString("zh-CN")}</span>
          </div>
        ))}
      </section>

      <section className={card}>
        <h2 className={h2}>我的伙伴授权（代运营/外包视角）</h2>
        {grants.length === 0 && <p className={dim}>您当前没有以伙伴身份持有的授权</p>}
        {grants.map((g) => (
          <div key={g.id} className="mt-2 rounded-lg bg-neutral-800/60 px-4 py-2 text-sm">
            <span className="font-medium">{g.tenant_name}</span>
            <span className="ml-3 text-body text-neutral-400">能力：{(g.capabilities ?? []).map(capabilityText).join("、")}</span>
            <div className="text-body text-neutral-500">有效期至 {new Date(g.expires_at).toLocaleDateString("zh-CN")}</div>
          </div>
        ))}
      </section></>}
    </div>
  );
}

const card = "rounded-xl border border-neutral-800 bg-neutral-900 p-5";
const h2 = "text-sm font-bold text-neutral-200";
const dim = "mt-2 text-body text-neutral-500";
