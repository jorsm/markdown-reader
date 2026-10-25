import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Events carry metadata only: never document text, credentials or tokens. */
export type TelemetryEvent =
    | {
          type: "synth";
          model: string;
          voice: string;
          language: string;
          /** Workspace-relative path of the document; its content is never recorded. */
          doc: string;
          charsSent: number;
          charsBilled: number;
          costUsd: number;
          cacheHit: boolean;
          totalMs: number;
          audioMs: number;
          error?: string;
      }
    | { type: "play_start"; ms: number; cacheHit: boolean; speed: number }
    | { type: "stall"; waitMs: number; speed: number }
    | { type: "session_end"; unitsPlayed: number; stalls: number; speed: number };

/** Spend over some period: what Inworld billed, its estimated cost, and how many requests the cache saved. */
export interface SpendTotals {
    charsBilled: number;
    costUsd: number;
    requests: number;
    cacheHits: number;
}

type Ledger = Record<string, Record<string, SpendTotals>>;

interface UsageFile {
    size: number;
    totals: SpendTotals;
}

const RETENTION_DAYS = 30;

/** Local-only JSON Lines telemetry (one file per day, kept 30 days) and a spend ledger that is never pruned. */
export class Telemetry {
    private readonly eventsDir: string;
    private readonly usageDir: string;
    private readonly writer = randomUUID();
    private readonly legacy: Ledger;
    private readonly files = new Map<string, UsageFile>();
    private readonly session: SpendTotals = emptyTotals();

    constructor(
        storageDir: string,
        private readonly now: () => Date = () => new Date(),
    ) {
        this.eventsDir = join(storageDir, "telemetry");
        this.usageDir = join(storageDir, "spend");
        mkdirSync(this.eventsDir, { recursive: true });
        mkdirSync(this.usageDir, { recursive: true });
        this.legacy = this.loadLegacy(join(storageDir, "spend.json"));
        this.prune();
    }

    /** Appends the event to today's file and, for synthesis, adds it to the spend ledger. */
    record(event: TelemetryEvent): void {
        const now = this.now();
        const line = JSON.stringify({ at: now.toISOString(), ...event });
        appendFileSync(join(this.eventsDir, `${day(now)}.jsonl`), `${line}\n`);
        if (event.type === "synth" && !event.error) {
            this.addSpend(day(now), event.model, event);
        }
    }

    /** Spend since VS Code started. */
    sessionSpend(): SpendTotals {
        return { ...this.session };
    }

    /** Spend of the current calendar month (UTC). */
    monthSpend(): SpendTotals {
        const key = day(this.now()).slice(0, 7);
        const totals = emptyTotals();
        for (const [
            date,
            models,
        ] of Object.entries(this.legacy)) {
            if (date.startsWith(key)) {
                Object.values(models).forEach((model) => addTotals(totals, model));
            }
        }
        for (const file of readdirSync(this.usageDir)) {
            if (file.startsWith(`${key}-`) && file.endsWith(".jsonl")) {
                addTotals(totals, this.readUsage(file));
            }
        }
        return totals;
    }

    private addSpend(date: string, model: string, event: { charsBilled: number; costUsd: number; cacheHit: boolean }): void {
        const delta: SpendTotals = { charsBilled: event.charsBilled, costUsd: event.costUsd, requests: event.cacheHit ? 0 : 1, cacheHits: event.cacheHit ? 1 : 0 };
        const file = `${date}.${this.writer}.jsonl`;
        const line = `${JSON.stringify({ model, ...delta })}\n`;
        appendFileSync(join(this.usageDir, file), line);
        addTotals(this.session, delta);
        // This writer is the only process appending to its file, so its cached totals can be updated directly.
        const cached = this.files.get(file) ?? { size: 0, totals: emptyTotals() };
        cached.size += Buffer.byteLength(line);
        addTotals(cached.totals, delta);
        this.files.set(file, cached);
    }

    private readUsage(file: string): SpendTotals {
        const path = join(this.usageDir, file);
        const size = statSync(path).size;
        const cached = this.files.get(file);
        if (cached?.size === size) {
            return cached.totals;
        }
        const totals = emptyTotals();
        for (const line of readFileSync(path, "utf8").split("\n")) {
            try {
                const entry: unknown = JSON.parse(line);
                if (isSpendEntry(entry)) {
                    addTotals(totals, entry);
                }
            } catch {
                // An interrupted append may leave a partial final line; completed records remain usable.
            }
        }
        this.files.set(file, { size, totals });
        return totals;
    }

    private loadLegacy(file: string): Ledger {
        try {
            return JSON.parse(readFileSync(file, "utf8")) as Ledger;
        } catch {
            // Old totals are read-only; a missing or unreadable legacy file never overwrites existing history.
            return {};
        }
    }

    private prune(): void {
        const cutoff = day(new Date(this.now().getTime() - RETENTION_DAYS * 86_400_000));
        for (const file of readdirSync(this.eventsDir)) {
            if (file.endsWith(".jsonl") && file.slice(0, 10) < cutoff) {
                rmSync(join(this.eventsDir, file), { force: true });
            }
        }
    }
}

function isSpendEntry(value: unknown): value is SpendTotals {
    if (!value || typeof value !== "object") {
        return false;
    }
    const entry = value as Record<string, unknown>;
    return (
        typeof entry.model === "string" &&
        [
            "charsBilled",
            "costUsd",
            "requests",
            "cacheHits",
        ].every((key) => typeof entry[key] === "number" && Number.isFinite(entry[key]) && entry[key] >= 0)
    );
}

/** Estimated cost in USD of `charsBilled` characters on `model`, at the configured price per million. */
export function costUsd(charsBilled: number, model: string, pricePerMillion: Record<string, number>): number {
    return (charsBilled * (pricePerMillion[model] ?? 0)) / 1_000_000;
}

function day(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function emptyTotals(): SpendTotals {
    return { charsBilled: 0, costUsd: 0, requests: 0, cacheHits: 0 };
}

function addTotals(into: SpendTotals, add: SpendTotals): void {
    into.charsBilled += add.charsBilled;
    into.costUsd += add.costUsd;
    into.requests += add.requests;
    into.cacheHits += add.cacheHits;
}
