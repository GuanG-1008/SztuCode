import { expect, test } from "@playwright/test";

test("agent workbench sidebar prioritizes tasks and project context", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /新建任务/ })).toBeVisible();
  await page.getByRole("button", { name: "搜索任务或项目", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "搜索任务或项目" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "工作台工具" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "SztuCode", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Work with SztuCode", exact: true })).toBeVisible();
  await expect(page.locator(".launcher-mark svg")).toBeVisible();
  await expect(page.getByRole("button", { name: "更多", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "浏览器连接", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "理解项目", exact: true }).click();
  const launcherInput = page.getByPlaceholder("描述你要完成的开发任务，输入 / 调用技能");
  await expect(launcherInput).toHaveValue(/分析当前项目结构/);
  await expect(launcherInput).toBeFocused();
  await expect(page.getByRole("button", { name: "理解项目", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveScreenshot("task-launcher-v5-1280.png", { fullPage: true });
});

test("task conversation scrolls against the workspace divider while controls stay visible", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const entries = Array.from(
    { length: 18 },
    (_, index) => `<article style="min-height:100px;padding:18px;border-bottom:1px solid #eee"><b>Task result ${index + 1}</b><p>Implementation and verification details.</p></article>`,
  ).join("");
  await page.locator(".kimi-main").evaluate((main, timeline) => {
    main.innerHTML = `
      <section class="work-page">
        <div class="work-layout">
          <section class="task-canvas">
            <header class="work-header">agent-learning</header>
            <div class="task-conversation">
              <div class="task-stream"><div class="execution-timeline">${timeline}</div></div>
              <form class="kimi-composer"><textarea></textarea><div class="composer-toolbar"><button class="round">+</button><span></span><button class="send">&uarr;</button></div></form>
            </div>
          </section>
          <div class="layout-divider"></div>
          <aside class="project-inspector file-rail">
            <header class="workspace-tab-strip"><nav><button class="active">任务摘要</button></nav></header>
            <main class="task-summary-view">${Array.from({ length: 30 }, (_, index) => `<section class="summary-section"><button class="summary-section-trigger">Task ${index + 1}</button></section>`).join("")}</main>
          </aside>
        </div>
      </section>`;
  }, entries);

  const stream = page.locator(".task-stream");
  await expect.poll(() => stream.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await stream.evaluate((element) => { element.scrollTop = 900; });

  const geometry = await page.evaluate(() => {
    const layout = document.querySelector<HTMLElement>(".work-layout")!;
    const taskCanvas = document.querySelector<HTMLElement>(".task-canvas")!;
    const stream = document.querySelector<HTMLElement>(".task-stream")!;
    const composer = document.querySelector<HTMLElement>(".kimi-composer")!;
    const divider = document.querySelector<HTMLElement>(".layout-divider")!;
    const inspector = document.querySelector<HTMLElement>(".project-inspector")!;
    const workHeader = document.querySelector<HTMLElement>(".work-header")!;
    const tabStrip = document.querySelector<HTMLElement>(".workspace-tab-strip")!;
    const summary = document.querySelector<HTMLElement>(".task-summary-view")!;
    const canvasBounds = taskCanvas.getBoundingClientRect();
    const inspectorBounds = inspector.getBoundingClientRect();
    return {
      taskCanvasRight: canvasBounds.right,
      dividerLeft: divider.getBoundingClientRect().left,
      panelGap: inspectorBounds.left - canvasBounds.right,
      panelsTopAligned: Math.abs(canvasBounds.top - inspectorBounds.top),
      panelsBottomAligned: Math.abs(canvasBounds.bottom - inspectorBounds.bottom),
      headersTopAligned: Math.abs(workHeader.getBoundingClientRect().top - tabStrip.getBoundingClientRect().top),
      headersBottomAligned: Math.abs(workHeader.getBoundingClientRect().bottom - tabStrip.getBoundingClientRect().bottom),
      conversationBottom: stream.parentElement!.getBoundingClientRect().bottom,
      composerBottom: composer.getBoundingClientRect().bottom,
      layoutOverflow: getComputedStyle(layout).overflowY,
      streamOverflow: getComputedStyle(stream).overflowY,
      summaryScrollable: summary.scrollHeight > summary.clientHeight,
    };
  });

  expect(geometry.taskCanvasRight).toBeCloseTo(geometry.dividerLeft, 0);
  expect(geometry.panelGap).toBeCloseTo(6, 0);
  expect(geometry.panelsTopAligned).toBeLessThanOrEqual(1);
  expect(geometry.panelsBottomAligned).toBeLessThanOrEqual(1);
  expect(geometry.headersTopAligned).toBeLessThanOrEqual(1);
  expect(geometry.headersBottomAligned).toBeLessThanOrEqual(1);
  expect(geometry.layoutOverflow).toBe("hidden");
  expect(geometry.streamOverflow).toBe("auto");
  expect(geometry.composerBottom).toBeLessThanOrEqual(geometry.conversationBottom);
  expect(geometry.summaryScrollable).toBe(true);
});

test("task conversation slash menu opens above the composer without clipping", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.locator(".kimi-main").evaluate((main) => {
    main.innerHTML = `
      <section class="work-page">
        <div class="work-layout no-inspector">
          <section class="task-canvas">
            <header class="work-header">agent-learning</header>
            <div class="task-conversation">
              <div class="task-stream"></div>
              <form class="kimi-composer">
                <section class="slash-menu" role="listbox" aria-label="斜杠命令与技能">
                  <div class="slash-menu__scroll"><section class="slash-menu__group"><h3>命令</h3><button><span class="slash-menu__icon command"></span><b>/plan</b><span>制定执行计划</span></button></section></div>
                  <footer><span>Enter 调用</span></footer>
                </section>
                <textarea aria-label="描述要完成的工作，或键入 / 调用技能">/</textarea>
                <div class="composer-toolbar"><button class="round">+</button><span></span><button class="send">&uarr;</button></div>
              </form>
            </div>
          </section>
        </div>
      </section>`;
  });

  const geometry = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".task-canvas")!.getBoundingClientRect();
    const composer = document.querySelector<HTMLElement>(".kimi-composer")!;
    const composerBounds = composer.getBoundingClientRect();
    const menuBounds = document.querySelector<HTMLElement>(".slash-menu")!.getBoundingClientRect();
    return {
      composerOverflow: getComputedStyle(composer).overflow,
      menuScrollMaxHeight: parseFloat(getComputedStyle(document.querySelector<HTMLElement>(".slash-menu__scroll")!).maxHeight),
      menuAboveComposer: menuBounds.bottom <= composerBounds.top,
      menuInsideCanvas: menuBounds.top >= canvas.top && menuBounds.bottom <= canvas.bottom,
      menuHeight: menuBounds.height,
    };
  });

  expect(geometry.composerOverflow).toBe("visible");
  expect(geometry.menuScrollMaxHeight).toBeGreaterThanOrEqual(300);
  expect(geometry.menuScrollMaxHeight).toBeLessThanOrEqual(340);
  expect(geometry.menuAboveComposer).toBe(true);
  expect(geometry.menuInsideCanvas).toBe(true);
  expect(geometry.menuHeight).toBeGreaterThan(0);
});

