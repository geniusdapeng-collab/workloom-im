# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workloom-clients.spec.ts >> PC 关键公共能力在窄视口与 200% 文字下不溢出
- Location: tests/ui/workloom-clients.spec.ts:365:1

# Error details

```
Error: {
  "viewport": 1024,
  "viewportHeight": 720,
  "documentWidth": 1024,
  "offenders": [
    {
      "tag": "span",
      "className": "ml-auto text-body text-neutral-500",
      "clientWidth": 13,
      "scrollWidth": 28,
      "text": "织元演示租户"
    }
  ],
  "verticallyClipped": [],
  "fixedOffenders": []
}

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 9

- Array []
+ Array [
+   Object {
+     "className": "ml-auto text-body text-neutral-500",
+     "clientWidth": 13,
+     "scrollWidth": 28,
+     "tag": "span",
+     "text": "织元演示租户",
+   },
+ ]
```

# Page snapshot

```yaml
- generic [ref=f9e3]:
  - generic [ref=f9e5]:
    - navigation "主导航" [ref=f9e6]:
      - generic [ref=f9e7]:
        - generic [ref=f9e11]:
          - generic [ref=f9e12]: WorkLoom
          - generic [ref=f9e13]: 企业数字员工即时协作
        - button "收起主导航" [expanded] [ref=f9e14] [cursor=pointer]
      - generic [ref=f9e18]:
        - generic [ref=f9e20]:
          - generic [ref=f9e21]: 搜索主导航
          - searchbox "搜索主导航" [ref=f9e22]
        - region [ref=f9e23]:
          - heading "今日" [level=2] [ref=f9e24]
          - generic [ref=f9e25]:
            - generic [ref=f9e26]:
              - button "经营首页" [ref=f9e27] [cursor=pointer]
              - button "收藏经营首页" [ref=f9e33]
            - generic [ref=f9e36]:
              - button "统一待办" [ref=f9e37] [cursor=pointer]
              - button "收藏统一待办" [ref=f9e42]
        - region [ref=f9e45]:
          - heading "协作" [level=2] [ref=f9e46]
          - generic [ref=f9e47]:
            - generic [ref=f9e48]:
              - button "任务中心" [ref=f9e49] [cursor=pointer]
              - button "收藏任务中心" [ref=f9e54]
            - generic [ref=f9e57]:
              - button "审批中心" [ref=f9e58] [cursor=pointer]
              - button "收藏审批中心" [ref=f9e63]
        - region [ref=f9e66]:
          - heading "经营" [level=2] [ref=f9e67]
          - generic [ref=f9e68]:
            - generic [ref=f9e69]:
              - button "经营报告" [ref=f9e70] [cursor=pointer]
              - button "收藏经营报告" [ref=f9e74]
            - generic [ref=f9e77]:
              - button "服务前台" [ref=f9e78] [cursor=pointer]
              - button "收藏服务前台" [ref=f9e84]
            - generic [ref=f9e87]:
              - button "老板视图" [ref=f9e88] [cursor=pointer]
              - button "收藏老板视图" [ref=f9e93]
        - region [ref=f9e96]:
          - button "安全与留痕" [ref=f9e97] [cursor=pointer]
        - region [ref=f9e101]:
          - button "自动化" [ref=f9e102] [cursor=pointer]
        - region [ref=f9e106]:
          - button "组织管理" [expanded] [ref=f9e107] [cursor=pointer]
          - generic [ref=f9e111]:
            - generic [ref=f9e112]:
              - button "公司与工作区" [ref=f9e113] [cursor=pointer]
              - button "收藏公司与工作区" [ref=f9e118]
            - generic [ref=f9e121]:
              - button "定制中心" [ref=f9e122] [cursor=pointer]
              - button "收藏定制中心" [ref=f9e128]
            - generic [ref=f9e131]:
              - button "资料录入" [ref=f9e132] [cursor=pointer]
              - button "收藏资料录入" [ref=f9e136]
            - generic [ref=f9e139]:
              - button "行业方案" [ref=f9e140] [cursor=pointer]
              - button "收藏行业方案" [ref=f9e145]
            - generic [ref=f9e148]:
              - button "数字员工" [ref=f9e149] [cursor=pointer]
              - button "收藏数字员工" [ref=f9e157]
            - generic [ref=f9e160]:
              - button "成员管理" [ref=f9e161] [cursor=pointer]
              - button "收藏成员管理" [ref=f9e167]
            - generic [ref=f9e170]:
              - button "伙伴授权" [ref=f9e171] [cursor=pointer]
              - button "收藏伙伴授权" [ref=f9e176]
        - region [ref=f9e179]:
          - heading "我的" [level=2] [ref=f9e180]
          - generic [ref=f9e182]:
            - button "个人与偏好" [ref=f9e183] [cursor=pointer]
            - button "收藏个人与偏好" [ref=f9e189]
      - generic [ref=f9e193]:
        - button "隐藏主导航" [ref=f9e194]: 隐藏
        - button "恢复默认布局" [ref=f9e195]: 恢复默认
        - button "打开视图与布局" [ref=f9e199]: 视图
    - button "小织助手；回车打开对话，方向键移动，按住 Shift 可加速移动" [ref=f9e202]:
      - img [ref=f9e206]:
        - generic:
          - generic: z
          - generic: z
          - generic: z
    - generic [ref=f9e211]:
      - complementary "AI 助手" [ref=f9e212]:
        - generic [ref=f9e213]:
          - generic [ref=f9e217]:
            - generic [ref=f9e218]:
              - img "数字负责人" [ref=f9e219]
              - generic [ref=f9e240]: AI 助手
            - generic [ref=f9e241]: 正在协助：伙伴授权
          - button "切换到我的（个人秘书）" [ref=f9e242] [cursor=pointer]: 我的
          - button "收起 AI 助手" [ref=f9e243] [cursor=pointer]
        - generic [ref=f9e247]:
          - generic [ref=f9e248]: 一个框，四种落点：问 → 直接回答 · 派 → 立项留言 → 只写账本 · 推进 → 续跑当前任务
          - generic [ref=f9e249]: 选择下方常用问题，或直接输入内容开始
        - generic [ref=f9e250]:
          - button "汇报当前经营概况" [ref=f9e251] [cursor=pointer]
          - button "今天有哪些业务关卡需要我确认" [ref=f9e254] [cursor=pointer]
        - generic [ref=f9e258]:
          - textbox "织伴全局对话框输入（提问 / 派活 / 留言 / 推进）" [ref=f9e259]:
            - /placeholder: 问一句、派个任务，或留言…（⌘K 唤起）
          - button "发送" [disabled] [ref=f9e260]
      - generic [ref=f9e261]:
        - generic [ref=f9e262]:
          - heading "伙伴授权" [level=1] [ref=f9e263]
          - paragraph [ref=f9e264]: 授权必须明确选择工作区、能力和有效期；伙伴的动作与吊销记录均可追溯。
        - generic [ref=f9e265]:
          - heading "第一步：登记伙伴" [level=2] [ref=f9e266]
          - generic [ref=f9e267]:
            - textbox "伙伴名称" [ref=f9e268]
            - textbox "对接人手机号" [ref=f9e269]
            - combobox [ref=f9e270]:
              - option "代运营或托管" [selected]
              - option "外包服务"
              - option "只读观察"
            - button "预览登记" [disabled] [ref=f9e271]
        - generic [ref=f9e272]:
          - heading "第二步：签发授权" [level=2] [ref=f9e273]
          - group "选择工作区（至少一项）" [ref=f9e274]:
            - generic [ref=f9e277]:
              - checkbox "织元产品部（AI 产品经理示例团队） 织元演示租户" [ref=f9e278]
              - generic [ref=f9e279]: 织元产品部（AI 产品经理示例团队）
              - generic [ref=f9e280]: 织元演示租户
          - group "选择伙伴能力（至少一项）" [ref=f9e281]:
            - generic [ref=f9e283]:
              - button "工单处理" [ref=f9e284]
              - button "日常执行" [ref=f9e285]
              - button "经营报表" [ref=f9e286]
              - button "交付物查看" [ref=f9e287]
          - generic [ref=f9e288]:
            - generic [ref=f9e289]:
              - generic [ref=f9e290]: 有效期
              - combobox "有效期" [ref=f9e291]:
                - option "30 天"
                - option "90 天" [selected]
                - option "180 天"
                - option "一年"
            - button "预览并签发" [disabled] [ref=f9e292]
          - paragraph [ref=f9e293]: 资金相关能力不向伙伴开放；空工作区范围会被客户端和服务端同时拒绝。
        - generic [ref=f9e294]:
          - heading "授权台账（0）" [level=2] [ref=f9e295]
          - paragraph [ref=f9e296]: 当前公司暂无伙伴授权。
  - region "操作通知"
```

