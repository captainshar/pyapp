/* Captions kiosk.
   One job: open the page, see what people are saying, in colour-and-shape
   coded blocks per speaker. No menus, no accounts, nothing saved. */

const SPEAKER_SLOTS = 6;      // matches --speaker-0..5 and #shape-0..5 in CSS/HTML
const MAX_BLOCKS = 40;        // older blocks scroll off and are dropped
const MERGE_WINDOW_MS = 8000; // same speaker within this window keeps one block
const MERGE_MAX_CHARS = 420;  // ...but a monologue still breaks into readable blocks
const SIZES = [32, 40, 48, 60, 72, 88, 104];
const RECONNECT_MS = 1500;

const params = new URLSearchParams(location.search);
const options = {
  // E-paper screens repaint far too slowly for word-by-word captions. This mode
  // trades the live feel for whole finished lines, black on white, no animation.
  eink: params.get("eink") === "1",
  // The browser's cleanup (noise suppression, AGC, echo cancellation) is tuned
  // for phone calls, not for recognisers. It smears the transients an acoustic
  // model reads, so raw audio is the default and ?dsp=on puts it back for an
  // A/B in the room that actually matters.
  dsp: params.get("dsp") === "on",
};

const els = {
  body: document.body,
  captions: document.getElementById("captions"),
  statusText: document.getElementById("statusText"),
  levelFill: document.getElementById("levelFill"),
  hint: document.getElementById("hint"),
  hintText: document.getElementById("hintText"),
  curtain: document.getElementById("curtain"),
  curtainTitle: document.getElementById("curtainTitle"),
  curtainBody: document.getElementById("curtainBody"),
  curtainButton: document.getElementById("curtainButton"),
  pause: document.getElementById("pause"),
  bigger: document.getElementById("bigger"),
  smaller: document.getElementById("smaller"),
};

const state = {
  engine: "webspeech",
  paused: false,
  stream: null,
  audioContext: null,
  node: null,
  socket: null,
  recognition: null,
  reconnectTimer: null,
  wakeLock: null,
  stopping: false,
  lastFinal: null,          // { speaker, at, said } — for merging
  interimNodes: [],
  blocks: 0,
  sizeIndex: 2,
  seenSpeakers: new Set(),
};

/* ---------- speaker identity ---------- */

// Deepgram hands out 0, 1, 2… in first-heard order, which is exactly the fixed
// assignment order we want. Past the sixth speaker we stop inventing colours
// and fall back to plain white — a seventh hue would not be tellable apart.
function speakerStyle(speaker) {
  if (speaker === null || speaker === undefined) {
    return { label: "Speaker", color: null, shape: null };
  }
  const n = Number(speaker);
  return {
    label: `Speaker ${n + 1}`,
    color: n < SPEAKER_SLOTS ? `var(--speaker-${n})` : null,
    shape: n < SPEAKER_SLOTS ? `#shape-${n}` : null,
  };
}

function buildBlock(speaker, text, interim) {
  const { label, color, shape } = speakerStyle(speaker);

  const block = document.createElement("div");
  block.className = interim ? "block interim" : "block";
  if (color) block.style.setProperty("--speaker", color);

  // A speaker is only ever named when we actually know there is more than one
  // voice; a solo talker gets clean captions with no chrome.
  if (speaker !== null && speaker !== undefined) {
    const who = document.createElement("div");
    who.className = "who";
    if (shape) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", shape);
      svg.appendChild(use);
      svg.setAttribute("aria-hidden", "true");
      who.appendChild(svg);
    }
    who.appendChild(document.createTextNode(label));
    block.appendChild(who);
  }

  const said = document.createElement("div");
  said.className = "said";
  said.textContent = text;
  block.appendChild(said);
  block.__said = said;
  block.__speaker = speaker;
  return block;
}

function noteSpeaker(speaker) {
  if (speaker === null || speaker === undefined) return;
  state.seenSpeakers.add(Number(speaker));
  // Retroactive by design: the blocks already on screen pick up their colour
  // and marker the moment a second voice makes the distinction meaningful.
  if (state.seenSpeakers.size > 1) els.body.dataset.multi = "true";
}

function clearInterim() {
  for (const node of state.interimNodes) node.remove();
  state.interimNodes = [];
}

function trim() {
  while (state.blocks > MAX_BLOCKS) {
    const first = els.captions.firstElementChild;
    if (!first) break;
    first.remove();
    state.blocks -= 1;
  }
}

function scrollToBottom() {
  els.captions.scrollTop = els.captions.scrollHeight;
}

