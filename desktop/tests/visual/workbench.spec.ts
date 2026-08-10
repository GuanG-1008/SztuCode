import { expect, test } from "@playwright/test";

test("agent workbench sidebar prioritizes tasks and project context", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /新建任务/ })).toBeVisible();
  await page.getByRole("button", { name: "搜索任务或项目", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "搜索任务或项目" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "工作台工具" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "SztuCode", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "心念为引，一言功毕", exact: true })).toBeVisible();
  await expect(page.locator(".launcher-mark svg")).toBeVisible();
  await expect(page.getByRole("button", { name: "更多", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "浏览器连接", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "理解项目", exact: true }).click();
  const launcherInput = page.getByPlaceholder("汝之所想，皆以言成");
  await expect(launcherInput).toHaveValue(/分析当前项目结构/);
  await expect(launcherInput).toBeFocused();
  await expect(page.getByRole("button", { name: "理解项目", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveScreenshot("task-launcher-v5-1280.png", { fullPage: true });
});

test("task conversation scrolls against the workspace divider while controls stay visible", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });

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
  await page.goto("/", { waitUntil: "domcontentloaded" });
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
                <textarea aria-label="汝之所想，皆以言成">/</textarea>
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

test("bottom diff preview is restored from the latest run after reopening a session", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await page.evaluate(async () => {
    const modulePath = "/src/lib/ipc.ts";
    const { IpcClient } = await import(modulePath) as {
      IpcClient: { prototype: { request: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>> } };
    };
    IpcClient.prototype.request = async (method, params = {}) => {
      if (method === "session.get_history") return { messages: [], run_stats: {} };
      if (method === "workspace.tree") return { nodes: [] };
      if (method === "change.list") {
        if (params.run_id !== "run-history") throw new Error("unexpected run id");
        return {
          changes: [{
            path: "src/App.vue",
            index_status: " ",
            worktree_status: "M",
            run_id: "run-history",
            agent_owned: true,
            revertible: true,
            additions: 12,
            deletions: 3,
          }],
        };
      }
      return {};
    };

    const root = document.querySelector("#app") as HTMLElement & {
      __vue_app__?: { _instance?: { setupState?: Record<string, unknown> } };
    };
    const state = root.__vue_app__?._instance?.setupState;
    if (!state) throw new Error("Vue application state is unavailable");
    const project = { workspace_id: "workspace-history", name: "History", path: "F:/history", archived: false };
    state.workspace = project;
    state.workspaces = [project];
    state.sessions = [{
      session_id: "session-history",
      title: "Historical task",
      status: "active",
      updated_at: "",
      archived: false,
      pinned: false,
      workspace_id: "workspace-history",
      latest_run_id: "run-history",
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_elapsed_s: 0,
    }];
    const chooseTask = state.chooseTask as ((id: string) => Promise<void>) | undefined;
    if (!chooseTask) throw new Error("chooseTask is unavailable");
    await chooseTask("session-history");
  });

  const preview = page.locator(".bottom-diff-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("本轮修改 1 个文件");
  await expect(preview).toContainText("+12");
  await expect(preview).toContainText("−3");
});

test("compaction context stays hidden while restored user turns remain separate", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await page.evaluate(async () => {
    const modulePath = "/src/lib/ipc.ts";
    const { IpcClient } = await import(modulePath) as {
      IpcClient: { prototype: { request: (method: string) => Promise<Record<string, unknown>> } };
    };
    IpcClient.prototype.request = async (method) => {
      if (method === "workspace.tree") return { nodes: [] };
      if (method === "session.get_history") {
        return {
          messages: [
            { role: "user", content: "第一条真实请求", run_id: "run-1" },
            { role: "assistant", content: "第一条历史输出", run_id: "run-1" },
            {
              role: "user",
              content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n## 1. Original Goal\nInternal only",
            },
            { role: "assistant", content: "Understood, I'll continue from this summary." },
            { role: "user", content: "第二条真实请求", run_id: "run-2" },
            { role: "assistant", content: "第二条历史输出", run_id: "run-2" },
          ],
          run_stats: {},
        };
      }
      return {};
    };

    const root = document.querySelector("#app") as HTMLElement & {
      __vue_app__?: { _instance?: { setupState?: Record<string, unknown> } };
    };
    const state = root.__vue_app__?._instance?.setupState;
    if (!state) throw new Error("Vue application state is unavailable");
    const project = { workspace_id: "workspace-history", name: "History", path: "F:/history", archived: false };
    state.workspace = project;
    state.workspaces = [project];
    state.sessions = [{
      session_id: "session-history",
      title: "Historical task",
      status: "active",
      updated_at: "",
      archived: false,
      pinned: false,
      workspace_id: "workspace-history",
      latest_run_id: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_elapsed_s: 0,
    }];
    const chooseTask = state.chooseTask as ((id: string) => Promise<void>) | undefined;
    if (!chooseTask) throw new Error("chooseTask is unavailable");
    await chooseTask("session-history");
  });

  await expect(page.locator(".timeline-user-message")).toHaveCount(2);
  await expect(page.locator(".timeline-user-message").nth(0)).toHaveText("第一条真实请求");
  await expect(page.locator(".timeline-user-message").nth(1)).toHaveText("第二条真实请求");
  await expect(page.getByText("第一条历史输出", { exact: true })).toBeVisible();
  await expect(page.getByText("第二条历史输出", { exact: true })).toBeVisible();
  await expect(page.getByText(/This session is being continued/)).toHaveCount(0);
  await expect(page.getByText("Understood, I'll continue from this summary.", { exact: true })).toHaveCount(0);
});

