// The reading panel is a view: it shows the document and which unit plays, and sends the reader's
// commands to the extension, which runs playback. When ffplay is not available, the extension also
// asks this panel to play each unit's audio and waits for its `ended` message.
(function () {
    const vscode = acquireVsCodeApi();
    const MIN_SPEED = 0.75;
    const MAX_SPEED = 3;

    const doc = document.getElementById("doc");
    const playButton = document.getElementById("play");
    const speedLabel = document.getElementById("speed");
    const speedSlider = document.getElementById("speedSlider");
    const languageSelect = document.getElementById("language");
    const voiceSelect = document.getElementById("voice");
    const modelSelect = document.getElementById("model");
    const spendLabel = document.getElementById("spend");
    const statusLabel = document.getElementById("status");
    const audio = new Audio();

    let currentSpeed = Number((vscode.getState() || {}).speed) || 1.5;
    let units = [];
    let currentId;
    let state = "stopped";
    let audioToken = 0;
    let audioUrl;

    const speed = () => currentSpeed;
    const post = (message) => vscode.postMessage(message);
    const indexOf = (id) => units.findIndex((u) => u.id === id);

    function status(text) {
        statusLabel.textContent = text || "";
    }

    function setState(next) {
        state = next;
        playButton.textContent = state === "playing" ? "⏸" : "▶";
        if (state === "stopped") {
            status("");
        }
    }

    function setRate() {
        audio.defaultPlaybackRate = speed();
        audio.playbackRate = speed();
    }

    function showSpeed() {
        speedLabel.textContent = `${currentSpeed.toFixed(2)}×`;
        speedSlider.value = String(currentSpeed);
        vscode.setState({ speed: currentSpeed });
    }

    /** Sets the speed, rounded to 0.05 within the allowed range, and tells the extension. */
    function setSpeed(value) {
        currentSpeed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(value * 20) / 20));
        showSpeed();
        post({ type: "speed", value: currentSpeed });
    }

    function showSpend(spend) {
        spendLabel.textContent = `$${spend.session.toFixed(4)} · $${spend.month.toFixed(2)}/month`;
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
        if (rect.top < 60 || rect.bottom > window.innerHeight - 40) {
            el.scrollIntoView({ block: "center", behavior: "smooth" });
        }
    }

    function start(id) {
        if (id) {
            post({ type: "start", id, speed: speed() });
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
    document.getElementById("slower").addEventListener("click", () => setSpeed(currentSpeed - 0.1));
    document.getElementById("faster").addEventListener("click", () => setSpeed(currentSpeed + 0.1));
    speedSlider.addEventListener("input", () => setSpeed(Number(speedSlider.value)));
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
            setSpeed(currentSpeed + 0.1);
        } else if (event.key === "-") {
            setSpeed(currentSpeed - 0.1);
        } else if (event.key.toLowerCase() === "e") {
            reveal(currentId);
        }
    });

    // Audio element output: used only when the extension sends `play`.
    audio.addEventListener("ended", () => post({ type: "ended", token: audioToken }));
    function playAudio(token, data) {
        if (audioUrl) {
            URL.revokeObjectURL(audioUrl);
        }
        audioToken = token;
        audioUrl = URL.createObjectURL(new Blob([data], { type: "audio/mpeg" }));
        audio.src = audioUrl;
        setRate();
        audio.play().catch((error) => post({ type: "playError", token, message: error.message }));
    }

    window.addEventListener("message", ({ data }) => {
        switch (data.type) {
            case "render":
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
                status("…");
                break;
            case "state":
                setState(data.state);
                break;
            case "spend":
                showSpend(data.spend);
                break;
            case "play":
                playAudio(data.token, data.data);
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
            case "speed":
                setRate();
                break;
        }
    });

    showSpeed();
    post({ type: "ready" });
})();
