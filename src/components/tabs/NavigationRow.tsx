import { Menu, Text, Tooltip } from "@mantine/core";
import {
  DragDropContext,
  Draggable,
  Droppable,
  useMouseSensor,
  useTouchSensor,
} from "@hello-pangea/dnd";
import { Link, useRouterState } from "@tanstack/react-router";
import { getCurrentWebviewWindow } from "@/platform/native";
import {
  BookmarkPlus,
  Castle,
  ChevronDown,
  Database,
  FolderOpen,
  LayoutGrid,
  LogOut,
  Maximize,
  PanelTop,
  PanelTopClose,
  Plus,
  Save,
  SquarePlus,
  X,
} from "lucide-react";
import {
  PersonIcon,
  EngineIcon,
  SettingsIcon,
  GuideIcon,
  LibraryIcon,
  AiChatIcon,
  FeedbackIcon,
} from "@/components/common/iconCatalog";
import cx from "clsx";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { databaseRouteTarget } from "@/components/databases/databaseRoute";
import { IconAction } from "@/components/common/IconAction";
import PointerContextMenu from "@/components/common/PointerContextMenu";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import { bindWindowControls, watchMaximized, type MenuAction } from "@/routes/-appMenu";
import type { PageTab } from "@/state/pageTabs";
import { useActiveDatabaseViewStore } from "@/state/store/database";
import { BoardTab, BoardTabIcon } from "./BoardTab";
import { boardTabId, isBoardsPath, isLibraryFamilyPath, pageTabOf } from "./boardTabDom";
import { TabActionsMenu } from "./TabActionsMenu";
import { useTabCommands } from "./TabCommands";
import classes from "./NavigationRow.module.css";
import { formatKeymap } from "@/utils/formatKeymap";

const appWindow = getCurrentWebviewWindow();
const COMPACT_NAVIGATION_ROW_WIDTH_EM = 48;
const POINTER_DRAG_SENSORS = [useMouseSensor, useTouchSensor];

function IconMinimize() {
  return (
    <svg
      aria-hidden
      width="16"
      height="16"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
    >
      <path d="M3 8C3 7.72386 3.22386 7.5 3.5 7.5H12.5C12.7761 7.5 13 7.72386 13 8C13 8.27614 12.7761 8.5 12.5 8.5H3.5C3.22386 8.5 3 8.27614 3 8Z" />
    </svg>
  );
}

function IconRestore() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
    >
      <path d="M5.08496 4C5.29088 3.4174 5.8465 3 6.49961 3H9.99961C11.6565 3 12.9996 4.34315 12.9996 6V9.5C12.9996 10.1531 12.5822 10.7087 11.9996 10.9146V6C11.9996 4.89543 11.1042 4 9.99961 4H5.08496ZM4.5 5H9.5C10.3284 5 11 5.67157 11 6.5V11.5C11 12.3284 10.3284 13 9.5 13H4.5C3.67157 13 3 12.3284 3 11.5V6.5C3 5.67157 3.67157 5 4.5 5ZM4.5 6C4.22386 6 4 6.22386 4 6.5V11.5C4 11.7761 4.22386 12 4.5 12H9.5C9.77614 12 10 11.7761 10 11.5V6.5C10 6.22386 9.77614 6 9.5 6H4.5Z" />
    </svg>
  );
}

function IconMaximize() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
    >
      <path d="M2 4.5C2 3.11929 3.11929 2 4.5 2H11.5C12.8807 2 14 3.11929 14 4.5V11.5C14 12.8807 12.8807 14 11.5 14H4.5C3.11929 14 2 12.8807 2 11.5V4.5ZM4.5 3C3.67157 3 3 3.67157 3 4.5V11.5C3 12.3284 3.67157 13 4.5 13H11.5C12.3284 13 13 12.3284 13 11.5V4.5C13 3.67157 12.3284 3 11.5 3H4.5Z" />
    </svg>
  );
}

