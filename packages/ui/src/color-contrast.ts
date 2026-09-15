/** WCAG 2.x contrast helpers shared by all three WorkLoom clients and projection gates. */
export type RgbColor = readonly [number, number, number];

export interface LightBrandTheme {
  primary: string;
  secondary: string;
}

const LIGHT_SURFACES = ["#ffffff", "#f7f8fb"] as const;
const MIN_TEXT_CONTRAST = 4.5;

export function parseHexColor(value: string): RgbColor | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match?.[1]) return null;
  const numeric = Number.parseInt(match[1], 16);
  return [(numeric >> 16) & 255, (numeric >> 8) & 255, numeric & 255];
}

function relativeLuminance(color: RgbColor): number {
  const channels = color.map((value) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
}

export function colorContrastRatio(foreground: string, background: string): number | null {
  const foregroundRgb = parseHexColor(foreground);
  const backgroundRgb = parseHexColor(background);
  if (!foregroundRgb || !backgroundRgb) return null;
  const first = relativeLuminance(foregroundRgb);
  const second = relativeLuminance(backgroundRgb);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function isAccessibleTextColor(
  foreground: string,
  background: string,
  minimum = MIN_TEXT_CONTRAST,
): boolean {
  const ratio = colorContrastRatio(foreground, background);
  return ratio !== null && ratio >= minimum;
}

export function accessibleForeground(background: string): "#ffffff" | "#111827" {
  const white = colorContrastRatio("#ffffff", background) ?? 0;
  const dark = colorContrastRatio("#111827", background) ?? 0;
  return white >= dark ? "#ffffff" : "#111827";
}

/**
 * C 端是浅色服务前台，品牌主色与辅助色既会用作按钮背景，也会用作正文/导航文字。
 * 因而二者必须在共享浅色表面上达到普通文本 4.5:1；不合格配置在生成和运行时均关闭。
 */
export function validateLightBrandTheme(theme: LightBrandTheme): string[] {
  const issues: string[] = [];
  for (const [key, color] of Object.entries(theme) as Array<[keyof LightBrandTheme, string]>) {
    if (!parseHexColor(color)) {
      issues.push(`${key} 必须使用六位十六进制颜色`);
      continue;
    }
    for (const surface of LIGHT_SURFACES) {
      if (!isAccessibleTextColor(color, surface)) {
        issues.push(`${key} 在浅色界面上的文字对比度低于 4.5:1`);
        break;
      }
    }
    const onColor = accessibleForeground(color);
    if (!isAccessibleTextColor(onColor, color)) {
      issues.push(`${key} 无法提供达到 4.5:1 的按钮前景色`);
    }
  }
  return issues;
}