test("focused long task titles auto-scroll without a horizontal scrollbar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const longTitle = "这是一个非常长的任务名称用于验证聚焦之后自动横向滚动并且不会出现任何横向滚动条";

  await page.locator("#app").evaluate((root, title) => {
    const app = (root as HTMLElement & {
      __vue_app__?: { _instance?: { setupState?: Record<string, unknown> } };
    }).__vue_app__;
    const state = app?._instance?.setupState;
    if (!state) throw new Error("Vue application state is unavailable");
    state.sessions = [{
      session_id: "session-long-title",
      title,
      status: "waiting_for_input",
      updated_at: "",
      archived: false,
      pinned: false,
      workspace_id: null,
      latest_run_id: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_elapsed_s: 0,
    }];
  }, longTitle);

  const row = page.getByRole("button", { name: longTitle, exact: true });
  const title = row.locator("[data-auto-scroll-title]");
  await expect(row).toBeVisible();
  await row.focus();

  const geometry = await title.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    scrollbarWidth: getComputedStyle(element).scrollbarWidth,
    rowOverflowX: getComputedStyle(element.closest("button")!).overflowX,
  }));
  expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
  expect(geometry.scrollbarWidth).toBe("none");
  expect(geometry.rowOverflowX).toBe("hidden");
  await expect.poll(() => title.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

  await page.getByRole("button", { name: /新建任务/ }).focus();
  await expect.poll(() => title.evaluate((element) => element.scrollLeft)).toBe(0);
});

test("workspace panel collapses smoothly before it is removed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
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
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await page.getByRole("button", { name: "全部任务", exact: true }).click();
  await expect(page.getByRole("heading", { name: "全部任务", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /新建任务/ }).click();
  await expect(page.getByRole("heading", { name: "心念为引，一言功毕", exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("汝之所想，皆以言成")).toBeFocused();

  await page.getByPlaceholder("汝之所想，皆以言成").fill("临时内容");
  await page.keyboard.press("Control+K");
  await expect(page.getByPlaceholder("汝之所想，皆以言成")).toHaveValue("");
  await expect(page.getByPlaceholder("汝之所想，皆以言成")).toBeFocused();

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await expect(page.getByRole("button", { name: "更多", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "浏览器连接", exact: true })).toBeVisible();
  // 通用问答入口暂时隐藏（App.vue chatEntryVisible=false），恢复后改回 toBeVisible
  await expect(page.getByRole("button", { name: "通用问答", exact: true })).not.toBeVisible();
  await expect(page).toHaveScreenshot("sidebar-more-tools-1280.png", { fullPage: true });
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await expect(page.getByRole("button", { name: "浏览器连接", exact: true })).toBeHidden();
});

test("slash menu groups commands and supports keyboard selection", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const launcherInput = page.getByPlaceholder("汝之所想，皆以言成");

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
  await page.goto("/", { waitUntil: "domcontentloaded" });

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
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /自动化/ }).click();
  await expect(page.getByRole("heading", { name: "定时任务", exact: true })).toBeVisible();
  await expect(page.getByText("暂无定时任务")).toBeVisible();
  await expect(page).toHaveScreenshot("agent-automations-1280.png", { fullPage: true });
});

