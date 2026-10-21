import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { AudioOutput, PlayResult } from "./AudioOutput";

/**
 * Plays audio files with ffplay from the extension host. VS Code's webview can't be relied on for
 * sound: the snap build's Chromium has no PulseAudio/PipeWire output, so audio "plays" in silence.
 * Speed uses ffmpeg's atempo filter, which keeps the pitch.
 */
export class NativePlayer implements AudioOutput {
    private process: ChildProcess | undefined;
    private paused = false;

    private constructor(private readonly binary: string) {}

    /** The player, or why ffplay can't be used (not on the PATH, or it fails to run). */
    static async find(binary = "ffplay"): Promise<{ player: NativePlayer } | { error: string }> {
        return new Promise((resolve) => {
            execFile(binary, ["-version"], { env: hostEnv(), timeout: 5000 }, (error, _stdout, stderr) => resolve(error ? { error: `${error.message} ${String(stderr).trim().slice(-300)}`.trim() } : { player: new NativePlayer(binary) }));
        });
    }

    /** Starts ffplay on `file` at `speed` (atempo keeps the pitch); stops whatever was playing. */
    play(file: string, speed: number): Promise<PlayResult> {
        this.stop();
        const child = spawn(
            this.binary,
            [
                "-nodisp",
                "-autoexit",
                "-loglevel",
                "error",
                "-af",
                `atempo=${speed}`,
                file,
            ],
            {
                env: hostEnv(),
                stdio: [
                    "ignore",
                    "ignore",
                    "pipe",
                ],
            },
        );
        this.process = child;
        this.paused = false;
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
        return new Promise((resolve, reject) => {
            child.on("error", (error) => reject(new Error(`ffplay could not start: ${error.message}`)));
            child.on("exit", (code) => {
                const stoppedByUs = this.process !== child;
                if (!stoppedByUs) {
                    this.process = undefined;
                }
                if (stoppedByUs) {
                    resolve("stopped");
                } else if (code === 0) {
                    resolve("ended");
                } else {
                    reject(new Error(`ffplay exited with code ${code}: ${tail(stderr) || "no output"}`));
                }
            });
        });
    }

    /** Freezes ffplay with SIGSTOP; the audio stream stays open, so resuming is instant. */
    pause(): void {
        if (this.process && !this.paused) {
            this.process.kill("SIGSTOP");
            this.paused = true;
        }
    }

    /** Thaws ffplay with SIGCONT. */
    resume(): void {
        if (this.process && this.paused) {
            this.process.kill("SIGCONT");
            this.paused = false;
        }
    }

    /** Ends ffplay; its `play` promise resolves "stopped". */
    stop(): void {
        const child = this.process;
        if (!child) {
            return;
        }
        this.process = undefined;
        // A paused (SIGSTOP) process gets SIGKILL: SIGCONT first would let a fragment of audio out.
        child.kill(this.paused ? "SIGKILL" : "SIGTERM");
        this.paused = false;
    }
}

/** The host environment without library overrides a sandboxed VS Code (snap) may set, which break host binaries. */
function hostEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.LD_LIBRARY_PATH;
    delete env.LD_PRELOAD;
    return env;
}

function tail(output: string): string {
    return output.trim().slice(-300);
}
