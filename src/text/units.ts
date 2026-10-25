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
    // Capture source lines before code spans normalize newlines and link destinations disappear.
    md.inline.State = class extends md.inline.State {
        /** Keeps source locations on parsed inline tokens, including breaks and code. */
        override push(type: string, tag: string, nesting: -1 | 0 | 1): Token {
            return this.locate(super.push(type, tag, nesting));
        }

        /** Keeps source locations on ordinary text when the parser flushes it. */
        override pushPending(): Token {
            return this.locate(super.pushPending());
        }

        private locate(token: Token): Token {
            const line = countNewlines(this.src.slice(0, this.pos));
            token.map = [
                line,
                line + 1,
            ];
            return token;
        }
    };
    const env = {};
    const tokens = md.parse(blankFrontmatter(source), env);
    const units: Unit[] = [];
    const seen = new Map<string, number>();
    let section = 0;

    const addUnit = (kind: UnitKind, line: number, sourceText: string, spoken: string): string | undefined => {
        if (!spoken.trim()) {
            return undefined;
        }
        const base = shortHash(`${kind}\n${sourceText}`, 12);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const id = `${base}-${n}`;
        units.push({ id, kind, line, section, spoken, index: units.length });
        return id;
    };

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token.type === "heading_open") {
            section++;
            const inline = tokens[i + 1];
            if (inline?.type === "inline") {
                const id = addUnit("heading", token.map?.[0] ?? 0, inline.content, spokenTokens(inline.children ?? [], language));
                if (id) {
                    token.attrSet("class", "u");
                    token.attrSet("data-u", id);
                }
                i++;
            }
            continue;
        }
        if (token.type === "tr_open") {
            const cells: Token[] = [];
            let j = i + 1;
            for (; j < tokens.length && tokens[j]!.type !== "tr_close"; j++) {
                const cell = tokens[j]!;
                if (cell.type === "inline") {
                    cells.push(cell);
                }
            }
            const spoken = cells.map((c) => spokenTokens(c.children ?? [], language)).join(", ");
            const id = addUnit("row", token.map?.[0] ?? 0, cells.map((c) => c.content).join(" | "), spoken);
            if (id) {
                token.attrSet("class", "u");
                token.attrSet("data-u", id);
            }
            i = j;
            continue;
        }
        // Inline tokens of tables were consumed with their row above.
        if (token.type === "inline") {
            const children = token.children ?? [];
            const text = children.map(inlineText).join("");
            // Code is an indivisible token: punctuation inside it must not create sentence boundaries.
            const masked = children.map((child) => (child.type === "code_inline" ? "x".repeat(child.content.length) : inlineText(child))).join("");
            const sentences = splitSentences(masked, language);
            if (sentences.length) {
                let end = 0;
                const spans = sentences.map(({ text: sentence, offset }) => {
                    const before = md.renderer.renderInline(sliceInline(children, end, offset), md.options, env);
                    end = offset + sentence.length;
                    const fragment = sliceInline(children, offset, end);
                    const html = md.renderer.renderInline(fragment, md.options, env);
                    const line = (token.map?.[0] ?? 0) + (fragment.find((child) => inlineText(child).length > 0)?.map?.[0] ?? 0);
                    const id = addUnit("sentence", line, html, spokenTokens(fragment, language));
                    return before + (id ? `<span class="u" data-u="${id}">${html}</span>` : html);
                });
                replaceChildren(token, spans.join("") + md.renderer.renderInline(sliceInline(children, end, text.length), md.options, env));
            }
        }
    }

    return { html: md.renderer.render(tokens, md.options, env), units };
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

/** Splits visible text with the runtime's locale-aware sentence rules, retaining offsets and common abbreviations. */
export function splitSentences(text: string, language = "en"): { text: string; offset: number }[] {
    const result: { text: string; offset: number }[] = [];
    let start = 0;
    const segments = new Intl.Segmenter(language, { granularity: "sentence" }).segment(text);
    for (const { index, segment } of segments) {
        const end = index + segment.length;
        const lastWord = /([\p{L}.]+)\.[\s"'”’)]*$/u.exec(segment)?.[1]?.toLowerCase() ?? "";
        if (ABBREVIATIONS.has(lastWord) || /^\p{L}$/u.test(lastWord)) {
            continue;
        }
        pushTrimmed(result, text, start, end);
        start = end;
    }
    pushTrimmed(result, text, start, text.length);
    return result;
}

function inlineText(token: Token): string {
    if (token.type === "text" || token.type === "code_inline") {
        return token.content;
    }
    if (token.type === "image") {
        return "\uFFFC";
    }
    return token.type === "softbreak" || token.type === "hardbreak" ? "\n" : "";
}

/** Takes a visible-text range without reparsing Markdown; formatting that crosses a boundary is reopened. */
function sliceInline(children: Token[], start: number, end: number): Token[] {
    if (start === end) {
        return [];
    }
    const result: Token[] = [];
    const opened: Token[] = [];
    let offset = 0;
    let started = false;
    const begin = () => {
        if (!started) {
            result.push(...opened);
            started = true;
        }
    };
    for (const child of children) {
        if (child.nesting === 1) {
            if (started) {
                result.push(child);
            }
            opened.push(child);
        } else if (child.nesting === -1) {
            opened.pop();
            if (started) {
                result.push(child);
            }
        } else {
            const length = inlineText(child).length;
            const from = Math.max(0, start - offset);
            const to = Math.min(length, end - offset);
            if (from < to || (length === 0 && offset >= start && offset < end)) {
                begin();
                const copy = Object.assign(Object.create(Object.getPrototypeOf(child)) as Token, child);
                if (child.type === "text" || child.type === "code_inline") {
                    copy.content = child.content.slice(from, to);
                }
                result.push(copy);
            }
            offset += length;
        }
        if (started && offset >= end) {
            break;
        }
    }
    for (const open of opened.reverse()) {
        const close = new (open.constructor as new (type: string, tag: string, nesting: number) => Token)(open.type.replace(/_open$/, "_close"), open.tag, -1);
        result.push(close);
    }
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

/** The narrator's words from parsed Markdown: no markup or URLs, with inline code made speakable. */
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
