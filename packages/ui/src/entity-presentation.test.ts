import { describe, expect, it } from "vitest";
import {
  avatarModelOf,
  avatarPresentationOf,
  skillIconOf,
} from "./entity-presentation";

describe("三端共享的行业无关实体外观解析", () => {
  it("显式 Bundle 外观元数据拥有最高优先级", () => {
    expect(avatarModelOf("任意稳定标识", "Knight")).toBe("Knight");
    expect(avatarPresentationOf("任意稳定标识", {
      model: "Rogue_Hooded", tint: "#123456", workAction: "Use_Item",
    })).toEqual({ model: "Rogue_Hooded", tint: "#123456", workAction: "Use_Item" });
    expect(skillIconOf("skill-any", "report")).toBe("report");
  });

  it("缺省外观只依赖稳定标识并保持确定性", () => {
    const identity = "agent-stable-001";
    expect(avatarModelOf(identity)).toBe(avatarModelOf(identity));
    expect(skillIconOf("skill-stable-001")).toBe(skillIconOf("skill-stable-001"));
  });

  it("未知元数据失败关闭到稳定 fallback，不透传任意文本", () => {
    expect(skillIconOf("skill-stable-002", "<script>alert(1)</script>"))
      .toBe(skillIconOf("skill-stable-002"));
    expect(avatarModelOf("agent-stable-002", "Unknown" as never))
      .toBe(avatarModelOf("agent-stable-002"));
  });
});
