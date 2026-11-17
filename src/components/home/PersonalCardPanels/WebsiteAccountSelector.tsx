import { Group, Select } from "@mantine/core";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { sessionsAtom } from "@/state/atoms";
import { playerGroups, type AccountSite } from "@/utils/session";
import { SiteLogos, siteLogosWidth } from "../SiteLogo";
import filterClasses from "./StatisticsFilters.module.css";

const ALL_ACCOUNTS = "All accounts";
const ALL_WEBSITES = "All websites";

const WEBSITE_SITE: Record<string, AccountSite> = { Lichess: "lichess", "Chess.com": "chesscom" };

interface WebsiteAccountSelectorProps {
  playerKey: string;
  onWebsiteChange: (website: string | null) => void;
  onAccountChange: (account: string | null) => void;
  allowAll: boolean;
}

const WebsiteAccountSelector = ({
  playerKey,
  onWebsiteChange,
  onAccountChange,
  allowAll,
}: WebsiteAccountSelectorProps) => {
  const { t } = useTranslation();
  const sessions = useAtomValue(sessionsAtom);

  const player = useMemo(
    () => playerGroups(sessions).find(({ key }) => key === playerKey),
    [playerKey, sessions],
  );
  const sites = useMemo(() => player?.sites ?? [], [player]);
  const websites = useMemo(() => {
    const availableWebsites = [];
    if (sites.includes("chesscom")) {
      availableWebsites.push({ value: "Chess.com", label: "Chess.com" });
    }
    if (sites.includes("lichess")) {
      availableWebsites.push({ value: "Lichess", label: "Lichess" });
    }
    if (allowAll) {
      availableWebsites.unshift({ value: ALL_WEBSITES, label: t("Home.Accounts.AllWebsites") });
    }
    return availableWebsites;
  }, [allowAll, sites, t]);
  // The logos a Website filter value stands for; "All websites" shows every site the player has.
  const filterLogoSites = (value: string | null): AccountSite[] =>
    value === ALL_WEBSITES ? sites : value && WEBSITE_SITE[value] ? [WEBSITE_SITE[value]] : [];

  const [website, setWebsite] = useState<string | null>(websites[0]?.value);
  const [account, setAccount] = useState<string | null>(ALL_ACCOUNTS);

  useEffect(() => {
    onWebsiteChange(website);
  }, [onWebsiteChange, website]);

  useEffect(() => {
    onAccountChange(account);
  }, [account, onAccountChange]);

  // The card keeps this selector mounted when another player is chosen; a website that player
  // has no account on would otherwise stay selected and filter every game away.
  useEffect(() => {
    if (!websites.some((option) => option.value === website)) {
      setWebsite(websites[0]?.value ?? null);
      setAccount(ALL_ACCOUNTS);
    }
  }, [website, websites]);

  const accounts = useMemo(
    () =>
      [ALL_ACCOUNTS].concat(
        (player?.sessions ?? [])
          .filter(
            (s) =>
              (website === "Chess.com" && s.chessCom?.username) ||
              (website === "Lichess" && s.lichess?.username),
          )
          .map((s) => s.chessCom?.username || s.lichess?.username)
          .filter((username): username is string => username !== undefined && username !== null),
      ),
    [player, website],
  );

  useEffect(() => {
    if (account !== null && !accounts.includes(account)) setAccount(ALL_ACCOUNTS);
  }, [account, accounts]);

  return (
    <>
      <Select
        classNames={{ dropdown: filterClasses.dropdown }}
        pt="lg"
        label={t("Home.Accounts.Website")}
        value={website}
        onChange={(value) => {
          setWebsite(value);
          setAccount(ALL_ACCOUNTS);
        }}
        data={websites}
        allowDeselect={false}
        leftSection={<SiteLogos sites={filterLogoSites(website)} decorative />}
        leftSectionWidth={siteLogosWidth(filterLogoSites(website).length) || undefined}
        renderOption={({ option }) => (
          <Group gap="xs" wrap="nowrap">
            <SiteLogos sites={filterLogoSites(option.value)} decorative />
            {option.label}
          </Group>
        )}
      />
      {website !== ALL_WEBSITES && accounts.filter((a) => a !== ALL_ACCOUNTS).length > 1 && (
        <Select
          classNames={{ dropdown: filterClasses.dropdown }}
          pt="lg"
          label={t("Home.Accounts.Account")}
          value={account}
          onChange={(value) => setAccount(value)}
          data={accounts.map((value) => ({
            value,
            label: value === ALL_ACCOUNTS ? t("Home.Accounts.AllAccounts") : value,
          }))}
          allowDeselect={false}
        />
      )}
    </>
  );
};

export default WebsiteAccountSelector;
