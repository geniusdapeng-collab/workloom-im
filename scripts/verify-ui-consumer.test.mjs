import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { verifyUiConsumerRepo } from "./verify-ui-consumer.mjs";

const CLIENTS = [
  { root: "apps/web", marker: "b-pc", shells: "OverlayManager, SideNavigation, TopContextBar, Overlay, Button, Textarea", body: "<OverlayManager><SideNavigation /><TopContextBar /><Overlay /><Button /><Textarea label=\"任务目标\" /></OverlayManager>" },
  { root: "apps/webb", marker: "b-mobile", shells: "OverlayManager, AppShell, BottomTabs, TopContextBar, Drawer, Button, Select", body: "<OverlayManager><AppShell><BottomTabs /><TopContextBar /><Drawer /><Button /><Select label=\"驳回原因\" /></AppShell></OverlayManager>" },
  { root: "apps/webc", marker: "c-mobile", shells: "OverlayManager, AppShell, BottomTabs, TopContextBar, Sheet, Button, Input", body: "<OverlayManager><AppShell><BottomTabs /><TopContextBar /><Sheet /><Button /><Input label=\"咨询内容\" /></AppShell></OverlayManager>" },
];

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "workloom-ui-consumer-"));
  writeFileSync(join(repo, ".workloom-ui.json"), `${JSON.stringify({
    package: "@workloom/ui",
    version: "1.2.3",
    updatePolicy: "upgrade-pr-only",
    requiredClientPackages: CLIENTS.map((client) => `${client.root}/package.json`),
  })}\n`);
  for (const client of CLIENTS) {
    mkdirSync(join(repo, client.root, "src"), { recursive: true });
    writeFileSync(join(repo, client.root, "package.json"), '{"dependencies":{"@workloom/ui":"1.2.3"}}\n');
    writeFileSync(join(repo, client.root, "src/main.tsx"), [
      'import "@workloom/ui/tokens.css";',
      'import "@workloom/ui/content-safety.css";',
      'import "@workloom/ui/components.css";',
      'import "./App";',
    ].join("\n"));
    writeFileSync(join(repo, client.root, "src/App.tsx"), `import { ${client.shells} } from "@workloom/ui";\nexport function Client(){return <main data-workloom-client="${client.marker}">${client.body}</main>}`);
  }
  return repo;
}

describe("行业仓共享界面消费门禁", () => {
  it("要求三端真实渲染共享壳、弹层和表单", () => {
    assert.deepEqual(verifyUiConsumerRepo(fixture()), []);
  });

  it("只导入但不渲染共享壳仍然失败", () => {
    const repo = fixture();
    const path = join(repo, "apps/webc/src/App.tsx");
    writeFileSync(path, readFileSync(path, "utf8").replace("<AppShell>", "<main>").replace("</AppShell>", "</main>"));
    assert.ok(verifyUiConsumerRepo(repo).some((error) => error.includes("apps/webc 未实际渲染共享基座组件 AppShell")));
  });

  it("操作按钮不能代替共享表单控件的真实消费", () => {
    const repo = fixture();
    const path = join(repo, "apps/webc/src/App.tsx");
    writeFileSync(path, readFileSync(path, "utf8")
      .replace(", Input", "")
      .replace('<Input label="咨询内容" />', ""));
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("apps/webc 未实际渲染共享基座组件 共享表单控件")));
    assert.equal(errors.some((error) => error.includes("apps/webc 未实际渲染共享基座组件 共享操作按钮")), false);
  });

  it("共享表单控件也不能代替操作按钮的真实消费", () => {
    const repo = fixture();
    const path = join(repo, "apps/web/src/App.tsx");
    writeFileSync(path, readFileSync(path, "utf8")
      .replace(", Button", "")
      .replace("<Button />", ""));
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("apps/web 未实际渲染共享基座组件 共享操作按钮")));
    assert.equal(errors.some((error) => error.includes("apps/web 未实际渲染共享基座组件 共享表单控件")), false);
  });

  it("拒绝重定义共享令牌和同名公共组件", () => {
    const repo = fixture();
    writeFileSync(join(repo, "apps/webb/src/styles.css"), ":root { --wl-color-action: red; --wl-brand-primary: blue; }\n");
    writeFileSync(join(repo, "apps/webb/src/Button.tsx"), "export function Button(){ return <button>本地按钮</button>; }\n");
    const errors = verifyUiConsumerRepo(repo);
    assert.ok(errors.some((error) => error.includes("重新定义共享令牌 --wl-color-action")));
    assert.ok(errors.some((error) => error.includes("疑似本地复制分叉")));
    assert.equal(errors.some((error) => error.includes("--wl-brand-primary")), false);
  });

  it("拒绝骨架、空态、状态标签、Badge 与 Card 的同义复制", () => {
    const repo = fixture();
    const path = join(repo, "apps/webc/src/local-feedback.tsx");
    writeFileSync(path, [
      "export function SkeletonList(){ return <div>加载中</div>; }",
      "export function EmptyState(){ return <div>暂无数据</div>; }",
      "export function StatusChip(){ return <span>处理中</span>; }",
      "export function Badge(){ return <span>标签</span>; }",
      "export function Card(){ return <section>内容</section>; }",
    ].join("\n"));
    const errors = verifyUiConsumerRepo(repo);
    for (const component of ["SkeletonList", "EmptyState", "StatusChip", "Badge", "Card"]) {
      assert.ok(errors.some((error) => error.includes(`本地定义 ${component}`)), `未拦截 ${component}`);
    }
  });
});