# Test source

```ts
  20  |   await demoEntry.focus();
  21  |   await page.keyboard.press("Enter");
  22  |   await page.waitForURL((url) => url.pathname === next, { timeout: 15_000 });
  23  |   const welcome = page.locator("[data-welcome-phase]");
  24  |   if (next === "/") {
  25  |     await expect(page.locator('[data-product-ready="true"]')).toBeVisible({ timeout: 15_000 });
  26  |     // 欢迎状态与经营主页数据并行读取；等待“显示欢迎”或“可重播”之一，避免异步欢迎在检查开始后才盖住页面。
  27  |     await expect(welcome.or(page.getByRole("button", { name: "重播欢迎" })).first()).toBeVisible({ timeout: 15_000 });
  28  |   }
  29  |   if (await welcome.isVisible()) {
  30  |     const leaveWelcome = welcome.getByRole("button", { name: /跳过开场|稍后继续|进入系统/ }).first();
  31  |     if (await leaveWelcome.isVisible()) {
  32  |       await leaveWelcome.click();
  33  |       await expect(welcome).toHaveCount(0);
  34  |     }
  35  |   }
  36  | }
  37  | 
  38  | async function enterBMobileOwner(page: Page, next = "/") {
  39  |   await enterOwnerDemo(page);
  40  |   const token = await page.evaluate(() => localStorage.getItem("workloom:workloom-im:b-pc:access-token"));
  41  |   expect(token, "PC 开发身份应返回可供同源 B 端验证的短期访问令牌").toBeTruthy();
  42  |   await page.goto(`http://127.0.0.1:3101${next}`);
  43  |   await page.evaluate((value) => {
  44  |     sessionStorage.setItem("workloom:workloom-im:b-mobile:access-token", value ?? "");
  45  |   }, token);
  46  |   await page.reload();
  47  |   await waitForStableUi(page);
  48  |   await expect(page.getByRole("button", { name: "打开主导航" })).toBeVisible({ timeout: 15_000 });
  49  | }
  50  | 
  51  | async function assertNoPageOverflow(page: Page) {
  52  |   const report = await page.evaluate(() => {
  53  |     const root = document.documentElement;
  54  |     const offenders = Array.from(document.querySelectorAll<HTMLElement>("body *"))
  55  |       .filter((element) => {
  56  |         const style = getComputedStyle(element);
  57  |         if (style.display === "none" || style.visibility === "hidden") return false;
  58  |         if (element.closest(".wl-visually-hidden, .sr-only, [aria-hidden='true']")) return false;
  59  |         if (element.matches(".wl-bottom-tabs__label") && style.overflowX === "hidden" && style.webkitLineClamp === "2") return false;
  60  |         if (["auto", "scroll"].includes(style.overflowX)) return false;
  61  |         return element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 2;
  62  |       })
  63  |       .slice(0, 12)
  64  |       .map((element) => ({
  65  |         tag: element.tagName.toLowerCase(),
  66  |         className: element.className.toString().slice(0, 100),
  67  |         clientWidth: element.clientWidth,
  68  |         scrollWidth: element.scrollWidth,
  69  |         text: (element.textContent ?? "").trim().slice(0, 60),
  70  |       }));
  71  |     const verticallyClipped = Array.from(document.querySelectorAll<HTMLElement>("button, [role='button'], .wl-badge, .wl-status-chip, [class~='overflow-hidden']"))
  72  |       .filter((element) => {
  73  |         const style = getComputedStyle(element);
  74  |         if (style.display === "none" || style.visibility === "hidden") return false;
  75  |         if (element.closest(".wl-visually-hidden, .sr-only, [aria-hidden='true']")) return false;
  76  |         if (element.matches(".wl-bottom-tabs__label, .wl-text-ellipsis")) return false;
  77  |         return element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 2;
  78  |       })
  79  |       .slice(0, 12)
  80  |       .map((element) => ({
  81  |         tag: element.tagName.toLowerCase(),
  82  |         className: element.className.toString().slice(0, 100),
  83  |         clientHeight: element.clientHeight,
  84  |         scrollHeight: element.scrollHeight,
  85  |         text: (element.textContent ?? "").trim().slice(0, 60),
  86  |       }));
  87  |     const fixedOffenders = Array.from(document.querySelectorAll<HTMLElement>("body *"))
  88  |       .filter((element) => {
  89  |         const style = getComputedStyle(element);
  90  |         if (style.position !== "fixed" || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  91  |         if (element.closest(".wl-visually-hidden, .sr-only, [aria-hidden='true']")) return false;
  92  |         if (element.matches(".wl-skip-link:not(:focus)")) return false;
  93  |         const rect = element.getBoundingClientRect();
  94  |         return rect.width > 0 && rect.height > 0 && (
  95  |           rect.left < -2 || rect.right > innerWidth + 2 || rect.top < -2 || rect.bottom > innerHeight + 2
  96  |         );
  97  |       })
  98  |       .slice(0, 12)
  99  |       .map((element) => {
  100 |         const rect = element.getBoundingClientRect();
  101 |         return {
  102 |           tag: element.tagName.toLowerCase(),
  103 |           className: element.className.toString().slice(0, 100),
  104 |           left: rect.left,
  105 |           right: rect.right,
  106 |           top: rect.top,
  107 |           bottom: rect.bottom,
  108 |         };
  109 |       });
  110 |     return {
  111 |       viewport: innerWidth,
  112 |       viewportHeight: innerHeight,
  113 |       documentWidth: root.scrollWidth,
  114 |       offenders,
  115 |       verticallyClipped,
  116 |       fixedOffenders,
  117 |     };
  118 |   });
  119 |   expect(report.documentWidth, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(report.viewport + 2);
> 120 |   expect(report.offenders, JSON.stringify(report, null, 2)).toEqual([]);
      |                                                             ^ Error: {
  121 |   expect(report.verticallyClipped, JSON.stringify(report, null, 2)).toEqual([]);
  122 |   expect(report.fixedOffenders, JSON.stringify(report, null, 2)).toEqual([]);
  123 | }
  124 | 
  125 | async function injectLongChineseSamples(page: Page) {
  126 |   const samples = [
  127 |     {
  128 |       locator: page.locator("main h1:visible, main h2:visible, main h3:visible").first(),
  129 |       text: "这是来自行业投影的超长中文页面标题，需要在当前内容区域内自然换行且绝不越界",
  130 |     },
  131 |     {
  132 |       locator: page.locator("main button:visible, main [role='button']:visible").first(),
  133 |       text: "这是来自行业投影的超长中文动态操作名称，需要在当前按钮内自然换行且绝不越界",
  134 |     },
  135 |     {
  136 |       locator: page.locator("main .wl-badge:visible, main .wl-status-chip:visible, main .status-strip:visible").first(),
  137 |       text: "等待业务负责人确认后继续执行",
  138 |     },
  139 |     {
  140 |       locator: page.locator(".wl-bottom-tabs__label:visible").first(),
  141 |       text: "今日经营协作总览",
  142 |     },
  143 |   ];
  144 |   for (const sample of samples) {
  145 |     if (await sample.locator.count() === 0) continue;
  146 |     await sample.locator.evaluate((element, text) => { element.textContent = text; }, sample.text);
  147 |   }
  148 | }
  149 | 
  150 | async function applyAndAssert200PercentText(page: Page) {
  151 |   const sample = page.locator("main h1:visible, main h2:visible, main h3:visible, main p:visible").first();
  152 |   await expect(sample).toBeVisible();
  153 |   const normalSize = await sample.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  154 |   await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  155 |   const scaledSize = await sample.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  156 |   expect(scaledSize, "200% 门禁必须真的放大页面文字，不能被固定 px 字号绕过").toBeGreaterThanOrEqual(normalSize * 1.8);
  157 | }
  158 | 
  159 | async function assertPrimaryNavigationFullyVisible(page: Page) {
  160 |   const navigation = page.locator(".wl-bottom-tabs:visible").first();
  161 |   if (await navigation.count() === 0) return;
  162 |   const report = await navigation.evaluate((element) => {
  163 |     const host = element.querySelector<HTMLElement>(".wl-bottom-tabs__items");
  164 |     const items = Array.from(element.querySelectorAll<HTMLElement>(".wl-bottom-tabs__item"));
  165 |     const labels = Array.from(element.querySelectorAll<HTMLElement>(".wl-bottom-tabs__label"));
  166 |     const hostRect = host?.getBoundingClientRect();
  167 |     return {
  168 |       hostClientWidth: host?.clientWidth ?? 0,
  169 |       hostScrollWidth: host?.scrollWidth ?? 0,
  170 |       navigationRect: (() => {
  171 |         const rect = element.getBoundingClientRect();
  172 |         return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  173 |       })(),
  174 |       itemWidths: items.map((item) => item.getBoundingClientRect().width),
  175 |       itemsInside: items.every((item) => {
  176 |         const rect = item.getBoundingClientRect();
  177 |         return Boolean(hostRect) && rect.left >= hostRect.left - 2 && rect.right <= hostRect.right + 2;
  178 |       }),
  179 |       labels: labels.map((label) => ({
  180 |         text: label.textContent?.trim() ?? "",
  181 |         lineClamp: getComputedStyle(label).webkitLineClamp,
  182 |       })),
  183 |     };
  184 |   });
  185 |   expect(report.hostScrollWidth, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(report.hostClientWidth + 2);
  186 |   expect(report.itemsInside, JSON.stringify(report, null, 2)).toBe(true);
  187 |   expect(Math.min(...report.itemWidths), JSON.stringify(report, null, 2)).toBeGreaterThanOrEqual(44);
  188 |   expect(report.navigationRect.left).toBeGreaterThanOrEqual(-2);
  189 |   expect(report.navigationRect.right).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 2);
  190 |   expect(report.navigationRect.top).toBeGreaterThanOrEqual(-2);
  191 |   expect(report.navigationRect.bottom).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 2);
  192 |   expect(report.labels.every((label) => label.text.length > 0)).toBe(true);
  193 | }
  194 | 
  195 | async function expectInsideViewport(locator: Locator) {
  196 |   const rect = await locator.boundingBox();
  197 |   expect(rect, "目标浮层应具有可见边界").not.toBeNull();
  198 |   const viewport = locator.page().viewportSize();
  199 |   expect(viewport, "测试必须设置固定视口").not.toBeNull();
  200 |   if (!rect || !viewport) return;
  201 |   expect(rect.x).toBeGreaterThanOrEqual(-2);
  202 |   expect(rect.y).toBeGreaterThanOrEqual(-2);
  203 |   expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width + 2);
  204 |   expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height + 2);
  205 | }
  206 | 
  207 | for (const client of clients) {
  208 |   test(`${client.name}：WCAG 严重问题、窄屏与 200% 文字缩放门禁`, async ({ page }) => {
  209 |     await page.setViewportSize({ width: client.width, height: client.height });
  210 |     await page.goto(client.url);
  211 |     await waitForStableUi(page);
  212 | 
  213 |     const accessibility = await new AxeBuilder({ page })
  214 |       .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
  215 |       .analyze();
  216 |     const blocking = accessibility.violations.filter((item) => item.impact === "critical" || item.impact === "serious");
  217 |     expect(blocking.map((item) => ({ id: item.id, impact: item.impact, help: item.help, targets: item.nodes.map((node) => node.target) }))).toEqual([]);
  218 | 
  219 |     await assertNoPageOverflow(page);
  220 |     await applyAndAssert200PercentText(page);
```