test("sidebar keeps the 952px boundary and auto-collapses below it", async ({ page }) => {
  await page.setViewportSize({ width: 952, height: 640 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
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
  await expect(page.getByRole("heading", { name: "心念为引，一言功毕", exact: true })).toBeVisible();

  await expandNavigation.click();
  await expect(page.getByRole("button", { name: /新建任务/ })).toBeVisible();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await expect(page.getByRole("button", { name: "浏览器连接" })).toBeVisible();
  await page.getByPlaceholder("汝之所想，皆以言成").fill("/");
  await expect(page.getByRole("listbox", { name: "斜杠命令与技能" })).toBeVisible();
  await expect(page).toHaveScreenshot("agent-sidebar-v6-951.png", { fullPage: true });

  await page.setViewportSize({ width: 952, height: 640 });
  await expect(page.getByRole("button", { name: "收起导航" })).toHaveAttribute("aria-expanded", "true");
});

test("sidebar content keeps its width while the navigation viewport collapses", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/", { waitUntil: "domcontentloaded" });

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
  await page.goto("/", { waitUntil: "domcontentloaded" });

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
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await expect(page.getByText("系统设置")).toBeVisible();
});

// 功能：验证右侧功能区"全屏"是真正的全屏——其余窗口功能全部隐藏，功能区独占整个视口，而非浮层遮挡
// 设计：复用 collapse 测试的 Vue 状态注入让会话区/功能区出现，点「全屏」后用 getBoundingClientRect 与 offsetParent
// 断言面板铺满视口且标题栏/导航/会话区真的 display:none，再按 Esc 验证恢复，避免只验证类名导致语义倒退
test("workspace panel fullscreen hides all other windows and fills the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#app").evaluate((root) => {
    const app = (root as HTMLElement & { __vue_app__?: { _instance?: { setupState?: Record<string, unknown> } } }).__vue_app__;
    const state = app?._instance?.setupState;
    if (!state) throw new Error("Vue application state is unavailable");
    state.workspace = { workspace_id: "workspace-fixture", name: "Fixture", path: "F:/fixture", archived: false };
    state.sessions = [{ session_id: "session-fixture", title: "Fixture task", status: "active", updated_at: "", archived: false, pinned: false, workspace_id: "workspace-fixture" }];
    state.activeId = "session-fixture";
  });

  const inspector = page.locator(".project-inspector");
  const expandButton = page.getByRole("button", { name: "全屏", exact: true });
  await expect(expandButton).toBeVisible();
  await expandButton.click();
  await expect(inspector).toHaveClass(/is-expanded/);

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".project-inspector.is-expanded")!;
    const rect = panel.getBoundingClientRect();
    return {
      panel: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      titlebarGone: !document.querySelector<HTMLElement>(".kimi-titlebar")?.offsetParent,
      sidebarGone: !document.querySelector<HTMLElement>(".sidebar-viewport")?.offsetParent,
      canvasGone: !document.querySelector<HTMLElement>(".task-canvas")?.offsetParent,
      dividerGone: !document.querySelector<HTMLElement>(".layout-divider")?.offsetParent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });

  expect(geometry.panel.x).toBe(0);
  expect(geometry.panel.y).toBe(0);
  expect(geometry.panel.width).toBeCloseTo(geometry.viewport.width, 0);
  expect(geometry.panel.height).toBeCloseTo(geometry.viewport.height, 0);
  expect(geometry.titlebarGone).toBe(true);
  expect(geometry.sidebarGone).toBe(true);
  expect(geometry.canvasGone).toBe(true);
  expect(geometry.dividerGone).toBe(true);

  // Esc 退出全屏：其余窗口功能恢复
  await page.keyboard.press("Escape");
  await expect(inspector).not.toHaveClass(/is-expanded/);
  await expect(page.locator(".kimi-titlebar")).toBeVisible();
  await expect(page.locator(".sidebar-viewport")).toBeVisible();
  await expect(page.locator(".task-canvas")).toBeVisible();
});