function IconX() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
    >
      <path d="M2.58859 2.71569L2.64645 2.64645C2.82001 2.47288 3.08944 2.4536 3.28431 2.58859L3.35355 2.64645L8 7.293L12.6464 2.64645C12.8417 2.45118 13.1583 2.45118 13.3536 2.64645C13.5488 2.84171 13.5488 3.15829 13.3536 3.35355L8.707 8L13.3536 12.6464C13.5271 12.82 13.5464 13.0894 13.4114 13.2843L13.3536 13.3536C13.18 13.5271 12.9106 13.5464 12.7157 13.4114L12.6464 13.3536L8 8.707L3.35355 13.3536C3.15829 13.5488 2.84171 13.5488 2.64645 13.3536C2.45118 13.1583 2.45118 12.8417 2.64645 12.6464L7.293 8L2.64645 3.35355C2.47288 3.17999 2.4536 2.91056 2.58859 2.71569L2.64645 2.64645L2.58859 2.71569Z" />
    </svg>
  );
}

const IN_APP_MENU_ICONS: Record<string, typeof SettingsIcon> = {
  new_tab: Plus,
  new_analysis: SquarePlus,
  open_file: FolderOpen,
  save: Save,
  save_to: Database,
  accounts: PersonIcon,
  engines: EngineIcon,
  settings: SettingsIcon,
  toggle_fullscreen: Maximize,
  toggle_focus_mode: PanelTopClose,
  save_layout_as: BookmarkPlus,
  manage_layouts: LayoutGrid,
  show_tabs: PanelTop,
  guide: GuideIcon,
  assistant: AiChatIcon,
  send_feedback: FeedbackIcon,
  about: Castle,
  exit: LogOut,
};

function MenuItems({ options }: { options: MenuAction[] }) {
  return options.map((option, i) => {
    if (option.kind === "separator") return <Menu.Divider key={i} />;
    const Icon = option.id ? IN_APP_MENU_ICONS[option.id] : undefined;
    return (
      <Menu.Item
        fz="0.8rem"
        key={option.id ?? option.label}
        aria-label={option.label}
        leftSection={
          Icon ? (
            <Icon size="0.875rem" color="var(--mantine-color-dimmed)" aria-hidden />
          ) : undefined
        }
        rightSection={
          option.shortcut && (
            <Text size="xs" c="dimmed">
              {formatKeymap(option.shortcut)}
            </Text>
          )
        }
        onClick={option.action}
      >
        {option.label}
      </Menu.Item>
    );
  });
}

