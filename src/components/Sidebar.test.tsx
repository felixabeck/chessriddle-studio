import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { AppShell, MantineProvider } from "@mantine/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { activeDatabaseViewStore } from "@/state/store/database";
import type { SuccessDatabaseInfo } from "@/utils/db";
import { SideBar } from "./Sidebar";
import classes from "./Sidebar.module.css";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  activeDatabaseViewStore.getState().clearDatabase();
  sessionStorage.clear();
});

async function renderSidebar(initialPath = "/", onSendFeedback: () => void = () => {}) {
  const rootRoute = createRootRoute({
    component: () => (
      <AppShell navbar={{ width: "3rem", breakpoint: 0 }}>
        <AppShell.Navbar>
          <SideBar onSendFeedback={onSendFeedback} />
        </AppShell.Navbar>
        <AppShell.Main>
          <Outlet />
        </AppShell.Main>
      </AppShell>
    ),
  });
  const routePaths = [
    "/",
    "/accounts",
    "/library",
    "/databases",
    "/databases/$databaseId",
    "/databasesX",
    "/engines",
    "/settings",
  ];
  const routes = routePaths.map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    await router.load();
  });
  await act(async () =>
    root!.render(
      <MantineProvider>
        <RouterProvider router={router} />
      </MantineProvider>,
    ),
  );
  return router;
}

const database: SuccessDatabaseInfo = {
  type: "success",
  file: { id: { id: "database-A" }, kind: "database" },
  filename: "database-A.db3",
  title: "Database A",
  description: "",
  player_count: 0,
  event_count: 0,
  game_count: 0,
  storage_size: "0",
  indexed: false,
};

function databasesLink() {
  return host!.querySelector<HTMLAnchorElement>('a[aria-label="SideBar.Library"]')!;
}

test("keeps the active sidebar marker aligned with client navigation", async () => {
  const router = await renderSidebar();

  const expectActiveLink = (label: string) => {
    const links = [...host!.querySelectorAll<HTMLAnchorElement>("a[aria-label]")];
    const classActive = links
      .filter((link) => link.classList.contains(classes.active))
      .map((link) => link.getAttribute("aria-label"));
    const ariaCurrent = links
      .filter((link) => link.getAttribute("aria-current") === "page")
      .map((link) => link.getAttribute("aria-label"));

    expect(classActive).toEqual([label]);
    expect(ariaCurrent).toEqual([label]);
    expect(
      links
        .filter(
          (link) =>
            link.classList.contains(classes.active) && link.getAttribute("aria-current") === "page",
        )
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual([label]);
  };

  const navigateAndExpect = async (to: string, label: string) => {
    await act(async () => {
      await router.navigate({ to });
    });
    expectActiveLink(label);
  };

  await navigateAndExpect("/accounts", "SideBar.User");
  await navigateAndExpect("/engines?selected=2", "SideBar.Engines");
  await navigateAndExpect("/library", "SideBar.Library");
  await navigateAndExpect("/databases", "SideBar.Library");
  await navigateAndExpect("/databases/abc", "SideBar.Library");
  await navigateAndExpect("/settings", "SideBar.Settings");
  await navigateAndExpect("/", "SideBar.Board");
});

test("reactively resumes the active database in the sidebar", async () => {
  await renderSidebar("/library");
  expect(databasesLink().getAttribute("href")).toBe("/library");
  await act(async () => activeDatabaseViewStore.getState().setDatabase(database));
  expect(databasesLink().getAttribute("href")).toBe("/databases/database-A");
});

test.each([undefined, null, {}, { file: {} }, { file: { id: { id: "" }, kind: "database" } }])(
  "renders safely and targets the overview with stored value %j",
  async (value) => {
    activeDatabaseViewStore.setState({ database: value as never });
    await expect(renderSidebar()).resolves.toBeDefined();
    expect(databasesLink().getAttribute("href")).toBe("/library");
  },
);

test("marks all database routes active independently of the resume target", async () => {
  activeDatabaseViewStore.getState().setDatabase(database);
  const router = await renderSidebar();
  for (const [to, active] of [
    ["/databases", true],
    ["/databases/", true],
    ["/databases/database-A", true],
    ["/databases/database-B", true],
    ["/settings", false],
    ["/databasesX", false],
  ] as const) {
    await act(async () => {
      await router.navigate({ to: to as string });
    });
    expect(databasesLink().getAttribute("href")).toBe("/databases/database-A");
    expect(databasesLink().getAttribute("aria-current")).toBe(active ? "page" : null);
    expect(databasesLink().classList.contains(classes.active)).toBe(active);
  }
});

test("opens feedback from the sidebar without navigating", async () => {
  const onSendFeedback = vi.fn();
  const router = await renderSidebar("/library", onSendFeedback);
  const button = host!.querySelector<HTMLButtonElement>(
    'button[aria-label="Menu.Help.SendFeedback"]',
  )!;
  expect(button.getAttribute("type")).toBe("button");
  await act(async () => button.click());
  expect(onSendFeedback).toHaveBeenCalledTimes(1);
  expect(router.state.location.pathname).toBe("/library");
  expect(button.classList.contains(classes.active)).toBe(false);
  expect(button.hasAttribute("aria-current")).toBe(false);
});

test("labels the sidebar feedback button with a tooltip", async () => {
  await renderSidebar();
  const button = host!.querySelector<HTMLButtonElement>(
    'button[aria-label="Menu.Help.SendFeedback"]',
  )!;
  await act(async () => {
    button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  });
  await vi.waitFor(() =>
    expect(
      [...document.querySelectorAll('[role="tooltip"]')].map((node) => node.textContent),
    ).toContain("Menu.Help.SendFeedback"),
  );
});
