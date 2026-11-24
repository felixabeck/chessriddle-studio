import type { Token } from "@/bindings";

/** Lexes plain PGN headers and movetext for unit fixtures. */
export function lex(pgn: string): Token[] {
    const tokens: Token[] = [];
    let rest = pgn.trimStart();
    while (rest.startsWith("[")) {
        const end = rest.indexOf("]");
        if (end === -1) break;
        const header = rest.slice(1, end);
        const match = /^(\S+)\s+"([^"]*)"$/.exec(header);
        if (match) {
            tokens.push({ type: "Header", value: { tag: match[1], value: match[2] } });
        }
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
