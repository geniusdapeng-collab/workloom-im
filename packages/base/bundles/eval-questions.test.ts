import { describe, expect, it } from "vitest";
import {
  bundleEvalQuestionId,
  loadVerifiedBundleEvalQuestions,
} from "./eval-questions.js";

describe("已验证 Bundle 考试题集", () => {
  it("AI PM、平台运营与酒店题集均来自各自清单声明并通过严格 Schema", () => {
    const aiPm = loadVerifiedBundleEvalQuestions("ai-pm");
    const platform = loadVerifiedBundleEvalQuestions("platform");
    const hotel = loadVerifiedBundleEvalQuestions("hotel");
    expect(aiPm.questions.length).toBeGreaterThan(0);
    expect(platform.questions.length).toBeGreaterThan(0);
    expect(hotel.questions.length).toBeGreaterThan(0);
    expect(aiPm.questions.some((question) => question.scenario.turns[0]?.input.includes("PRD"))).toBe(true);
    expect(hotel.questions.some((question) => question.tags.includes("退房"))).toBe(true);
  });

  it("题号同时绑定工作区、Bundle、题序与题面，不跨租户碰撞", () => {
    const set = loadVerifiedBundleEvalQuestions("ai-pm");
    const question = set.questions[0]!;
    const first = bundleEvalQuestionId("workspace-a", set.bundleId, 0, question);
    expect(first).toBe(bundleEvalQuestionId("workspace-a", set.bundleId, 0, question));
    expect(first).not.toBe(bundleEvalQuestionId("workspace-b", set.bundleId, 0, question));
    expect(first).toMatch(/^evq-[a-f0-9]{16}-ai-pm-001-[a-f0-9]{12}$/);
  });
});
