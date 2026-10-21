// Player for the reading panel. The extension host renders the document and prepares audio;
// this script plays it unit by unit, highlights the current unit and reports timings.
(function () {
    const vscode = acquireVsCodeApi();
    const LOOKAHEAD = window.READER.lookahead;
    /** Silence after each kind of unit at 1×, in milliseconds; divided by the speed. */
    const PAUSE_MS = { heading: 650, sentence: 280, row: 200 };
    const SPEEDS = [
        1,
        1.25,
        1.5,
        1.75,
        2,
        2.25,
        2.5,
    ];

    const doc = document.getElementById("doc");
    const playButton = document.getElementById("play");
    const speedLabel = document.getElementById("speed");
    const languageSelect = document.getElementById("language");
    const voiceSelect = document.getElementById("voice");
    const modelSelect = document.getElementById("model");
    const spendLabel = document.getElementById("spend");
    const statusLabel = document.getElementById("status");
    const audio = new Audio();

    const saved = vscode.getState() || {};
    let units = [];
    let index = -1;
    let playing = false;
    let speedIndex = saved.speedIndex ?? 2;
    let audioById = new Map();
    let waitingSince = 0;
    let clickedAt = 0;
    let pauseTimer = 0;
    let stalls = 0;
    let played = 0;
    /** True when the extension plays audio with ffplay; the panel then only sends commands and shows progress. */
    let native = false;
    let nativePaused = false;

    const speed = () => SPEEDS[speedIndex];

    function post(message) {
        vscode.postMessage(message);
    }

    function telemetry(event) {
        post({ type: "telemetry", event });
    }

    function status(text) {
        statusLabel.textContent = text || "";
    }

    function showSpeed() {
        speedLabel.textContent = `${speed().toFixed(2).replace(/0$/, "")}×`;
        // Loading a new source resets playbackRate to defaultPlaybackRate, so set both.
        audio.defaultPlaybackRate = speed();
        audio.playbackRate = speed();
        vscode.setState({ speedIndex });
    }

    function showSpend(spend) {
        if (spend) {
            spendLabel.textContent = `$${spend.session.toFixed(4)} · $${spend.month.toFixed(2)}/month`;
        }
    }

    function element(id) {
        return doc.querySelector(`[data-u="${id}"]`);
    }

    function highlight() {
        doc.querySelectorAll(".playing").forEach((el) => el.classList.remove("playing"));
        const unit = units[index];
        const el = unit && element(unit.id);
        if (!el) {
            return;
        }
        el.classList.add("playing");
        const rect = el.getBoundingClientRect();
        if (rect.top < 60 || rect.bottom > window.innerHeight - 40) {
            el.scrollIntoView({ block: "center", behavior: "smooth" });
        }
    }

    function want() {
        if (index >= 0) {
            post({ type: "want", ids: units.slice(index, index + LOOKAHEAD + 1).map((u) => u.id) });
        }
    }

    function start(i) {
        if (native) {
            index = i;
            playing = true;
            nativePaused = false;
            playButton.textContent = "⏸";
            highlight();
            post({ type: "start", id: units[i].id, speed: speed() });
            return;
        }
        clearTimeout(pauseTimer);
        audio.pause();
        index = i;
        playing = true;
        clickedAt = performance.now();
        playButton.textContent = "⏸";
        want();
        playCurrent();
    }

    function playCurrent() {
        const unit = units[index];
        if (!unit) {
            stop();
            return;
        }
        highlight();
        const uri = audioById.get(unit.id);
        if (!uri) {
            waitingSince = waitingSince || performance.now();
            status("…");
            return;
        }
        if (clickedAt) {
            telemetry({ type: "play_start", ms: Math.round(performance.now() - clickedAt), cacheHit: !waitingSince, speed: speed() });
            clickedAt = 0;
        } else if (waitingSince) {
            stalls++;
            telemetry({ type: "stall", waitMs: Math.round(performance.now() - waitingSince), speed: speed() });
        }
        waitingSince = 0;
        status("");
        audio.src = uri;
        audio.defaultPlaybackRate = speed();
        audio.playbackRate = speed();
        audio.play().catch((error) => {
            pause();
            post({ type: "playbackError", message: error.message });
        });
    }

    function next() {
        played++;
        index++;
        want();
        playCurrent();
    }

    function pause() {
        if (native && playing) {
            nativePaused = true;
            post({ type: "pause" });
        }
        playing = false;
        clearTimeout(pauseTimer);
        audio.pause();
        playButton.textContent = "▶";
    }

    function stop() {
        if (played) {
            telemetry({ type: "session_end", unitsPlayed: played, stalls, speed: speed() });
        }
        pause();
        played = 0;
        stalls = 0;
    }

    audio.addEventListener("ended", () => {
        const unit = units[index];
        pauseTimer = setTimeout(next, (PAUSE_MS[unit?.kind] ?? 250) / speed());
    });

    doc.addEventListener("click", (event) => {
        const el = event.target.closest("[data-u]");
        if (!el || event.target.closest("a")) {
            return;
        }
        const i = units.findIndex((u) => u.id === el.dataset.u);
        if (i >= 0) {
            start(i);
        }
    });

    doc.addEventListener("dblclick", (event) => {
        const el = event.target.closest("[data-u]");
        const unit = el && units.find((u) => u.id === el.dataset.u);
        if (unit) {
            post({ type: "reveal", line: unit.line });
        }
    });

    playButton.addEventListener("click", () => {
        if (playing) {
            pause();
        } else if (native && nativePaused) {
            nativePaused = false;
            playing = true;
            playButton.textContent = "⏸";
            post({ type: "resume" });
        } else {
            start(Math.max(index, 0));
        }
    });
    document.getElementById("slower").addEventListener("click", () => changeSpeed(-1));
    document.getElementById("faster").addEventListener("click", () => changeSpeed(1));

    function changeSpeed(delta) {
        speedIndex = Math.min(SPEEDS.length - 1, Math.max(0, speedIndex + delta));
        showSpeed();
        if (native) {
            post({ type: "speed", value: speed() });
        }
    }

    languageSelect.addEventListener("change", () => post({ type: "choose", language: languageSelect.value, voice: "" }));
    voiceSelect.addEventListener("change", () => post({ type: "choose", language: languageSelect.value, voice: voiceSelect.value }));
    modelSelect.addEventListener("change", () => post({ type: "model", value: modelSelect.value }));

    document.addEventListener("keydown", (event) => {
        if (event.target instanceof HTMLSelectElement) {
            return;
        }
        if (event.key === " ") {
            event.preventDefault();
            playButton.click();
        } else if (event.key === "ArrowRight" && index + 1 < units.length) {
            start(index + 1);
        } else if (event.key === "ArrowLeft" && index > 0) {
            start(index - 1);
        } else if (event.key === "+" || event.key === "=") {
            changeSpeed(1);
        } else if (event.key === "-") {
            changeSpeed(-1);
        } else if (event.key.toLowerCase() === "e" && units[index]) {
            post({ type: "reveal", line: units[index].line });
        }
    });

    window.addEventListener("message", ({ data }) => {
        switch (data.type) {
            case "render": {
                const current = units[index];
                doc.innerHTML = data.html;
                units = data.units;
                native = data.native;
                modelSelect.value = data.model;
                if (current) {
                    const same = units.findIndex((u) => u.id === current.id);
                    index = same >= 0 ? same : units.findIndex((u) => u.line >= current.line);
                    if (same < 0) {
                        pause();
                    }
                    highlight();
                }
                languageSelect.innerHTML = data.languages
                    .map(
                        ([
                            code,
                            name,
                        ]) => `<option value="${code}">${name}</option>`,
                    )
                    .join("");
                languageSelect.value = data.choice.language;
                showSpend(data.spend);
                break;
            }
            case "voices":
                voiceSelect.innerHTML = data.voices.map((v) => `<option value="${v.voiceId}" title="${v.description.replace(/"/g, "&quot;")}">${v.displayName}</option>`).join("");
                voiceSelect.value = data.choice.voice;
                languageSelect.value = data.choice.language;
                break;
            case "reset":
                pause();
                audioById.forEach((url) => URL.revokeObjectURL(url));
                audioById = new Map();
                break;
            case "audio":
                if (!audioById.has(data.id)) {
                    audioById.set(data.id, URL.createObjectURL(new Blob([data.data], { type: "audio/mpeg" })));
                }
                showSpend(data.spend);
                if (!native && playing && units[index]?.id === data.id && audio.paused) {
                    playCurrent();
                }
                break;
            case "playing":
                index = units.findIndex((u) => u.id === data.id);
                status("");
                highlight();
                break;
            case "waiting":
                status("…");
                break;
            case "stopped":
                playing = false;
                nativePaused = false;
                status("");
                playButton.textContent = "▶";
                break;
            case "audioError":
                // The extension shows the error as a VS Code notification; the player only stops.
                if (playing && units[index]?.id === data.id) {
                    status("");
                    pause();
                }
                break;
        }
    });

    showSpeed();
    post({ type: "ready" });
})();
