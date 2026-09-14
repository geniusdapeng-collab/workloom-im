/**
 * 空态 / 骨架屏 / 告警条（设计规范 §5.10）
 * 空态：虚线框 + 星云晕染 + 图标 + 一句话引导 + 主行动按钮；副官语气（§9.1）
 * 骨架屏：分块骨架 + 流光扫过（1.4s），禁止白屏与整页转圈（G10 首屏口径）
 * 告警条：红（危险/熔断）/ 琥珀（提醒/降级）/ 青（信息）三级横幅，左图标右文字，可附行动按钮
 */
import type { ReactNode } from "react";
import { Button } from "@workloom/ui";

export { EmptyState, Skeleton } from "@workloom/ui";

export type BannerLevel = "alert" | "warn" | "info";

const BANNER_META: Record<BannerLevel, { icon: string; cls: string }> = {
  alert: { icon: "⛔", cls: "border-alert/50 bg-alert/8 text-alert" },
  warn: { icon: "⚠", cls: "border-warn/45 bg-warn/8 text-warn" },
  info: { icon: "🛰", cls: "border-holo/40 bg-holo/6 text-holo" },
};

export function BannerAlert({
  level,
  children,
  actionLabel,
  onAction,
}: {
  level: BannerLevel;
  children: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const m = BANNER_META[level];
  return (
    <div className={`flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-body ${m.cls}`}>
      <span>{m.icon}</span>
      <span className="flex-1">{children}</span>
      {actionLabel && (
        <Button
          variant="quiet"
          onClick={onAction}
          className="cursor-pointer rounded-md border border-current px-2.5 py-0.5 text-body font-bold"
        >
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
