const test = require("node:test");
const assert = require("node:assert/strict");
const { contextFor, renderDocument, splitSentences, speakCode } = require("../out/text/units.js");

const DOC = `---
id: "0001"
title: Secret frontmatter
---

# Goal

Every change is checkable. It uses \`src/utils/retry.ts\` here. See e.g. the table.

| Field | Meaning |
| --- | --- |
| \`id\` | Four digits |

\`\`\`sh
npm run check
\`\`\`
`;

test("frontmatter is neither shown nor read, and line numbers still point at the source", () => {
    const { html, units } = renderDocument(DOC, "en");
    assert.ok(!html.includes("Secret frontmatter"));
    assert.ok(!units.some((u) => u.spoken.includes("Secret")));
    const heading = units.find((u) => u.kind === "heading");
    assert.equal(DOC.split("\n")[heading.line], "# Goal");
});

test("locale sentence boundaries retain common abbreviations", () => {
    const parts = splitSentences("It works, e.g. Here too. Done!").map((p) => p.text);
    assert.deepEqual(parts, [
        "It works, e.g. Here too.",
        "Done!",
    ]);
});

test("code spans with punctuation and multiple backticks stay in one sentence", () => {
    const { html, units } = renderDocument("Use ``a.b. Next `value` `` now. Then continue.", "en");
    assert.deepEqual(
        units.map((unit) => unit.spoken),
        [
            "Use a dot b dot Next value now.",
            "Then continue.",
        ],
    );
    assert.ok(html.includes("<code>a.b. Next `value` </code>"));
});

test("formatting and links that span sentences render as balanced markup and speak only labels", () => {
    const { html, units } = renderDocument("**Read this first. Then [read *this. And this*](https://example.org/a.b).** Finish.", "en");
    assert.deepEqual(
        units.map((unit) => unit.spoken),
        [
            "Read this first.",
            "Then read this.",
            "And this.",
            "Finish.",
        ],
    );
    const spans = [...html.matchAll(/<span class="u"[^>]*>(.*?)<\/span>/gs)].map((match) => match[1]);
    assert.equal(spans[0], "<strong>Read this first.</strong>");
    assert.equal(spans[1], '<strong>Then <a href="https://example.org/a.b">read <em>this.</em></a></strong>');
    assert.equal(spans[2], '<strong><a href="https://example.org/a.b"><em>And this</em></a>.</strong>');
});

test("reference links stay resolved in sentences, headings and table cells without speaking their URL", () => {
    const { html, units } = renderDocument('# [Heading][ref]\n\n[First sentence. Second sentence.][ref]\n\n| Label |\n| --- |\n| [Table label][ref] |\n\n[ref]: https://example.org/private.target "Reference title"\n', "en");
    assert.deepEqual(
        units.map((unit) => unit.spoken),
        [
            "Heading",
            "First sentence.",
            "Second sentence.",
            "Label",
            "Table label",
        ],
    );
    assert.ok(html.includes('href="https://example.org/private.target" title="Reference title"'));
    assert.ok(!units.some((unit) => /https|private.target|\[ref\]/.test(unit.spoken)));
});

test("sentence wrappers retain images, escaped markup, hard breaks and source lines", () => {
    const source = "![before](before.png) **First.\nSecond.**  \nThird &amp; \\*literal\\*. ![after](after.png)";
    const { html, units } = renderDocument(source, "en");
    assert.deepEqual(
        units.map((unit) => unit.spoken),
        [
            "First.",
            "Second.",
            "Third & *literal*.",
        ],
    );
    assert.deepEqual(
        units.map((unit) => unit.line),
        [
            0,
            1,
            2,
        ],
    );
    assert.ok(html.includes('src="before.png"'));
    assert.ok(html.includes('src="after.png"'));
    assert.ok(html.includes("<br>"));
    assert.ok(html.includes("&amp; *literal*"));
});

test("sentence boundaries work with punctuation that has no following space", () => {
    assert.deepEqual(
        renderDocument("一つ目です。二つ目です！", "ja").units.map((unit) => unit.spoken),
        [
            "一つ目です。",
            "二つ目です！",
        ],
    );
});

test("source jumps account for newlines hidden inside code spans and link destinations", () => {
    for (const source of [
        "Before `code\nwith newline`.\nNext sentence.",
        "[Before](\nhttps://example.org).\nNext sentence.",
    ]) {
        const { units } = renderDocument(source, "en");
        const next = units.find((unit) => unit.spoken === "Next sentence.");
        assert.equal(next.line, 2);
        assert.equal(source.split("\n")[next.line], next.spoken);
    }
});

test("table rows are read cell by cell, code blocks are not read", () => {
    const { units } = renderDocument(DOC, "en");
    assert.deepEqual(
        units.filter((u) => u.kind === "row").map((u) => u.spoken),
        [
            "Field, Meaning",
            "id, Four digits",
        ],
    );
    assert.ok(!units.some((u) => u.spoken.includes("npm run check")));
});

test("inline code is spoken with the symbol words of the chosen language", () => {
    assert.equal(speakCode("src/utils/retry.ts", "en"), "src slash utils slash retry dot ts");
    assert.equal(speakCode("vertexAiChat.projectId", "it"), "vertex Ai Chat punto project Id");
    assert.equal(speakCode("B11", "en"), "B 11");
});

test("editing one sentence leaves the ids of the others unchanged, so their audio stays cached", () => {
    const before = renderDocument(DOC, "en").units.map((u) => u.id);
    const after = renderDocument(DOC.replace("Every change is checkable.", "Every change is reviewed."), "en").units.map((u) => u.id);
    const changed = before.filter((id) => !after.includes(id));
    assert.equal(changed.length, 1);
});

test("synthesis context stays within Inworld's limits: 5 previous units, same section", () => {
    const text = `# A\n\n${Array.from({ length: 9 }, (_, i) => `Sentence number ${i + 1} is here.`).join(" ")}\n\n# B\n\nFirst of B.`;
    const { units } = renderDocument(text, "en");
    const last = units.find((u) => u.spoken === "Sentence number 9 is here.");
    assert.deepEqual(
        contextFor(units, last),
        [
            4,
            5,
            6,
            7,
            8,
        ].map((n) => `Sentence number ${n} is here.`),
    );
    assert.deepEqual(
        contextFor(
            units,
            units.find((u) => u.spoken === "First of B."),
        ),
        ["B"],
    );
});

test("Markdown with no spoken words creates no units that could send empty text to synthesis", () => {
    for (const source of [
        "",
        " \n\n\t",
        "#\n",
        "![](image.png)",
        "[](https://example.org)",
        "`()`",
    ]) {
        const { html, units } = renderDocument(source, "en");
        assert.deepEqual(units, [], `unexpected speech unit for ${JSON.stringify(source)}`);
        assert.ok(!html.includes('class="u"'), "content without spoken words must not get clickable speech controls");
    }
    const { units } = renderDocument("#\n\n![](image.png)\n\nAn actual sentence.\n\n[](https://example.org)", "en");
    assert.deepEqual(
        units.map((unit) => unit.spoken),
        ["An actual sentence."],
    );
});
