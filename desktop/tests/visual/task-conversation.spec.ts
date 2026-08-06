import { expect, test } from "@playwright/test";

test("task conversation prioritizes outcome, evidence, and optional work records", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tests/visual/fixtures/task-conversation.html");

  const verifiedLabels = page.getByText("已完成并验证", { exact: true });
  await expect(verifiedLabels).toHaveCount(2);
  await expect(verifiedLabels.nth(0)).toBeVisible();
  const resultRegions = page.getByRole("region", { name: "任务结果" });
  await expect(resultRegions).toHaveCount(2);
  await expect(resultRegions.nth(0)).toBeVisible();
  const evidenceRegions = page.getByRole("region", { name: "验证与变更" });
  await expect(evidenceRegions).toHaveCount(2);
  await expect(evidenceRegions.nth(0)).toContainText("1 项验证通过");
  await expect(evidenceRegions.nth(0)).toContainText("3 个文件有变更");
  await expect(page.getByText("等待你的授权", { exact: true })).toBeVisible();
  await expect(page.getByText("正在项目中定位代码", { exact: true })).toBeVisible();
  await expect(page.getByText("第一次命令不可用，我已切换到项目中存在的测试入口并完成验证。", { exact: true })).toBeVisible();
  await expect(page.getByText("执行遇到问题", { exact: true })).toHaveCount(0);

  const records = page.locator(".work-record");
  await expect(records).toHaveCount(4);
  await records.first().locator("summary").click();
  await expect(records.first().getByText("定位重复跳转入口", { exact: true })).toBeVisible();
  await expect(records.first().getByRole("button", { name: "过程说明" })).toBeVisible();
});

test("task conversation remains readable in a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 440, height: 820 });
  await page.goto("/tests/visual/fixtures/task-conversation.html");

  const layout = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    evidenceColumns: getComputedStyle(document.querySelector(".evidence-strip")!).gridTemplateColumns,
  }));
  expect(layout.content).toBeLessThanOrEqual(layout.viewport);
  expect(layout.evidenceColumns).not.toBe("none");
  await expect(page.getByRole("button", { name: "允许一次" })).toBeVisible();
  await expect(page.getByText("没有结构化测试记录", { exact: true })).toHaveCount(0);
});
