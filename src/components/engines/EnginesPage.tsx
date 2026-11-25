import { tauri } from "@/platform/tauri";
import {
  Button,
  Center,
  Divider,
  Group,
  Input,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from "@mantine/core";
import InstallStockfishButton from "./InstallStockfishButton";
import { Cloud, Plus, Search } from "lucide-react";
import { EngineIcon } from "@/components/common/iconCatalog";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useStore } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWRImmutable from "swr/immutable";
import { Route } from "@/routes/engines";
import { IconAction } from "@/components/common/IconAction";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { enginesAtom } from "@/state/atoms";
import { useEngineEditDraft } from "./engineEditDraft";
import { type Engine, engineMultiPv } from "@/utils/engines";
import { capabilityKey } from "@/utils/pathCapabilities";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import GenericCard from "../common/GenericCard";
import OpenFolderButton from "../common/OpenFolderButton";
import LinesSlider from "../panels/analysis/LinesSlider";
import AddEngine from "./AddEngine";
import EnginePortrait from "./EnginePortrait";
import classes from "./EnginesPage.module.css";
import EngineSettings from "./EngineSettings";

const COMPACT_ENGINES_WIDTH_EM = 62;

export default function EnginesPage() {
  const { t } = useTranslation();
  const compact = useScaledMaxWidth(COMPACT_ENGINES_WIDTH_EM);

  const [engines] = useAtom(enginesAtom);
  const enginesList = useMemo(() => engines ?? [], [engines]);
  const [opened, setOpened] = useState(false);
  const [search, setSearch] = useState("");
  const { selected } = Route.useSearch();
  const navigate = useNavigate();
  const setSelected = (v: number | null) => {
    navigate({ to: "/engines", search: { selected: v ?? undefined } });
  };

  const selectedEngine = selected !== undefined ? enginesList[selected] : null;
  const filteredEngines = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const indexedEngines = enginesList.map((item, index) => ({ item, index }));

    if (!normalizedSearch) {
      return indexedEngines;
    }

    return indexedEngines.filter(({ item }) => {
      const values = [
        item.name,
        item.id,
        item.type,
        item.type === "local" ? item.filename : "",
        item.type === "local" ? (item.version ?? "") : "",
        item.type === "local" && item.elo ? item.elo.toString() : "",
      ];

      return values.some((value) => value.toLowerCase().includes(normalizedSearch));
    });
  }, [enginesList, search]);
  const hasSearch = search.trim().length > 0;
  const hasEngines = enginesList.length > 0;

  return (
    <Stack h="100%" className={classes.page} data-compact={compact || undefined}>
      <AddEngine opened={opened} setOpened={setOpened} />
      <Group align="baseline" py="sm" pl={compact ? "xs" : "md"}>
        <Title size={compact ? "h3" : undefined}>{t("Engines.Title")}</Title>
        <OpenFolderButton />
      </Group>
      <Group
        grow={!compact}
        flex={1}
        className={classes.panels}
        align="start"
        px={compact ? "xs" : "md"}
        pb="md"
      >
        <Paper withBorder style={{ borderWidth: 2 }} className={classes.listPanel}>
          <Stack gap={0} h="100%" mih={0}>
            <Group p="xs" gap="xs">
              <Input
                size="sm"
                style={{ flexGrow: 1, minWidth: 0 }}
                leftSection={<Search size="1rem" />}
                placeholder={t("Common.Search")}
                aria-label={t("Common.Search")}
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
              />
              <IconAction
                label={t("Common.AddNew")}
                variant="default"
                size="lg"
                onClick={() => setOpened(true)}
              >
                <Plus size="1rem" />
              </IconAction>
            </Group>
            <Divider />
            <ScrollArea flex={1} mih={0} scrollbars="y">
              <SimpleGrid cols={{ base: 1, md: 2 }} p="xs">
                {filteredEngines.map(({ item, index }) => {
                  const stats =
                    item.type === "local"
                      ? [
                          {
                            label: "ELO",
                            value: item.elo ? item.elo.toString() : "??",
                          },
                        ]
                      : [{ label: t("Engines.Card.Type"), value: "Cloud" }];
                  if (item.type === "local" && item.version) {
                    stats.push({
                      label: t("Common.Version"),
                      value: item.version,
                    });
                  }
                  return (
                    <GenericCard
                      id={index}
                      key={item.id}
                      isSelected={selected === index}
                      setSelected={setSelected}
                      error={undefined}
                      Header={<EngineName engine={item} compact={compact} />}
                      stats={stats}
                    />
                  );
                })}
              </SimpleGrid>
            </ScrollArea>
            {filteredEngines.length === 0 && (
              <Center h="100%">
                <Stack align="center" gap="sm">
                  <ThemeIcon size={64} radius="100%" variant="light" color="gray">
                    <EngineIcon size={32} />
                  </ThemeIcon>
                  <Text c="dimmed" fw={500} ta="center">
                    {hasSearch ? t("Common.NoResults") : t("Engines.Empty.NoInstalled")}
                  </Text>
                  {!hasSearch && !hasEngines && (
                    <>
                      <Text c="dimmed" size="sm" ta="center">
                        {t("Engines.Empty.AddHint")}
                      </Text>
                      <InstallStockfishButton />
                    </>
                  )}
                </Stack>
              </Center>
            )}
          </Stack>
        </Paper>
        {!selectedEngine || selected === undefined ? (
          <Paper
            withBorder
            style={{ borderWidth: 2 }}
            p={compact ? "xs" : "md"}
            className={classes.editor}
          >
            <Center h="100%">
              <Stack align="center" gap="sm">
                <ThemeIcon size={80} radius="100%" variant="light" color="gray">
                  <EngineIcon size={40} />
                </ThemeIcon>
                <Text c="dimmed" fw={500} size="lg">
                  {t("Engines.Settings.NoEngine")}
                </Text>
              </Stack>
            </Center>
          </Paper>
        ) : (
          <Paper
            withBorder
            style={{ borderWidth: 2 }}
            p={compact ? "xs" : "md"}
            className={classes.editor}
          >
            {selectedEngine.type === "local" ? (
              <EngineSettings
                key={selectedEngine.id}
                engine={selectedEngine}
                compact={compact}
                selected={selected}
                setSelected={setSelected}
              />
            ) : (
              <CloudSettings
                key={selectedEngine.id}
                compact={compact}
                engine={selectedEngine}
                setSelected={setSelected}
              />
            )}
          </Paper>
        )}
      </Group>
    </Stack>
  );
}

