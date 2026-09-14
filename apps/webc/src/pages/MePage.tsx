import { useEffect, useState } from "react";
import { Button, Overlay, clientChineseText, clientIdentifierText, clientValueText } from "@workloom/ui";
import { ApiError, api, clearCSession, getStoredUser, storeUser } from "../lib/api";
import { getConfig, getConfigState } from "../lib/config";
import { resetPrefetch, startPrefetch } from "../lib/prefetch";
import type { ActionReceipt, ActionState, BusinessRecord, MemberInfo, SessionUser } from "../lib/types";
import { DemoBadge, PageHeader, chineseMessage } from "../components/common";

export default function MePage({ onGoChat }: { onGoChat: () => void }) {
  const cfg = getConfig();
  const profile = cfg.profile;
  const configReady = getConfigState().ready;
  const [member, setMember] = useState<MemberInfo | null>(null);
  const [orders, setOrders] = useState<BusinessRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);
  const [user, setUser] = useState<SessionUser | null>(() => getStoredUser());
  const [bindingOpen, setBindingOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [codeState, setCodeState] = useState<ActionState>("idle");
  const [bindState, setBindState] = useState<ActionState>("idle");
  const [bindingMessage, setBindingMessage] = useState("");
  const [bindingError, setBindingError] = useState("");
  const [bindingReceipt, setBindingReceipt] = useState<ActionReceipt | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!getConfigState().ready) {
      setMember(null);
      setOrders([]);
      setDemo(false);
      setLoadError("服务配置尚未就绪，账号信息未读取；系统没有展示演示数据。");
      setLoading(false);
      return () => { cancelled = true; };
    }
    // 优先消费首屏并行预取结果；预取未命中再自行拉取
    void startPrefetch().then(async (p) => {
      if (!p.sessionOk) {
        if (!cancelled) {
          setMember(null);
          setOrders([]);
          setDemo(false);
          setLoadError("服务连接失败，账号信息未读取；系统没有展示演示数据。");
          setLoading(false);
        }
        return;
      }
      let m = p.member;
      let o = p.orders;
      if (profile.membership && !m) {
        m = await api.member().catch(() => null);
      }
      if (profile.orders && !o) {
        o = await api.orders().then((r) => r.orders).catch(() => null);
      }
      if (cancelled) return;
      setMember(m);
      setOrders(o ?? []);
      setDemo(Boolean(m?.demo));
      setUser(getStoredUser());
      if ((profile.membership && !m) || (profile.orders && !o)) {
        setLoadError("部分信息暂时无法读取；页面只展示已经由服务端确认的数据，请稍后重试。");
      } else {
        setLoadError("");
      }
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setMember(null);
      setOrders([]);
      setDemo(false);
      setLoadError("账号信息暂时无法读取；系统没有展示演示数据。请稍后重试。");
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [profile.membership, profile.orders, reloadVersion]);

  const reload = () => {
    resetPrefetch();
    setLoadError("");
    setLoading(true);
    setReloadVersion((version) => version + 1);
  };

  const requestCode = async () => {
    if (!configReady || !/^1\d{10}$/.test(phone.trim()) || codeState === "pending") return;
    setCodeState("pending");
    setBindingError("");
    setBindingMessage("");
    try {
      const result = await api.requestIdentityCode({ phone: phone.trim() });
      setCodeState(result.state);
      setBindingMessage(chineseMessage(result.message, "验证码已发送，请查收"));
    } catch (err) {
      const requestId = err instanceof ApiError ? err.requestId : undefined;
      setCodeState("failed");
      setBindingError(`${chineseMessage(err instanceof Error ? err.message : null, "验证码请求失败，请稍后重试")}${requestId ? `（请求${clientIdentifierText(requestId)}）` : ""}`);
    }
  };

  const bindIdentity = async () => {
    if (!configReady || !/^1\d{10}$/.test(phone.trim()) || !/^\d{6}$/.test(code.trim()) || bindState === "pending") return;
    setBindState("pending");
    setBindingError("");
    try {
      const result = await api.bindIdentity({ phone: phone.trim(), code: code.trim() });
      storeUser(result.user);
      setUser(result.user);
      setBindingReceipt(result.receipt);
      setBindState(result.receipt.demo ? "demo" : "success");
      const [nextMember, nextOrders] = await Promise.all([
        profile.membership ? api.member().catch(() => null) : Promise.resolve(null),
        profile.orders ? api.orders().then((r) => r.orders).catch(() => null) : Promise.resolve(null),
      ]);
      if (nextMember) setMember(nextMember);
      if (nextOrders) setOrders(nextOrders);
    } catch (err) {
      const requestId = err instanceof ApiError ? err.requestId : undefined;
      setBindState("failed");
      setBindingError(`${chineseMessage(err instanceof Error ? err.message : null, "身份绑定失败，请检查验证码后重试")}${requestId ? `（请求${clientIdentifierText(requestId)}）` : ""}`);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="我的"
        right={demo || user?.authMode === "demo" || user?.identityMode === "demo" ? <DemoBadge /> : undefined}
      />
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {loadError && (
          <div role="alert" className="flex min-w-0 flex-col gap-3 rounded-2xl border border-alert/50 bg-alert/10 p-4 text-body text-alert min-[380px]:flex-row min-[380px]:items-center min-[380px]:justify-between">
            <p className="min-w-0 break-words leading-relaxed">{loadError}</p>
            <Button className="shrink-0" onClick={reload}>重新加载</Button>
          </div>
        )}
        {/* 身份摘要；权益/积分仅在行业投影显式启用时出现。 */}
        <div className="overflow-hidden rounded-2xl border border-gline bg-gradient-to-br from-bg700 via-bg800 to-bg900 p-4">
          {loading ? (
            <div aria-hidden>
              <div className="flex items-center gap-3">
                <div className="skeleton h-12 w-12 rounded-full" />
                <div className="flex-1">
                  <div className="skeleton h-4 w-24" />
                  <div className="skeleton mt-2 h-3 w-16" />
                </div>
                <div className="skeleton h-7 w-14" />
              </div>
              <div className="mt-3 flex gap-1.5 border-t border-gline/40 pt-3">
                <div className="skeleton h-5 w-20 rounded-full" />
                <div className="skeleton h-5 w-24 rounded-full" />
              </div>
            </div>
          ) : (
            <>
              <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full border border-gline bg-gold/15 font-orb text-[16px] text-gold">
                    {user?.nickname?.slice(0, 1) ?? cfg.logoText}
                  </div>
                  <div className="min-w-0">
                    <p className="break-words text-[15px] font-semibold text-ink">
                      {user?.nickname ?? `${cfg.brandName}用户`}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 text-body text-gold">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2l2.4 4.8 5.3.8-3.8 3.7.9 5.3L12 14.1 7.2 16.6l.9-5.3L4.3 7.6l5.3-.8L12 2z" />
                      </svg>
                      {profile.membership
                        ? member ? clientChineseText(member.title, "权益信息待确认") : "权益信息待确认"
                        : profile.labels.identity}
                    </p>
                  </div>
                </div>
                {profile.membership ? (
                  <div className="shrink-0 text-right">
                    <p className="max-w-[9rem] break-words font-orb text-[20px] text-goldhi">
                      {member?.metric ? clientValueText(member.metric.value) : "…"}
                    </p>
                    <p className="max-w-[9rem] break-words text-body text-ink3">
                      {member?.metric
                        ? clientChineseText(member.metric.label, profile.labels.points)
                        : profile.labels.points}
                    </p>
                  </div>
                ) : (
                  <span className={`shrink-0 rounded-full border px-2.5 py-1 text-body ${user?.authMode === "demo" ? "border-warn/50 bg-warn/10 text-warn" : "border-go/50 bg-go/10 text-go"}`}>
                    {user?.authMode === "demo" ? "演示身份" : "入口已验证"}
                  </span>
                )}
              </div>
              {profile.membership && <div className="mt-3 flex flex-wrap gap-1.5 border-t border-gline/40 pt-3">
                {(member?.benefits ?? []).map((b) => (
                  <span key={b} className="rounded-full bg-gold/10 px-2.5 py-1 text-body text-goldhi">
                    {clientChineseText(b, "权益待确认")}
                  </span>
                ))}
              </div>}
            </>
          )}
        </div>

        {/* 身份绑定状态由 Bundle identityPolicy 投影决定，基座默认不展示死入口。 */}
        {profile.identityBinding && <div className="rounded-2xl border border-line bg-card px-4 py-3">
          <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-body text-ink">身份绑定</p>
            <p className="mt-0.5 break-words text-body text-ink3">
              {user?.memberId ? `${profile.labels.identity}已关联` : "网页访客身份 · 绑定后可使用专属权益"}
            </p>
          </div>
          {user?.memberId ? <span
            className={`rounded-full border px-2.5 py-1 text-body ${
              user.identityMode === "demo"
                ? "border-warn/50 bg-warn/10 text-warn"
                : "border-go/50 bg-go/10 text-go"
            }`}
          >
            {user.identityMode === "demo"
              ? "演示绑定"
              : user.identityMode === "verified"
                ? "已核验"
                : "身份已关联"}
          </span> : (
            <button
              type="button"
              onClick={() => {
                setBindingOpen((open) => !open);
                setBindingError("");
              }}
              disabled={!configReady}
              className="pressable shrink-0 rounded-full border border-gline bg-gold/10 px-3 py-1.5 text-body text-gold disabled:opacity-50"
              aria-expanded={bindingOpen}
            >
              {!configReady ? "配置待恢复" : bindingOpen ? "收起" : "去绑定"}
            </button>
          )}
          </div>

          {bindingOpen && !user?.memberId && (
            <div className="mt-3 space-y-3 border-t border-line pt-3">
              <label className="block">
                <span className="mb-1.5 block text-body text-ink2">身份手机号</span>
                <input
                  value={phone}
                  onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 11))}
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="请输入 11 位手机号"
                  className="h-11 w-full min-w-0 rounded-xl border border-line bg-bg900 px-3.5 text-body text-ink outline-none placeholder:text-ink3 focus:border-gline"
                />
              </label>
              <div className="flex min-w-0 flex-col gap-2 min-[360px]:flex-row">
                <label className="min-w-0 flex-1">
                  <span className="mb-1.5 block text-body text-ink2">验证码</span>
                  <input
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="6 位验证码"
                    className="h-11 w-full min-w-0 rounded-xl border border-line bg-bg900 px-3.5 text-body text-ink outline-none placeholder:text-ink3 focus:border-gline"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void requestCode()}
                  disabled={!/^1\d{10}$/.test(phone.trim()) || codeState === "pending"}
                  className="pressable min-h-11 shrink-0 self-end rounded-xl border border-gline px-3 py-2 text-body leading-snug text-gold disabled:opacity-40"
                >
                  {codeState === "pending" ? "正在请求…" : codeState === "failed" ? "重新获取" : "获取验证码"}
                </button>
              </div>
              {bindingMessage && (
                <div className={`break-words rounded-xl border px-3 py-2 text-body leading-relaxed ${codeState === "demo" ? "border-warn/50 bg-warn/10 text-warn" : "border-gline bg-gold/5 text-ink2"}`}>
                  {bindingMessage}
                </div>
              )}
              {bindingError && (
                <div role="alert" className="break-words rounded-xl border border-alert/50 bg-alert/10 px-3 py-2 text-body leading-relaxed text-alert">
                  {bindingError}
                </div>
              )}
              <button
                type="button"
                onClick={() => void bindIdentity()}
                disabled={!/^1\d{10}$/.test(phone.trim()) || !/^\d{6}$/.test(code.trim()) || bindState === "pending"}
                className="pressable min-h-11 w-full rounded-full bg-gold px-5 py-2.5 text-body font-medium leading-snug text-ongold disabled:opacity-40"
              >
                {bindState === "pending" ? "正在核验并绑定…" : bindState === "failed" ? "重新绑定" : "核验并绑定身份"}
              </button>
              <p className="break-words text-body leading-relaxed text-ink3">
                正式环境仅在租户已配置短信或渠道身份核验后可用；未配置时系统会明确提示，不会假装发送或绑定成功。
              </p>
            </div>
          )}
          {bindingReceipt && (
            <div className="mt-2 space-y-1 text-body text-ink3">
              {bindingReceipt.demo && (
                <p className="break-words text-warn">当前为演示绑定，仅关联演示身份数据，未通过真实短信或渠道核验。</p>
              )}
              <p className="break-words">绑定回执：{clientIdentifierText(bindingReceipt.requestId)}</p>
              {bindingReceipt.eventId && <p className="break-words">账本凭证：{clientIdentifierText(bindingReceipt.eventId)}</p>}
            </div>
          )}
        </div>}

        {/* 历史会话入口 */}
        <button
          type="button"
          onClick={onGoChat}
          className="pressable flex w-full items-center justify-between rounded-2xl border border-line bg-card px-4 py-3.5 text-left active:bg-bg700"
        >
          <div className="min-w-0">
            <p className="text-body text-ink">历史会话</p>
            <p className="mt-0.5 break-words text-body text-ink3">继续与 {cfg.agentName} 的对话</p>
          </div>
          <span className="text-ink3">›</span>
        </button>

        {/* 客服电话（配置驱动） */}
        {cfg.supportPhone && (
          <a
            href={`tel:${cfg.supportPhone}`}
            className="pressable flex w-full items-center justify-between rounded-2xl border border-line bg-card px-4 py-3.5"
          >
            <div>
              <p className="text-body text-ink">联系客服</p>
              <p className="mt-0.5 text-body text-ink3">{cfg.supportPhone}</p>
            </div>
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-holo/10 text-holo">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
              </svg>
            </span>
          </a>
        )}

        <Button variant="quiet" className="w-full" onClick={() => setLogoutOpen(true)}>
          退出当前服务
        </Button>

        {/* 行业业务记录由投影显式开启并提供中文术语。 */}
        {profile.orders && <div className="rounded-2xl border border-line bg-card p-4">
          <p className="text-body font-medium text-ink">{profile.labels.orders}</p>
          <div className="mt-2.5 space-y-2.5">
            {orders.slice(0, 3).map((o) => (
              <div key={o.id} className="flex items-center justify-between text-body">
                <span className="min-w-0 break-words text-ink2">{clientChineseText(o.title, "业务记录")}</span>
                <span className="shrink-0 pl-2 text-ink3">{clientChineseText(o.statusText, "状态待确认")}</span>
              </div>
            ))}
            {orders.length === 0 && !loading && (
              <p className="text-body text-ink3">{loadError ? `${profile.labels.orders}尚未读取` : profile.labels.emptyOrders}</p>
            )}
          </div>
        </div>}
      </div>
      <Overlay
        open={logoutOpen}
        title="退出当前服务？"
        description="将清除本设备中的登录状态与短期入口凭据，不会删除工单、订单或事件账本。"
        onClose={() => setLogoutOpen(false)}
        dismissOnBackdrop={false}
        footer={<>
          <Button onClick={() => setLogoutOpen(false)}>继续使用</Button>
          <Button
            variant="danger"
            onClick={() => {
              clearCSession();
              location.replace(`${location.pathname}${location.hash || "#chat"}`);
            }}
          >
            确认退出
          </Button>
        </>}
      >
        <p className="m-0 break-words text-body leading-relaxed text-ink2">
          正式环境退出后，请从服务方提供的可信入口重新进入；演示环境会建立新的匿名演示会话。
        </p>
      </Overlay>
    </div>
  );
}
