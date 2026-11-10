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
The grammar in res/uci.pest is unchanged. All other upstream bytes are unchanged.

A future upstream bump must re-apply this patch or demonstrate its replacement
and pass the application's uci_numeric_ tests.
