// The reading panel is a view: it shows the document and which unit plays, and sends the reader's
// commands to the extension, which runs playback. When ffplay is not available, the extension also
// asks this panel to play each unit's audio and waits for its `ended` message.
(function () {
    const vscode = acquireVsCodeApi();
    /** How much the − and + buttons and keys change the speed; the slider's range and step come from the extension. */
    const SPEED_STEP = 0.1;

    const doc = document.getElementById("doc");
    const toolbar = document.getElementById("toolbar");
    const playButton = document.getElementById("play");
    const speedSelect = document.getElementById("speed");
    const customSpeed = document.getElementById("customSpeed");
    const speedSlider = document.getElementById("speedSlider");
    const languageSelect = document.getElementById("language");
    const voiceSelect = document.getElementById("voice");
    const modelSelect = document.getElementById("model");
    const spendLabel = document.getElementById("spend");
    const statusLabel = document.getElementById("status");
    const audio = new Audio();

    let speed = 1.5;
    let units = [];
    let currentId;
    let state = "stopped";
    let audioToken = 0;
    let audioUrl;

    const post = (message) => vscode.postMessage(message);
    const indexOf = (id) => units.findIndex((u) => u.id === id);

    function status(text) {
        statusLabel.textContent = text || "";
    }

    function setState(next) {
        state = next;
        const action = state === "playing" ? "Pause" : state === "paused" ? "Resume" : "Play";
        playButton.dataset.state = state;
        playButton.setAttribute("aria-label", action);
        playButton.title = `${action} (Space)`;
        if (state === "stopped") {
            status("");
        }
    }

    function setRate() {
        audio.defaultPlaybackRate = speed;
        audio.playbackRate = speed;
    }

    function showSpeed() {
        customSpeed.textContent = `${speed.toFixed(2)}×`;
        const value = String(speed);
        speedSelect.value = Array.from(speedSelect.options).some((option) => option.value === value) ? value : "custom";
        speedSlider.setAttribute("aria-valuetext", `${speed.toFixed(2)} times normal speed`);
    }

    /**
     * Sets the speed through the slider, which clamps it to its range and snaps it to its step, and applies it
     * to the panel's audio at once. `remember` sends it to the extension, which keeps it for every panel.
     */
    function setSpeed(value, remember) {
        speedSlider.value = String(value);
        const next = Number(speedSlider.value);
        if (next !== speed) {
            speed = next;
            setRate();
        }
        showSpeed();
        if (remember) {
            post({ type: "speed", value: speed });
        }
    }

    function showSpend(spend) {
        spendLabel.textContent = `Session $${spend.session.toFixed(4)} · Month $${spend.month.toFixed(2)}`;
    }

    function fillSelect(select, entries, value) {
        select.replaceChildren(
            ...entries.map(
                ([
                    optionValue,
                    text,
                    title,
                ]) => {
                    const option = new Option(text, optionValue);
                    option.title = title || "";
                    return option;
                },
            ),
        );
        select.value = value;
    }

    function highlight() {
        doc.querySelectorAll(".playing").forEach((el) => el.classList.remove("playing"));
        const el = currentId && doc.querySelector(`[data-u="${currentId}"]`);
        if (!el) {
            return;
        }
        el.classList.add("playing");
        const rect = el.getBoundingClientRect();
        if (rect.top < toolbar.getBoundingClientRect().bottom + 12 || rect.bottom > window.innerHeight - 40) {
            el.scrollIntoView({ block: "center", behavior: "smooth" });
        }
    }

    function start(id) {
        if (id) {
            post({ type: "start", id });
        }
    }

    function reveal(id) {
        const unit = units[indexOf(id)];
        if (unit) {
            post({ type: "reveal", line: unit.line });
        }
    }

    doc.addEventListener("click", (event) => {
        const el = event.target.closest("[data-u]");
        if (el && !event.target.closest("a")) {
            start(el.dataset.u);
        }
    });
    doc.addEventListener("dblclick", (event) => reveal(event.target.closest("[data-u]")?.dataset.u));

    playButton.addEventListener("click", () => {
        if (state === "playing") {
            post({ type: "pause" });
        } else if (state === "paused") {
            post({ type: "resume" });
        } else {
            start(currentId || units[0]?.id);
        }
    });
    document.getElementById("slower").addEventListener("click", () => setSpeed(speed - SPEED_STEP, true));
    document.getElementById("faster").addEventListener("click", () => setSpeed(speed + SPEED_STEP, true));
    speedSelect.addEventListener("change", () => {
        setSpeed(Number(speedSelect.value), true);
        speedSelect.blur();
    });
    // While dragging, only the label and the panel's audio follow; the extension hears the final value.
    speedSlider.addEventListener("input", () => setSpeed(Number(speedSlider.value), false));
    speedSlider.addEventListener("change", () => {
        setSpeed(Number(speedSlider.value), true);
        // Give the keyboard back to the reader: Space, arrows and +/− would otherwise drive the slider.
        speedSlider.blur();
    });
    languageSelect.addEventListener("change", () => post({ type: "choose", language: languageSelect.value, voice: "" }));
    voiceSelect.addEventListener("change", () => post({ type: "choose", language: languageSelect.value, voice: voiceSelect.value }));
    modelSelect.addEventListener("change", () => post({ type: "model", value: modelSelect.value }));

    document.addEventListener("keydown", (event) => {
        if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) {
            return;
        }
        const i = indexOf(currentId);
        if (event.key === " ") {
            event.preventDefault();
            playButton.click();
        } else if (event.key === "ArrowRight" && i + 1 < units.length) {
            start(units[i + 1].id);
        } else if (event.key === "ArrowLeft" && i > 0) {
            start(units[i - 1].id);
        } else if (event.key === "+" || event.key === "=") {
            setSpeed(speed + SPEED_STEP, true);
        } else if (event.key === "-") {
            setSpeed(speed - SPEED_STEP, true);
        } else if (event.key.toLowerCase() === "e") {
            reveal(currentId);
        }
    });

    // Audio element output: used only when the extension sends `play`.
    audio.addEventListener("ended", () => post({ type: "ended", token: audioToken }));
    function playAudio(token, data, paused) {
        if (audioUrl) {
            URL.revokeObjectURL(audioUrl);
        }
        audioToken = token;
        audioUrl = URL.createObjectURL(new Blob([data], { type: "audio/mpeg" }));
        audio.src = audioUrl;
        setRate();
        if (!paused) {
            audio.play().catch((error) => post({ type: "playError", token, message: error.message }));
        }
    }

    window.addEventListener("message", ({ data }) => {
        switch (data.type) {
            case "render":
                setSpeed(data.speed, false);
                doc.innerHTML = data.html;
                units = data.units;
                highlight();
                fillSelect(
                    languageSelect,
                    Object.entries(data.languages).map(
                        ([
                            code,
                            name,
                        ]) => [
                            code,
                            name,
                        ],
                    ),
                    data.choice.language,
                );
                fillSelect(
                    modelSelect,
                    Object.entries(data.models).map(
                        ([
                            id,
                            name,
                        ]) => [
                            id,
                            name,
                        ],
                    ),
                    data.model,
                );
                showSpend(data.spend);
                break;
            case "voices":
                fillSelect(
                    voiceSelect,
                    data.voices.map((v) => [
                        v.voiceId,
                        v.displayName,
                        v.description,
                    ]),
                    data.choice.voice,
                );
                languageSelect.value = data.choice.language;
                break;
            case "playing":
                currentId = data.id;
                status("");
                highlight();
                break;
            case "waiting":
                status("Preparing audio…");
                break;
            case "state":
                setState(data.state);
                break;
            case "spend":
                showSpend(data.spend);
                break;
            case "play":
                playAudio(data.token, data.data, data.paused);
                break;
            case "pauseAudio":
                audio.pause();
                break;
            case "resumeAudio":
                audio.play().catch((error) => post({ type: "playError", token: audioToken, message: error.message }));
                break;
            case "stopAudio":
                audioToken = 0;
                audio.pause();
                break;
        }
    });

    post({ type: "ready" });
})();
