/**
 * 三端共享、行业无关的实体外观解析。
 *
 * 业务语义只能通过已验证 Bundle 投影出的显式 presentation 元数据进入；
 * 未提供元数据时仅按稳定标识散列，绝不从岗位名、技能名或行业词猜测外观。
 */
import type { IconName } from "./navigation";

export const AVATAR_MODELS = ["Knight", "Mage", "Rogue", "Rogue_Hooded", "Barbarian"] as const;
export type AvatarModel = (typeof AVATAR_MODELS)[number];

export interface AvatarPresentation {
  model: AvatarModel;
  tint?: string;
  workAction?: string;
  cape?: boolean;
  helmetOff?: boolean;
}

const FALLBACK_AVATARS: readonly AvatarModel[] = ["Rogue", "Mage", "Rogue_Hooded", "Barbarian"];

function stableIndex(identity: string, size: number): number {
  let hash = 0;
  for (const char of identity) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return (hash >>> 0) % size;
}

/** 显式模型优先；否则只按稳定标识确定性分配。 */
export function avatarModelOf(identity: string, explicitModel?: AvatarModel): AvatarModel {
  if (explicitModel && AVATAR_MODELS.includes(explicitModel)) return explicitModel;
  return FALLBACK_AVATARS[stableIndex(identity, FALLBACK_AVATARS.length)]!;
}

/** 显式角色外观优先；否则生成不带业务含义的稳定外观。 */
export function avatarPresentationOf(
  identity: string,
  explicit?: AvatarPresentation,
): AvatarPresentation {
  if (explicit && AVATAR_MODELS.includes(explicit.model)) return { ...explicit };
  return { model: avatarModelOf(identity), workAction: "Idle" };
}

export const SKILL_ICON_NAMES = ["skills", "star", "configuration", "search", "rules", "report"] as const satisfies readonly IconName[];
export type SkillIconName = (typeof SKILL_ICON_NAMES)[number];

/** Bundle/分发元数据可指定命名图标；缺省只按技能稳定标识分配，不读取名称语义。 */
export function skillIconOf(identity: string, explicitIcon?: string | null): SkillIconName {
  if (explicitIcon && SKILL_ICON_NAMES.includes(explicitIcon as SkillIconName)) {
    return explicitIcon as SkillIconName;
  }
  return SKILL_ICON_NAMES[stableIndex(identity, SKILL_ICON_NAMES.length)]!;
}
