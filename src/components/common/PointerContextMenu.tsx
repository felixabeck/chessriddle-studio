import { Menu } from "@mantine/core";
import type { ReactNode } from "react";

export type PointerMenuPoint = { x: number; y: number };

/**
 * A menu opened at the pointer. Render it only while open, keyed by its point, so a right click
 * elsewhere reopens it there. Render it outside the element that opens it: React bubbles events
 * from the dropdown's portal up the component tree.
 */
export default function PointerContextMenu({
  point,
  onClose,
  closeOnItemClick,
  children,
}: {
  point: PointerMenuPoint;
  onClose: () => void;
  closeOnItemClick?: boolean;
  children: ReactNode;
}) {
  return (
    <Menu
      opened
      onChange={(opened) => {
        if (!opened) onClose();
      }}
      shadow="md"
      width={200}
      position="bottom-start"
      offset={0}
      floatingStrategy="fixed"
      hideDetached={false}
      returnFocus={false}
      closeOnItemClick={closeOnItemClick}
    >
      <Menu.Target>
        <span
          aria-hidden
          style={{
            position: "fixed",
            left: point.x,
            top: point.y,
            width: 0,
            height: 0,
            pointerEvents: "none",
          }}
        />
      </Menu.Target>
      <Menu.Dropdown>{children}</Menu.Dropdown>
    </Menu>
  );
}
