import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NavigationEntry } from "./navigation";
import {
  AppShell,
  BottomTabs,
  ResizablePanel,
  SectionNavigation,
  SideNavigation,
  TopContextBar,
  clampPanelSize,
  panelSizeForKey,
} from "./shell";
import { DemoBanner, OfflineState, PermissionState, Progress, Skeleton, progressPercent } from "./states";

const ENTRIES: readonly NavigationEntry[] = [
  {
    capabilityId: "workloom.today",
    route: "/",
    title: "经营首页",
    group: "today",
    icon: "home",
    clients: ["b-pc", "b-mobile"],
    source: "base",
    order: 10,
  },
  {
    capabilityId: "workloom.approvals",
    route: "/approvals",
    title: "需要企业负责人确认的高风险经营动作审批中心",
    group: "collaboration",
    icon: "approval",
    clients: ["b-pc", "b-mobile"],
    source: "base",
    order: 20,
  },
];

describe("共享运行状态", () => {
  it("演示、离线和权限状态默认只呈现可理解的中文", () => {
    const html = renderToStaticMarkup(
      <>
        <DemoBanner />
        <OfflineState />
        <PermissionState scope="经营中心只读权限" />
      </>,
    );
    for (const text of ["当前为演示环境", "当前处于离线状态", "暂无访问权限", "权限范围：", "经营中心只读权限"]) {
      expect(html).toContain(text);
    }
  });

  it("骨架屏具有状态名称并限制异常数量", () => {
    const html = renderToStaticMarkup(<Skeleton count={30} label="经营数据正在加载" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="经营数据正在加载"');
    expect((html.match(/wl-skeleton--text/g) ?? []).length).toBe(20);
  });

  it("进度值安全钳制并关联说明", () => {
    expect(progressPercent(3, 4)).toBe(75);
    expect(progressPercent(5, 0)).toBe(0);
    const html = renderToStaticMarkup(<Progress label="行业包装配进度" value={15} max={10} description="正在完成最后检查" />);
    expect(html).toContain("100%");
    expect(html).toContain('value="10"');
    expect(html).toContain("正在完成最后检查");
  });
});

describe("共享应用壳", () => {
  it("侧边导航使用能力标识、中文分组和当前页语义", () => {
    const html = renderToStaticMarkup(
      <SideNavigation
        entries={ENTRIES}
        activeRoute="/approvals/42"
        beforeGroups={<label>搜索页面<input /></label>}
        renderItemAction={(entry) => <button type="button">收藏{entry.title}</button>}
        onNavigate={() => undefined}
      />,
    );
    expect(html).toContain('aria-label="主导航"');
    expect(html).toContain("今日");
    expect(html).toContain("协作");
    expect(html).toContain("需要企业负责人确认的高风险经营动作审批中心");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("搜索页面");
    expect(html).toContain("收藏经营首页");
  });

  it("折叠导航不丢失项目可访问名称", () => {
    const html = renderToStaticMarkup(
      <SideNavigation entries={ENTRIES} collapsed onCollapsedChange={() => undefined} onNavigate={() => undefined} />,
    );
    expect(html).toContain('aria-label="经营首页"');
    expect(html).toContain('aria-label="展开主导航"');
  });

  it("侧边导航对绕过 Bundle 装配的机器字段仍安全兜底", () => {
    const html = renderToStaticMarkup(
      <SideNavigation
        entries={[{ ...ENTRIES[0]!, title: "订单 orderStatus" }]}
        onNavigate={() => undefined}
      />,
    );
    expect(html).toContain("未命名页面");
    expect(html).not.toContain("orderStatus");
  });

  it("移动底栏与上下文栏允许长中文自然呈现", () => {
    const html = renderToStaticMarkup(
      <>
        <TopContextBar title="云栖酒店今日经营情况与需要你确认的事项" description="数字员工已完成分析，正在等待负责人裁决" />
        <BottomTabs
          items={[{ id: "today", label: "今日经营", icon: "home" }, { id: "mine", label: "个人与偏好", icon: "account", badge: 12 }]}
          activeId="today"
          onSelect={() => undefined}
        />
      </>,
    );
    expect(html).toContain("云栖酒店今日经营情况与需要你确认的事项");
    expect(html).toContain("个人与偏好");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="个人与偏好，12 项提醒"');
  });

  it("页内分区复用左侧纵向导航且保留当前页语义", () => {
    const html = renderToStaticMarkup(
      <SectionNavigation
        label="考试院分区"
        items={[{ id: "report", label: "成绩单" }, { id: "questions", label: "超长中文行业题库名称", badge: 18 }]}
        activeId="questions"
        onSelect={() => undefined}
      />,
    );
    expect(html).toContain('aria-label="考试院分区"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("超长中文行业题库名称");
    expect(html).toContain("wl-section-navigation__item");
  });

  it("应用壳提供跳转入口和明确的主要内容区域", () => {
    const html = renderToStaticMarkup(
      <AppShell topBar={<div>顶部上下文</div>} sideNavigation={<div>侧边导航</div>} bottomTabs={<div>移动导航</div>}>
        <p>经营内容</p>
      </AppShell>,
    );
    expect(html).toContain('href="#wl-main-content"');
    expect(html).toContain('aria-label="主要内容"');
    expect(html).toContain('data-navigation-mode="responsive"');
  });

  it("可调面板暴露键盘边界与恢复原始大小", () => {
    expect(clampPanelSize(900, 240, 720)).toBe(720);
    expect(clampPanelSize(100, 720, 240)).toBe(240);
    expect(panelSizeForKey("ArrowRight", 320, 240, 720, 24, 360)).toBe(344);
    expect(panelSizeForKey("Home", 320, 240, 720, 24, 360)).toBe(240);
    expect(panelSizeForKey("End", 320, 240, 720, 24, 360)).toBe(720);
    expect(panelSizeForKey("Enter", 320, 240, 720, 24, 360)).toBe(360);
    expect(panelSizeForKey("Escape", 320, 240, 720, 24, 360)).toBeNull();
    const html = renderToStaticMarkup(
      <ResizablePanel title="数字员工协作详情" size={320} onSizeChange={() => undefined} onCollapsedChange={() => undefined}>
        <p>任务正在执行</p>
      </ResizablePanel>,
    );
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-valuemin="240"');
    expect(html).toContain('aria-valuemax="720"');
    expect(html).toContain('aria-valuenow="320"');
    expect(html).toContain('aria-valuetext="320 像素"');
  });
});
