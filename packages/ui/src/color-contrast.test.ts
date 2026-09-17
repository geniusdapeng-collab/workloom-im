import { describe, expect, it } from "vitest";
import {
  accessibleForeground,
  colorContrastRatio,
  isAccessibleTextColor,
  validateLightBrandTheme,
} from "./color-contrast";

describe("共享品牌色可访问性", () => {
  it("拒绝会在浅色客户端中消失的品牌文字色", () => {
    expect(validateLightBrandTheme({ primary: "#5b8cff", secondary: "#8b5cf6" }))
      .toContain("primary 在浅色界面上的文字对比度低于 4.5:1");
  });

  it("接受满足正文与按钮双向对比度的品牌色", () => {
    expect(validateLightBrandTheme({ primary: "#2457c5", secondary: "#6d28d9" })).toEqual([]);
    expect(accessibleForeground("#2457c5")).toBe("#ffffff");
    expect(isAccessibleTextColor("#ffffff", "#2457c5")).toBe(true);
  });

  it("对非法颜色失败关闭", () => {
    expect(colorContrastRatio("red", "#ffffff")).toBeNull();
    expect(validateLightBrandTheme({ primary: "red", secondary: "#6d28d9" })[0]).toMatch(/六位十六进制/);
  });
});
