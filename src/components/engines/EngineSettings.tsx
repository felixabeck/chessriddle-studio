import { tauri } from "@/platform/tauri";
import type { EngineOption, EngineResourceHandle } from "@/bindings";
import {
  Alert,
  Button,
  Center,
  Checkbox,
  Collapse,
  Divider,
  Group,
  Input,
  JsonInput,
  NumberInput,
  ScrollArea,
  Select,
  SimpleGrid,
  Space,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useToggle } from "@mantine/hooks";
import AppModal from "../common/AppModal";
import { AlertCircle, ChevronDown, ChevronRight, Copy, Folder, ImagePlus } from "lucide-react";
import { useAtom, useStore } from "jotai";
import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWRImmutable from "swr/immutable";
import { match, P } from "ts-pattern";
import { IconAction } from "@/components/common/IconAction";
import { notifyUnlessCancelled, runUnlessCancelled } from "@/components/files/notifyError";
import { enginesAtom } from "@/state/atoms";
import type { EngineOwnerSaveReceipt } from "@/state/engineOwnerStorage";
import { useEngineEditDraft } from "./engineEditDraft";
import { EngineAttachmentDraft, replaceEngineById } from "./engineAttachments";
import {
  isEngineResourceFileOptionName,
  isEngineResourcePathOptionName,
  parsePersistedEngineJson,
  type Engine,
  type LocalEngine,
  engineOptionValue,
  retireEngine,
  requiredEngineSettings,
  requiredEngineSettingsDefaults,
} from "@/utils/engines";
import { capabilityKey } from "@/utils/pathCapabilities";
import { errorUnlessCancelled } from "@/platform/errors";
import ConfirmModal from "../common/ConfirmModal";
import GoModeInput from "../common/GoModeInput";
import UpgradeEngineModal from "./UpgradeEngineModal";
import EnginePortrait from "./EnginePortrait";
import { getEngineOptionPresentation } from "./engineOptionCatalog";
import classes from "./EnginesPage.module.css";

