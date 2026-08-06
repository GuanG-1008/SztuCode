import { expect, test } from "@playwright/test";

type DiffState = {
  changes?: Array<{ path: string; index_status: string; worktree_status: string; additions: number; deletions: number }>;
  selected?: string;
  diff?: string;
  loadingChanges?: boolean;
  loadingDiff?: boolean;
  changesError?: string;
  diffError?: string;
  actionError?: string;
};

/** 通过 DOM 元素上的 __vueParentComponent 拿到 DiffReview 实例并注入状态 */
async function openDiffFixture(
  page: import("@playwright/test").Page,
  state: DiffState = {},
): Promise<() => Record<string, unknown>> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tests/visual/fixtures/diff-review.html");

  await page.locator(".diff-review").evaluate((el, extra) => {
    const instance = (el as HTMLElement & { __vueParentComponent?: { setupState?: Record<string, unknown> } }).__vueParentComponent;
    const setup = instance?.setupState;
    if (!setup) throw new Error("DiffReview setupState is unavailable");
    const apply = (key: string, value: unknown) => {
      const refish = setup[key] as { value?: unknown } | undefined;
      if (refish && typeof refish === "object" && "value" in refish) refish.value = value;
      else setup[key] = value;
    };
    for (const [key, value] of Object.entries(extra as DiffState)) {
      if (value === undefined) continue;
      apply(key, value);
    }
  }, state);

  return () => page.locator(".diff-review").evaluate((el) => {
    const instance = (el as HTMLElement & { __vueParentComponent?: { setupState?: Record<string, unknown> } }).__vueParentComponent;
    return instance?.setupState ?? {};
  });
}

test("列表加载失败时展示内联错误与重试入口", async ({ page }) => {
  await openDiffFixture(page, { changes: [], selected: "", changesError: "本地服务尚未连接" });

  await expect(page.getByText(/加载失败/)).toBeVisible();
  await expect(page.getByRole("button", { name: /重试/ })).toBeVisible();
  await expect(page.getByText("选择左侧文件查看差异")).toBeVisible();
});

test("Diff 加载失败时保留选中文件并展示重试", async ({ page }) => {
  const readState = await openDiffFixture(page, {
    changes: [
      { path: "src/a.py", index_status: "M", worktree_status: "M", additions: 2, deletions: 1 },
      { path: "src/b.py", index_status: "M", worktree_status: "M", additions: 5, deletions: 3 },
    ],
    selected: "src/a.py",
    diffError: "本地服务尚未连接",
  });

  await expect(page.getByText(/差异加载失败/)).toBeVisible();
  await expect(page.getByRole("button", { name: /重试/ })).toBeVisible();
  await expect(page.locator(".diff-review__file.active")).toContainText("src/a.py");

  const state = await readState();
  expect(state.diff).toBe("");
  expect(state.selected).toBe("src/a.py");
});

test("Diff 加载成功时展示差异内容", async ({ page }) => {
  await openDiffFixture(page, {
    changes: [
      { path: "src/a.py", index_status: "M", worktree_status: "M", additions: 2, deletions: 1 },
    ],
    selected: "src/a.py",
    diff: "--- a/src/a.py\n+++ b/src/a.py\n@@ -1,3 +1,4 @@\n+print('hello')",
  });

  await expect(page.locator(".diff-review__pre")).toContainText("print('hello')");
  await expect(page.getByText(/差异加载失败/)).toHaveCount(0);
});

test("接受失败时不标记已暂存并展示内联错误", async ({ page }) => {
  await openDiffFixture(page, {
    changes: [
      { path: "src/a.py", index_status: "M", worktree_status: "M", additions: 2, deletions: 1 },
    ],
    selected: "src/a.py",
    diff: "--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1,2 @@\n+print('x')",
  });

  await page.locator(".diff-review__file-accept").click();
  // 无 daemon：stageChanges reject → 展示接受失败，且不标记已暂存
  await expect(page.getByText(/接受失败/)).toBeVisible();
  await expect(page.getByText("已暂存")).toHaveCount(0);
});

test("拒绝失败时不标记已拒绝并展示内联错误", async ({ page }) => {
  await openDiffFixture(page, {
    changes: [
      { path: "src/a.py", index_status: "M", worktree_status: "M", additions: 2, deletions: 1 },
    ],
    selected: "src/a.py",
    diff: "--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1,2 @@\n+print('x')",
  });

  page.on("dialog", (dialog) => void dialog.accept());
  await page.locator(".diff-review__file-reject").click();
  await expect(page.getByText(/拒绝失败/)).toBeVisible();
  await expect(page.getByText("已拒绝")).toHaveCount(0);
});
