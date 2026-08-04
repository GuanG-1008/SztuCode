import { expect, test } from "@playwright/test";

test("agent workbench sidebar prioritizes tasks and project context", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /新建任务/ })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "搜索任务或项目" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "工作台工具" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "SztuCode", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "开始一个任务", exact: true })).toBeVisible();
  await expect(page.locator(".launcher-heading").getByText("SztuCode", { exact: true })).toBeVisible();
  await expect(page.locator(".launcher-mark img")).toHaveAttribute("alt", "SztuCode");
  await expect(page.getByRole("button", { name: "更多", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "浏览器连接", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "理解项目", exact: true }).click();
  const launcherInput = page.getByPlaceholder("描述你要完成的开发任务，输入 / 调用技能");
  await expect(launcherInput).toHaveValue(/分析当前项目结构/);
  await expect(launcherInput).toBeFocused();
  await expect(page.getByRole("button", { name: "理解项目", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveScreenshot("task-launcher-v5-1280.png", { fullPage: true });
});

test("new task, keyboard shortcut, and more tools remain interactive", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");

  await page.getByRole("button", { name: "全部任务", exact: true }).click();
  await expect(page.getByRole("heading", { name: "全部任务", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /新建任务/ }).click();
  await expect(page.getByRole("heading", { name: "开始一个任务", exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("描述你要完成的开发任务，输入 / 调用技能")).toBeFocused();

  await page.getByPlaceholder("描述你要完成的开发任务，输入 / 调用技能").fill("临时内容");
  await page.keyboard.press("Control+K");
  await expect(page.getByPlaceholder("描述你要完成的开发任务，输入 / 调用技能")).toHaveValue("");
  await expect(page.getByPlaceholder("描述你要完成的开发任务，输入 / 调用技能")).toBeFocused();

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await expect(page.getByRole("button", { name: "更多", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "浏览器连接", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "通用问答", exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot("sidebar-more-tools-1280.png", { fullPage: true });
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await expect(page.getByRole("button", { name: "浏览器连接", exact: true })).toBeHidden();
});

test("slash menu groups commands and supports keyboard selection", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const launcherInput = page.getByPlaceholder("描述你要完成的开发任务，输入 / 调用技能");

  await launcherInput.fill("/");
  const slashMenu = page.getByRole("listbox", { name: "斜杠命令与技能" });
  await expect(slashMenu).toBeVisible();
  await expect(slashMenu.getByRole("region", { name: "命令" }).getByRole("option")).toHaveCount(3);
  await expect(slashMenu.getByRole("region", { name: "技能" }).getByRole("option")).toHaveCount(12);
  await expect(slashMenu.getByRole("option", { name: /\/frontend-design/ })).toBeVisible();
  await expect(slashMenu.getByRole("option", { name: /\/plan/ })).toHaveAttribute("aria-selected", "true");
  await expect(slashMenu.getByText("正在使用内建技能目录，连接本地服务后会同步项目与用户技能")).toBeVisible();
  await expect(page).toHaveScreenshot("slash-command-menu-v3-1280.png", { fullPage: true });

  await page.keyboard.press("ArrowDown");
  await expect(slashMenu.getByRole("option", { name: /\/edits/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(launcherInput).toHaveValue("/edits ");
  await expect(launcherInput).toBeFocused();
  await expect(slashMenu).toBeHidden();

  await launcherInput.fill("/auto");
  await page.keyboard.press("Enter");
  await expect(launcherInput).toHaveValue("/auto ");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alertdialog", { name: "高风险权限提示" })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();

  await launcherInput.fill("/pla");
  await expect(slashMenu.getByRole("option")).toHaveCount(1);
  await expect(slashMenu.getByRole("option", { name: /\/plan/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(slashMenu).toBeHidden();
});

test("new-task controls expose project and permission workflows", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");

  await page.getByRole("button", { name: "选择本地项目", exact: true }).click();
  await expect(page.getByRole("menu", { name: "选择项目" })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "搜索工作空间" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /打开本地文件夹/ })).toBeVisible();
  await expect(page).toHaveScreenshot("launcher-project-menu-1280.png", { fullPage: true });

  await page.getByRole("button", { name: "标准审批", exact: true }).click();
  await expect(page.getByRole("menu", { name: "权限模式" })).toBeVisible();
  await expect(page.getByRole("menu", { name: "权限模式" }).getByRole("menuitemcheckbox")).toHaveCount(1);
  await expect(page.getByRole("menu", { name: "权限模式" }).getByText("计划模式")).toHaveCount(0);
  await expect(page.getByRole("menu", { name: "权限模式" }).getByText("允许编辑")).toHaveCount(0);
  await expect(page).toHaveScreenshot("launcher-permission-menu-1280.png", { fullPage: true });
  await page.getByRole("menuitemcheckbox", { name: /允许全部权限/ }).click();
  await expect(page.getByRole("alertdialog", { name: "高风险权限提示" })).toBeVisible();
  await expect(page).toHaveScreenshot("launcher-permission-confirm-1280.png", { fullPage: true });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: "高风险权限提示" })).toBeHidden();
});

test("automation page communicates its local service integration state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: /自动化/ }).click();
  await expect(page.getByRole("heading", { name: "定时任务", exact: true })).toBeVisible();
  await expect(page.getByText("暂无定时任务")).toBeVisible();
  await expect(page).toHaveScreenshot("agent-automations-1280.png", { fullPage: true });
});

test("sidebar remains usable at compact desktop width", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 720 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /新建任务/ })).toBeVisible();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await expect(page.getByRole("button", { name: "浏览器连接" })).toBeVisible();
  await page.getByPlaceholder("描述你要完成的开发任务，输入 / 调用技能").fill("/");
  await expect(page.getByRole("listbox", { name: "斜杠命令与技能" })).toBeVisible();
  await expect(page).toHaveScreenshot("agent-sidebar-v5-760.png", { fullPage: true });
});

test("settings remains available from the workbench footer", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await expect(page.getByText("系统设置")).toBeVisible();
});
