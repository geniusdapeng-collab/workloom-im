import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, Drawer, Popover, Sheet } from "./overlays";

vi.mock("react-dom", () => ({
  createPortal: (children: ReactNode) => children,
}));

afterEach(() => vi.unstubAllGlobals());

describe("共享弹层原语", () => {
  it("确认框使用警示对话框语义并默认提供取消路径", () => {
    vi.stubGlobal("document", {});
    const html = renderToStaticMarkup(
      <ConfirmDialog open title="确认发布围栏规则" description="发布后将影响正在运行的数字员工" onClose={() => undefined} onConfirm={() => undefined} />,
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("取消");
    expect(html).toContain("确认");
    expect(html).toContain("关闭");
  });

  it("抽屉和移动面板复用同一个 Overlay 视觉与语义边界", () => {
    vi.stubGlobal("document", {});
    const drawerHtml = renderToStaticMarkup(<Drawer open title="任务详情" onClose={() => undefined}>内容</Drawer>);
    const sheetHtml = renderToStaticMarkup(<Sheet open title="选择操作" onClose={() => undefined}>内容</Sheet>);
    expect(drawerHtml).toContain("wl-overlay--drawer");
    expect(sheetHtml).toContain("wl-overlay--sheet");
    expect(drawerHtml).toContain('role="dialog"');
    expect(sheetHtml).toContain('role="dialog"');
  });

  // 非模态浮层也要有可见出口：Esc / 点击外部之外，面板内必须有「关闭」按钮。
  it("浮层工具面板提供可见关闭按钮（含无标题形态）", () => {
    vi.stubGlobal("document", {});
    const titled = renderToStaticMarkup(
      <Popover open onOpenChange={() => undefined} trigger="更多" title="可用操作">
        <button type="button">查看详情</button>
      </Popover>,
    );
    expect(titled).toContain("wl-popover__close");
    expect(titled).toContain('aria-label="关闭"');
    expect(titled).toContain("可用操作");

    const untitled = renderToStaticMarkup(
      <Popover open onOpenChange={() => undefined} trigger="更多" closeLabel="收起筛选">
        <button type="button">查看详情</button>
      </Popover>,
    );
    expect(untitled).toContain('aria-label="收起筛选"');
  });
});
