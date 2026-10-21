/**
 * Prepares audio for the units the player will need next, at most `concurrency` at a time, in order.
 * A new `want` list replaces the queue: units no longer wanted are dropped, and their requests aborted.
 */
export class Scheduler {
    private queue: string[] = [];
    private readonly inFlight = new Map<string, AbortController>();
    private readonly done = new Set<string>();

    constructor(
        private readonly concurrency: () => number,
        private readonly run: (id: string, signal: AbortSignal) => Promise<void>,
    ) {}

    want(ids: string[]): void {
        const wanted = new Set(ids);
        for (const [
            id,
            controller,
        ] of this.inFlight) {
            if (!wanted.has(id)) {
                controller.abort();
                this.inFlight.delete(id);
            }
        }
        this.queue = ids.filter((id) => !this.done.has(id) && !this.inFlight.has(id));
        this.pump();
    }

    /** Forgets prepared units, e.g. after the voice or language changed. */
    reset(): void {
        for (const controller of this.inFlight.values()) {
            controller.abort();
        }
        this.inFlight.clear();
        this.queue = [];
        this.done.clear();
    }

    private pump(): void {
        while (this.inFlight.size < this.concurrency() && this.queue.length) {
            const id = this.queue.shift()!;
            const controller = new AbortController();
            this.inFlight.set(id, controller);
            this.run(id, controller.signal)
                .then(() => {
                    if (this.inFlight.get(id) === controller) {
                        this.done.add(id);
                    }
                })
                // eslint-disable-next-line no-restricted-syntax -- `run` reports its own failures to the player; the unit stays unprepared and can be wanted again.
                .catch(() => {})
                .finally(() => {
                    if (this.inFlight.get(id) === controller) {
                        this.inFlight.delete(id);
                    }
                    this.pump();
                });
        }
    }
}
