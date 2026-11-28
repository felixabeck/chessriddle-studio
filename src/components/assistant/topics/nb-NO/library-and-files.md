---
id: library-and-files
title: Filer og biblioteket
summary: Sett opp en arbeidsmappe, opprett og organiser PGN-filer, åpne og lagre partier og administrer papirkurven.
source: c4c2624190fac7bb
---

[[page:library]] ({{label:SideBar.Library}}) samler PGN-filene i arbeidsområdet ditt (partier, repertoarer, turneringer, oppgaver og andre filer) sammen med partidatabasene dine.

Før du oppretter filer må du velge en arbeidsmappe. Hvis ingen mappe er valgt ennå, klikker du {{label:Files.ChooseFolder}} på [[page:library]], eller konfigurerer [[setting:files-directory]] ({{label:Settings.Directories.Files}}) under [[settings-category:directories]].

På [[page:library]]:
- Klikk {{label:Files.CreateFile}} for å opprette en ny PGN-fil eller {{label:Files.CreateFolder}} for å organisere filer i undermapper.
- Bruk søkefeltet {{label:Common.Search}} og rullegardinmenyen {{label:Files.FileType}} til å filtrere etter filtype eller {{label:Library.GamesDatabase}}.
- Velg en fil for å forhåndsvise partiene i den (forhåndsvisningen kan skjule trekkene med øyeknappen, [[setting:hide-preview-moves]]), åpne den på analysebrettet eller bruke {{label:Files.Rename}}, {{label:Files.Move}} og {{label:Files.Trash}}.

Mens du redigerer en fil på analysebrettet:
- Lagre endringer med lagreknappen i brettets topplinje (vises når automatisk lagring er slått av, utilgjengelig eller mislyktes), {{label:Menu.File}} -> {{label:Common.Save}}, eller hurtigtasten {{label:Settings.Keybinds.Actions.SAVE_FILE}}.
- Slå på [[setting:auto-save]] ({{label:Settings.AutoSave}}) for å lagre endringer i åpnede filer automatisk.
- Bruk {{label:Menu.File}} -> {{label:Board.Database.Save}} (eller {{label:Board.Action.More}} -> {{label:Board.Database.Save}} i brettets topplinje) for å lagre det gjeldende partiet i en annen biblioteksfil eller database.

Å flytte en fil til {{label:Files.Trash}} sletter den ikke permanent med én gang. Du kan klikke {{label:Common.Undo}} direkte i varselet, eller bla ned til delen {{label:Files.Trash}} i [[page:library]] for å bruke {{label:Files.Restore}}, {{label:Files.DeletePermanently}} eller {{label:Files.EmptyTrash}}.

Når ChessRiddle-kontoen din er tilkoblet, klikker du {{label:Library.Sync.Action}} på [[page:library]] for å synkronisere valgte PGN-filer og partidatabaser til ditt private bibliotek på ChessRiddle (opptil 100 filer, 5 MB, 40 000 trekk og 5 000 partier per fil). Redigeringer, navneendringer, fravalg og slettinger oppdateres automatisk; nedlastede partihistorikker forblir lokale. Når du slår av synkronisering, kan du velge å beholde eller fjerne de synkroniserte filene på ChessRiddle.