function CloudSettings({
  engine,
  setSelected,
  compact,
}: {
  engine: Engine;
  setSelected: (v: number | null) => void;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const [, save] = useAtom(enginesAtom);
  const { displayed, submit } = useEngineEditDraft(engine);
  const store = useStore();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <ScrollArea h={compact ? "auto" : "100%"} scrollbars="y" offsetScrollbars="present">
      <Stack>
        <Divider variant="dashed" label={t("Common.GeneralSettings")} />
        <TextInput
          w={compact ? "100%" : "50%"}
          label={t("Common.Name")}
          value={displayed.name}
          onChange={(e) => submit({ kind: "field", field: "name", value: e.currentTarget.value })}
        />
        <Divider variant="dashed" label={t("Engines.Settings.AdvancedSettings")} />
        <Stack w={compact ? "100%" : "50%"} className={classes.cloudLines}>
          <Text fw="bold">{t("Engines.Settings.NumOfLines")}</Text>
          <LinesSlider
            value={engineMultiPv(displayed.settings ?? [])}
            setValue={(value) => submit({ kind: "option", name: "MultiPV", value: String(value) })}
            ariaLabel={t("Engines.Settings.NumOfLines")}
          />
        </Stack>
        <Group justify="right">
          <Button
            color="danger"
            onClick={() => {
              void (async () => {
                try {
                  const receipt = await save((current) =>
                    current.filter((item) => item.id !== engine.id),
                  );
                  if (
                    receipt.saved &&
                    alive.current &&
                    !store.get(enginesAtom)?.some((item) => item.id === engine.id)
                  )
                    setSelected(null);
                } catch (error) {
                  notifyUnlessCancelled(t("Common.Error"), error);
                }
              })();
            }}
          >
            {t("Common.Remove")}
          </Button>
        </Group>
      </Stack>
    </ScrollArea>
  );
}

export function EngineName({ engine, compact = false }: { engine: Engine; compact?: boolean }) {
  const { t } = useTranslation();
  const { data: fileExists, error } = useSWRImmutable(
    ["file-exists", engine.type === "local" ? capabilityKey(engine.handle) : null],
    async () => {
      if (engine.type !== "local") return true;
      const res = await tauri.fileExists(engine.handle.id);
      return res;
    },
  );

  const isMissing = engine.type === "local" && fileExists === false;
  const inspectionFailed = engine.type === "local" && error !== undefined;
  const hasError = isMissing || inspectionFailed;
  const status = isMissing
    ? t("Engines.FileMissing")
    : inspectionFailed
      ? `(${t("Common.Error")})`
      : "";

  return (
    <Group wrap={compact ? "wrap" : "nowrap"} miw={0} className={classes.engineName}>
      <EnginePortrait
        engine={engine}
        imageProps={{ h: "2.5rem", fit: "contain", flex: 0 }}
        fallback={engine.type !== "local" ? <Cloud size="2.5rem" /> : <EngineIcon size="2.5rem" />}
      />
      <Stack gap={0} miw={0}>
        <Text
          fw="bold"
          lineClamp={compact ? undefined : 1}
          style={{ overflowWrap: "anywhere" }}
          c={hasError ? "danger" : undefined}
        >
          {engine.name} {status}
        </Text>
        <Text
          size="xs"
          c="dimmed"
          style={{ overflowWrap: "anywhere" }}
          lineClamp={compact ? undefined : 1}
        >
          {engine.type === "local" ? engine.filename : engine.url}
        </Text>
      </Stack>
    </Group>
  );
}
