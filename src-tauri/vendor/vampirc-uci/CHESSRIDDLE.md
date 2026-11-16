# ChessRiddle Studio patch to vampirc-uci

Upstream: franciscoBSalgueiro/vampirc-uci at revision
0d2b70d1e9cc6fb2159717a7252e1e080c25bd53, from
https://github.com/franciscoBSalgueiro/vampirc-uci.
Retained files are Cargo.toml, LICENSE, README.md, .gitignore, res/ and src/.
Dependency resolution uses the application's lockfile.

The patch in src/parser.rs decodes cp, mate and WDL numbers fallibly as i32.
An overflowing number makes the whole info line Unknown with its original text.
This avoids WDL panics and scores silently becoming exact zeroes.
Missing score or WDL numbers also fail decoding.
Other numeric fields keep their upstream default on overflow.
An info time outside the Duration range becomes zero instead of panicking.

The patch in res/uci.pest lets the number rule match any digit count.
Upstream capped it at 12 digits, so a 13-digit nodes count matched only its
first 12 digits and the rest of the info line, including its pv, was silently
dropped. Decoding, not the grammar, now handles a value that does not fit.
The milliseconds rule keeps its 12-digit cap: only go commands use it,
which the application sends and never parses from an engine.
All other upstream bytes are unchanged.

A future upstream bump must re-apply this patch or demonstrate its replacement
and pass the application's uci_numeric_ tests.
