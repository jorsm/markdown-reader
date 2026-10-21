import { createHash } from "node:crypto";
import MarkdownIt from "markdown-it";

type Token = ReturnType<MarkdownIt["parse"]>[number];

/** What a unit is in the document; it sets the pause after it. */
export type UnitKind = "heading" | "sentence" | "row";

/** One clickable, separately synthesized piece of the document. */
export interface Unit {
    id: string;
    kind: UnitKind;
    /** Zero-based source line where the unit starts. */
    line: number;
    /** Heading count before the unit, so context stays within a section. */
    section: number;
    /** Position in the document's unit list. */
    index: number;
    /** What the TTS engine is asked to say. */
    spoken: string;
}

/** The document as the panel shows it, with every unit wrapped in a clickable element, and its units in order. */
export interface RenderedDocument {
    html: string;
    units: Unit[];
}

/** Words spoken for the symbols inside inline code, per language. */
const SYMBOL_WORDS: Record<string, Record<string, string>> = {
    en: { "/": "slash", ".": "dot", _: "underscore", "-": "dash", "@": "at", "#": "hash", ":": "colon", "=": "equals" },
    it: { "/": "barra", ".": "punto", _: "trattino basso", "-": "trattino", "@": "chiocciola", "#": "cancelletto", ":": "due punti", "=": "uguale" },
};

const ABBREVIATIONS = new Set([
    "e.g",
    "i.e",
    "etc",
    "vs",
    "cf",
    "approx",
    "no",
    "fig",
    "mr",
    "mrs",
    "dr",
    "es",
    "ecc",
    "pag",
]);

/** Renders Markdown to HTML and splits it into speech units: headings, sentences and table rows. Code blocks are shown, not read. */
export function renderDocument(source: string, language: string): RenderedDocument {
    const md = new MarkdownIt({ html: false, linkify: false });
    const tokens = md.parse(blankFrontmatter(source), {});
    const units: Unit[] = [];
    const seen = new Map<string, number>();
    let section = 0;

    const addUnit = (kind: UnitKind, line: number, sourceText: string, spoken: string): string => {
        const base = shortHash(`${kind}\n${sourceText}`, 12);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const id = `${base}-${n}`;
        if (spoken.trim()) {
            units.push({ id, kind, line, section, spoken, index: units.length });
        }
        return id;
    };

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token.type === "heading_open") {
            section++;
            const inline = tokens[i + 1];
            if (inline?.type === "inline") {
                const id = addUnit("heading", token.map?.[0] ?? 0, inline.content, spokenTokens(inline.children ?? [], language));
                token.attrSet("class", "u");
                token.attrSet("data-u", id);
                i++;
            }
            continue;
        }
        if (token.type === "tr_open") {
            const cells: string[] = [];
            let j = i + 1;
            for (; j < tokens.length && tokens[j]!.type !== "tr_close"; j++) {
                const cell = tokens[j]!;
                if (cell.type === "inline") {
                    cells.push(cell.content);
                }
            }
            const spoken = cells.map((c) => spokenInline(md, c, language)).join(", ");
            const id = addUnit("row", token.map?.[0] ?? 0, cells.join(" | "), spoken);
            token.attrSet("class", "u");
            token.attrSet("data-u", id);
            i = j;
            continue;
        }
        // Inline tokens of tables were consumed with their row above.
        if (token.type === "inline") {
            let line = token.map?.[0] ?? 0;
            let counted = 0;
            const spans = splitSentences(token.content).map(({ text, offset }) => {
                line += countNewlines(token.content.slice(counted, offset));
                counted = offset;
                const id = addUnit("sentence", line, text, spokenInline(md, text, language));
                return `<span class="u" data-u="${id}">${md.renderInline(text)}</span>`;
            });
            replaceChildren(token, spans.join(" "));
        }
    }

    return { html: md.renderer.render(tokens, md.options, {}), units };
}

/** Inworld accepts at most 5 previous requests, 2,000 characters in all, as synthesis context. */
const CONTEXT_MAX_UNITS = 5;
const CONTEXT_MAX_CHARS = 2000;

