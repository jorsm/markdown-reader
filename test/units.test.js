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

test("sentences split at sentence ends but not after abbreviations or inside code spans", () => {
    const parts = splitSentences("Use `a.b. Next` now. It works, e.g. Here too. Done!").map((p) => p.text);
    assert.deepEqual(parts, [
        "Use `a.b. Next` now.",
        "It works, e.g. Here too.",
        "Done!",
    ]);
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
