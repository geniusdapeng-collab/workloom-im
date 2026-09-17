import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, Drawer, Sheet } from "./overlays";

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
});
