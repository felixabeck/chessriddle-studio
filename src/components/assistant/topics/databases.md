---
id: databases
title: Databases, explorer, position search, players, and tournaments
summary: Add or download game databases, pick a reference database, search positions in the explorer, and browse games, players, and tournaments.
---

Databases live in [[page:library]] ({{label:SideBar.Library}}) alongside your PGN files, and are stored in [[setting:databases-directory]].

To add a database, open [[page:library]] and click {{label:Library.AddDatabase}}:
- {{label:Databases.Add.Web}}: download curated game databases from the catalog.
- {{label:Common.Local}}: pick a local PGN file (including `.pgn.zst` or `.pgn.bz2`), enter a {{label:Common.Name}} and optional {{label:Common.Description}}, and click {{label:Databases.Add.Convert}}.

Select a database in [[page:library]] to manage it:
- Check {{label:Databases.Settings.ReferenceDatabase}} to make it the default reference database for the explorer, repertoire builder, game report novelties, and the Coach.
- Check {{label:Databases.Settings.Indexed}} to create or remove search indexes for faster lookups.
- Click {{label:Databases.Settings.Explore}} to open the database table view.
- Under {{label:Databases.Settings.Actions}}, use {{label:Databases.Settings.AddGames}} to append PGN files, {{label:Databases.Settings.ExportPGN}} to export to PGN, or {{label:Common.Delete}} to remove the database.
- Under {{label:Databases.Settings.AdvancedTools}}, use {{label:Databases.Settings.MergePlayers}} to combine duplicate player entries, or {{label:Databases.Settings.RemoveDup}} and {{label:Databases.Settings.RemoveEmpty}} to clean up games.

Inside the database table view, switch between {{label:Common.Games}}, {{label:Databases.Card.Players}}, and {{label:Databases.Settings.Events}} (tournaments):
- Search and sort games, preview a game, or open it on the analysis board.
- In {{label:Databases.Card.Players}}, select a player to view {{label:Home.Personal.Overview}}, {{label:Home.Personal.Ratings}}, and {{label:Home.Personal.Openings}} (an interactive opening tree with a {{label:Databases.OpeningTree.Prepare}} button), plus FIDE info via {{label:Databases.FIDE.Info}}.
- In {{label:Databases.Settings.Events}}, search tournaments by name and sort by date, players, games, or average ELO.

In a player's {{label:Home.Personal.Preparation}} tab, compare their games with your repertoire files:
- Choose the opponent's color, the {{label:Databases.OpeningTree.Since}} period, and (with linked online accounts) {{label:Databases.OpeningTree.OverTheBoard}}, {{label:Databases.OpeningTree.Online}}, or {{label:Databases.Preparation.Both}}. Click {{label:Databases.Preparation.Refresh}} to run the comparison again.
- Review the lines the opponent plays and {{label:Databases.Preparation.GapsTitle}}. Click any row to open your repertoire file at that position with other side lines hidden; switch between {{label:Notation.PreparationOpponentLines}} and {{label:Notation.PreparationAllLines}} in the notation header.
- Click {{label:Databases.Preparation.TrainLines}} to start a timed practice run over those lines; your answers update the normal spaced-repetition schedule.

On the analysis board, open {{label:Board.Tabs.Database}} to use the opening explorer:
- Switch between {{label:Board.Database.Local}}, {{label:Board.Database.LichessAll}}, and {{label:Board.Database.LichessMaster}} (the Lichess online explorers require a signed-in Lichess account on [[page:accounts]]).
- Switch between {{label:Board.Database.Stats}} (move statistics) and {{label:Board.Database.Games}} (matching games).
- For local databases, click {{label:Board.Database.Compare}} to view two databases side by side, or open {{label:Board.Database.Local.Position}} to switch between {{label:Board.Database.Local.Exact}} and {{label:Board.Database.Local.Partial}} position search (including {{label:Board.Database.Local.SimilarStructure}} for pawn-structure search and {{label:Fen.Empty}} for custom patterns).
- Use {{label:Board.Database.Pin}} to pin the explorer above or below the board or notation, and {{label:Board.Database.Unpin}} to return it to the tabs.
- When {{label:Databases.OpeningTree.Prepare}} opens a board for a database player, the explorer adds your reference database as another column beside the opponent's games; click {{label:Board.Database.RemoveReference}} to hide it or {{label:Board.Database.ShowReference}} to bring it back.