export default function EngineSettings({
  engine,
  selected,
  setSelected,
  compact,
}: {
  engine: LocalEngine;
  selected: number;
  setSelected: (v: number | null) => void;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const errorTitle = t("Common.Error");
  const [upgradeOpened, setUpgradeOpened] = useState(false);
  const [expertOpened, setExpertOpened] = useState(false);
  const optionsId = useId();

  const [, setEngines] = useAtom(enginesAtom);
  const { displayed, submit } = useEngineEditDraft(engine);
  const store = useStore();
  const actionOwner = useRef({ active: true, busy: false });
  useEffect(() => {
    const owner = { active: true, busy: false };
    actionOwner.current = owner;
    return () => {
      owner.active = false;
    };
  }, [engine.id, selected]);
  const targetId = engine.id;
  const attachmentDraft = useRef(new EngineAttachmentDraft());
  useEffect(() => {
    const draft = new EngineAttachmentDraft();
    attachmentDraft.current = draft;
    return () => {
      void draft.close().catch((error) => notifyUnlessCancelled(errorTitle, error));
    };
  }, [errorTitle, targetId]);
  const { data: options, error: configError } = useSWRImmutable(
    ["engine-config", capabilityKey(engine.handle)],
    async () => {
      return await tauri.getEngineConfig(engine.handle);
    },
  );
  const configFailure = configError === undefined ? null : errorUnlessCancelled(configError);

  const saveAttachment = useCallback(
    async (
      draft: EngineAttachmentDraft,
      update: (current: LocalEngine) => LocalEngine,
      isDraftCurrent: () => boolean,
    ) => {
      const submittedAttachments = draft.submission();
      let applied = false;
      const receipt = await setEngines((prev) =>
        prev.map((item) => {
          if (item.id !== targetId || item.type !== "local" || !isDraftCurrent()) return item;
          applied = true;
          return update(item);
        }),
      );
      if (!applied) return false;
      await draft.adopt(receipt, submittedAttachments);
      return true;
    },
    [setEngines, targetId],
  );

  const defaultsAttempt = useRef<unknown>(null);
  useEffect(() => {
    if (defaultsAttempt.current === options) return;
    defaultsAttempt.current = options;
    if (options) {
      const settings = [...(engine.settings || [])];
      const defaults = requiredEngineSettingsDefaults(options).filter(
        (setting) => !settings.some((stored) => stored.name === setting.name),
      );
      if (defaults.length > 0) {
        submit({ kind: "defaults", settings: defaults });
      }
    }
  }, [engine, options, submit]);

  const completeOptions =
    options?.options
      .filter((option) => option.type !== "button")
      .map((option) => {
        const setting = displayed.settings?.find((setting) => setting.name === option.value.name);
        return {
          ...option,
          value: {
            ...option.value,
            value: setting ? (engineOptionValue(setting) ?? "") : option.value.default,
          },
        };
      }) || [];

  function changeImage() {
    void runUnlessCancelled(t("Common.Error"), async () => {
      const draft = attachmentDraft.current;
      const imageHandle = await draft.issue(
        "image",
        () => tauri.issueEngineImage(),
        (accepted, isCurrent) =>
          saveAttachment(draft, (current) => ({ ...current, imageHandle: accepted }), isCurrent),
      );
      return imageHandle;
    });
  }

  function setSetting(
    name: string,
    value: string | number | boolean | null,
    def: string | number | boolean | null,
  ) {
    // An emptied field (cleared text, deselected combo, non-number) carries no UCI value, and the
    // native launch refuses an empty option value, so it means "the engine default".
    const emptied =
      value === null || value === "" || (typeof value === "number" && !Number.isFinite(value));
    const next = emptied ? def : value;
    const stored =
      next !== def || requiredEngineSettings.includes(name) ? String(next ?? "") : null;
    submit({ kind: "option", name, value: stored === "" ? null : stored });
  }

  function setResourceSetting(
    name: string,
    resource: EngineResourceHandle,
    append: boolean,
    isCurrent: () => boolean,
    draft: EngineAttachmentDraft,
  ) {
    return saveAttachment(
      draft,
      (current) => {
        const settings = [...(current.settings || [])];
        const index = settings.findIndex((setting) => setting.name === name);
        const existing = settings[index];
        const resources =
          append && existing?.type === "resource" ? [...existing.resources, resource] : [resource];
        const next: EngineOption = { type: "resource", name, resources };
        if (index === -1) settings.push(next);
        else settings[index] = next;
        return { ...current, settings };
      },
      isCurrent,
    );
  }

  const [deleteModal, toggleDeleteModal] = useToggle();
  const [jsonModal, toggleJSONModal] = useToggle();

  const limitStrength = completeOptions.find(
    (option) => option.value.name.toLowerCase() === "uci_limitstrength",
  );
  const visibleOptions = completeOptions.filter(
    (option) =>
      option.value.name.toLowerCase() !== "uci_elo" ||
      !limitStrength ||
      limitStrength.value.value === true ||
      limitStrength.value.value === "true",
  );
  const expertCount = visibleOptions.filter(
    (option) => getEngineOptionPresentation(option.value.name, t).tier === "expert",
  ).length;

  function renderDescription(name: string, label: string, description?: string) {
    if (!description) return undefined;
    return (
      <>
        {description}
        {name !== label && (
          <>
            {" "}
            <Text component="span" c="dimmed" size="xs" style={{ whiteSpace: "nowrap" }}>
              {"· "}
              <Text component="span" ff="monospace">
                {name}
              </Text>
            </Text>
          </>
        )}
      </>
    );
  }

  function renderOption(option: (typeof completeOptions)[number]) {
    const { label, description } = getEngineOptionPresentation(option.value.name, t);
    const fieldId = `${optionsId}-${encodeURIComponent(option.value.name)}`;
    const note = renderDescription(option.value.name, label, description);
    return match(option)
      .with({ type: "spin", value: P.select() }, (v: any) => {
        return (
          <NumberInput
            key={v.name}
            label={label}
            description={note}
            inputWrapperOrder={["label", "input", "description", "error"]}
            min={Number(v.min)}
            max={Number(v.max)}
            allowDecimal={false}
            value={Number(v.value)}
            // A cleared field reports "" mid-edit; keep the last valid value until it holds a number.
            onChange={(e) => {
              if (typeof e === "number") setSetting(v.name, e, Number(v.default));
            }}
          />
        );
      })
      .with({ type: "combo", value: P.select() }, (v: any) => {
        return (
          <Select
            key={v.name}
            label={label}
            description={note}
            inputWrapperOrder={["label", "input", "description", "error"]}
            data={v.var}
            value={v.value}
            allowDeselect={false}
            onChange={(e) => setSetting(v.name, e, v.default)}
          />
        );
      })
      .with({ type: "string", value: P.select() }, (v: any) => {
        if (isEngineResourcePathOptionName(v.name)) {
          return (
            <Input.Wrapper
              key={v.name}
              id={fieldId}
              label={label}
              description={note}
              inputWrapperOrder={["label", "input", "description", "error"]}
            >
              <Group align="center" wrap={compact ? "wrap" : "nowrap"}>
                <TextInput
                  id={fieldId}
                  aria-describedby={note ? `${fieldId}-description` : undefined}
                  flex={1}
                  miw={0}
                  style={compact ? { flexBasis: "100%" } : undefined}
                  placeholder={t("Engines.Settings.SyzygyPathPlaceholder", {
                    separator: ":",
                  })}
                  value={v.value || ""}
                  readOnly
                />
                <Button
                  variant="default"
                  leftSection={<Folder size="1rem" />}
                  onClick={() => {
                    void runUnlessCancelled(t("Common.Error"), async () => {
                      const draft = attachmentDraft.current;
                      return draft.issue(
                        `resource:${v.name}`,
                        () => tauri.issueEngineResource(true),
                        (resource, isCurrent) =>
                          setResourceSetting(v.name, resource, true, isCurrent, draft),
                      );
                    });
                  }}
                >
                  {t("Common.Open")}
                </Button>
              </Group>
            </Input.Wrapper>
          );
        }
        if (isEngineResourceFileOptionName(v.name)) {
          return (
            <Input.Wrapper
              key={v.name}
              id={fieldId}
              label={label}
              description={note}
              inputWrapperOrder={["label", "input", "description", "error"]}
            >
              <Group>
                <Button
                  id={fieldId}
                  aria-label={label}
                  aria-describedby={note ? `${fieldId}-description` : undefined}
                  variant="default"
                  leftSection={<Folder size="1rem" />}
                  onClick={() => {
                    void runUnlessCancelled(t("Common.Error"), async () => {
                      const draft = attachmentDraft.current;
                      return draft.issue(
                        `resource:${v.name}`,
                        () => tauri.issueEngineResource(false),
                        (resource, isCurrent) =>
                          setResourceSetting(v.name, resource, false, isCurrent, draft),
                      );
                    });
                  }}
                >
                  {t("Common.Open")}
                </Button>
              </Group>
            </Input.Wrapper>
          );
        }
        return (
          <TextInput
            key={v.name}
            label={label}
            description={note}
            inputWrapperOrder={["label", "input", "description", "error"]}
            value={v.value || ""}
            onChange={(e) => setSetting(v.name, e.currentTarget.value, v.default)}
          />
        );
      })
      .otherwise(() => null);
  }

  function renderOptions(tier: "essential" | "expert") {
    const tierOptions = visibleOptions.filter(
      (option) => getEngineOptionPresentation(option.value.name, t).tier === tier,
    );
    const targetElo = limitStrength
      ? visibleOptions.find((option) => option.value.name.toLowerCase() === "uci_elo")
      : undefined;
    return (
      <>
        <SimpleGrid cols={compact ? 1 : 2}>
          {tierOptions
            .filter(
              (option) =>
                option.type !== "check" &&
                !(limitStrength && option.value.name.toLowerCase() === "uci_elo"),
            )
            .map(renderOption)}
        </SimpleGrid>
        <SimpleGrid cols={compact ? 1 : 2}>
          {tierOptions
            .filter((option) => option.type === "check")
            .map((o) => {
              const { label, description } = getEngineOptionPresentation(o.value.name, t);
              return (
                <Fragment key={o.value.name}>
                  <Checkbox
                    label={label}
                    description={renderDescription(o.value.name, label, description)}
                    checked={o.value.value === true || o.value.value === "true"}
                    disabled={o.value.name.toLowerCase() === "uci_chess960"}
                    onChange={(e) =>
                      setSetting(o.value.name, e.currentTarget.checked, o.value.default as boolean)
                    }
                  />
                  {o.value.name.toLowerCase() === "uci_limitstrength" && targetElo
                    ? renderOption(targetElo)
                    : null}
                </Fragment>
              );
            })}
        </SimpleGrid>
      </>
    );
  }

  return (
    <ScrollArea
      h={compact ? "auto" : "100%"}
      offsetScrollbars={compact ? "present" : true}
      scrollbars="y"
    >
      <Stack>
        <Divider variant="dashed" label={t("Common.GeneralSettings")} />
        <Group grow={!compact} align="start" wrap="nowrap" className={classes.general}>
          <Stack miw={0} w={compact ? "100%" : undefined}>
            <Group wrap={compact ? "wrap" : "nowrap"} w="100%">
              <TextInput
                flex={1}
                miw={0}
                w={compact ? "100%" : undefined}
                style={compact ? { flexBasis: "100%" } : undefined}
                label={t("Common.Name")}
                value={displayed.name}
                onChange={(e) =>
                  submit({ kind: "field", field: "name", value: e.currentTarget.value })
                }
              />
              <TextInput
                label={t("Common.Version")}
                w={compact ? "100%" : "5rem"}
                value={displayed.version}
                placeholder="?"
                onChange={(e) =>
                  submit({ kind: "field", field: "version", value: e.currentTarget.value })
                }
              />
            </Group>
            <Group grow>
              <NumberInput
                label="ELO"
                value={displayed.elo || undefined}
                min={0}
                placeholder={t("Common.Unknown")}
                onChange={(v) =>
                  submit({
                    kind: "field",
                    field: "elo",
                    value: typeof v === "number" ? v : undefined,
                  })
                }
              />
            </Group>
          </Stack>
          <Center className={classes.portrait} w={compact ? "100%" : undefined}>
            <EnginePortrait
              engine={engine}
              imageProps={{ mah: "10rem", maw: "100%", fit: "contain" }}
              selectImage={{ label: t("Engines.Settings.SelectImage"), onClick: changeImage }}
              fallback={
                <IconAction
                  label={t("Engines.Settings.SelectImage")}
                  size="10rem"
                  variant="subtle"
                  styles={{
                    root: {
                      border: "1px dashed",
                    },
                  }}
                  onClick={changeImage}
                >
                  <ImagePlus size="2.5rem" />
                </IconAction>
              }
            />
          </Center>
        </Group>
        <Divider variant="dashed" label={t("Engines.Settings.SearchSettings")} />
        <div className={classes.goMode}>
          <GoModeInput
            goMode={displayed.go || null}
            setGoMode={(v) => submit({ kind: "field", field: "go", value: v })}
          />
        </div>

        <Divider variant="dashed" label={t("Engines.Settings.AdvancedSettings")} />
        {configFailure && (
          <Alert icon={<AlertCircle size="1rem" />} title={t("Common.Error")} color="danger">
            {configFailure.message}
          </Alert>
        )}
        {renderOptions("essential")}
        {expertCount > 0 && (
          <>
            <Button
              variant="subtle"
              style={{ alignSelf: "flex-start" }}
              leftSection={
                expertOpened ? <ChevronDown size="1rem" /> : <ChevronRight size="1rem" />
              }
              aria-expanded={expertOpened}
              aria-controls={`${optionsId}-expert`}
              onClick={() => setExpertOpened((opened) => !opened)}
            >
              {t("Engines.Settings.ExpertSettings", { count: expertCount })}
            </Button>
            <Collapse in={expertOpened} id={`${optionsId}-expert`}>
              <Stack>{renderOptions("expert")}</Stack>
            </Collapse>
          </>
        )}

        <Group justify="end">
          <Button variant="default" onClick={() => setUpgradeOpened(true)}>
            {t("Engines.Upgrade.Title")}
          </Button>
          <Button variant="default" onClick={() => toggleJSONModal(true)}>
            {t("Engines.Settings.EditJSON")}
          </Button>
          <Button
            variant="default"
            onClick={() =>
              submit({
                kind: "reset",
                settings: options ? requiredEngineSettingsDefaults(options) : undefined,
              })
            }
          >
            {t("Engines.Settings.Reset")}
          </Button>
          <Button
            leftSection={<Copy size="1rem" />}
            variant="default"
            onClick={() => {
              const owner = actionOwner.current;
              if (owner.busy) return;
              owner.busy = true;
              const id = crypto.randomUUID();
              void (async () => {
                try {
                  let inserted = false;
                  const receipt = await setEngines((current) => {
                    const index = current.findIndex(
                      (item) => item.id === targetId && item.type === "local",
                    );
                    if (index < 0) return current;
                    const source = current[index];
                    const copy = [...current];
                    copy.splice(index + 1, 0, { ...source, id, name: `${source.name} (Copy)` });
                    inserted = true;
                    return copy;
                  });
                  if (receipt.saved && inserted && owner.active) {
                    const index = store.get(enginesAtom)?.findIndex((item) => item.id === id) ?? -1;
                    if (index >= 0) setSelected(index);
                  }
                } catch (error) {
                  notifyUnlessCancelled(t("Common.Error"), error);
                } finally {
                  owner.busy = false;
                }
              })();
            }}
          >
            {t("Common.Duplicate")}
          </Button>
          <Button color="danger" onClick={() => toggleDeleteModal()}>
            {t("Common.Remove")}
          </Button>
        </Group>
        <ConfirmModal
          title={t("Engines.Remove.Title")}
          description={t("Engines.Remove.Message")}
          opened={deleteModal}
          onClose={toggleDeleteModal}
          onConfirm={async () => {
            setSelected(null);
            try {
              await setEngines({ removeLocalId: targetId });
            } catch (error) {
              notifyUnlessCancelled(t("Common.Error"), error);
            } finally {
              try {
                await retireEngine(engine);
              } catch (error) {
                notifyUnlessCancelled(t("Common.Error"), error);
              }
            }
          }}
          confirmLabel={t("Common.Remove")}
        />
      </Stack>
      <JSONModal
        key={`${engine.id}:json`}
        opened={jsonModal}
        toggleOpened={toggleJSONModal}
        engine={engine}
        setEngine={async (v) => {
          let present = false;
          const receipt = await setEngines((current) => {
            present = current.some((item) => item.id === targetId);
            return replaceEngineById(current, targetId, v);
          });
          return present ? receipt : { ...receipt, saved: false, synchronized: false };
        }}
      />
      <UpgradeEngineModal
        key={`${engine.id}:upgrade`}
        engine={engine}
        opened={upgradeOpened}
        setOpened={setUpgradeOpened}
      />
    </ScrollArea>
  );
}

function JSONModal({
  opened,
  toggleOpened,
  engine,
  setEngine,
}: {
  opened: boolean;
  toggleOpened: () => void;
  engine: Engine;
  setEngine: (v: Engine) => Promise<EngineOwnerSaveReceipt>;
}) {
  const { t } = useTranslation();

  const [value, setValue] = useState(JSON.stringify(engine, null, 2));
  const [error, setError] = useState<string | null>(null);
  const submission = useRef({ active: true, busy: false, initialized: false });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const owner = { active: true, busy: false, initialized: false };
    submission.current = owner;
    setSaving(false);
    return () => {
      owner.active = false;
    };
  }, [opened]);
  useEffect(() => {
    if (opened && !submission.current.initialized) {
      submission.current.initialized = true;
      setValue(JSON.stringify(engine, null, 2));
      setError(null);
    }
  }, [opened, engine]);
  return (
    <AppModal
      opened={opened}
      onClose={toggleOpened}
      title={t("Engines.Settings.EditJSON")}
      size="xl"
    >
      <JsonInput
        autosize
        disabled={saving}
        value={value}
        onChange={(e) => {
          if (submission.current.busy) return;
          setValue(e);
          setError(null);
        }}
        error={error}
      />
      <Space h="md" />
      <Button
        disabled={saving}
        onClick={async () => {
          const owner = submission.current;
          if (owner.busy) return;
          const parseRes = parsePersistedEngineJson(value);
          if (parseRes.success) {
            owner.busy = true;
            setSaving(true);
            try {
              const receipt = await setEngine(parseRes.data);
              if (receipt.saved && owner.active) {
                setError(null);
                toggleOpened();
              }
            } catch (error) {
              notifyUnlessCancelled(t("Common.Error"), error);
            } finally {
              owner.busy = false;
              if (owner.active) setSaving(false);
            }
          } else {
            setError("Invalid Configuration");
          }
        }}
      >
        {t("Common.Save")}
      </Button>
    </AppModal>
  );
}