export default function NavigationRow({
  menuActions,
  showWindowControls = true,
  onSendFeedback,
  showAssistant = false,
  assistantOpened = false,
  onToggleAssistant,
}: {
  menuActions: MenuAction[];
  showWindowControls?: boolean;
  onSendFeedback: () => void;
  showAssistant?: boolean;
  assistantOpened?: boolean;
  onToggleAssistant?: () => void;
}) {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const onBoards = isBoardsPath(pathname);
  const libraryCurrent = isLibraryFamilyPath(pathname);
  const currentPage = pageTabOf(pathname);
  const compact = useScaledMaxWidth(COMPACT_NAVIGATION_ROW_WIDTH_EM);
  const database = useActiveDatabaseViewStore((s) => s.database);
  const libraryTarget = databaseRouteTarget(database);
  const {
    tabs,
    activeTab,
    selectTab,
    closeTab,
    duplicateTab,
    renameTab,
    reorderTabs,
    newTab,
    pageTabs,
    showPageTab,
    closePageTab,
  } = useTabCommands();
  const tabListRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [menuOpened, setMenuOpened] = useState(false);
  const [allTabsOpened, setAllTabsOpened] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
    restoreFocus: boolean;
  } | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const windowControls = useMemo(
    () => bindWindowControls(appWindow, (error) => notifyUnlessCancelled(t("Common.Error"), error)),
    [t],
  );

  useEffect(() => {
    return watchMaximized({
      isMaximized: () => appWindow.isMaximized(),
      onResized: (handler) => appWindow.onResized(handler),
      setMaximized: setIsMaximized,
      notify: (error) => notifyUnlessCancelled(t("Common.Error"), error),
    });
  }, [t]);

  useEffect(() => {
    if (contextMenu && !tabs.some((tab) => tab.value === contextMenu.tabId)) setContextMenu(null);
  }, [contextMenu, tabs]);

  // A keyboard open lands on the first item. A pointer open focuses the menu container
  // instead: a focused item keeps Mantine's highlight and, once WebKit counts the focus as
  // keyboard-driven, the focus ring, beside the item under the pointer. ArrowDown from the
  // container still reaches the first item (Mantine's MenuDropdown handler).
  const menuOpenedByPointer = useRef(false);
  useEffect(() => {
    if (!menuOpened) return;
    const id = window.setTimeout(() => {
      const menu = document.querySelector<HTMLElement>('[role="menu"]');
      const byPointer = menuOpenedByPointer.current;
      menuOpenedByPointer.current = false;
      const target = byPointer ? menu : menu?.querySelector<HTMLElement>('[role="menuitem"]');
      target?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [menuOpened]);

  // True once an element other than the body has held focus, including one already focused when
  // the row mounted. Until then a focused body is the startup state, not focus that a closed tab
  // dropped.
  const focusSeen = useRef(false);
  useEffect(() => {
    if (document.activeElement && document.activeElement !== document.body) {
      focusSeen.current = true;
      return;
    }
    const markFocusSeen = () => {
      focusSeen.current = true;
    };
    document.addEventListener("focusin", markFocusSeen, { once: true });
    return () => document.removeEventListener("focusin", markFocusSeen);
  }, []);

  // When closing a tab drops focus to the body, focus moves to the newly active tab. At startup
  // it stays put: focusing the tab from code then draws the keyboard focus ring at every launch.
  useEffect(() => {
    if (!focusSeen.current || document.activeElement !== document.body || !activeTab) return;
    tabListRef.current?.querySelector<HTMLButtonElement>('[role="tab"][tabindex="0"]')?.focus();
  }, [activeTab, tabs.length]);

  useEffect(() => {
    const list = tabListRef.current;
    if (!list) return;
    const measure = () => {
      setOverflowing(list.scrollWidth > list.clientWidth + 1);
      list
        .querySelector<HTMLButtonElement>('[role="tab"][tabindex="0"]')
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeTab, tabs.length]);

  const tabStopId =
    (onBoards ? tabs.find((tab) => tab.value === activeTab)?.value : null) ??
    (activeTab && tabs.some((tab) => tab.value === activeTab) ? activeTab : null) ??
    tabs[0]?.value ??
    null;

  const openTabMenu = (
    tabId: string,
    event: { clientX: number; clientY: number; currentTarget: HTMLElement },
    restoreFocus: boolean,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const keyboard = event.clientX === 0 && event.clientY === 0;
    setAllTabsOpened(false);
    setContextMenu({
      tabId,
      x: keyboard || restoreFocus ? rect.left : event.clientX,
      y: keyboard || restoreFocus ? rect.bottom : event.clientY,
      restoreFocus,
    });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
      const tab = (event.target as HTMLElement | null)?.closest("[role='tab']");
      if (!(tab instanceof HTMLElement) || !tabListRef.current?.contains(tab)) return;
      const tabId = tab.getAttribute("data-tab-id");
      if (!tabId) return;
      event.preventDefault();
      event.stopPropagation();
      openTabMenu(tabId, { clientX: 0, clientY: 0, currentTarget: tab }, true);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  });

  const onTabKeyDown = (
    tabId: string,
    index: number,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key === "F2") {
      event.preventDefault();
      renameTab(tabId);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectTab(tabId);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || tabs.length === 0) {
      return;
    }
    event.preventDefault();
    const last = tabs.length - 1;
    let next = index;
    if (event.key === "ArrowRight") next = Math.min(index + 1, last);
    if (event.key === "ArrowLeft") next = Math.max(index - 1, 0);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = last;
    const nextId = tabs[next]?.value;
    if (!nextId) return;
    document.getElementById(boardTabId(nextId))?.focus();
    if (onBoards) selectTab(nextId);
  };

  const pageTabView: Record<PageTab, { icon: typeof SettingsIcon; label: string }> = {
    accounts: { icon: PersonIcon, label: t("SideBar.Accounts") },
    engines: { icon: EngineIcon, label: t("SideBar.Engines") },
    settings: { icon: SettingsIcon, label: t("SideBar.Settings") },
    guide: { icon: GuideIcon, label: t("Guide.Title") },
  };

  return (
    <nav className={cx(classes.row, compact && classes.compact)} data-tauri-drag-region>
      <Menu
        opened={menuOpened}
        onChange={(opened) => {
          setMenuOpened(opened);
          if (!opened) {
            // A closing click's pointerdown must not mark the next (keyboard) open.
            menuOpenedByPointer.current = false;
            window.setTimeout(() => menuButtonRef.current?.focus(), 0);
          }
        }}
        offset={2}
        shadow="md"
        width={compact ? "min(12.5rem, calc(100vw - 8px))" : "12.5rem"}
        position="bottom-start"
        transitionProps={{ duration: 0 }}
        withinPortal
        trapFocus={false}
        middlewares={{ flip: true, shift: true, inline: false }}
        styles={{
          dropdown: {
            maxHeight: "calc(100dvh - 2.625rem - 16px)",
            overflowY: "auto",
          },
        }}
      >
        <Menu.Target>
          <button
            type="button"
            ref={menuButtonRef}
            className={classes.menu}
            onPointerDown={() => {
              menuOpenedByPointer.current = true;
            }}
            aria-label={t("Menu.Application.Menu")}
            data-expanded={menuOpened || undefined}
          >
            <img src="/logo.png" alt="" className={classes.logo} />
            <ChevronDown size="0.75rem" aria-hidden />
          </button>
        </Menu.Target>
        <Menu.Dropdown className={cx(classes.menuDropdown, compact && classes.compactMenu)}>
          <MenuItems options={menuActions} />
        </Menu.Dropdown>
      </Menu>
      <div className={classes.scrollGroup}>
        <Tooltip label={t("SideBar.Library")} disabled={!compact} position="bottom" openDelay={400}>
          <Link
            {...libraryTarget}
            preload="intent"
            aria-label={t("SideBar.Library")}
            className={cx(classes.pinned, libraryCurrent && classes.current)}
            aria-current={libraryCurrent ? "page" : undefined}
          >
            <LibraryIcon size="0.875rem" aria-hidden />
            <span className={classes.compactLabel}>{t("SideBar.Library")}</span>
          </Link>
        </Tooltip>
        {pageTabs.map((page) => {
          const { icon: Icon, label } = pageTabView[page];
          const current = currentPage === page;
          return (
            <span
              key={page}
              className={cx(classes.pinned, classes.pageTab, current && classes.current)}
              data-page-tab={page}
            >
              <Tooltip label={label} disabled={!compact} position="bottom" openDelay={400}>
                <button
                  type="button"
                  className={classes.pageTabButton}
                  aria-label={label}
                  aria-current={current ? "page" : undefined}
                  onClick={() => showPageTab(page)}
                >
                  <Icon size="0.875rem" aria-hidden />
                  <span className={classes.compactLabel}>{label}</span>
                </button>
              </Tooltip>
              <button
                type="button"
                className={classes.pageTabClose}
                aria-label={t("Tab.CloseNamed", { name: label })}
                onClick={() => closePageTab(page)}
              >
                <X size="0.875rem" aria-hidden />
              </button>
            </span>
          );
        })}
        <div className={classes.tabs} data-tab-strip>
          <DragDropContext
            enableDefaultSensors={false}
            sensors={POINTER_DRAG_SENSORS}
            onDragEnd={({ destination, source }) => {
              if (destination?.index !== undefined) reorderTabs(source.index, destination.index);
            }}
          >
            <Droppable droppableId="droppable" direction="horizontal">
              {(provided) => (
                <div
                  ref={(node) => {
                    provided.innerRef(node);
                    tabListRef.current = node;
                  }}
                  {...provided.droppableProps}
                  className={classes.tabList}
                  role="tablist"
                  aria-orientation="horizontal"
                >
                  {tabs.map((tab, i) => (
                    <Draggable
                      key={tab.value}
                      draggableId={tab.value}
                      index={i}
                      disableInteractiveElementBlocking
                    >
                      {(provided) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          className={classes.tabSlot}
                          role="presentation"
                        >
                          <BoardTab
                            tab={tab}
                            onSelect={selectTab}
                            selected={onBoards && activeTab === tab.value}
                            tabStop={tabStopId === tab.value}
                            panelMounted={onBoards && activeTab === tab.value}
                            overflowing={overflowing}
                            dragHandleProps={provided.dragHandleProps}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              openTabMenu(tab.value, event, false);
                            }}
                            onKeyDown={(event) => onTabKeyDown(tab.value, i, event)}
                            onClose={(tabId) => void closeTab(tabId)}
                          />
                        </div>
                      )}
                    </Draggable>
                  ))}
                  <div role="presentation">{provided.placeholder}</div>
                </div>
              )}
            </Droppable>
          </DragDropContext>
          <button
            type="button"
            className={classes.stripAction}
            aria-label={t("Tab.NewTab")}
            onClick={newTab}
          >
            <Plus size="0.875rem" aria-hidden />
          </button>
          {overflowing && (
            <Menu
              shadow="md"
              width={220}
              opened={allTabsOpened}
              onChange={setAllTabsOpened}
              position="bottom-end"
            >
              <Menu.Target>
                <button type="button" className={classes.stripAction} aria-label={t("Tab.AllTabs")}>
                  <ChevronDown size="0.875rem" aria-hidden />
                </button>
              </Menu.Target>
              <Menu.Dropdown>
                {tabs.map((tab) => {
                  const name = t(tab.name, { defaultValue: tab.name });
                  const current = tab.value === activeTab;
                  return (
                    <Menu.Item
                      key={tab.value}
                      className={classes.allTabsItem}
                      leftSection={<BoardTabIcon tab={tab} />}
                      rightSection={current ? <span className={classes.activeMark} /> : undefined}
                      onClick={() => selectTab(tab.value)}
                    >
                      {name}
                    </Menu.Item>
                  );
                })}
              </Menu.Dropdown>
            </Menu>
          )}
        </div>
        <div className={classes.dragGap} data-tauri-drag-region />
        {showAssistant && onToggleAssistant && (
          <Tooltip
            label={t("Navigation.Assistant")}
            disabled={!compact}
            position="bottom"
            openDelay={400}
          >
            <button
              type="button"
              className={classes.barAction}
              aria-label={t("Navigation.Assistant")}
              aria-pressed={assistantOpened}
              data-active={assistantOpened || undefined}
              onClick={onToggleAssistant}
            >
              <AiChatIcon size="0.875rem" aria-hidden />
              <span className={classes.compactLabel}>{t("Navigation.Assistant")}</span>
            </button>
          </Tooltip>
        )}
        <Tooltip
          label={t("Navigation.Feedback")}
          disabled={!compact}
          position="bottom"
          openDelay={400}
        >
          <button
            type="button"
            className={classes.barAction}
            aria-label={t("Navigation.Feedback")}
            onClick={onSendFeedback}
          >
            <FeedbackIcon size="0.875rem" aria-hidden />
            <span className={classes.compactLabel}>{t("Navigation.Feedback")}</span>
          </button>
        </Tooltip>
      </div>
      {showWindowControls && (
        <div className={classes.windowControls}>
          <IconAction
            label={t("Window.Minimize")}
            onClick={() => void windowControls.minimize()}
            className={classes.windowButton}
          >
            <IconMinimize />
          </IconAction>
          <IconAction
            label={t(isMaximized ? "Window.Restore" : "Window.Maximize")}
            onClick={() => void windowControls.toggleMaximize()}
            className={classes.windowButton}
          >
            {isMaximized ? <IconRestore /> : <IconMaximize />}
          </IconAction>
          <IconAction
            label={t("Window.Close")}
            onClick={() => void windowControls.close()}
            className={classes.closeWindow}
          >
            <IconX />
          </IconAction>
        </div>
      )}
      {contextMenu && tabs.some((tab) => tab.value === contextMenu.tabId) && (
        <PointerContextMenu
          key={`${contextMenu.tabId}:${contextMenu.x}:${contextMenu.y}`}
          point={contextMenu}
          onClose={() => {
            const restoreId = contextMenu.restoreFocus ? contextMenu.tabId : null;
            setContextMenu(null);
            if (restoreId && tabs.some((tab) => tab.value === restoreId)) {
              document.getElementById(boardTabId(restoreId))?.focus();
            }
          }}
        >
          <TabActionsMenu
            tabId={contextMenu.tabId}
            onDuplicate={duplicateTab}
            onRename={renameTab}
            onClose={(id) => void closeTab(id)}
          />
        </PointerContextMenu>
      )}
    </nav>
  );
}
