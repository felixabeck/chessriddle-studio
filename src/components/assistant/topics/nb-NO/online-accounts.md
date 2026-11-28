---
id: online-accounts
title: Nettkontoer og motstanderforberedelse
summary: Legg til kontoer for Lichess og Chess.com, last ned partiene dine og koble nettkontoer til spillere i en database for å studere motstanderens åpninger.
source: fb725d488406a0b7
---

Administrer kontoene dine på Lichess og Chess.com under [[page:accounts]] ({{label:SideBar.Accounts}}).

Slik legger du til en konto:
1. Klikk {{label:Home.Accounts.Add}} på [[page:accounts]].
2. Skriv eventuelt inn eller velg et {{label:Home.Accounts.PlayerName}} for å samle flere kontoer under én spillerprofil.
3. Velg Lichess eller Chess.com under {{label:Home.Accounts.Website}} og skriv inn {{label:Home.Accounts.Username}}.
4. For Lichess kan du eventuelt krysse av for {{label:Home.Accounts.LoginWithBrowser}} for å logge inn med OAuth. Innlogging gir raskere nedlasting av partier og tilgang til Lichess sine nettbaserte åpningsutforskere på analysebrettet.
5. Klikk {{label:Common.Add}}.

På hvert kontokort på [[page:accounts]]:
- Klikk {{label:Home.Accounts.UpdateStats}} for å oppdatere rangeringene og statistikken din.
- Klikk nedlastingsknappen for å laste ned partiene dine til en lokal database (senere nedlastinger henter bare nye partier siden forrige nedlasting).
- Klikk {{label:Home.Accounts.RemoveAccount}} for å fjerne kontoen.
- Når partier er lastet ned, viser høyre side av [[page:accounts]] din personlige statistikk ({{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}} og {{label:Home.Personal.Openings}}).

Slik studerer du en motstanders nettåpninger fra en database:
1. Åpne en database i [[page:library]] og bytt til fanen {{label:Databases.Card.Players}}.
2. Velg en spiller for å åpne spillerkortet.
3. Klikk {{label:Databases.Opponent.AddShort}} ved siden av spillerens navn for å koble ett eller flere brukernavn fra Lichess eller Chess.com til den spilleren.
4. Klikk {{label:Databases.Opponent.Manage}} for å filtrere etter {{label:Databases.OpeningTree.Since}} og {{label:Databases.Opponent.TimeControls}}, eller for å bruke {{label:Databases.Opponent.RemoveGames}} eller {{label:Databases.Opponent.Unlink}}.
5. Klikk {{label:Databases.Opponent.Download}} (eller {{label:Databases.Opponent.Update}}) for å hente nettpartiene deres.
6. Klikk {{label:Databases.OpeningTree.Prepare}} fra fanene på spillerkortet ({{label:Home.Personal.Preparation}} eller {{label:Home.Personal.Openings}}) for å åpne et analysebrett med motstanderens partier festet i utforskeren; åpne {{label:Home.Personal.Openings}} først for å bla gjennom deres nærsjakk- og nettbaserte åpningstre, filtrere etter farge og {{label:Databases.OpeningTree.Since}} og velge en bestemt linje.
