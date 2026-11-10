import { Box, Button, getDefaultZIndex, Group, Image, Menu, Text } from "@mantine/core";
import { getCurrentWebviewWindow } from "@/platform/native";
import { Menu as MenuIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { bindWindowControls, watchMaximized, type MenuGroup } from "@/routes/-appMenu";
import { IconAction } from "./common/IconAction";
import classes from "./TopBar.module.css";

const appWindow = getCurrentWebviewWindow();
const COMPACT_TITLE_BAR_WIDTH_EM = 48;
// Below-parent placement needs pointer travel grace before the submenu closes.
const SUBMENU_HOVER_CLOSE_DELAY_MS = 150;

function MenuOptions({ options }: { options: MenuGroup["options"] }) {
  return options.map((option, i) =>
    option.kind === "separator" ? (
      <Menu.Divider key={i} />
    ) : (
      <Menu.Item
        fz="0.8rem"
        key={option.label}
        rightSection={
          option.shortcut && (
            <Text size="xs" c="dimmed">
              {option.shortcut}
            </Text>
          )
        }
        onClick={option.action}
      >
        {option.label}
      </Menu.Item>
    ),
  );
}

function CompactMenuGroup({ group }: { group: MenuGroup }) {
  const target = useRef<HTMLButtonElement>(null);
  // Menu.Sub supplies arrow navigation and hover. Click/Enter/Space also enter the
  // group through that same ArrowRight handler, including its first-item focus.
  // Opening below the group keeps hover from covering its click target with an action.
  const enterGroup = () => {
    target.current?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  };
  return (
    <Menu.Sub
      width="min(20rem, calc(100vw - 16px))"
      position="bottom-start"
      floatingStrategy="fixed"
      closeDelay={SUBMENU_HOVER_CLOSE_DELAY_MS}
    >
      <Menu.Sub.Target>
        <Menu.Sub.Item
          ref={target}
          fz="0.8rem"
          onClick={enterGroup}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              enterGroup();
            }
          }}
        >
          {group.label}
        </Menu.Sub.Item>
      </Menu.Sub.Target>
      <Menu.Sub.Dropdown className={classes.compactOptions}>
        <MenuOptions options={group.options} />
      </Menu.Sub.Dropdown>
    </Menu.Sub>
  );
}

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

function IconMaximize() {
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

function IconSquare() {
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

function TopBar({
  menuActions,
  showWindowControls = true,
}: {
  menuActions: MenuGroup[];
  showWindowControls?: boolean;
}) {
  const { t } = useTranslation();
  const compact = useScaledMaxWidth(COMPACT_TITLE_BAR_WIDTH_EM);
  const menuArea = useRef<HTMLDivElement>(null);
  const menuFocus = useRef<HTMLElement | null>(null);
  const focusHandlers = {
    onFocusCapture: (event: React.FocusEvent<HTMLElement>) => {
      menuFocus.current = event.target;
    },
    onBlurCapture: () => {
      menuFocus.current = null;
    },
  };
  const [openedMenu, setOpenedMenu] = useState<string | null>(null);

  useLayoutEffect(() => {
    setOpenedMenu(null);
    // Removing a focused node does not fire blur. Only reclaim focus when that
    // remembered menu node disappeared and the browser left focus on the body.
    if (
      menuFocus.current &&
      !menuFocus.current.isConnected &&
      document.activeElement === document.body
    ) {
      menuArea.current?.querySelector("button")?.focus({ preventScroll: true });
    }
  }, [compact]);
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

  return (
    <Group gap={0} className={classes.root}>
      <Box
        ref={menuArea}
        {...focusHandlers}
        className={compact ? classes.compactMenuArea : classes.menuArea}
      >
        {compact ? (
          <Menu
            key="compact"
            opened={openedMenu === "compact"}
            onChange={(opened) => setOpenedMenu(opened ? "compact" : null)}
            offset={2}
            shadow="md"
            zIndex={getDefaultZIndex("popover") + 1}
            width="min(12rem, calc(100vw - 16px))"
            position="bottom-start"
            transitionProps={{ duration: 0 }}
          >
            <Menu.Target>
              <IconAction label={t("Menu.Application.Menu")} className={classes.compactTarget}>
                <MenuIcon size="1.25rem" />
              </IconAction>
            </Menu.Target>
            <Menu.Dropdown {...focusHandlers}>
              {menuActions.map((group) => (
                <CompactMenuGroup key={group.label} group={group} />
              ))}
            </Menu.Dropdown>
          </Menu>
        ) : (
          <Group gap="xs" px="sm" wrap="nowrap">
            <Box className={classes.brand} data-tauri-drag-region>
              <Box h="1.25rem" w="1.25rem" className={classes.logo}>
                <Image src="/logo.png" alt="" fit="fill" />
              </Box>
              {/* Brand name, deliberately not translated. Colours mirror the website's Logo.tsx. */}
              <span className={classes.wordmark}>
                <span className={classes.wordmarkChess}>Chess</span>
                <span>Riddle</span> <span className={classes.wordmarkProduct}>Studio</span>
              </span>
            </Box>
            <Group gap={0} wrap="nowrap">
              {menuActions.map((action) => (
                <Menu
                  key={action.label}
                  opened={openedMenu === action.label}
                  onChange={(opened) => setOpenedMenu(opened ? action.label : null)}
                  offset={2}
                  shadow="md"
                  width={200}
                  position="bottom-start"
                  transitionProps={{ duration: 0 }}
                >
                  <Menu.Target>
                    <Button
                      styles={{
                        root: {
                          transform: "none",
                          color: "var(--cf-foreground)",
                        },
                        label: {
                          fontWeight: "normal",
                        },
                      }}
                      fz="0.8rem"
                      variant="subtle"
                      size="compact-xs"
                    >
                      {action.label}
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown {...focusHandlers}>
                    <MenuOptions options={action.options} />
                  </Menu.Dropdown>
                </Menu>
              ))}
            </Group>
          </Group>
        )}
      </Box>
      <Box className={classes.dragRegion} data-tauri-drag-region />
      {showWindowControls && (
        <Box className={classes.windowControls}>
          <Group gap={0} wrap="nowrap">
            <IconAction
              label={t("Window.Minimize")}
              onClick={() => void windowControls.minimize()}
              className={classes.icon}
            >
              <IconMinimize />
            </IconAction>
            <IconAction
              label={t(isMaximized ? "Window.Restore" : "Window.Maximize")}
              onClick={() => void windowControls.toggleMaximize()}
              className={classes.icon}
            >
              {isMaximized ? <IconMaximize /> : <IconSquare />}
            </IconAction>
            <IconAction
              label={t("Window.Close")}
              onClick={() => void windowControls.close()}
              className={classes.close}
            >
              <IconX />
            </IconAction>
          </Group>
        </Box>
      )}
    </Group>
  );
}

export default TopBar;