// 功能：模型管理页在窄窗口下不横向溢出、文字不重叠
// 设计：独立 fixture 挂载 ModelManager（IPC 已 mock），分别以 920px（宽）/620px（窄）两个视口渲染，
// 断言页面无横向滚动、操作列与按钮不重叠，并对窄视口提交视觉快照
async function openModelManagerFixture(page: import("@playwright/test").Page, width: number, height = 800) {
  await page.setViewportSize({ width, height });
  await page.goto("/tests/visual/fixtures/model-manager.html");
  await expect(page.getByRole("heading", { name: "模型", exact: true })).toBeVisible();
  await expect(page.locator(".model-table-row")).toHaveCount(4);
}

test("model manager keeps a clear table layout at 920px and never overflows horizontally", async ({ page }) => {
  await openModelManagerFixture(page, 920);

  const geometry = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".model-manager-body")!;
    const table = document.querySelector<HTMLElement>(".model-table")!;
    const row = document.querySelector<HTMLElement>(".model-table-row")!;
    const action = row.querySelector<HTMLElement>("span:last-child")!;
    return {
      bodyScrollWidth: body.scrollWidth,
      bodyClientWidth: body.clientWidth,
      rowRight: row.getBoundingClientRect().right,
      tableRight: table.getBoundingClientRect().right,
      actionRight: action.getBoundingClientRect().right,
      headerVisible: !!Array.from(document.querySelectorAll(".model-table > header span")).find((el) => (el as HTMLElement).offsetParent),
      nameEllipsized: getComputedStyle(row.querySelector("b")!).textOverflow === "ellipsis",
    };
  });

  expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(geometry.bodyClientWidth);
  expect(geometry.rowRight).toBeLessThanOrEqual(geometry.tableRight);
  expect(geometry.actionRight).toBeLessThanOrEqual(geometry.tableRight);
  expect(geometry.headerVisible).toBe(true);
  expect(geometry.nameEllipsized).toBe(true);

  // 920px 仍是完整表格：四列表头全部可见
  const headerLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".model-table > header span"))
      .filter((el) => el.offsetParent)
      .map((el) => el.textContent?.trim()),
  );
  expect(headerLabels).toEqual(["模型", "服务商", "接口", "操作"]);
  await expect(page).toHaveScreenshot("model-manager-920.png", { fullPage: true });
});

