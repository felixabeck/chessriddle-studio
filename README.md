<br />
<div align="center">
  <a href="https://github.com/felixabeck/chessriddle-studio">
    <img width="115" height="115" src="https://github.com/franciscoBSalgueiro/en-croissant/blob/master/src-tauri/icons/icon.png" alt="Logo of the original En Croissant project">
  </a>

<h3 align="center">ChessRiddle Studio</h3>

  <p align="center">
    The Ultimate Chess Toolkit
    <br />
    <a href="https://github.com/felixabeck/chessriddle-studio"><strong>Source and support</strong></a>
    <br />
    <br />
    <a href="https://github.com/felixabeck/chessriddle-studio/issues">Issues</a>
    ·
    <a href="https://www.encroissant.org/docs">Upstream documentation</a>
  </p>
</div>

> **This is a modified version of [En Croissant](https://github.com/franciscoBSalgueiro/en-croissant).**
> Modified by Felix Beck since 2026-08-09, and released under the GNU General Public License v3.0
> with no warranty. Not affiliated with, nor endorsed by, the original project.

ChessRiddle Studio is an open-source, cross-platform chess GUI that aims to be powerful, customizable and easy to use. It is Felix Beck's fork of En Croissant.

## Features

- Store and analyze your games from [lichess.org](https://lichess.org) and [chess.com](https://chess.com)
- Multi-engine analysis. Supports all UCI engines
- Prepare a repertoire and train it with spaced repetition
- Simple engine and database installation and management
- Absolute or partial position search in the database

<img src="https://github.com/franciscoBSalgueiro/encroisssant-site/blob/master/public/showcase.webp" />

## Building from source

Refer to the [Tauri documentation](https://tauri.app/start/prerequisites/) for the requirements on your platform.

ChessRiddle Studio uses pnpm as the package manager for dependencies. Refer to the [pnpm install instructions](https://pnpm.io/installation) for how to install it on your platform.

```bash
git clone https://github.com/felixabeck/chessriddle-studio
cd chessriddle-studio
pnpm install
pnpm build
```

The built app can be found at `src-tauri/target/release`

## Donate

If you wish to support the original En Croissant project, you can do so [here](https://encroissant.org/support). All donations are greatly appreciated!

## Contributing

For contributing to this project please refer to the [Contributing guide](./CONTRIBUTING.md).

## License

This software is licensed under GPL-3.0 License.

The Alpha chess piece set (`public/pieces/alpha.css`), designed by Eric Bentzen, is not covered by the GPL. Felix Beck holds a lifelong licence from the designer to use it in ChessRiddle Studio. Reselling the design or images based on it is not permitted. Outside ChessRiddle Studio, the designer's own terms apply: free for personal, non-commercial use.
