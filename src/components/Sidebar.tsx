import { AppShellSection, Stack, Tooltip } from "@mantine/core";
import {
  type LucideIcon,
  ChessKnight,
  Brain,
  Library,
  MessageSquarePlus,
  Settings,
  User,
} from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";
import cx from "clsx";
import { useTranslation } from "react-i18next";
import {
  databaseRouteTarget,
  type DatabaseRouteTarget,
} from "@/components/databases/databaseRoute";
import { useActiveDatabaseViewStore } from "@/state/store/database";
import { i18nKey } from "@/utils/i18nKey";
import classes from "./Sidebar.module.css";

type SidebarPath = "/" | "/accounts" | "/library" | "/databases" | "/engines" | "/settings";

interface NavbarLinkProps {
  icon: LucideIcon;
  label: string;
  target?: DatabaseRouteTarget | { to: SidebarPath };
  matchPath: SidebarPath;
}

function matchesSidebarPath(pathname: string, matchPath: SidebarPath): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === matchPath || (matchPath !== "/" && path.startsWith(`${matchPath}/`));
}

function NavbarLink({ matchPath, target = { to: matchPath }, icon: Icon, label }: NavbarLinkProps) {
  const active = useRouterState({
    select: (state) =>
      matchesSidebarPath(state.location.pathname, matchPath) ||
      (matchPath === "/library" && matchesSidebarPath(state.location.pathname, "/databases")),
  });
  return (
    <Tooltip label={label} position="right">
      <Link
        {...target}
        preload="intent"
        aria-label={label}
        className={cx(classes.link, active && classes.active)}
        aria-current={active ? "page" : undefined}
      >
        <Icon size="1.5rem" strokeWidth={2} />
      </Link>
    </Tooltip>
  );
}

const linksdata = [
  { icon: ChessKnight, labelKey: i18nKey("SideBar.Board"), matchPath: "/" },
  { icon: User, labelKey: i18nKey("SideBar.User"), matchPath: "/accounts" },
  {
    icon: Library,
    labelKey: i18nKey("SideBar.Library"),
    matchPath: "/library",
  },
  { icon: Brain, labelKey: i18nKey("SideBar.Engines"), matchPath: "/engines" },
] as const;

export function SideBar({ onSendFeedback }: { onSendFeedback: () => void }) {
  const { t } = useTranslation();
  const database = useActiveDatabaseViewStore((s) => s.database);

  const links = linksdata.map((link) => (
    <NavbarLink
      {...link}
      {...(link.matchPath === "/library" ? { target: databaseRouteTarget(database) } : {})}
      label={t(link.labelKey)}
      key={link.labelKey}
    />
  ));

  return (
    <>
      <AppShellSection grow>
        <Stack justify="center" gap={0}>
          {links}
        </Stack>
      </AppShellSection>
      <AppShellSection>
        <Stack justify="center" gap={0}>
          <Tooltip label={t("Menu.Help.SendFeedback")} position="right">
            <button
              type="button"
              aria-label={t("Menu.Help.SendFeedback")}
              className={cx(classes.link, classes.button)}
              onClick={onSendFeedback}
            >
              <MessageSquarePlus size="1.5rem" strokeWidth={2} />
            </button>
          </Tooltip>
          <NavbarLink icon={Settings} label={t("SideBar.Settings")} matchPath="/settings" />
        </Stack>
      </AppShellSection>
    </>
  );
}