test("workspace panel collapses smoothly before it is removed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator("#app").evaluate((root) => {
    const app = (root as HTMLElement & { __vue_app__?: { _instance?: { setupState?: Record<string, unknown> } } }).__vue_app__;
    const state = app?._instance?.setupState;
    if (!state) throw new Error("Vue application state is unavailable");
    state.workspace = { workspace_id: "workspace-fixture", name: "Fixture", path: "F:/fixture", archived: false };
    state.sessions = [{ session_id: "session-fixture", title: "Fixture task", status: "active", updated_at: "", archived: false, pinned: false, workspace_id: "workspace-fixture" }];
    state.activeId = "session-fixture";
  });

  const workspaceToggle = page.getByRole("button", { name: "工作区" });
  const layout = page.locator(".work-layout");
  const inspector = page.locator(".project-inspector");
  await expect(workspaceToggle).toHaveAttribute("aria-expanded", "true");
  await expect(inspector).toBeVisible();

  await workspaceToggle.click();
  await expect(workspaceToggle).toHaveAttribute("aria-expanded", "false");
  await expect(layout).toHaveClass(/no-inspector/);
  await expect(inspector).toBeAttached();
  await expect.poll(() => inspector.count()).toBe(0);

  const columns = await layout.evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(columns.split(" ").map(parseFloat).slice(-2)).toEqual([0, 0]);
});

