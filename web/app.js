/* Captions kiosk.
   One job: open the page, see what people are saying, in colour-and-shape
   coded blocks per speaker. No menus, no accounts, nothing saved. */

const SPEAKER_SLOTS = 6;      // matches --speaker-0..5 and #shape-0..5 in CSS/HTML
const MAX_BLOCKS = 40;        // older blocks scroll off and are dropped
const MERGE_WINDOW_MS = 8000; // same speaker within this window keeps one block
const MERGE_MAX_CHARS = 420;  // ...but a monologue still breaks into readable blocks
const SIZES = [32, 40, 48, 60, 72, 88, 104];
const RECONNECT_MS = 1500;

// A feed driven far past full scale transcribes as mush. Warn only on sustained
// clipping so a single door slam doesn't trip it.
const CLIP_LEVEL = 0.985;
const CLIP_FRAMES_TO_WARN = 12;   // ~0.75s of continuous clipping
const CLIP_FRAMES_TO_CLEAR = 45;  // ~3s clean before the warning goes away

// Labels a platform gives a microphone that isn't the one built into the slab.
// Anything plugged in was plugged in deliberately, so it wins by default.
const EXTERNAL_HINTS = /usb|headset|wired|external|dock|interface|line|audio device|analog/i;
const BUILTIN_HINTS = /built-?in|internal|default|back|front|bottom|top/i;

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
  micButton: document.getElementById("micButton"),
  micName: document.getElementById("micName"),
  tooLoud: document.getElementById("tooLoud"),
  picker: document.getElementById("picker"),
  micList: document.getElementById("micList"),
  pickerClose: document.getElementById("pickerClose"),
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
  deviceId: null,        // null = let the platform pick
  pinnedDeviceId: null,  // set once she chooses by hand; auto-switching stops
  devices: [],
  clipRun: 0,
  cleanRun: 0,
  clipping: false,
  selectionHonoured: true,
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

/* ---------- microphone selection ---------- */

function micLabel(device, index) {
  // Labels are empty until permission is granted, and some platforms never
  // fill them in at all.
  return device.label || `Microphone ${index + 1}`;
}

function scoreDevice(device, index) {
  const label = micLabel(device, index);
  if (EXTERNAL_HINTS.test(label)) return 2;
  if (BUILTIN_HINTS.test(label)) return 0;
  return 1;
}

// The whole point of the plug-in-a-better-mic advice is that plugging it in has
// to be the entire interaction. So anything external wins automatically.
function preferredDevice(devices) {
  let best = null;
  let bestScore = -1;
  devices.forEach((device, index) => {
    const score = scoreDevice(device, index);
    if (score > bestScore) { best = device; bestScore = score; }
  });
  return best;
}

async function refreshDevices() {
  if (!navigator.mediaDevices.enumerateDevices) return;
  const all = await navigator.mediaDevices.enumerateDevices();
  state.devices = all.filter((d) => d.kind === "audioinput" && d.deviceId !== "communications");
  showMicName();
}

function showMicName() {
  const index = state.devices.findIndex((d) => d.deviceId === state.deviceId);
  const device = index >= 0 ? state.devices[index] : null;
  const name = device ? micLabel(device, index) : "Microphone";
  // Platform labels are verbose ("Headset Microphone (USB Audio Device)").
  // The first couple of words carry the meaning at a glance.
  els.micName.textContent = name.replace(/\s*\(.*\)\s*$/, "").slice(0, 28);
  // The browser-speech fallback opens its own capture and ignores the device we
  // picked, so offering a picker there would be a lie. Deepgram gets the audio
  // we actually chose, so it gets the control.
  els.micButton.hidden =
    state.engine !== "deepgram" || state.devices.length < 1 || !state.selectionHonoured;
}

async function switchTo(deviceId) {
  state.deviceId = deviceId;
  resetClipping();
  stopCapture();
  await startCapture();
  await refreshDevices();
}

function openPicker() {
  els.micList.replaceChildren();
  state.devices.forEach((device, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mic-option" + (device.deviceId === state.deviceId ? " current" : "");
    button.textContent = micLabel(device, index);
    button.onclick = async () => {
      // A deliberate choice outranks auto-detection from here on.
      state.pinnedDeviceId = device.deviceId;
      els.picker.hidden = true;
      await switchTo(device.deviceId);
    };
    els.micList.appendChild(button);
  });
  els.picker.hidden = false;
}

