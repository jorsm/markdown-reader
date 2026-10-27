import { readFile } from "node:fs/promises";

/** How a {@link AudioOutput.play} call ended: the audio finished, or {@link AudioOutput.stop} cut it short. */
export type PlayResult = "ended" | "stopped";

/** Where audio is heard. The reader's sequencer drives one of these and does not care which. */
export interface AudioOutput {
    /** Plays a file to its end ("ended"), or until `stop` ("stopped"); rejects if it can't play. */
    play(file: string, speed: number): Promise<PlayResult>;
    /** Pauses the unit playing now; `play` stays pending until it is resumed and ends, or is stopped. */
    pause(): void;
    /** Resumes a paused unit. */
    resume(): void;
    /** Ends the unit playing now: its `play` promise resolves "stopped". */
    stop(): void;
}

/**
 * Plays through the panel's audio element: the extension sends the bytes, the panel plays them from a
 * Blob URL and reports back when the unit ends or fails. The default output on every platform.
 */
export class WebviewOutput implements AudioOutput {
    private token = 0;
    private paused = false;
    private pending: { token: number; resolve: (result: PlayResult) => void; reject: (error: Error) => void } | undefined;

    constructor(private readonly post: (message: unknown) => Thenable<boolean>) {}

    async play(file: string, speed: number): Promise<PlayResult> {
        this.stop();
        const token = this.token;
        const data = new Uint8Array(await readFile(file));
        if (token !== this.token) {
            // Stopped while the file was read.
            return "stopped";
        }
        const done = new Promise<PlayResult>((resolve, reject) => (this.pending = { token, resolve, reject }));
        await this.post({ type: "play", token, data, speed, paused: this.paused });
        return done;
    }

    /** Called with the panel's `ended` and `playError` messages. */
    settle(token: number, error?: string): void {
        if (this.pending?.token !== token) {
            return;
        }
        const { resolve, reject } = this.pending;
        this.pending = undefined;
        if (error === undefined) {
            resolve("ended");
        } else {
            reject(new Error(`playback failed. ${error}`));
        }
    }

    /** Pauses the panel's audio element. */
    pause(): void {
        this.paused = true;
        void this.post({ type: "pauseAudio" });
    }

    /** Resumes the panel's audio element. */
    resume(): void {
        this.paused = false;
        if (this.pending) {
            void this.post({ type: "resumeAudio" });
        }
    }

    /** Ends the unit playing now: its `play` promise resolves "stopped". */
    stop(): void {
        this.token++;
        this.paused = false;
        this.pending?.resolve("stopped");
        this.pending = undefined;
        void this.post({ type: "stopAudio" });
    }
}