test("new task, keyboard shortcut, and more tools remain interactive", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");

  await page.getByRole("button", { name: "全部任务", exact: true }).click();
  await expect(page.getByRole("heading", { name: "全部任务", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /新建任务/ }).click();
  await expect(page.getByRole("heading", { name: "Work with SztuCode", exact: true })).toBeVisible();
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

test("sidebar keeps the 952px boundary and auto-collapses below it", async ({ page }) => {
  await page.setViewportSize({ width: 952, height: 640 });
  await page.goto("/");
  const navigationToggle = page.getByRole("button", { name: "收起导航" });
  await expect(navigationToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: /新建任务/ })).toBeVisible();

  await page.setViewportSize({ width: 952, height: 639 });
  await expect(page.getByRole("button", { name: "展开导航" })).toHaveAttribute("aria-expanded", "false");

  await page.setViewportSize({ width: 952, height: 640 });
  await expect(page.getByRole("button", { name: "收起导航" })).toHaveAttribute("aria-expanded", "true");

  await page.setViewportSize({ width: 951, height: 640 });
  const expandNavigation = page.getByRole("button", { name: "展开导航" });
  await expect(expandNavigation).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: /新建任务/ })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Work with SztuCode", exact: true })).toBeVisible();

  await expandNavigation.click();
  await expect(page.getByRole("button", { name: /新建任务/ })).toBeVisible();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await expect(page.getByRole("button", { name: "浏览器连接" })).toBeVisible();
  await page.getByPlaceholder("描述你要完成的开发任务，输入 / 调用技能").fill("/");
  await expect(page.getByRole("listbox", { name: "斜杠命令与技能" })).toBeVisible();
  await expect(page).toHaveScreenshot("agent-sidebar-v6-951.png", { fullPage: true });

  await page.setViewportSize({ width: 952, height: 640 });
  await expect(page.getByRole("button", { name: "收起导航" })).toHaveAttribute("aria-expanded", "true");
});

test("sidebar content keeps its width while the navigation viewport collapses", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");

  const sidebar = page.locator(".agent-sidebar");
  const viewport = page.locator(".sidebar-viewport");
  await expect(sidebar).toHaveCSS("width", "268px");
  await page.getByRole("button", { name: "收起导航" }).click();

  const geometry = await page.evaluate(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    const sidebar = document.querySelector<HTMLElement>(".agent-sidebar")!;
    const viewport = document.querySelector<HTMLElement>(".sidebar-viewport")!;
    const command = document.querySelector<HTMLElement>(".new-task-button")!;
    return {
      sidebarWidth: sidebar.getBoundingClientRect().width,
      viewportWidth: viewport.getBoundingClientRect().width,
      commandWidth: command.getBoundingClientRect().width,
    };
  });

  expect(geometry.viewportWidth).toBeGreaterThan(0);
  expect(geometry.viewportWidth).toBeLessThan(268);
  expect(geometry.sidebarWidth).toBe(268);
  expect(geometry.commandWidth).toBeGreaterThan(240);
  await expect(page.getByRole("button", { name: /新建任务/ })).toBeHidden();

  await page.getByRole("button", { name: "展开导航" }).click();
  const expandedGeometry = await page.evaluate(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    const sidebar = document.querySelector<HTMLElement>(".agent-sidebar")!;
    const viewport = document.querySelector<HTMLElement>(".sidebar-viewport")!;
    const command = document.querySelector<HTMLElement>(".new-task-button")!;
    return {
      sidebarWidth: sidebar.getBoundingClientRect().width,
      viewportWidth: viewport.getBoundingClientRect().width,
      commandWidth: command.getBoundingClientRect().width,
    };
  });

  expect(expandedGeometry.viewportWidth).toBeGreaterThan(0);
  expect(expandedGeometry.viewportWidth).toBeLessThan(268);
  expect(expandedGeometry.sidebarWidth).toBe(268);
  expect(expandedGeometry.commandWidth).toBeGreaterThan(240);
  await expect(page.getByRole("button", { name: /新建任务/ })).toBeVisible();
});

test("sidebar resizer clamps its range and collapses after an intentional over-pull", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.removeItem("sztu.sidebarWidth"));
  await page.goto("/");

  const shell = page.locator(".kimi-shell");
  const resizer = page.getByRole("separator", { name: "调整导航宽度" });
  const dragTo = async (targetX: number, release = true) => {
    const bounds = await resizer.boundingBox();
    if (!bounds) throw new Error("Sidebar resizer is unavailable");
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetX, bounds.y + bounds.height / 2, { steps: 5 });
    if (release) await page.mouse.up();
  };

  await dragTo(520);
  await expect(resizer).toHaveAttribute("aria-valuenow", "360");
  expect(await page.evaluate(() => localStorage.getItem("sztu.sidebarWidth"))).toBe("360");

  await dragTo(210);
  await expect(resizer).toHaveAttribute("aria-valuenow", "224");
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);

  await dragTo(150, false);
  await expect(shell).toHaveClass(/sidebar-collapse-armed/);
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  await page.mouse.up();

  await expect(shell).toHaveClass(/sidebar-collapsed/);
  await expect(page.getByRole("button", { name: "展开导航" })).toHaveAttribute("aria-expanded", "false");
});

test("settings remains available from the workbench footer", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await expect(page.getByText("系统设置")).toBeVisible();
});