/* ---------- clipping ---------- */

function resetClipping() {
  state.clipRun = 0;
  state.cleanRun = 0;
  state.clipping = false;
  els.tooLoud.hidden = true;
}

function watchLevel(peak) {
  if (peak >= CLIP_LEVEL) {
    state.clipRun += 1;
    state.cleanRun = 0;
    if (!state.clipping && state.clipRun >= CLIP_FRAMES_TO_WARN) {
      state.clipping = true;
      els.tooLoud.hidden = false;
    }
  } else {
    state.cleanRun += 1;
    state.clipRun = 0;
    if (state.clipping && state.cleanRun >= CLIP_FRAMES_TO_CLEAR) {
      state.clipping = false;
      els.tooLoud.hidden = true;
    }
  }
}

/* ---------- audio capture ---------- */

async function openMicrophone(deviceId) {
  const audio = {
    channelCount: 1,
    // Off by default: these are telephony features. Echo cancellation has
    // nothing to cancel here (nothing is playing), and AGC flattens exactly the
    // transients the recogniser leans on. Deepgram does its own front-end work
    // on raw audio. ?dsp=on to compare in the real room.
    echoCancellation: options.dsp,
    noiseSuppression: options.dsp,
    autoGainControl: options.dsp,
  };

  if (!deviceId) return navigator.mediaDevices.getUserMedia({ audio });

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { ...audio, deviceId: { exact: deviceId } },
    });
  } catch (error) {
    // Android is the case that matters: Chrome there often exposes a single
    // "default" input and rejects or quietly ignores an exact deviceId. Android
    // routes a plugged-in USB or wired mic at the system level anyway, so the
    // unconstrained request gets the right audio. Never let a failed preference
    // cost us a working microphone.
    if (error && (error.name === "OverconstrainedError" || error.name === "NotFoundError")) {
      state.selectionHonoured = false;
      return navigator.mediaDevices.getUserMedia({ audio });
    }
    throw error;
  }
}

async function startCapture() {
  state.selectionHonoured = true;
  state.stream = await openMicrophone(state.deviceId);

  state.audioContext = new AudioContext();
  await state.audioContext.audioWorklet.addModule("/pcm-worklet.js");
  if (state.audioContext.state === "suspended") await state.audioContext.resume();

  const source = state.audioContext.createMediaStreamSource(state.stream);
  state.node = new AudioWorkletNode(state.audioContext, "pcm-worklet");
  state.node.port.onmessage = ({ data }) => {
    watchLevel(data.peak);
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

  // Report what we actually got, never what we asked for.
  const settings = state.stream.getAudioTracks()[0]?.getSettings?.() || {};
  if (settings.deviceId) {
    if (state.deviceId && settings.deviceId !== state.deviceId) state.selectionHonoured = false;
    state.deviceId = settings.deviceId;
  }
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
  await refreshDevices();

  // If something better was already plugged in before she switched it on, move
  // to it now — labels are only readable once permission has been granted.
  const preferred = preferredDevice(state.devices);
  if (preferred && preferred.deviceId !== state.deviceId && scoreDevice(preferred, 0) === 2) {
    await switchTo(preferred.deviceId);
  }

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

// Plugging a microphone in mid-service should be the whole interaction: no
// menus, no restart. Chrome fires this on hot-plug, so follow it.
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", async () => {
    if (!state.stream) return;              // not capturing yet
    if (state.pinnedDeviceId) return;       // she chose by hand; respect it
    await refreshDevices();
    const preferred = preferredDevice(state.devices);
    if (!preferred || preferred.deviceId === state.deviceId) return;
    const index = state.devices.indexOf(preferred);
    // Only follow a plug-in, never demote to the built-in mic on a stray event.
    if (scoreDevice(preferred, index) < 2) return;
    await switchTo(preferred.deviceId);
    setState("listening", "Switched microphone");
    setTimeout(() => { if (!state.paused) setState("listening", "Listening"); }, 2500);
  });
}

els.micButton.addEventListener("click", openPicker);
els.pickerClose.addEventListener("click", () => { els.picker.hidden = true; });

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
