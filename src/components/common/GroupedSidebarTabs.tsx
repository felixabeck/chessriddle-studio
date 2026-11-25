import { Tabs } from "@mantine/core";
import { type CSSProperties, Fragment, type HTMLAttributes, type ReactNode } from "react";
import classes from "./SidebarTabsPage.module.css";

type DataAttributes = { [key: `data-${string}`]: string | undefined };

export type GroupedSidebarTab = {
  readonly value: string;
  readonly label: string;
  readonly emoji: string;
  readonly accent: string;
  readonly tabProps?: HTMLAttributes<HTMLButtonElement> & DataAttributes;
};

export type GroupedSidebarGroup = {
  readonly id: string;
  readonly title: string;
  readonly headingProps?: HTMLAttributes<HTMLDivElement> & DataAttributes;
  readonly tabs: readonly GroupedSidebarTab[];
};

function renderTab(tab: GroupedSidebarTab): ReactNode {
  return (
    <Tabs.Tab
      key={tab.value}
      value={tab.value}
      style={{ "--sidebar-accent": tab.accent } as CSSProperties}
      leftSection={
        <span aria-hidden="true" className={classes.tabEmoji}>
          {tab.emoji}
        </span>
      }
      {...tab.tabProps}
    >
      {tab.label}
    </Tabs.Tab>
  );
}

/**
 * Shared grouped sidebar for Guide and Settings: uppercase group headings, a colour-emoji
 * identity per entry, and a 3px accent bar on the selected tab. Compact mode flattens the
 * groups (no headings) and uses a 2px underline under each pill instead of the sidebar bar.
 */
export function GroupedSidebarTabs({
  groups,
  compact,
  extraTabs,
  "aria-label": ariaLabel,
}: {
  groups: readonly GroupedSidebarGroup[];
  compact: boolean;
  extraTabs?: readonly GroupedSidebarTab[];
  "aria-label"?: string;
}) {
  const flattened = [...groups.flatMap((group) => group.tabs), ...(extraTabs ?? [])];

  return (
    <Tabs.List h={compact ? undefined : "100%"} aria-label={ariaLabel}>
      {compact ? (
        flattened.map(renderTab)
      ) : (
        <>
          {groups.map((group) => (
            <Fragment key={group.id}>
              <div
                role="presentation"
                aria-hidden="true"
                className={classes.groupHeading}
                {...group.headingProps}
              >
                {group.title}
              </div>
              {group.tabs.map(renderTab)}
            </Fragment>
          ))}
          {extraTabs?.map(renderTab)}
        </>
      )}
    </Tabs.List>
  );
}
