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
        const month = day(this.now()).slice(0, 7);
        const total = emptyTotals();
        for (const [
            date,
            models,
        ] of Object.entries(this.ledger)) {
            if (date.startsWith(month)) {
                for (const t of Object.values(models)) {
                    addTotals(total, t);
                }
            }
        }
        return total;
    }

    private addSpend(model: string, event: { charsBilled: number; costUsd: number; cacheHit: boolean }): void {
        const delta: SpendTotals = { charsBilled: event.charsBilled, costUsd: event.costUsd, requests: event.cacheHit ? 0 : 1, cacheHits: event.cacheHit ? 1 : 0 };
        const today = (this.ledger[day(this.now())] ??= {});
        addTotals((today[model] ??= emptyTotals()), delta);
        addTotals(this.session, delta);
        writeFileSync(this.ledgerFile, JSON.stringify(this.ledger, null, 1));
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
