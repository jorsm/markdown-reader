interface Entry {
    promise: Promise<string>;
    resolve: (file: string) => void;
    reject: (error: unknown) => void;
    controller: AbortController;
    state: "queued" | "running" | "done";
}

/** Rejects the promise of a unit that is no longer wanted, so nothing waits on it forever. */
export class NotWantedError extends Error {
    constructor() {
        super("Audio no longer wanted");
        this.name = "AbortError";
    }
}

/**
 * Prepares the audio of the units the player needs next, at most `concurrency` at a time, in order.
 * Each unit has one promise of its audio file. A new `want` list replaces the queue: units no longer
 * wanted are aborted and their promises rejected; a unit that failed is retried when wanted again.
 */
export class Scheduler {
    private readonly entries = new Map<string, Entry>();

    constructor(
        private readonly concurrency: () => number,
        private readonly run: (id: string, signal: AbortSignal) => Promise<string>,
    ) {}

    want(ids: string[]): void {
        const wanted = new Set(ids);
        for (const [
            id,
            entry,
        ] of this.entries) {
            if (entry.state !== "done" && !wanted.has(id)) {
                this.drop(id, entry);
            }
        }
        for (const id of ids) {
            if (!this.entries.has(id)) {
                this.entries.set(id, newEntry());
            }
        }
        this.pump(ids);
    }

    /** The audio file of a wanted unit; rejects if preparing it fails or it stops being wanted. */
    ready(id: string): Promise<string> {
        const entry = this.entries.get(id);
        return entry ? entry.promise : Promise.reject(new NotWantedError());
    }

    isReady(id: string): boolean {
        return this.entries.get(id)?.state === "done";
    }

    /** Forgets everything, e.g. after the voice, language or model changed. */
    reset(): void {
        for (const [
            id,
            entry,
        ] of this.entries) {
            this.drop(id, entry);
        }
    }

    private drop(id: string, entry: Entry): void {
        entry.controller.abort();
        entry.reject(new NotWantedError());
        this.entries.delete(id);
    }

    private pump(order: string[] = [...this.entries.keys()]): void {
        let running = [...this.entries.values()].filter((e) => e.state === "running").length;
        for (const id of order) {
            if (running >= this.concurrency()) {
                return;
            }
            const entry = this.entries.get(id);
            if (entry?.state !== "queued") {
                continue;
            }
            entry.state = "running";
            running++;
            this.run(id, entry.controller.signal).then(
                (file) => {
                    entry.state = "done";
                    entry.resolve(file);
                    this.pump();
                },
                (error: unknown) => {
                    if (this.entries.get(id) === entry) {
                        this.entries.delete(id);
                    }
                    entry.reject(error);
                    this.pump();
                },
            );
        }
    }
}

function newEntry(): Entry {
    let resolve!: (file: string) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    // eslint-disable-next-line no-restricted-syntax -- a unit dropped before the player reached it rejects with nobody awaiting; that is expected.
    promise.catch(() => {});
    return { promise, resolve, reject, controller: new AbortController(), state: "queued" };
}