/** The spoken text of the units just before `unit` in the same section, oldest first, within Inworld's limits. */
export function contextFor(units: Unit[], unit: Unit): string[] {
    const result: string[] = [];
    let total = 0;
    for (let i = unit.index - 1; i >= 0 && result.length < CONTEXT_MAX_UNITS; i--) {
        const previous = units[i]!;
        if (previous.section !== unit.section || total + previous.spoken.length > CONTEXT_MAX_CHARS) {
            break;
        }
        result.unshift(previous.spoken);
        total += previous.spoken.length;
    }
    return result;
}

/** Replaces YAML frontmatter with empty lines, so it is neither shown nor read and line numbers stay right. */
function blankFrontmatter(source: string): string {
    const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(source);
    if (!match) {
        return source;
    }
    return "\n".repeat(countNewlines(match[0])) + source.slice(match[0].length);
}

function replaceChildren(inline: Token, html: string): void {
    const child = new (inline.constructor as new (type: string, tag: string, nesting: number) => Token)("html_inline", "", 0);
    child.content = html;
    inline.children = [child];
}

function countNewlines(text: string): number {
    return text.split("\n").length - 1;
}

/** Splits Markdown inline text into sentences, never inside code spans or link targets. */
export function splitSentences(text: string): { text: string; offset: number }[] {
    // Masking keeps offsets: code spans and link targets can't end a sentence.
    const masked = text.replace(/`[^`]*`|\]\([^)]*\)/g, (m) => "\u0000".repeat(m.length));
    const result: { text: string; offset: number }[] = [];
    let start = 0;
    const boundary = /[.!?…]["'”’)\]*_]*\s+(?=["“'‘([*_`]*[\p{Lu}\p{N}`])/gu;
    for (const match of masked.matchAll(boundary)) {
        const end = match.index + match[0].length;
        const before = masked.slice(start, match.index + 1);
        const lastWord = /([\p{L}.]+)\.$/u.exec(before)?.[1]?.toLowerCase() ?? "";
        if (ABBREVIATIONS.has(lastWord) || /^\p{L}$/u.test(lastWord)) {
            continue;
        }
        pushTrimmed(result, text, start, end);
        start = end;
    }
    pushTrimmed(result, text, start, text.length);
    return result;
}

function pushTrimmed(result: { text: string; offset: number }[], text: string, start: number, end: number): void {
    const slice = text.slice(start, end);
    const lead = slice.length - slice.trimStart().length;
    const trimmed = slice.trim();
    if (trimmed) {
        result.push({ text: trimmed, offset: start + lead });
    }
}

/** The words a narrator says for a piece of Markdown inline text: no markup, no URLs, code made speakable. */
export function spokenInline(md: MarkdownIt, text: string, language: string): string {
    return spokenTokens(md.parseInline(text, {})[0]?.children ?? [], language);
}

/** {@link spokenInline} for text markdown-it has already parsed. */
function spokenTokens(children: Token[], language: string): string {
    const parts: string[] = [];
    for (const child of children) {
        switch (child.type) {
            case "text":
                parts.push(child.content.replace(/→/g, ","));
                break;
            case "code_inline":
                parts.push(speakCode(child.content, language));
                break;
            case "softbreak":
            case "hardbreak":
                parts.push(" ");
                break;
            default:
                // Formatting, link markers, images and raw HTML carry no words to say.
                break;
        }
    }
    return parts.join("").replace(/\s+/g, " ").trim();
}

/** A short hex SHA-256 of `input`: unit ids and audio cache keys. */
export function shortHash(input: string, length: number): string {
    return createHash("sha256").update(input).digest("hex").slice(0, length);
}

/** `src/utils/retry.ts` → "src slash utils slash retry dot ts"; `camelCase` → "camel Case"; `B11` → "B 11". */
export function speakCode(code: string, language: string): string {
    const words = SYMBOL_WORDS[language.slice(0, 2)] ?? SYMBOL_WORDS.en!;
    return code
        .split(/\s+/)
        .map((token) =>
            token
                .replace(/\/+$/, "")
                .replace(/[/._\-@#:=]/g, (s) => ` ${words[s] ?? s} `)
                .replace(/[(){}[\]<>*?!,;"'`|\\]/g, " ")
                .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
                .replace(/(\p{L})(\p{N})/gu, "$1 $2"),
        )
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
}
