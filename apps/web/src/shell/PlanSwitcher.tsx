/**
 * 版本切换演示（F12 权限态：社区版/Pro/Teams/VPC 实切实测 F7.2 能力矩阵）
 * 顶栏胶囊显当前版本；点击展开四版本菜单；切换=auth.setPlan（owner 专属，留痕 plan.switch）
 * → 重签 JWT → 整页重载，各页权限态即时生效（隐藏非置灰 E2.6；越版调用 403+升级提示 H-10）
 */
import { useEffect, useRef, useState } from "react";
import { ensureDemoLogin, setToken, trpc } from "../lib/trpc";

const PLAN_LABEL: Record<string, string> = {
  community: "社区版", pro: "专业版", teams: "团队版", vpc: "专有部署版",
};
const PLAN_ORDER = ["community", "pro", "teams", "vpc"] as const;

export function PlanSwitcher({ onPlan }: { onPlan?: (plan: string) => void }) {
  const [plan, setPlan] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      await ensureDemoLogin();
      const me = await trpc.members.me.query() as { identity: { plan: string } };
      setPlan(me.identity.plan);
      onPlan?.(me.identity.plan);
    })();
  }, [onPlan]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const switchPlan = async (p: string) => {
    if (p === plan) { setOpen(false); return; }
    setBusy(true);
    setErr("");
    try {
      const r = await trpc.auth.setPlan.mutate({ plan: p as "community" | "pro" | "teams" | "vpc" });
      setToken(r.token); // 重签 JWT 后整页重载：权限态全端一致（F5.6）
      window.location.reload();
    } catch (e) {
      console.error("版本切换失败", e);
      setErr("版本暂时无法切换，当前权限没有改变，请稍后重试。");
      setBusy(false);
    }
  };

  if (!plan) return null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title="点击切换演示版本，权限范围会即时更新"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`cursor-pointer rounded-full border px-2.5 py-1 text-body font-bold transition ${
          plan === "community"
            ? "border-line text-ink3 hover:border-gline"
            : "border-gold/50 bg-gold/8 text-goldhi hover:border-gold"
        }`}
      >
        {PLAN_LABEL[plan] ?? "版本待确认"} ▾
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-30 w-44 max-w-[calc(100vw-1rem)] rounded-lg border border-line bg-bg950/95 p-1.5 shadow-[0_12px_40px_rgba(0,0,0,.6)] backdrop-blur-md" role="menu" aria-label="切换演示版本">
          <div className="px-2 pb-1 pt-1 text-body tracking-[.15em] text-ink3">版本切换演示</div>
          {PLAN_ORDER.map((p) => (
            <button
              key={p}
              type="button"
              role="menuitemradio"
              aria-checked={p === plan}
              disabled={busy}
              onClick={() => void switchPlan(p)}
              className={`flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-left text-body hover:bg-card ${
                p === plan ? "font-bold text-goldhi" : "text-ink2"
              }`}
            >
              <span>{PLAN_LABEL[p]}</span>
              <span className="text-body text-ink3">
                {p === "community" ? "基础协作能力" : p === "pro" ? "含夜班与巡检" : p === "teams" ? "含集团共享记忆" : "支持内网部署"}
              </span>
            </button>
          ))}
          {err && <div className="px-2 py-1 text-body text-alert">✗ {err}</div>}
        </div>
      )}
    </div>
  );
}