function render(segments, isFinal) {
  // Interim results rewrite themselves several times a second. On e-paper that
  // is a smear, so those screens wait for the finished line.
  if (options.eink && !isFinal) return;

  clearInterim();

  for (const segment of segments) noteSpeaker(segment.speaker);

  if (!isFinal) {
    for (const segment of segments) {
      const block = buildBlock(segment.speaker, segment.text, true);
      els.captions.appendChild(block);
      state.interimNodes.push(block);
    }
    showHint(false);
    scrollToBottom();
    return;
  }

  for (const segment of segments) {
    const last = state.lastFinal;
    const sameSpeaker = last && last.speaker === segment.speaker;
    const recent = last && Date.now() - last.at < MERGE_WINDOW_MS;

    const roomy = last && last.said.textContent.length < MERGE_MAX_CHARS;

    if (sameSpeaker && recent && roomy && last.said.isConnected) {
      last.said.textContent += " " + segment.text;
      last.at = Date.now();
    } else {
      const block = buildBlock(segment.speaker, segment.text, false);
      els.captions.appendChild(block);
      state.blocks += 1;
      state.lastFinal = { speaker: segment.speaker, at: Date.now(), said: block.__said };
    }
  }

  trim();
  showHint(false);
  scrollToBottom();
}

/* ---------- chrome ---------- */

function setState(name, text) {
  els.body.dataset.state = name;
  els.statusText.textContent = text;
}

function showHint(visible, text) {
  if (text) els.hintText.textContent = text;
  els.hint.hidden = !visible || state.blocks > 0;
}

function showCurtain(title, body, buttonLabel, onClick) {
  els.curtainTitle.textContent = title;
  els.curtainBody.textContent = body;
  els.curtainButton.textContent = buttonLabel;
  els.curtainButton.onclick = onClick;
  els.curtain.hidden = false;
}

function hideCurtain() {
  els.curtain.hidden = true;
  els.curtainButton.onclick = null;
}

function applySize() {
  document.documentElement.style.setProperty("--caption-size", SIZES[state.sizeIndex] + "px");
  els.smaller.disabled = state.sizeIndex === 0;
  els.bigger.disabled = state.sizeIndex === SIZES.length - 1;
  try {
    localStorage.setItem("captionSize", String(state.sizeIndex));
  } catch (_) {
    // Private browsing or blocked storage: the size just won't be remembered.
  }
}

/* ---------- audio capture ---------- */

async function startCapture() {
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // Off by default: these are telephony features. Echo cancellation has
      // nothing to cancel here (nothing is playing), and AGC flattens exactly
      // the transients the recogniser leans on. Deepgram does its own
      // front-end work on raw audio. ?dsp=on to compare in the real room.
      echoCancellation: options.dsp,
      noiseSuppression: options.dsp,
      autoGainControl: options.dsp,
    },
  });

  state.audioContext = new AudioContext();
  await state.audioContext.audioWorklet.addModule("/pcm-worklet.js");
  if (state.audioContext.state === "suspended") await state.audioContext.resume();

  const source = state.audioContext.createMediaStreamSource(state.stream);
  state.node = new AudioWorkletNode(state.audioContext, "pcm-worklet");
  state.node.port.onmessage = ({ data }) => {
    // A bar that moves ten times a second would keep an e-paper panel busy
    // repainting instead of showing words.
    if (!options.eink) {
      els.levelFill.style.width = Math.min(100, Math.round(data.peak * 140)) + "%";
    }
    if (state.paused) return;
    const socket = state.socket;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(data.audio);
  };
  source.connect(state.node);
  // Keep the worklet pulling without putting the microphone on the speakers.
  state.node.connect(state.audioContext.destination);
}

function stopCapture() {
  if (state.node) {
    state.node.port.postMessage("stop");
    state.node.disconnect();
    state.node = null;
  }
  if (state.audioContext) {
    state.audioContext.close();
    state.audioContext = null;
  }
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
}

/* ---------- deepgram path ---------- */

