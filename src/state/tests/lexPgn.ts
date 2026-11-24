import type { Token } from "@/bindings";

/** Lexes plain PGN headers and movetext for unit fixtures. */
export function lex(pgn: string): Token[] {
    const tokens: Token[] = [];
    let rest = pgn.trimStart();
    while (rest.startsWith("[")) {
        const quoted = /^\[(\S+)\s+"([^"]*)"\]/.exec(rest);
        if (quoted) {
            tokens.push({ type: "Header", value: { tag: quoted[1], value: quoted[2] } });
            rest = rest.slice(quoted[0].length).trimStart();
            continue;
        }
        const end = rest.indexOf("]");
        if (end === -1) break;
        rest = rest.slice(end + 1).trimStart();
    }
    for (const [part] of rest.matchAll(/\{[^}]*\}|[()*]|[^\s(){}]+/g)) {
        if (part.startsWith("{")) tokens.push({ type: "Comment", value: part.slice(1, -1) });
        else if (part === "(") tokens.push({ type: "ParenOpen" });
        else if (part === ")") tokens.push({ type: "ParenClose" });
        else if (part === "*") tokens.push({ type: "Outcome", value: "*" });
        else if (!/^\d+\.+$/.test(part)) tokens.push({ type: "San", value: part });
    }
    return tokens;
}
