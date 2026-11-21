# Ideas from other chess apps

Ideas seen in other chess apps that could be useful for ChessRiddle Studio. This is a list of
ideas to consider, not a roadmap and not a list of decisions. Each entry names its source and
the date it was read, and marks what the source does not say.

## ChessMonitor Studio

Source: <https://www.chessmonitor.com/blog/2026-chessmonitor-studio>, blog post dated
2026-10-09, read 2026-11-21. Pricing page: <https://www.chessmonitor.com/pricing>.

What it is: an "all-in-one application for preparing and analyzing chess games", built with
Anish Giri. It brings together ChessMonitor's explorers, its "Ultra Database" and the
user's personal statistics, which used to be separate pages. In beta for paying customers
(Plus plan and above).

Not stated by the source: whether it is a web app or a desktop program, offline use, local
engines, where files are stored, or open-source status. It opens at
`chessmonitor.com/studio` and the planned engines are cloud engines, so it is probably a web
app that needs a connection. That is an inference, not a statement from ChessMonitor.

Ideas worth looking at:

- **Tabs like a web browser, boards side by side.** "In Studio, every board lives in its own
  tab, similar to tabs in a web browser", and boards can be placed next to each other.
- **Free panel layout.** Notation, engines, explorers and databases can be arranged freely:
  "Multiple boards, engines, databases, everything in parallel!"
- **Everything follows the active board.** "Everything stays synchronized with your active
  board."
- **Own files as searchable databases.** Under "My Files", users "add own files to Studio".
  "Your games or repertoire are stored inside of databases. You can search these for positions
  and quickly find the games you were looking for!"
- **Files synced with a mobile app.** Own files are "synchronized with our mobile app for
  iPhone and Android". For Studio this would mean an optional sync through a ChessRiddle
  account, with local files still working offline.
- **Planned: cloud engines.** Lc0 and a "heavier" Stockfish, run "in the cloud".

Not covered by the post: game import from Lichess or Chess.com, puzzles or training, and
repertoire training. Repertoires appear only as files stored and searched in "My Files".

## ChessBase 27

Sources, all read 2026-11-21:

- <https://en.chessbase.com/post/chessbase-27-all-new-functions> (ChessBase, 2026-11-15)
- <https://en.chessbase.com/post/chessbase-27-the-new-plans-tab-with-matthias-wuellenweber>
  (ChessBase, 2026-11-17)
- <https://chessbase.in/news/chessbase-27-is-here> (ChessBase India, 2026-11-17)
- <https://en.chessbase.com/post/chessbase-for-mac-people-are-loving-it> (ChessBase, 2026-11-15)

All are the vendor's own pages, so the claims are ChessBase's description, not tested.

What it is: ChessBase's commercial database program, released 2026-11-17. "ChessBase 27 is a
Windows program." Mac users get "a separate program built for the Mac", ChessBase for Mac, a
subscription that "does not yet have all of ChessBase 27's functions". Requirements include
"an internet connection". "The online features need a Premium Membership. 12 months of Premium
are included." It "can be installed on up to three devices, with one ChessBase account."
Prices on ChessBase's site: Starter package €249.90, Mega package €349.90, premium package
€499.90.

Not stated by the sources: which core features work offline, what happens after the included
12 months of Premium, cloud sync in detail ("cloud features" is named once and not described),
Linux support, and any mobile app for the program itself.

Ideas worth looking at:

- **Plans Explorer.** It "mines your reference database for the typical plans of both sides in
  the current position" and "You can use it in any position, not just in the opening." It
  "lists the games where they appeared and draws the piece manoeuvres on the board."
- **Practical engine moves.** The engine pane separates the objectively best move from moves
  almost as strong that pose more practical problems, and from moves that leave only one
  satisfactory reply. "The program marks the most practically attractive moves" and gives "a
  verbal assessment of how difficult a continuation is to find."
- **Interesting Games score.** "ChessBase 27 uses machine learning to assign an interest score
  to games." "The score appears in the game list and can be used for sorting."
- **Position-pattern search.** "The program supports Chess Query Language", for searches such
  as smothered mates, underpromotions or model mates.
- **Opening catalog that follows the board.** "A new interactive opening encyclopedia built
  directly into the board window", with "Around 2,000 opening entries, based on the ECO
  system", profiles such as sharpness and draw tendency, and "Annotated repertoire
  recommendations for White and Black." "The catalog follows the position on the board."
- **Repertoire training.** "A dedicated function for practicing your opening repertoire." The
  sources do not describe how it works.
- **Play a position out against a human-like engine.** "ChessBase 27 lets you play out a
  position against Fritz, using its human-play algorithm." ChessBase India: "Ideal for testing
  the lines in your repertoire."
- **Second analysis board.** ChessBase describes it as "a second, independent board for
  exploring variations without changing the game being analysed."
- **Lichess opening tree.** "A new opening-tree pane based on more than eight billion Lichess
  games", with time-control filters and "Separate trees for variants such as Chess960 and
  Atomic." It is a Premium feature and "gives access to a huge online playing database".
- **AI assistant with your own API key.** Ask ChessBase "uses the Anthropic or OpenAI agentic
  interface which then accesses ChessBase functionality directly", and "if you already use an
  API key from Anthropic or OpenAI you can also bring this." Otherwise "Usage is charged in
  Ducats". One example task is "Creating a complete fully annotated opening repertoire for a
  club player."
- **Coaching in the browser.** "The coach starts a session and shares a link or QR code."
  "Students can join using a free web application on a computer, tablet or phone", without a
  ChessBase account. "Usage is limited to one coach with up to 5 students and a total of 25
  teaching hours per month."
- **Command bar.** A bar that finds commands and settings as you type.
- **Chess960 everywhere.** "This is supported throughout the program", including opening
  books and analysis.