test("model manager switches to single column at 620px without horizontal overflow", async ({ page }) => {
  await openModelManagerFixture(page, 620);

  const geometry = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".model-manager-body")!;
    const table = document.querySelector<HTMLElement>(".model-table")!;
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".model-table-row"));
    const firstRow = rows[0]!;
    const header = document.querySelector<HTMLElement>(".model-table > header")!;
    const editorButton = document.querySelector<HTMLElement>(".model-add-button")!;
    const vendorCell = firstRow.querySelector<HTMLElement>(":scope > span:nth-child(2)")!;
    const apiCell = firstRow.querySelector<HTMLElement>(":scope > span:nth-child(3)")!;
    return {
      bodyScrollWidth: body.scrollWidth,
      bodyClientWidth: body.clientWidth,
      tableRight: table.getBoundingClientRect().right,
      bodyRight: body.getBoundingClientRect().right,
      firstRowRight: firstRow.getBoundingClientRect().right,
      editorButtonRight: editorButton.getBoundingClientRect().right,
      rowCount: rows.length,
      headerRight: header.getBoundingClientRect().right,
      vendorCellHidden: getComputedStyle(vendorCell).display === "none",
      apiCellHidden: getComputedStyle(apiCell).display === "none",
      nameTitle: firstRow.querySelector("b")!.getAttribute("title"),
      modelTitle: firstRow.querySelector("small")!.getAttribute("title"),
    };
  });

  expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(geometry.bodyClientWidth);
  expect(geometry.firstRowRight).toBeLessThanOrEqual(geometry.tableRight);
  expect(geometry.tableRight).toBeLessThanOrEqual(geometry.bodyRight);
  expect(geometry.editorButtonRight).toBeLessThanOrEqual(geometry.bodyRight);
  expect(geometry.headerRight).toBeLessThanOrEqual(geometry.bodyRight);
  expect(geometry.rowCount).toBe(4);
  // 窄窗口下服务商/接口列让位于名称与操作，完整值保留在 title 中
  expect(geometry.vendorCellHidden).toBe(true);
  expect(geometry.apiCellHidden).toBe(true);
  expect(geometry.nameTitle).toBeTruthy();
  expect(geometry.modelTitle).toBeTruthy();
  await expect(page).toHaveScreenshot("model-manager-620.png", { fullPage: true });
});

test("model editor form becomes single column at 620px and stays inside the dialog", async ({ page }) => {
  await openModelManagerFixture(page, 620);
  // 直接注入编辑器打开状态与服务商选择（绕过点击，避免 backdrop 拦截，与 diff-review 注入模式一致）
  await page.locator(".model-manager").evaluate((el) => {
    const instance = (el as HTMLElement & { __vueParentComponent?: { setupState?: Record<string, unknown> } }).__vueParentComponent;
    const setup = instance?.setupState;
    if (!setup) throw new Error("ModelManager setupState is unavailable");
    const apply = (key: string, value: unknown) => {
      const refish = setup[key] as { value?: unknown } | undefined;
      if (refish && typeof refish === "object" && "value" in refish) refish.value = value;
      else setup[key] = value;
    };
    apply("editorOpen", true);
    apply("selectedVendor", { name: "DeepSeek", logo: null, mark: "D", provider: "openai", baseUrl: "https://api.deepseek.com/v1", apiKeyUrl: "https://platform.deepseek.com/api_keys" });
  });
  await expect(page.locator(".model-editor-fields")).toBeVisible();

  const geometry = await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>(".model-editor")!;
    const fields = document.querySelector<HTMLElement>(".model-editor-fields")!;
    const grid = document.querySelector<HTMLElement>(".model-vendor-grid")!;
    const labels = Array.from(fields.querySelectorAll<HTMLElement>("label"));
    const editorRect = editor.getBoundingClientRect();
    const columns = getComputedStyle(fields).gridTemplateColumns.split(" ").length;
    const vendorColumns = getComputedStyle(grid).gridTemplateColumns.split(" ").length;
    return {
      editorWidth: editorRect.width,
      editorRight: editorRect.right,
      viewportWidth: window.innerWidth,
      fieldsColumns: columns,
      vendorColumns,
      fieldsInside: fields.getBoundingClientRect().right <= editorRect.right,
      labelCount: labels.length,
      labelsInside: labels.every((label) => label.getBoundingClientRect().right <= editorRect.right + 0.5),
    };
  });

  expect(geometry.editorWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.editorRight).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.fieldsColumns).toBe(1);
  expect(geometry.vendorColumns).toBe(1);
  expect(geometry.fieldsInside).toBe(true);
  expect(geometry.labelCount).toBeGreaterThan(0);
  expect(geometry.labelsInside).toBe(true);
  await expect(page.locator(".model-editor")).toHaveScreenshot("model-editor-620.png", { fullPage: true });
});
