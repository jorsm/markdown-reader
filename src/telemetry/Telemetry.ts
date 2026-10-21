import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

export interface SpendTotals {
    charsBilled: number;
    costUsd: number;
    requests: number;
    cacheHits: number;
}

type Ledger = Record<string, Record<string, SpendTotals>>;

const RETENTION_DAYS = 30;

/** Local-only JSON Lines telemetry (one file per day, kept 30 days) and a spend ledger that is never pruned. */
export class Telemetry {
    private readonly eventsDir: string;
    private readonly ledgerFile: string;
    private ledger: Ledger;
    private session: SpendTotals = emptyTotals();
    private unsaved = false;
    /** Running total of the current month, so showing spend never walks the ledger. */
    private month: { key: string; totals: SpendTotals } | undefined;

    constructor(
        storageDir: string,
        private readonly now: () => Date = () => new Date(),
    ) {
        this.eventsDir = join(storageDir, "telemetry");
        this.ledgerFile = join(storageDir, "spend.json");
        mkdirSync(this.eventsDir, { recursive: true });
        this.ledger = this.loadLedger();
        this.prune();
    }

    record(event: TelemetryEvent): void {
        const line = JSON.stringify({ at: this.now().toISOString(), ...event });
        appendFileSync(join(this.eventsDir, `${day(this.now())}.jsonl`), `${line}\n`);
        if (event.type === "synth" && !event.error) {
            this.addSpend(event.model, event);
        }
    }

    sessionSpend(): SpendTotals {
        return { ...this.session };
    }

    monthSpend(): SpendTotals {
        return { ...this.currentMonth() };
    }

    /** Writes the ledger if cache hits changed it since the last billed request. */
    flush(): void {
        if (this.unsaved) {
            this.save();
        }
    }

    /** The running total of the current month, rebuilt from the ledger only when the month changes. */
    private currentMonth(): SpendTotals {
        const key = day(this.now()).slice(0, 7);
        if (this.month?.key !== key) {
            const totals = emptyTotals();
            for (const [
                date,
                models,
            ] of Object.entries(this.ledger)) {
                if (date.startsWith(key)) {
                    Object.values(models).forEach((m) => addTotals(totals, m));
                }
            }
            this.month = { key, totals };
        }
        return this.month.totals;
    }

    private addSpend(model: string, event: { charsBilled: number; costUsd: number; cacheHit: boolean }): void {
        const delta: SpendTotals = { charsBilled: event.charsBilled, costUsd: event.costUsd, requests: event.cacheHit ? 0 : 1, cacheHits: event.cacheHit ? 1 : 0 };
        // Built before the ledger changes, so the delta is counted once.
        const month = this.currentMonth();
        const today = (this.ledger[day(this.now())] ??= {});
        addTotals((today[model] ??= emptyTotals()), delta);
        addTotals(this.session, delta);
        addTotals(month, delta);
        // A cache hit only bumps a counter: it is saved with the next billed request, or by flush().
        if (event.cacheHit) {
            this.unsaved = true;
        } else {
            this.save();
        }
    }

    private save(): void {
        writeFileSync(this.ledgerFile, JSON.stringify(this.ledger, null, 1));
        this.unsaved = false;
    }

    private loadLedger(): Ledger {
        try {
            return JSON.parse(readFileSync(this.ledgerFile, "utf8")) as Ledger;
        } catch {
            // No ledger yet (first run) or unreadable: start a new one rather than block reading.
            return {};
        }
    }

    private prune(): void {
        const cutoff = day(new Date(this.now().getTime() - RETENTION_DAYS * 86_400_000));
        for (const file of readdirSync(this.eventsDir)) {
            if (file.endsWith(".jsonl") && file.slice(0, 10) < cutoff) {
                rmSync(join(this.eventsDir, file));
            }
        }
    }
}

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