function connectSocket() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/ws/transcribe`);
  socket.binaryType = "arraybuffer";
  state.socket = socket;

  socket.onopen = () => setState("listening", "Listening");

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "caption") render(message.segments, message.isFinal);
    else if (message.type === "error") fallbackToWebSpeech();
  };

  socket.onclose = () => {
    state.socket = null;
    if (state.stopping || state.engine !== "deepgram") return;
    // Networks drop. Reconnect quietly rather than making her fix anything.
    setState("error", "Reconnecting…");
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(connectSocket, RECONNECT_MS);
  };
}

/* ---------- browser speech fallback ---------- */

function webSpeechAvailable() {
  return "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
}

function startWebSpeech() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = state.language || "en-US";
  state.recognition = recognition;

  recognition.onstart = () => setState("listening", "Listening · one speaker");

  recognition.onresult = (event) => {
    let finalText = "";
    let interimText = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) finalText += result[0].transcript;
      else interimText += result[0].transcript;
    }
    // No diarization here, so every block is anonymous: plain white, no marker.
    if (interimText.trim()) render([{ speaker: null, text: interimText.trim() }], false);
    if (finalText.trim()) render([{ speaker: null, text: finalText.trim() }], true);
  };

  recognition.onerror = (event) => {
    if (event.error === "not-allowed") needPermission();
  };

  // Chrome stops this after a stretch of silence; restarting is what makes it
  // behave like an always-on captioner.
  recognition.onend = () => {
    if (state.stopping || state.paused || state.engine !== "webspeech") return;
    try {
      recognition.start();
    } catch (_) {
      setTimeout(() => { try { recognition.start(); } catch (_) {} }, 400);
    }
  };

  recognition.start();
}

function fallbackToWebSpeech() {
  state.engine = "webspeech";
  if (state.socket) { state.socket.onclose = null; state.socket.close(); state.socket = null; }
  if (!webSpeechAvailable()) {
    setState("error", "Speech service unavailable");
    showCurtain(
      "Can't hear right now",
      "The captions service isn't reachable. Check the internet connection, then try again.",
      "Try again",
      () => location.reload()
    );
    return;
  }
  startWebSpeech();
}

/* ---------- lifecycle ---------- */

function needPermission() {
  setState("error", "Microphone blocked");
  showCurtain(
    "Let this screen listen",
    "Tap the button, then choose Allow so the words can appear here.",
    "Turn on captions",
    () => { hideCurtain(); boot(); }
  );
}

async function keepAwake() {
  if (!("wakeLock" in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
  } catch (_) {
    // Not fatal — the tablet's own sleep setting takes over.
  }
}

async function boot() {
  setState("idle", "Starting…");
  showHint(true, "Waiting for someone to speak…");

  try {
    const response = await fetch("/api/config");
    const config = await response.json();
    state.engine = config.engine;
    state.language = config.language;
  } catch (_) {
    state.engine = "webspeech";
  }

  try {
    await startCapture();
  } catch (error) {
    if (error && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
      needPermission();
    } else {
      setState("error", "No microphone found");
      showCurtain(
        "No microphone",
        "This device isn't offering a microphone. Plug one in, then try again.",
        "Try again",
        () => location.reload()
      );
    }
    return;
  }

  hideCurtain();
  keepAwake();

  if (state.engine === "deepgram") connectSocket();
  else fallbackToWebSpeech();
}

/* ---------- controls ---------- */

els.pause.addEventListener("click", () => {
  state.paused = !state.paused;
  els.pause.textContent = state.paused ? "Resume" : "Pause";
  els.pause.setAttribute("aria-label", state.paused ? "Resume captions" : "Pause captions");
  if (state.paused) {
    setState("paused", "Paused");
    clearInterim();
    if (state.recognition) { try { state.recognition.stop(); } catch (_) {} }
  } else {
    setState("listening", "Listening");
    if (state.engine === "webspeech" && state.recognition) {
      try { state.recognition.start(); } catch (_) {}
    }
  }
});

els.bigger.addEventListener("click", () => {
  state.sizeIndex = Math.min(SIZES.length - 1, state.sizeIndex + 1);
  applySize();
  scrollToBottom();
});

els.smaller.addEventListener("click", () => {
  state.sizeIndex = Math.max(0, state.sizeIndex - 1);
  applySize();
  scrollToBottom();
});

// Browsers only grant fullscreen from a gesture, so take the first tap.
document.addEventListener("pointerdown", function once() {
  document.removeEventListener("pointerdown", once);
  if (document.fullscreenElement) return;
  const request = document.documentElement.requestFullscreen;
  if (request) request.call(document.documentElement).catch(() => {});
}, { once: true });

// A wake lock is released whenever the tab is backgrounded; take it again.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !state.wakeLock) keepAwake();
});

window.addEventListener("pagehide", () => {
  state.stopping = true;
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: "stop" }));
  }
  stopCapture();
});

try {
  const saved = parseInt(localStorage.getItem("captionSize"), 10);
  if (Number.isInteger(saved) && saved >= 0 && saved < SIZES.length) state.sizeIndex = saved;
} catch (_) {
  // Storage blocked; fall back to the default size.
}
if (options.eink) els.body.dataset.eink = "true";
applySize();
boot();
