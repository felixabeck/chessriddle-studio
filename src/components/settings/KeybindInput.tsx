import { Button, Group, Kbd } from "@mantine/core";
import { Check, X } from "lucide-react";
import cx from "clsx";
import { useAtom } from "jotai";
import { useEffect, useState } from "react";
import { useRecordHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { keyMapAtom } from "@/state/keybinds";
import { formatKeymap } from "@/utils/formatKeymap";
import { IconAction } from "../common/IconAction";
import classes from "./KeybindInput.module.css";

function KeybindInput({
  action,
  keybind,
}: {
  action: string;
  keybind: {
    name: string;
    keys: string;
  };
}) {
  const [hovering, setHovering] = useState(false);

  const [keys, { start, stop, isRecording }] = useRecordHotkeys();

  // The recorder's document listener is only removed by stop().
  useEffect(() => stop, [stop]);

  useEffect(() => {
    if (!isRecording) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        stop();
      }
    };

    // Capture Escape before the recorder's document bubble listener adds it.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isRecording, stop]);

  return (
    <>
      {!isRecording ? (
        <Button
          variant="subtle"
          color="gray"
          aria-label={keybind.name}
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
          onClick={() => start()}
        >
          <KbdDisplay keys={keybind.keys} hovering={hovering} />
        </Button>
      ) : (
        <ShortcutInput keys={keys} stop={stop} action={action} />
      )}
    </>
  );
}

function KbdDisplay({ keys, hovering }: { keys: string; hovering: boolean }) {
  const splitted = formatKeymap(keys).split("+");
  return (
    <Group>
      {splitted.map((key, i) => (
        <Group key={key}>
          <Kbd className={cx({ [classes.kbd]: hovering })}>{key}</Kbd>
          {i !== splitted.length - 1 && "+"}
        </Group>
      ))}
    </Group>
  );
}

function ShortcutInput({
  keys,
  action,
  stop,
}: {
  keys: Set<string>;
  action: string;
  stop: () => void;
}) {
  const { t } = useTranslation();
  const [, setKeymap] = useAtom(keyMapAtom);
  const stringed = Array.from(keys).join("+");

  return (
    <Group>
      {stringed === "" ? (
        <Kbd>{t("Settings.Keybinds.PressAnyKey")}</Kbd>
      ) : (
        <KbdDisplay keys={stringed} hovering={false} />
      )}
      <IconAction
        label={t("Common.Cancel")}
        variant="outline"
        color="danger"
        onClick={() => {
          stop();
        }}
      >
        <X />
      </IconAction>
      <IconAction
        label={t("Common.Save")}
        variant="outline"
        color="success"
        disabled={stringed === ""}
        onClick={() => {
          stop();
          setKeymap((prev) => ({
            ...prev,
            [action]: {
              name: prev[action].name,
              keys: stringed,
            },
          }));
        }}
      >
        <Check />
      </IconAction>
    </Group>
  );
}

export default KeybindInput;
