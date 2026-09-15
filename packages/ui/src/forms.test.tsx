import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Checkbox, Combobox, IconButton, Input, Radio, Select, Switch, Textarea } from "./forms";

describe("三端共享表单原语", () => {
  it("输入控件把中文标签、说明和错误与控件建立关联", () => {
    const html = renderToStaticMarkup(
      <Input
        id="company-name"
        label="企业完整名称"
        description="请输入营业执照上的完整中文名称"
        error="企业名称不能为空"
        value=""
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('for="company-name"');
    expect(html).toContain('aria-describedby="company-name-description company-name-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-errormessage="company-name-error"');
    expect(html).toContain('data-invalid="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("企业名称不能为空");
  });

  it("选择和多行输入都保留原生语义与长中文标签", () => {
    const selectHtml = renderToStaticMarkup(
      <Select label="请选择需要由数字员工持续经营的业务范围" required defaultValue="">
        <option value="">请选择</option>
        <option value="hotel">酒店经营</option>
      </Select>,
    );
    const textareaHtml = renderToStaticMarkup(
      <Textarea label="补充说明" description="可填写需要人类负责人重点确认的边界" defaultValue="" />,
    );
    expect(selectHtml).toContain("请选择需要由数字员工持续经营的业务范围");
    expect(selectHtml).not.toContain("（选填）");
    expect(selectHtml).toContain("（必填）");
    expect(selectHtml).toContain('data-required="true"');
    expect(textareaHtml).toContain("（选填）");
    expect(textareaHtml).toContain("wl-textarea");
  });

  it("复选框和开关使用可聚焦的原生输入", () => {
    const checkboxHtml = renderToStaticMarkup(
      <Checkbox label="我已阅读并确认围栏范围" description="高风险动作仍需负责人审批" defaultChecked />,
    );
    const switchHtml = renderToStaticMarkup(
      <Switch label="启用夜班运行" description="夜间仅执行围栏允许的动作" defaultChecked />,
    );
    expect(checkboxHtml).toContain('type="checkbox"');
    expect(checkboxHtml).toContain("我已阅读并确认围栏范围");
    expect(switchHtml).toContain('role="switch"');
    expect(switchHtml).toContain("夜间仅执行围栏允许的动作");
  });

  it("组合框与单选项保留中文标签、原生键盘和错误关联", () => {
    const comboboxHtml = renderToStaticMarkup(
      <Combobox
        id="workspace-search"
        label="查找并切换工作区"
        options={[{ value: "workspace-internal-id", label: "华东经营中心" }]}
        error="请选择您有权限进入的工作区"
      />,
    );
    const radioHtml = renderToStaticMarkup(
      <Radio id="format-pdf" name="format" value="pdf" label="PDF 文档" description="适合归档和分享" defaultChecked />,
    );
    expect(comboboxHtml).toContain('role="combobox"');
    expect(comboboxHtml).toContain('aria-controls="workspace-search-options"');
    expect(comboboxHtml).toContain('aria-invalid="true"');
    expect(comboboxHtml).toContain("华东经营中心");
    expect(radioHtml).toContain('type="radio"');
    expect(radioHtml).toContain("适合归档和分享");
  });

  it("纯图标按钮强制提供可访问名称和忙碌状态", () => {
    const html = renderToStaticMarkup(<IconButton icon="close" label="关闭详情面板" busy />);
    expect(html).toContain('aria-label="关闭详情面板"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("关闭详情面板，处理中");
    expect(html).toContain("disabled");
  });
});
