const $ = id => document.getElementById(id);
const clamp = (n, min, max) => Math.max(min, Math.min(max, Number(n) || 0));
const uid = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

const state = {
  projectName: "Koilof Project", audioFile: null, audioUrl: "", baseDuration: 30, duration: 30, currentTime: 0, playing: false,
  audioDuration: 0, audioStart: 0, audioEnd: 30, audioGain: .85, audioFadeIn: 0, audioFadeOut: 0,
  width: 1080, height: 1920, pxPerSec: 42, textClips: [], backgrounds: [], audioClips: [],
  selected: null, history: [], future: [], activeJob: null, pollTimer: null, previewBgId: null, previewAudioClipId: null, lastTick: 0,
  tool: "select", clipboard: null, contextTarget: null,
};

const els = {
  audio: $("previewAudio"), audioInput: $("audioInput"), videoInput: $("videoInput"), audioName: $("audioName"),
  bgInput: $("backgroundInput"), mediaBin: $("mediaBin"), lyrics: $("lyricsText"),
  previewFrame: $("previewFrame"), previewText: $("previewText"), previewImage: $("previewBgImage"),
  previewVideo: $("previewBgVideo"), previewFallback: $("previewFallback"),
  previewRange: $("previewRange"), previewToggle: $("previewToggle"),
  currentTime: $("currentTimeLabel"), durationLabel: $("durationLabel"),
  timelineViewport: $("timelineViewport"), timelineContent: $("timelineContent"),
  ruler: $("timelineRuler"), textTrack: $("textTrack"), backgroundTrack: $("backgroundTrack"),
  audioTrack: $("audioTrack"), audioTrackName: $("audioTrackName"), waveform: $("waveformCanvas"),
  audioClip: $("audioClip"),
  playhead: $("playhead"), projectInspector: $("projectInspector"), textInspector: $("textInspector"),
  backgroundInspector: $("backgroundInspector"), audioInspector: $("audioInspector"), inspectorHeading: $("inspectorHeading"),
  selectionHint: $("selectionHint"), toast: $("toast"), exportDialog: $("exportDialog"),
  newProjectDialog: $("newProjectDialog"), settingsDialog: $("settingsDialog"), helpDialog: $("helpDialog"),
  contextMenu: $("contextMenu"),
};

function formatTime(value, precise = false) {
  const total = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  const hundredths = Math.floor((total % 1) * 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${precise ? `.${String(hundredths).padStart(2, "0")}` : ""}`;
}

function showToast(text) {
  els.toast.textContent = text;
  els.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 2200);
}

function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function cloneEditableState() {
  return {
    projectName: state.projectName,
    baseDuration: state.baseDuration,
    duration: state.duration,
    audioStart: state.audioStart,
    audioEnd: state.audioEnd,
    audioGain: state.audioGain,
    audioFadeIn: state.audioFadeIn,
    audioFadeOut: state.audioFadeOut,
    textClips: state.textClips.map(item => ({...item})),
    backgrounds: state.backgrounds.map(item => ({...item})),
    audioClips: state.audioClips.map(item => ({...item})),
  };
}

function pushHistory() {
  state.history.push(cloneEditableState());
  if (state.history.length > 50) state.history.shift();
  state.future = [];
  updateHistoryButtons();
}

function restoreEditableState(snapshot) {
  if (!snapshot) return;
  state.projectName = snapshot.projectName ?? state.projectName;
  state.baseDuration = snapshot.baseDuration ?? state.baseDuration;
  state.duration = snapshot.duration;
  state.audioStart = snapshot.audioStart ?? state.audioStart;
  state.audioEnd = snapshot.audioEnd ?? state.audioEnd;
  state.audioGain = snapshot.audioGain ?? state.audioGain;
  state.audioFadeIn = snapshot.audioFadeIn ?? state.audioFadeIn;
  state.audioFadeOut = snapshot.audioFadeOut ?? state.audioFadeOut;
  state.textClips = snapshot.textClips.map(item => ({...item}));
  state.backgrounds = snapshot.backgrounds.map(item => ({...item}));
  state.audioClips = (snapshot.audioClips || []).map(item => ({...item}));
  state.selected = null;
  renderAll();
}

function updateHistoryButtons() {
  $("undoBtn").disabled = !state.history.length;
  $("redoBtn").disabled = !state.future.length;
}

function undo() {
  if (!state.history.length) return;
  state.future.push(cloneEditableState());
  restoreEditableState(state.history.pop());
  updateHistoryButtons();
}

function redo() {
  if (!state.future.length) return;
  state.history.push(cloneEditableState());
  restoreEditableState(state.future.pop());
  updateHistoryButtons();
}

function selectItem(type, id) {
  state.selected = id ? {type, id} : null;
  renderTimeline();
  renderInspector();
  updatePreview();
}

function setTool(tool) {
  state.tool = tool === "blade" ? "blade" : "select";
  document.querySelectorAll("[data-tool]").forEach(button => {
    button.classList.toggle("active", button.dataset.tool === state.tool);
  });
  document.body.classList.toggle("blade-mode", state.tool === "blade");
  showToast(state.tool === "blade" ? "Ножницы включены: клик по клипу разрежет его" : "Курсор включён");
}

function getSelectedClip() {
  if (!state.selected) return null;
  if (state.selected.type === "audio") {
    return state.audioClips.find(item => item.id === state.selected.id) || null;
  }
  const collection = state.selected.type === "text" ? state.textClips : state.backgrounds;
  return collection.find(item => item.id === state.selected.id) || null;
}

function collectionFor(type) {
  if (type === "audio") return state.audioClips;
  return type === "text" ? state.textClips : state.backgrounds;
}

function getClipByRef(ref) {
  if (!ref) return null;
  return collectionFor(ref.type).find(item => item.id === ref.id) || null;
}

function recalculateDuration() {
  const ends = [
    state.baseDuration || 30,
    ...state.textClips.map(item => item.end),
    ...state.backgrounds.map(item => item.end),
    ...state.audioClips.map(item => item.end),
  ];
  state.duration = Math.max(...ends);
  els.previewRange.max = state.duration;
}

function setCurrentTime(time, syncAudio = true) {
  state.currentTime = clamp(time, 0, state.duration);
  els.previewRange.value = state.currentTime;
  els.currentTime.textContent = formatTime(state.currentTime, true);
  els.playhead.style.left = `${state.currentTime * state.pxPerSec}px`;
  if (syncAudio && state.audioFile) syncAudioToTimeline();
  updatePreview();
}

function setPlaying(playing) {
  state.playing = playing;
  els.previewToggle.textContent = playing ? "Ⅱ" : "▶";
}

async function play() {
  if (state.currentTime >= state.duration - .02) setCurrentTime(0);
  state.lastTick = performance.now();
  try {
    setPlaying(true);
    if (state.audioFile) await syncAudioToTimeline();
    tick();
  } catch {
    showToast("Не удалось запустить просмотр");
  }
}

function pause() {
  els.audio.pause();
  els.previewVideo.pause();
  setPlaying(false);
}

function togglePlay() {
  state.playing ? pause() : play();
}

function tick() {
  if (!state.playing) return;
  const now = performance.now();
  const delta = Math.min(.08, Math.max(0, (now - state.lastTick) / 1000));
  state.lastTick = now;
  setCurrentTime(state.currentTime + delta, false);
  if (state.audioFile) syncAudioToTimeline();
  if (state.currentTime >= state.duration - .02) {
    pause();
    return;
  }
  requestAnimationFrame(tick);
}

function currentAudioClip() {
  return state.audioClips.find(item => state.currentTime >= item.start && state.currentTime < item.end) || null;
}

async function syncAudioToTimeline() {
  const clip = currentAudioClip();
  if (!clip || !state.audioFile) {
    state.previewAudioClipId = null;
    els.audio.pause();
    return;
  }
  const mediaTime = clip.sourceStart + (state.currentTime - clip.start);
  const needsSeek = state.previewAudioClipId !== clip.id || Math.abs((els.audio.currentTime || 0) - mediaTime) > .12;
  if (needsSeek) {
    state.previewAudioClipId = clip.id;
    els.audio.currentTime = clamp(mediaTime, clip.sourceStart, clip.sourceEnd);
  }
  updateAudioVolume(clip);
  if (state.playing && els.audio.paused) await els.audio.play();
}

function updateAudioVolume(clip = currentAudioClip()) {
  if (!clip) {
    els.audio.volume = 0;
    return;
  }
  const local = state.currentTime - clip.start;
  const duration = Math.max(.1, clip.end - clip.start);
  const fadeIn = clip.fadeIn > 0 ? clamp(local / clip.fadeIn, 0, 1) : 1;
  const fadeOut = clip.fadeOut > 0 ? clamp((duration - local) / clip.fadeOut, 0, 1) : 1;
  els.audio.volume = clamp((clip.gain ?? state.audioGain) * Math.min(fadeIn, fadeOut), 0, 1);
}

function currentTextClip() {
  return state.textClips.find(item => state.currentTime >= item.start && state.currentTime < item.end);
}

function currentBackgroundClip() {
  const matches = state.backgrounds.filter(item => state.currentTime >= item.start && state.currentTime < item.end);
  return matches.at(-1) || state.backgrounds[0] || null;
}

function renderAnimatedText(clip) {
  if (!clip) {
    els.previewText.textContent = state.textClips.length ? "" : "Добавьте текст";
    els.previewText.className = `preview-text${state.textClips.length ? " hidden" : ""}`;
    return;
  }
  const progress = clamp((state.currentTime - clip.start) / Math.max(.05, clip.end - clip.start), 0, 1);
  els.previewText.className = `preview-text anim-${clip.animation || "fade"}${state.selected?.id === clip.id ? " selected" : ""}`;
  if (clip.animation === "typewriter") {
    els.previewText.textContent = clip.text.slice(0, Math.ceil(clip.text.length * Math.min(1, progress * 2.2)));
  } else if (clip.animation === "word_fill") {
    const words = clip.text.split(/\s+/);
    const active = Math.min(words.length - 1, Math.floor(progress * words.length));
    els.previewText.innerHTML = words.map((word, index) => `<span style="opacity:${index <= active ? 1 : .28};color:${index === active ? "#ff6d29" : clip.color}">${escapeHtml(word)}</span>`).join(" ");
  } else {
    els.previewText.textContent = clip.text;
  }
  els.previewText.style.left = `${clip.x}%`;
  els.previewText.style.top = `${clip.y}%`;
  els.previewText.style.fontSize = `${Math.max(14, clip.fontSize * previewScale())}px`;
  els.previewText.style.color = clip.color;
  els.previewText.style.webkitTextStroke = `${Math.max(0, clip.stroke * previewScale())}px ${clip.strokeColor}`;
  els.previewText.style.textAlign = clip.align;
  els.previewText.style.fontWeight = clip.weight || 800;
  els.previewText.style.textTransform = clip.uppercase ? "uppercase" : "none";
}

function previewScale() {
  const rect = els.previewFrame.getBoundingClientRect();
  return Math.max(.18, rect.width / state.width);
}

function updatePreviewBackground(clip) {
  if (!clip) {
    els.previewImage.classList.remove("active");
    els.previewVideo.classList.remove("active");
    els.previewFallback.className = `preview-fallback ${$("backgroundColor").value === "#161316" ? "ember" : "mono"}`;
    state.previewBgId = null;
    return;
  }
  if (state.previewBgId !== clip.id) {
    state.previewBgId = clip.id;
    els.previewImage.classList.remove("active");
    els.previewVideo.classList.remove("active");
    if (clip.type.startsWith("video")) {
      els.previewVideo.src = clip.url;
      els.previewVideo.classList.add("active");
      els.previewVideo.play().catch(() => {});
    } else {
      els.previewImage.src = clip.url;
      els.previewImage.classList.add("active");
    }
  }
  const media = clip.type.startsWith("video") ? els.previewVideo : els.previewImage;
  media.style.filter = `blur(${clip.blur || 0}px)`;
  media.style.transform = backgroundTransform(clip);
  if (clip.type.startsWith("video") && Number.isFinite(els.previewVideo.duration)) {
    els.previewVideo.muted = !clip.includeAudio;
    els.previewVideo.volume = clamp(clip.audioGain ?? 1, 0, 1);
    const local = Math.max(0, state.currentTime - clip.start);
    if (Math.abs(els.previewVideo.currentTime - local) > .25) els.previewVideo.currentTime = local % Math.max(.1, els.previewVideo.duration);
    state.playing ? els.previewVideo.play().catch(() => {}) : els.previewVideo.pause();
  }
}

function backgroundTransform(clip) {
  const p = clamp((state.currentTime - clip.start) / Math.max(.1, clip.end - clip.start), 0, 1);
  if (clip.motion === "zoom_in") return `scale(${1 + .12 * p})`;
  if (clip.motion === "zoom_out") return `scale(${1.12 - .12 * p})`;
  if (clip.motion === "pan_left") return `scale(1.12) translateX(${4 - 8 * p}%)`;
  if (clip.motion === "pan_right") return `scale(1.12) translateX(${-4 + 8 * p}%)`;
  return "scale(1)";
}

function updatePreview() {
  renderAnimatedText(currentTextClip());
  updatePreviewBackground(currentBackgroundClip());
}

function fitCanvas() {
  const ratio = state.width / state.height;
  els.previewFrame.classList.remove("ratio-vertical", "ratio-horizontal", "ratio-square");
  els.previewFrame.classList.add(Math.abs(ratio - 1) < .05 ? "ratio-square" : ratio > 1 ? "ratio-horizontal" : "ratio-vertical");
  $("canvasInfo").textContent = `${state.width} × ${state.height}`;
}

async function setAudioFile(file) {
  if (!file) return;
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audioFile = file;
  state.audioUrl = URL.createObjectURL(file);
  els.audio.src = state.audioUrl;
  els.audioName.textContent = file.name;
  els.audioTrackName.textContent = file.name;
  await new Promise(resolve => {
    els.audio.onloadedmetadata = () => {
      state.audioDuration = Math.max(1, els.audio.duration || 30);
      state.audioStart = 0;
      state.audioEnd = state.audioDuration;
      state.baseDuration = Math.max(state.baseDuration || 30, state.audioEnd - state.audioStart);
      state.duration = state.baseDuration;
      state.audioClips = [{
        id: uid(), name: file.name, start: 0, end: state.audioDuration,
        sourceStart: 0, sourceEnd: state.audioDuration,
        gain: state.audioGain, fadeIn: state.audioFadeIn, fadeOut: state.audioFadeOut,
      }];
      els.previewRange.max = state.duration;
      els.durationLabel.textContent = formatTime(state.duration, true);
      resolve();
    };
    els.audio.onerror = resolve;
  });
  drawWaveform(file);
  if (!state.textClips.length && els.lyrics.value.trim()) createTextClips();
  normalizeBackgrounds();
  renderAll();
  showToast("Трек добавлен. Перемотка работает и во время воспроизведения");
}

function updateAudioTrim(start, end) {
  const clip = getSelectedClip();
  if (!state.audioFile || !clip || state.selected?.type !== "audio") return;
  const safeStart = clamp(start, 0, Math.max(0, state.audioDuration - .2));
  const safeEnd = clamp(end, safeStart + .2, state.audioDuration);
  const sourceLength = safeEnd - safeStart;
  clip.sourceStart = safeStart;
  clip.sourceEnd = safeEnd;
  clip.end = clip.start + sourceLength;
  state.audioStart = safeStart;
  state.audioEnd = safeEnd;
  state.duration = Math.max(state.duration, clip.end);
  state.currentTime = clamp(state.currentTime, 0, state.duration);
  els.previewRange.max = state.duration;
  normalizeBackgrounds();
  renderAll();
}

async function drawWaveform(file) {
  const canvas = els.waveform;
  const context = canvas.getContext("2d");
  try {
    const audioContext = new AudioContext();
    const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    const data = buffer.getChannelData(0);
    const width = Math.max(1000, state.duration * state.pxPerSec);
    canvas.width = width;
    canvas.height = 62;
    const step = Math.ceil(data.length / width);
    context.clearRect(0, 0, width, 62);
    context.fillStyle = "rgba(131,217,120,.72)";
    for (let x = 0; x < width; x++) {
      let min = 1, max = -1;
      const start = x * step;
      for (let i = 0; i < step; i++) {
        const value = data[start + i] || 0;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      const y = (1 + min) * 31;
      context.fillRect(x, y, 1, Math.max(1, (max - min) * 31));
    }
    audioContext.close();
  } catch {
    canvas.width = Math.max(1000, state.duration * state.pxPerSec);
    canvas.height = 62;
  }
}

function createDefaultTextClip(text, start, end) {
  return {
    id: uid(), text, start, end, x: 50, y: 50, fontSize: 76, color: "#ffffff",
    stroke: 2, strokeColor: "#000000", align: "center", animation: "fade",
    weight: 800, uppercase: false,
  };
}

function createTextClips() {
  const lines = els.lyrics.value.split(/\n+/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) {
    showToast("Вставьте текст песни");
    return;
  }
  pushHistory();
  const slot = state.duration / lines.length;
  state.textClips = lines.map((line, index) => createDefaultTextClip(line, index * slot, (index + 1) * slot));
  selectItem("text", state.textClips[0].id);
  renderAll();
  showToast(`Создано фраз: ${lines.length}`);
}

function addTextClip() {
  pushHistory();
  const start = clamp(state.currentTime, 0, Math.max(0, state.duration - 1));
  const clip = createDefaultTextClip("Новая фраза", start, Math.min(state.duration, start + 2.5));
  state.textClips.push(clip);
  selectItem("text", clip.id);
  renderAll();
}

function autoArrangeText() {
  if (!state.textClips.length) return;
  pushHistory();
  const weights = state.textClips.map(item => Math.max(4, item.text.length));
  const total = weights.reduce((a, b) => a + b, 0);
  let cursor = 0;
  state.textClips.forEach((item, index) => {
    const length = state.duration * weights[index] / total;
    item.start = cursor;
    item.end = index === state.textClips.length - 1 ? state.duration : cursor + length;
    cursor = item.end;
  });
  renderAll();
}

function addBackgroundFile(file, options = {}) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const lastEnd = state.backgrounds.reduce((max, item) => Math.max(max, item.end), 0);
  const start = options.start ?? (lastEnd < state.duration - .25 ? lastEnd : clamp(state.currentTime, 0, Math.max(0, state.duration - 2)));
  const end = options.end ?? Math.min(state.duration, start + Math.min(6, Math.max(2, state.duration / Math.max(1, state.backgrounds.length + 1))));
  const clip = {
    id: uid(), file, url, name: options.name || file.name,
    type: file.type.startsWith("video") ? "video" : "image",
    start, end: Math.max(start + .5, end), transition: "fade", motion: "zoom_in", blur: 0,
    removeMode: "none", keyColor: "#00ff00", keyStrength: 0.18,
    includeAudio: file.type.startsWith("video"), audioGain: 1,
    attribution: options.attribution || "",
  };
  state.backgrounds.push(clip);
  if (clip.type === "video") probeVideoDuration(clip, url, options);
  normalizeBackgrounds();
  selectItem("background", clip.id);
  if (!options.silent) renderAll();
  return clip;
}

function probeVideoDuration(clip, url, options = {}) {
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.src = url;
  video.onloadedmetadata = () => {
    const mediaDuration = Number.isFinite(video.duration) ? Math.max(.5, video.duration) : 0;
    if (!mediaDuration) return;
    clip.mediaDuration = mediaDuration;
    if (options.end == null) {
      const isFirstMedia = state.backgrounds.length === 1 && !state.audioFile && !state.textClips.length;
      if (isFirstMedia) state.baseDuration = Math.max(state.baseDuration || 30, Math.min(mediaDuration, 7200));
      const maxEnd = Math.max(state.baseDuration || 30, state.duration);
      clip.end = Math.min(maxEnd, clip.start + mediaDuration);
      if (clip.end <= clip.start + .15) clip.end = Math.min(maxEnd, clip.start + 5);
      renderAll();
    }
  };
}

function addBackgroundFiles(files) {
  const list = [...files].filter(Boolean);
  if (!list.length) return;
  pushHistory();
  const baseStart = clamp(state.currentTime, 0, Math.max(0, state.duration - .5));
  if (list.length === 1) {
    const clip = addBackgroundFile(list[0], {start: baseStart, silent:true});
    if (clip) selectItem("background", clip.id);
    renderAll();
    return;
  }
  const available = Math.max(.5, state.duration - baseStart);
  const slot = Math.max(.5, available / list.length);
  let lastClip = null;
  list.forEach((file, index) => {
    const start = baseStart + slot * index;
    const end = index === list.length - 1 ? state.duration : Math.min(state.duration, start + slot);
    lastClip = addBackgroundFile(file, {start, end, silent:true});
  });
  if (lastClip) selectItem("background", lastClip.id);
  renderAll();
}

function normalizeBackgrounds() {
  state.backgrounds.forEach(item => {
    item.start = clamp(item.start, 0, state.duration);
    item.end = clamp(Math.max(item.start + .1, item.end), 0, state.duration);
  });
}

async function addBuiltinBackground(name) {
  try {
    const response = await fetch(`/assets/backgrounds/${name}.jpg`);
    if (!response.ok) throw new Error();
    const blob = await response.blob();
    pushHistory();
    addBackgroundFile(new File([blob], `${name}.jpg`, {type: "image/jpeg"}), {name});
  } catch {
    showToast("Фон ещё не установлен в библиотеку");
  }
}

function renderMediaBin() {
  if (!state.backgrounds.length) {
    els.mediaBin.className = "media-grid empty-state";
    els.mediaBin.textContent = "Перетащите сюда фото или видео";
    return;
  }
  els.mediaBin.className = "media-grid";
  els.mediaBin.innerHTML = "";
  state.backgrounds.forEach(item => {
    const button = document.createElement("button");
    button.className = "media-card";
    button.innerHTML = item.type === "video"
      ? `<video src="${item.url}" muted></video><span class="media-type">VIDEO</span><small>${escapeHtml(item.name)}</small>`
      : `<img src="${item.url}" alt=""><span class="media-type">PHOTO</span><small>${escapeHtml(item.name)}</small>`;
    button.addEventListener("click", () => selectItem("background", item.id));
    button.addEventListener("dblclick", () => {
      item.start = state.currentTime;
      item.end = Math.min(state.duration, item.start + 5);
      renderAll();
    });
    els.mediaBin.appendChild(button);
  });
}

function renderRuler() {
  const width = Math.max(900, state.duration * state.pxPerSec);
  els.timelineContent.style.width = `${width}px`;
  els.ruler.innerHTML = "";
  const interval = state.pxPerSec >= 70 ? 1 : state.pxPerSec >= 35 ? 2 : 5;
  for (let second = 0; second <= state.duration; second += interval) {
    const mark = document.createElement("span");
    mark.className = "ruler-mark";
    mark.style.left = `${second * state.pxPerSec}px`;
    mark.textContent = formatTime(second);
    els.ruler.appendChild(mark);
  }
  els.waveform.style.width = `${width}px`;
}

function clipElement(item, type) {
  const element = document.createElement("div");
  element.className = `timeline-clip ${type}-clip${state.selected?.id === item.id ? " selected" : ""}`;
  element.dataset.id = item.id;
  element.dataset.type = type;
  element.style.left = `${item.start * state.pxPerSec}px`;
  element.style.width = `${Math.max(12, (item.end - item.start) * state.pxPerSec)}px`;
  if (type === "text") {
    element.innerHTML = `<span class="clip-handle left"></span><span>${escapeHtml(item.text)}</span><span class="clip-handle right"></span>`;
  } else {
    element.innerHTML = `${item.type === "video" ? `<video src="${item.url}" muted></video>` : `<img src="${item.url}" alt="">`}<span>${escapeHtml(item.name)}</span><i class="clip-handle left"></i><i class="clip-handle right"></i>`;
  }
  element.addEventListener("pointerdown", event => startClipDrag(event, item, type, element));
  element.addEventListener("contextmenu", event => {
    event.stopPropagation();
    openContextMenu(event, {type, id: item.id});
  });
  return element;
}

function renderTimeline() {
  renderRuler();
  els.textTrack.innerHTML = "";
  els.backgroundTrack.innerHTML = "";
  state.textClips.forEach(item => els.textTrack.appendChild(clipElement(item, "text")));
  state.backgrounds.forEach(item => els.backgroundTrack.appendChild(clipElement(item, "background")));
  renderAudioClip();
  els.playhead.style.left = `${state.currentTime * state.pxPerSec}px`;
}

function renderAudioClip() {
  if (!state.audioFile) {
    document.querySelectorAll(".audio-clip.generated").forEach(item => item.remove());
    els.audioClip.style.display = "block";
    els.audioClip.className = "timeline-clip audio-clip empty";
    els.audioClip.style.left = "0px";
    els.audioClip.style.width = `${Math.max(180, state.duration * state.pxPerSec)}px`;
    els.audioTrackName.textContent = "Добавьте аудио";
    return;
  }
  els.audioClip.style.display = "none";
  document.querySelectorAll(".audio-clip.generated").forEach(item => item.remove());
  state.audioClips.forEach(item => {
    const element = document.createElement("div");
    element.className = `timeline-clip audio-clip generated${state.selected?.type === "audio" && state.selected.id === item.id ? " selected" : ""}`;
    element.dataset.id = item.id;
    element.dataset.type = "audio";
    element.style.left = `${item.start * state.pxPerSec}px`;
    element.style.width = `${Math.max(28, (item.end - item.start) * state.pxPerSec)}px`;
    element.innerHTML = `<span>${escapeHtml(item.name || state.audioFile.name)} · ${formatTime(item.sourceStart)}-${formatTime(item.sourceEnd)}</span><i class="clip-handle left"></i><i class="clip-handle right"></i>`;
    element.addEventListener("pointerdown", event => startAudioDrag(event, item, element));
    element.addEventListener("contextmenu", event => {
      event.stopPropagation();
      openContextMenu(event, {type:"audio", id:item.id});
    });
    els.audioTrack.appendChild(element);
  });
  els.audioTrackName.textContent = state.audioFile.name;
}

function startAudioDrag(event, item, element) {
  if (!state.audioFile || event.button !== 0) return;
  event.stopPropagation();
  selectItem("audio", item.id);
  if (state.tool === "blade") {
    const rect = els.timelineContent.getBoundingClientRect();
    splitClipAt("audio", item.id, (event.clientX - rect.left) / state.pxPerSec);
    return;
  }
  pushHistory();
  const startX = event.clientX;
  const original = {...item};
  const handle = event.target.classList.contains("left") ? "left" : event.target.classList.contains("right") ? "right" : "move";
  element.setPointerCapture(event.pointerId);
  const move = moveEvent => {
    const delta = (moveEvent.clientX - startX) / state.pxPerSec;
    if (handle === "left") {
      item.start = clamp(original.start + delta, 0, item.end - .15);
      item.sourceStart = clamp(original.sourceStart + (item.start - original.start), 0, item.sourceEnd - .15);
    } else if (handle === "right") {
      item.end = clamp(original.end + delta, item.start + .15, state.duration);
      item.sourceEnd = clamp(original.sourceEnd + (item.end - original.end), item.sourceStart + .15, state.audioDuration);
    }
    else {
      const length = original.end - original.start;
      item.start = clamp(original.start + delta, 0, Math.max(0, state.duration - length));
      item.end = item.start + length;
    }
    element.style.left = `${item.start * state.pxPerSec}px`;
    element.style.width = `${Math.max(28, (item.end - item.start) * state.pxPerSec)}px`;
    renderInspectorValues();
  };
  const up = () => {
    element.releasePointerCapture(event.pointerId);
    element.removeEventListener("pointermove", move);
    element.removeEventListener("pointerup", up);
    recalculateDuration();
    renderAll();
  };
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", up);
}

function startClipDrag(event, item, type, element) {
  if (event.button !== 0) return;
  event.stopPropagation();
  selectItem(type, item.id);
  if (state.tool === "blade") {
    const rect = els.timelineContent.getBoundingClientRect();
    splitClipAt(type, item.id, (event.clientX - rect.left) / state.pxPerSec);
    return;
  }
  pushHistory();
  const startX = event.clientX;
  const original = {start: item.start, end: item.end};
  const handle = event.target.classList.contains("left") ? "left" : event.target.classList.contains("right") ? "right" : "move";
  element.setPointerCapture(event.pointerId);
  element.style.cursor = "grabbing";
  const move = moveEvent => {
    const delta = (moveEvent.clientX - startX) / state.pxPerSec;
    if (handle === "left") item.start = clamp(original.start + delta, 0, item.end - .15);
    else if (handle === "right") item.end = clamp(original.end + delta, item.start + .15, state.duration);
    else {
      const length = original.end - original.start;
      item.start = clamp(original.start + delta, 0, state.duration - length);
      item.end = item.start + length;
    }
    element.style.left = `${item.start * state.pxPerSec}px`;
    element.style.width = `${Math.max(12, (item.end - item.start) * state.pxPerSec)}px`;
    updatePreview();
    renderInspectorValues();
  };
  const up = () => {
    element.releasePointerCapture(event.pointerId);
    element.style.cursor = "grab";
    element.removeEventListener("pointermove", move);
    element.removeEventListener("pointerup", up);
    renderAll();
  };
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", up);
}

function seekFromTimeline(event) {
  if (event.target.closest(".timeline-clip")) return;
  const rect = els.timelineContent.getBoundingClientRect();
  setCurrentTime((event.clientX - rect.left) / state.pxPerSec);
}

function timeFromTimelineX(clientX) {
  const rect = els.timelineContent.getBoundingClientRect();
  return clamp((clientX - rect.left) / state.pxPerSec, 0, state.duration);
}

function startTimelineSeek(event) {
  if (event.button !== 0 || event.target.closest(".timeline-clip")) return;
  event.preventDefault();
  closeContextMenu();
  document.body.classList.add("scrubbing");
  els.timelineViewport.setPointerCapture(event.pointerId);
  const moveTo = moveEvent => setCurrentTime(timeFromTimelineX(moveEvent.clientX));
  const move = moveEvent => moveTo(moveEvent);
  const up = upEvent => {
    document.body.classList.remove("scrubbing");
    if (els.timelineViewport.hasPointerCapture(upEvent.pointerId)) els.timelineViewport.releasePointerCapture(upEvent.pointerId);
    els.timelineViewport.removeEventListener("pointermove", move);
    els.timelineViewport.removeEventListener("pointerup", up);
    els.timelineViewport.removeEventListener("pointercancel", up);
  };
  moveTo(event);
  els.timelineViewport.addEventListener("pointermove", move);
  els.timelineViewport.addEventListener("pointerup", up);
  els.timelineViewport.addEventListener("pointercancel", up);
}

function renderInspector() {
  [els.projectInspector, els.textInspector, els.backgroundInspector, els.audioInspector].forEach(view => view.classList.remove("active"));
  const clip = getSelectedClip();
  if (!clip) {
    els.projectInspector.classList.add("active");
    els.inspectorHeading.textContent = "Свойства проекта";
    els.selectionHint.textContent = "Выберите клип на таймлайне";
    return;
  }
  if (state.selected.type === "audio") {
    els.audioInspector.classList.add("active");
    els.inspectorHeading.textContent = "Аудиотрек";
    els.selectionHint.textContent = `${formatTime(clip.start, true)} - ${formatTime(clip.end, true)}`;
  } else if (state.selected.type === "text") {
    els.textInspector.classList.add("active");
    els.inspectorHeading.textContent = "Текстовая фраза";
    els.selectionHint.textContent = `${formatTime(clip.start, true)} – ${formatTime(clip.end, true)}`;
  } else {
    els.backgroundInspector.classList.add("active");
    els.inspectorHeading.textContent = "Фоновый клип";
    els.selectionHint.textContent = clip.name;
  }
  renderInspectorValues();
}

function renderInspectorValues() {
  const clip = getSelectedClip();
  if (!clip) return;
  if (state.selected.type === "audio") {
    $("audioInspectorName").textContent = clip.name || state.audioFile?.name || "Аудио не выбрано";
    $("audioInspectorMeta").textContent = state.audioFile ? `Файл: ${formatTime(state.audioDuration)} · участок: ${formatTime(clip.sourceStart)}-${formatTime(clip.sourceEnd)}` : "Добавьте MP3, WAV или M4A";
    $("audioGain").value = clip.gain ?? state.audioGain;
    $("audioGainOut").textContent = `${Math.round((clip.gain ?? state.audioGain) * 100)}%`;
    $("audioStart").max = state.audioDuration;
    $("audioEnd").max = state.audioDuration;
    $("audioStart").value = clip.sourceStart.toFixed(2);
    $("audioEnd").value = clip.sourceEnd.toFixed(2);
    $("audioStartOut").textContent = formatTime(clip.sourceStart, true);
    $("audioEndOut").textContent = formatTime(clip.sourceEnd, true);
    $("audioFadeIn").value = clip.fadeIn ?? 0;
    $("audioFadeOut").value = clip.fadeOut ?? 0;
    $("audioFadeInOut").textContent = `${Number(clip.fadeIn || 0).toFixed(1)}с`;
    $("audioFadeOutOut").textContent = `${Number(clip.fadeOut || 0).toFixed(1)}с`;
  } else if (state.selected.type === "text") {
    $("clipText").value = clip.text;
    $("fontSize").value = clip.fontSize;
    $("fontSizeOut").textContent = clip.fontSize;
    $("textColor").value = clip.color;
    $("strokeWidth").value = clip.stroke;
    $("strokeOut").textContent = clip.stroke;
    $("strokeColor").value = clip.strokeColor;
    $("textAlign").value = clip.align;
    $("textAnimation").value = clip.animation;
    $("textX").value = Math.round(clip.x);
    $("textY").value = Math.round(clip.y);
  } else {
    $("bgTransition").value = clip.transition;
    $("bgMotion").value = clip.motion;
    $("backgroundBlur").value = clip.blur;
    $("blurOut").textContent = clip.blur;
    $("bgRemoveMode").value = clip.removeMode || "none";
    $("bgKeyColor").value = clip.keyColor || "#00ff00";
    $("bgKeyStrength").value = clip.keyStrength ?? 0.18;
    $("keyStrengthOut").textContent = Number(clip.keyStrength ?? 0.18).toFixed(2);
    $("bgIncludeAudio").value = String(clip.includeAudio !== false);
    $("bgIncludeAudio").disabled = clip.type !== "video";
    $("bgAudioGain").value = clip.audioGain ?? 1;
    $("bgAudioGain").disabled = clip.type !== "video";
    $("bgAudioGainOut").textContent = `${Math.round((clip.audioGain ?? 1) * 100)}%`;
    $("backgroundPreviewCard").innerHTML = clip.type === "video"
      ? `<video src="${clip.url}" muted autoplay loop></video>`
      : `<img src="${clip.url}" alt="">`;
  }
}

function renderProjectInfo() {
  els.previewRange.max = state.duration;
  els.durationLabel.textContent = formatTime(state.duration, true);
  $("projectDuration").textContent = `${formatTime(state.duration)} мин`;
  $("exportDuration").textContent = formatTime(state.duration);
  $("exportResolution").textContent = `${state.width} × ${state.height}`;
  $("exportLines").textContent = state.textClips.length;
}

function renderAll() {
  recalculateDuration();
  fitCanvas();
  renderProjectInfo();
  renderMediaBin();
  renderTimeline();
  renderInspector();
  setCurrentTime(state.currentTime, false);
  $("saveState").textContent = "Есть несохранённые изменения";
}

function deleteSelected() {
  if (!state.selected) return;
  if (state.selected.type === "audio") {
    pushHistory();
    pause();
    state.audioClips = state.audioClips.filter(item => item.id !== state.selected.id);
    if (!state.audioClips.length) {
      if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
      state.audioFile = null;
      state.audioUrl = "";
      state.audioDuration = 0;
      state.audioStart = 0;
      state.audioEnd = state.duration;
      els.audio.removeAttribute("src");
    }
    state.selected = null;
    recalculateDuration();
    renderAll();
    return;
  }
  pushHistory();
  const collection = collectionFor(state.selected.type);
  const index = collection.findIndex(item => item.id === state.selected.id);
  if (index >= 0) collection.splice(index, 1);
  state.selected = null;
  renderAll();
}

function splitClipAt(type, id, time = state.currentTime) {
  const clip = getClipByRef({type, id});
  if (!clip || time <= clip.start + .15 || time >= clip.end - .15) {
    showToast("Поставьте курсор внутри выбранного клипа");
    return false;
  }
  pushHistory();
  const copy = {...clip, id: uid(), start: time};
  if (type === "audio") {
    const cutSource = clip.sourceStart + (time - clip.start);
    copy.sourceStart = cutSource;
    copy.sourceEnd = clip.sourceEnd;
    clip.sourceEnd = cutSource;
  }
  clip.end = time;
  const collection = collectionFor(type);
  collection.push(copy);
  selectItem(type, copy.id);
  renderAll();
  return true;
}

function splitSelected() {
  if (!state.selected) {
    splitAllAtCursor();
    return;
  }
  splitClipAt(state.selected.type, state.selected.id, state.currentTime);
}

function splitAllAtCursor() {
  let count = 0;
  const splitRefs = [];
  ["background", "text", "audio"].forEach(type => {
    collectionFor(type).forEach(item => {
      if (state.currentTime > item.start + .15 && state.currentTime < item.end - .15) {
        splitRefs.push({type, id: item.id});
      }
    });
  });
  if (!splitRefs.length) {
    showToast("На курсоре нет клипов для разреза");
    return;
  }
  pushHistory();
  splitRefs.forEach(ref => {
    const clip = getClipByRef(ref);
    if (!clip) return;
    const copy = {...clip, id: uid(), start: state.currentTime};
    if (ref.type === "audio") {
      const cutSource = clip.sourceStart + (state.currentTime - clip.start);
      copy.sourceStart = cutSource;
      copy.sourceEnd = clip.sourceEnd;
      clip.sourceEnd = cutSource;
    }
    clip.end = state.currentTime;
    collectionFor(ref.type).push(copy);
    count++;
  });
  renderAll();
  showToast(`Разрезано клипов: ${count}`);
}

function duplicateSelected() {
  const clip = getSelectedClip();
  if (!clip) {
    showToast("Выберите клип для дубля");
    return;
  }
  pushHistory();
  const length = clip.end - clip.start;
  const start = clamp(state.currentTime, 0, Math.max(0, state.duration - length));
  const copy = {...clip, id: uid(), start, end: start + length};
  collectionFor(state.selected.type).push(copy);
  selectItem(state.selected.type, copy.id);
  recalculateDuration();
  renderAll();
}

function copySelected() {
  const clip = getSelectedClip();
  if (!clip) return;
  state.clipboard = {type: state.selected.type, clip: {...clip}};
  showToast("Клип скопирован");
}

function pasteClipboard() {
  if (!state.clipboard) {
    showToast("Буфер пуст");
    return;
  }
  pushHistory();
  const length = state.clipboard.clip.end - state.clipboard.clip.start;
  const start = clamp(state.currentTime, 0, Math.max(0, state.duration - length));
  const copy = {...state.clipboard.clip, id: uid(), start, end: start + length};
  collectionFor(state.clipboard.type).push(copy);
  selectItem(state.clipboard.type, copy.id);
  recalculateDuration();
  renderAll();
}

function snapSelectedStartToCursor() {
  const clip = getSelectedClip();
  if (!clip) return;
  pushHistory();
  const length = clip.end - clip.start;
  clip.start = clamp(state.currentTime, 0, Math.max(0, state.duration - length));
  clip.end = clip.start + length;
  renderAll();
}

function fillSelectedGap() {
  const clip = getSelectedClip();
  if (!clip) return;
  const collection = collectionFor(state.selected.type).filter(item => item.id !== clip.id).sort((a, b) => a.start - b.start);
  const next = collection.find(item => item.start > clip.start);
  pushHistory();
  clip.end = next ? Math.max(clip.start + .15, next.start) : state.duration;
  renderAll();
}

function openContextMenu(event, target = state.selected) {
  event.preventDefault();
  const rect = els.timelineContent.getBoundingClientRect();
  const time = clamp((event.clientX - rect.left) / state.pxPerSec, 0, state.duration);
  setCurrentTime(time);
  state.contextTarget = target;
  if (target?.id) selectItem(target.type, target.id);
  els.contextMenu.classList.add("open");
  els.contextMenu.setAttribute("aria-hidden", "false");
  const menuRect = els.contextMenu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - menuRect.width - 10);
  const y = Math.min(event.clientY, window.innerHeight - menuRect.height - 10);
  els.contextMenu.style.left = `${Math.max(10, x)}px`;
  els.contextMenu.style.top = `${Math.max(10, y)}px`;
}

function closeContextMenu() {
  els.contextMenu.classList.remove("open");
  els.contextMenu.setAttribute("aria-hidden", "true");
}

function runMenuAction(action) {
  if (state.contextTarget?.id) selectItem(state.contextTarget.type, state.contextTarget.id);
  const actions = {
    split: splitSelected,
    splitAll: splitAllAtCursor,
    duplicate: duplicateSelected,
    copy: copySelected,
    paste: pasteClipboard,
    snapStart: snapSelectedStartToCursor,
    fillGap: fillSelectedGap,
    delete: deleteSelected,
  };
  actions[action]?.();
  closeContextMenu();
}

function dragPreviewText(event) {
  const clip = currentTextClip();
  if (!clip || event.button !== 0) return;
  selectItem("text", clip.id);
  pushHistory();
  els.previewText.setPointerCapture(event.pointerId);
  const move = moveEvent => {
    const rect = els.previewFrame.getBoundingClientRect();
    clip.x = clamp((moveEvent.clientX - rect.left) / rect.width * 100, 4, 96);
    clip.y = clamp((moveEvent.clientY - rect.top) / rect.height * 100, 4, 96);
    updatePreview();
    renderInspectorValues();
  };
  const up = () => {
    els.previewText.releasePointerCapture(event.pointerId);
    els.previewText.removeEventListener("pointermove", move);
    els.previewText.removeEventListener("pointerup", up);
  };
  els.previewText.addEventListener("pointermove", move);
  els.previewText.addEventListener("pointerup", up);
}

function applyTextStyle(name) {
  const clip = getSelectedClip();
  if (!clip || state.selected.type !== "text") return;
  pushHistory();
  const presets = {
    clean: {fontSize:72,color:"#ffffff",stroke:0,strokeColor:"#000000",weight:700,uppercase:false},
    bold: {fontSize:90,color:"#ffffff",stroke:3,strokeColor:"#000000",weight:900,uppercase:false},
    poster: {fontSize:100,color:"#ff6d29",stroke:1,strokeColor:"#161316",weight:900,uppercase:true},
    soft: {fontSize:68,color:"#f3ded2",stroke:0,strokeColor:"#000000",weight:600,uppercase:false},
  };
  Object.assign(clip, presets[name]);
  renderAll();
}

async function searchBackgrounds() {
  const query = $("backgroundSearch").value.trim();
  if (!query) return;
  const box = $("onlineBackgrounds");
  box.innerHTML = `<div class="tip">Ищем свободные изображения…</div>`;
  try {
    const response = await fetch(`/api/backgrounds/search?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Ошибка поиска");
    box.innerHTML = "";
    data.results.forEach(item => {
      const button = document.createElement("button");
      button.className = "online-card";
      button.innerHTML = `<img src="${item.thumbnail}" alt=""><small>${escapeHtml(item.title || "Фон")}</small>`;
      button.title = item.attribution || "";
      button.addEventListener("click", () => importOnlineBackground(item));
      box.appendChild(button);
    });
    if (!data.results.length) box.innerHTML = `<div class="tip">Ничего не найдено. Попробуйте другой запрос.</div>`;
  } catch (error) {
    box.innerHTML = `<div class="tip">${escapeHtml(error.message)}</div>`;
  }
}

async function importOnlineBackground(item) {
  showToast("Загружаем фон…");
  try {
    const response = await fetch(`/api/backgrounds/fetch?url=${encodeURIComponent(item.url)}`);
    if (!response.ok) throw new Error("Не удалось загрузить изображение");
    const blob = await response.blob();
    pushHistory();
    addBackgroundFile(new File([blob], `${item.id || "background"}.jpg`, {type: blob.type || "image/jpeg"}), {
      name: item.title || "Openverse", attribution: item.attribution || "",
    });
  } catch (error) {
    showToast(error.message);
  }
}

async function checkAi() {
  const status = $("aiStatus");
  try {
    const response = await fetch("/api/ai/status");
    const data = await response.json();
    status.className = `ai-status ${data.online ? "online" : "offline"}`;
    status.innerHTML = `<span></span>${data.online ? `Ollama подключена · ${data.model}` : "Ollama не запущена · доступны быстрые локальные инструменты"}`;
  } catch {
    status.className = "ai-status offline";
    status.innerHTML = "<span></span>ИИ недоступен";
  }
}

function addAiMessage(role, text) {
  const message = document.createElement("div");
  message.className = `ai-message ${role}`;
  message.textContent = text;
  $("aiMessages").appendChild(message);
  $("aiMessages").scrollTop = $("aiMessages").scrollHeight;
}

async function askAi(prompt) {
  const text = els.lyrics.value.trim();
  if (!text) {
    showToast("Сначала вставьте текст песни");
    return;
  }
  addAiMessage("user", prompt);
  $("sendAi").disabled = true;
  try {
    const response = await fetch("/api/ai/edit", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({prompt, text}),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "ИИ не ответил");
    els.lyrics.value = data.text.trim();
    addAiMessage("assistant", data.text.trim());
    showToast(data.local ? "Применён локальный быстрый редактор" : "ИИ обновил текст");
  } catch (error) {
    addAiMessage("assistant", error.message);
  } finally {
    $("sendAi").disabled = false;
  }
}

function projectPayload() {
  return {
    width: state.width, height: state.height, fps: Number($("fps").value),
    quality: $("quality").value, background_color: $("backgroundColor").value,
    clip_start: 0,
    clip_end: state.duration,
    audio_start: state.audioStart, audio_end: state.audioEnd, audio_gain: state.audioGain,
    audio_fade_in: state.audioFadeIn, audio_fade_out: state.audioFadeOut,
    audio_clips: state.audioClips.map(item => ({
      start:item.start,end:item.end,source_start:item.sourceStart,source_end:item.sourceEnd,
      gain:item.gain ?? 1,fade_in:item.fadeIn ?? 0,fade_out:item.fadeOut ?? 0,
    })),
    lyrics_text: state.textClips.map(item => item.text).join("\n"),
    timings: state.textClips.map(item => ({
      start:item.start,end:item.end,text:item.text,x:item.x,y:item.y,font_size:item.fontSize,
      text_color:item.color,stroke_width:item.stroke,stroke_color:item.strokeColor,
      align:item.align,text_animation:item.animation,weight:item.weight,uppercase:item.uppercase,
    })),
    background_clips: state.backgrounds.map((item, index) => ({
      file_index:index,start:item.start,end:item.end,transition:item.transition,motion:item.motion,blur:item.blur,
      remove_mode:item.removeMode || "none",key_color:item.keyColor || "#00ff00",key_strength:item.keyStrength ?? 0.18,
      include_audio:item.includeAudio !== false,audio_gain:item.audioGain ?? 1,
    })),
    preset: $("quality").value === "fast" ? "ultrafast" : $("quality").value === "best" ? "medium" : "veryfast",
    crf: $("quality").value === "fast" ? 26 : $("quality").value === "best" ? 19 : 22,
    output_name:`${state.projectName || "koilof_video"}.mp4`,
  };
}

async function generateVideo() {
  if (!state.audioFile && !state.backgrounds.length && !state.textClips.length) {
    showToast("Добавьте видео, фон, аудио или титры");
    return;
  }
  const form = new FormData();
  form.append("project", JSON.stringify(projectPayload()));
  if (state.audioFile) form.append("audio", state.audioFile, state.audioFile.name);
  state.backgrounds.forEach(item => form.append("backgrounds", item.file, item.file.name));
  setExportStatus("running", "Создаём видео…");
  $("logBox").textContent = "Загрузка проекта…";
  try {
    const response = await fetch("/api/generate", {method:"POST",body:form});
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Ошибка запуска");
    state.activeJob = data.job_id;
    pollJob();
  } catch (error) {
    setExportStatus("error", "Не удалось начать экспорт");
    $("logBox").textContent = error.message;
  }
}

function setExportStatus(type, text) {
  $("statusLine").className = `status-line ${type}`;
  $("statusLine").innerHTML = `<span></span>${escapeHtml(text)}`;
}

function pollJob() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (!state.activeJob) return;
    try {
      const response = await fetch(`/api/job/${state.activeJob}`);
      const data = await response.json();
      $("logBox").textContent = (data.logs || []).join("\n");
      $("logBox").scrollTop = $("logBox").scrollHeight;
      if (data.status === "done") {
        clearInterval(state.pollTimer);
        setExportStatus("done", "Видео готово");
        loadOutputs();
      } else if (data.status === "error") {
        clearInterval(state.pollTimer);
        setExportStatus("error", data.error || "Ошибка экспорта");
      } else if (data.status === "stopped") {
        clearInterval(state.pollTimer);
        setExportStatus("idle", "Экспорт остановлен");
      }
    } catch {
      clearInterval(state.pollTimer);
      setExportStatus("error", "Потеряна связь с сервером");
    }
  }, 900);
}

async function loadOutputs() {
  try {
    const data = await (await fetch("/api/outputs")).json();
    $("outputsBox").innerHTML = (data.files || []).map(item => `<a class="output-link" href="/output/${encodeURIComponent(item.name)}" target="_blank">${escapeHtml(item.name)}</a>`).join("");
  } catch {}
}

function saveProject() {
  const data = {
    version:2,projectName:state.projectName,width:state.width,height:state.height,baseDuration:state.baseDuration,duration:state.duration,
    audio:{start:state.audioStart,end:state.audioEnd,gain:state.audioGain,fadeIn:state.audioFadeIn,fadeOut:state.audioFadeOut},
    audioClips:state.audioClips,
    textClips:state.textClips,backgrounds:state.backgrounds.map(({file,url,...item}) => item),
    lyrics:els.lyrics.value,
  };
  localStorage.setItem("koilof-editor-v2", JSON.stringify(data));
  $("saveState").textContent = "Сохранено локально";
  showToast("Проект сохранён. Медиафайлы нужно выбрать заново после перезапуска");
}

function loadTextFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let text = String(reader.result || "");
    if (file.name.toLowerCase().endsWith(".srt")) {
      text = text.replace(/\r/g,"").split(/\n\s*\n/).map(block => block.split("\n").filter(line => !/^\d+$/.test(line.trim()) && !/-->/.test(line)).join(" ").trim()).filter(Boolean).join("\n");
    } else if (file.name.toLowerCase().endsWith(".lrc")) {
      text = text.replace(/\[[0-9:.]+\]/g,"").split("\n").map(line => line.trim()).filter(Boolean).join("\n");
    }
    els.lyrics.value = text;
  };
  reader.readAsText(file, "utf-8");
}

function syncProjectFieldsToState() {
  state.width = clamp($("newProjectWidth").value, 240, 7680);
  state.height = clamp($("newProjectHeight").value, 240, 7680);
  state.baseDuration = clamp($("newProjectDuration").value, 1, 7200);
  state.duration = state.baseDuration;
  $("fps").value = $("newProjectFps").value;
  $("quality").value = $("newProjectQuality").value;
  $("backgroundColor").value = $("newProjectBg").value;
  updateFormatButtons();
}

function updateFormatButtons() {
  document.querySelectorAll(".format-btn").forEach(button => {
    button.classList.toggle("active", Number(button.dataset.w) === state.width && Number(button.dataset.h) === state.height);
  });
}

function revokeProjectMedia() {
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.backgrounds.forEach(item => {
    if (item.url) URL.revokeObjectURL(item.url);
  });
}

function openNewProjectDialog() {
  $("projectNameInput").value = state.projectName || "Koilof Project";
  $("newProjectWidth").value = state.width;
  $("newProjectHeight").value = state.height;
  $("newProjectDuration").value = Math.round((state.baseDuration || state.duration) * 100) / 100;
  $("newProjectFps").value = $("fps").value;
  $("newProjectQuality").value = $("quality").value;
  $("newProjectBg").value = $("backgroundColor").value;
  document.querySelectorAll(".project-preset").forEach(button => {
    const matches = button.dataset.w && Number(button.dataset.w) === state.width && Number(button.dataset.h) === state.height;
    button.classList.toggle("active", Boolean(matches));
  });
  els.newProjectDialog.showModal();
}

function createNewProject() {
  pause();
  revokeProjectMedia();
  state.projectName = $("projectNameInput").value.trim() || "Koilof Project";
  state.audioFile = null;
  state.audioUrl = "";
  state.audioDuration = 0;
  state.audioStart = 0;
  state.textClips = [];
  state.backgrounds = [];
  state.audioClips = [];
  state.selected = null;
  state.history = [];
  state.future = [];
  state.currentTime = 0;
  state.previewBgId = null;
  state.previewAudioClipId = null;
  els.audio.removeAttribute("src");
  els.audioName.textContent = "Добавить трек";
  els.audioTrackName.textContent = "Добавьте аудио";
  els.lyrics.value = "";
  syncProjectFieldsToState();
  state.audioEnd = state.baseDuration;
  updateHistoryButtons();
  renderAll();
  $("saveState").textContent = state.projectName;
  els.newProjectDialog.close();
  showToast(`Создан проект: ${state.projectName}`);
}

function openSettingsDialog() {
  $("settingsFps").value = $("fps").value;
  $("settingsQuality").value = $("quality").value;
  $("settingsBg").value = $("backgroundColor").value;
  $("settingsDuration").value = Math.round((state.baseDuration || state.duration) * 100) / 100;
  els.settingsDialog.showModal();
}

function applySettings() {
  pushHistory();
  $("fps").value = $("settingsFps").value;
  $("quality").value = $("settingsQuality").value;
  $("backgroundColor").value = $("settingsBg").value;
  state.baseDuration = clamp($("settingsDuration").value, 1, 7200);
  state.duration = Math.max(state.baseDuration, ...state.textClips.map(item => item.end), ...state.backgrounds.map(item => item.end), ...state.audioClips.map(item => item.end));
  state.currentTime = clamp(state.currentTime, 0, state.duration);
  renderAll();
  els.settingsDialog.close();
  showToast("Настройки проекта обновлены");
}

function closeTopMenus(except = null) {
  document.querySelectorAll(".menu-panel").forEach(panel => {
    if (panel.id !== except) {
      panel.classList.remove("open");
      panel.setAttribute("aria-hidden", "true");
    }
  });
}

function applyBackgroundQuickAction(action) {
  const clip = getSelectedClip();
  if (!clip || state.selected?.type !== "background") {
    showToast("Выберите видео или фон на дорожке");
    return;
  }
  pushHistory();
  if (action === "bgBlur") clip.blur = clip.blur ? 0 : 16;
  if (action === "bgChroma") {
    clip.removeMode = "chroma";
    clip.keyColor = "#00ff00";
    clip.keyStrength = 0.18;
  }
  if (action === "bgLumaDark") {
    clip.removeMode = "luma_dark";
    clip.keyColor = "#000000";
    clip.keyStrength = 0.22;
  }
  renderAll();
}

function runToolAction(action) {
  const actions = {
    select: () => setTool("select"),
    blade: () => setTool("blade"),
    split: splitSelected,
    splitAll: splitAllAtCursor,
    duplicate: duplicateSelected,
    copy: copySelected,
    paste: pasteClipboard,
    addText: addTextClip,
    importVideo: () => els.videoInput.click(),
    importAudio: () => els.audioInput.click(),
    export: () => {
      renderProjectInfo();
      els.exportDialog.showModal();
    },
    bgBlur: () => applyBackgroundQuickAction("bgBlur"),
    bgChroma: () => applyBackgroundQuickAction("bgChroma"),
    bgLumaDark: () => applyBackgroundQuickAction("bgLumaDark"),
  };
  actions[action]?.();
  closeTopMenus();
}

function bindHeaderMenus() {
  $("newProjectTop").addEventListener("click", openNewProjectDialog);
  $("settingsTop").addEventListener("click", openSettingsDialog);
  $("helpTop").addEventListener("click", () => els.helpDialog.showModal());
  document.querySelectorAll("[data-menu-toggle]").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      const panel = $(button.dataset.menuToggle);
      const willOpen = !panel.classList.contains("open");
      closeTopMenus(panel.id);
      panel.classList.toggle("open", willOpen);
      panel.setAttribute("aria-hidden", String(!willOpen));
    });
  });
  document.querySelectorAll("[data-tool-action]").forEach(button => {
    button.addEventListener("click", () => runToolAction(button.dataset.toolAction));
  });
  document.querySelectorAll(".project-preset").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".project-preset").forEach(item => item.classList.toggle("active", item === button));
      if (button.dataset.w) {
        $("newProjectWidth").value = button.dataset.w;
        $("newProjectHeight").value = button.dataset.h;
      }
    });
  });
  ["newProjectWidth", "newProjectHeight"].forEach(id => {
    $(id).addEventListener("input", () => document.querySelectorAll(".project-preset").forEach(item => item.classList.remove("active")));
  });
  $("createNewProject").addEventListener("click", createNewProject);
  $("applySettings").addEventListener("click", applySettings);
  document.addEventListener("pointerdown", event => {
    if (!event.target.closest(".menu-popover")) closeTopMenus();
  });
}

function bindFileDrop(target, handler) {
  if (!target) return;
  target.addEventListener("dragover", event => {
    event.preventDefault();
    target.classList.add("drag-over");
  });
  target.addEventListener("dragleave", () => target.classList.remove("drag-over"));
  target.addEventListener("drop", event => {
    event.preventDefault();
    target.classList.remove("drag-over");
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) handler(files);
  });
}

function bindInspector() {
  const textFields = ["clipText","fontSize","textColor","strokeWidth","strokeColor","textAlign","textAnimation","textX","textY"];
  textFields.forEach(id => $(id).addEventListener("input", () => {
    const clip = getSelectedClip();
    if (!clip || state.selected.type !== "text") return;
    const map = {
      clipText:"text",fontSize:"fontSize",textColor:"color",strokeWidth:"stroke",
      strokeColor:"strokeColor",textAlign:"align",textAnimation:"animation",textX:"x",textY:"y",
    };
    const numeric = ["fontSize","strokeWidth","textX","textY"].includes(id);
    clip[map[id]] = numeric ? Number($(id).value) : $(id).value;
    if (id === "fontSize") $("fontSizeOut").textContent = $(id).value;
    if (id === "strokeWidth") $("strokeOut").textContent = $(id).value;
    updatePreview();
    renderTimeline();
  }));
  ["bgTransition","bgMotion","backgroundBlur","bgRemoveMode","bgKeyColor","bgKeyStrength","bgIncludeAudio","bgAudioGain"].forEach(id => $(id).addEventListener("input", () => {
    const clip = getSelectedClip();
    if (!clip || state.selected.type !== "background") return;
    if (id === "bgTransition") clip.transition = $(id).value;
    if (id === "bgMotion") clip.motion = $(id).value;
    if (id === "bgRemoveMode") clip.removeMode = $(id).value;
    if (id === "bgKeyColor") clip.keyColor = $(id).value;
    if (id === "bgIncludeAudio") clip.includeAudio = $(id).value === "true";
    if (id === "bgAudioGain") {
      clip.audioGain = Number($(id).value);
      $("bgAudioGainOut").textContent = `${Math.round(clip.audioGain * 100)}%`;
    }
    if (id === "bgKeyStrength") {
      clip.keyStrength = Number($(id).value);
      $("keyStrengthOut").textContent = clip.keyStrength.toFixed(2);
    }
    if (id === "backgroundBlur") {
      clip.blur = Number($(id).value);
      $("blurOut").textContent = clip.blur;
    }
    updatePreview();
  }));
  $("audioGain").addEventListener("input", () => {
    const clip = getSelectedClip();
    if (!clip || state.selected?.type !== "audio") return;
    clip.gain = Number($("audioGain").value);
    state.audioGain = clip.gain;
    $("previewVolume").value = Math.min(1, clip.gain);
    renderInspectorValues();
    updateAudioVolume();
  });
  $("audioStart").addEventListener("change", () => {
    const clip = getSelectedClip();
    if (clip && state.selected?.type === "audio") updateAudioTrim(Number($("audioStart").value), clip.sourceEnd);
  });
  $("audioEnd").addEventListener("change", () => {
    const clip = getSelectedClip();
    if (clip && state.selected?.type === "audio") updateAudioTrim(clip.sourceStart, Number($("audioEnd").value));
  });
  $("audioFadeIn").addEventListener("input", () => {
    const clip = getSelectedClip();
    if (!clip || state.selected?.type !== "audio") return;
    clip.fadeIn = Number($("audioFadeIn").value);
    state.audioFadeIn = clip.fadeIn;
    renderInspectorValues();
    updateAudioVolume();
  });
  $("audioFadeOut").addEventListener("input", () => {
    const clip = getSelectedClip();
    if (!clip || state.selected?.type !== "audio") return;
    clip.fadeOut = Number($("audioFadeOut").value);
    state.audioFadeOut = clip.fadeOut;
    renderInspectorValues();
    updateAudioVolume();
  });
  $("setAudioStartAtCursor").addEventListener("click", () => {
    const clip = getSelectedClip();
    if (clip && state.selected?.type === "audio") updateAudioTrim(clip.sourceStart + Math.max(0, state.currentTime - clip.start), clip.sourceEnd);
  });
  $("setAudioEndAtCursor").addEventListener("click", () => {
    const clip = getSelectedClip();
    if (clip && state.selected?.type === "audio") updateAudioTrim(clip.sourceStart, clip.sourceStart + Math.max(0, state.currentTime - clip.start));
  });
  $("resetAudioTrim").addEventListener("click", () => updateAudioTrim(0, state.audioDuration || state.duration));
  document.querySelectorAll("[data-text-style]").forEach(button => button.addEventListener("click", () => applyTextStyle(button.dataset.textStyle)));
}

function bind() {
  document.querySelectorAll(".library-tab").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll(".library-tab").forEach(item => item.classList.toggle("active", item === button));
    document.querySelectorAll(".library-view").forEach(view => view.classList.toggle("active", view.dataset.view === button.dataset.tab));
  }));
  els.audioInput.addEventListener("change", () => setAudioFile(els.audioInput.files[0]));
  if (els.videoInput) els.videoInput.addEventListener("change", () => {
    addBackgroundFiles(els.videoInput.files);
    els.videoInput.value = "";
  });
  els.bgInput.addEventListener("change", () => {
    addBackgroundFiles(els.bgInput.files);
    els.bgInput.value = "";
  });
  bindFileDrop(els.mediaBin, addBackgroundFiles);
  bindFileDrop(els.previewFrame, addBackgroundFiles);
  bindFileDrop(els.timelineViewport, addBackgroundFiles);
  document.querySelectorAll(".builtin-bg").forEach(button => button.addEventListener("click", () => addBuiltinBackground(button.dataset.bg)));
  $("createTextClips").addEventListener("click", createTextClips);
  $("addTextClip").addEventListener("click", addTextClip);
  $("loadTextFile").addEventListener("click", () => $("hiddenTextFile").click());
  $("hiddenTextFile").addEventListener("change", () => loadTextFile($("hiddenTextFile").files[0]));
  els.previewToggle.addEventListener("click", togglePlay);
  $("jumpStart").addEventListener("click", () => setCurrentTime(0));
  $("jumpEnd").addEventListener("click", () => setCurrentTime(state.duration));
  els.previewRange.addEventListener("input", () => setCurrentTime(Number(els.previewRange.value)));
  $("previewVolume").addEventListener("input", () => {
    state.audioGain = Number($("previewVolume").value);
    const clip = currentAudioClip() || (state.selected?.type === "audio" ? getSelectedClip() : null);
    if (clip) clip.gain = state.audioGain;
    renderInspectorValues();
    updateAudioVolume();
  });
  els.audio.addEventListener("seeked", () => {
    const clip = state.audioClips.find(item => item.id === state.previewAudioClipId);
    if (clip && state.playing) setCurrentTime(clip.start + Math.max(0, els.audio.currentTime - clip.sourceStart), false);
  });
  els.audio.addEventListener("pause", () => { if (state.playing) setPlaying(false); });
  els.previewText.addEventListener("pointerdown", dragPreviewText);
  els.audioClip.addEventListener("pointerdown", startAudioDrag);
  els.audioTrack.addEventListener("click", event => {
    const clipElement = event.target.closest(".audio-clip.generated");
    if (clipElement) selectItem("audio", clipElement.dataset.id);
    else {
      const clip = currentAudioClip() || state.audioClips[0];
      if (clip) selectItem("audio", clip.id);
    }
  });
  els.audioClip.addEventListener("contextmenu", event => {
    event.stopPropagation();
    const clip = currentAudioClip() || state.audioClips[0];
    if (clip) openContextMenu(event, {type:"audio", id:clip.id});
  });
  els.timelineViewport.addEventListener("pointerdown", startTimelineSeek);
  els.timelineViewport.addEventListener("contextmenu", event => openContextMenu(event, state.selected));
  document.addEventListener("pointerdown", event => {
    if (!event.target.closest("#contextMenu")) closeContextMenu();
  });
  els.contextMenu.addEventListener("click", event => {
    const button = event.target.closest("[data-menu-action]");
    if (button) runMenuAction(button.dataset.menuAction);
  });
  document.querySelectorAll("[data-tool]").forEach(button => button.addEventListener("click", () => setTool(button.dataset.tool)));
  $("timelineZoom").addEventListener("input", () => {
    state.pxPerSec = Number($("timelineZoom").value);
    renderTimeline();
    if (state.audioFile) drawWaveform(state.audioFile);
  });
  document.querySelectorAll(".format-btn").forEach(button => button.addEventListener("click", () => {
    state.width = Number(button.dataset.w);
    state.height = Number(button.dataset.h);
    updateFormatButtons();
    renderAll();
  }));
  $("fitCanvas").addEventListener("click", fitCanvas);
  $("autoArrange").addEventListener("click", autoArrangeText);
  $("splitClip").addEventListener("click", splitSelected);
  $("splitAllAtCursor").addEventListener("click", splitAllAtCursor);
  $("duplicateSelected").addEventListener("click", duplicateSelected);
  $("deleteSelected").addEventListener("click", deleteSelected);
  $("deleteTextClip").addEventListener("click", deleteSelected);
  $("deleteBackgroundClip").addEventListener("click", deleteSelected);
  $("undoBtn").addEventListener("click", undo);
  $("redoBtn").addEventListener("click", redo);
  $("saveProject").addEventListener("click", saveProject);
  $("searchBackgrounds").addEventListener("click", searchBackgrounds);
  $("backgroundSearch").addEventListener("keydown", event => { if (event.key === "Enter") searchBackgrounds(); });
  $("sendAi").addEventListener("click", () => {
    const prompt = $("aiPrompt").value.trim();
    if (prompt) askAi(prompt);
  });
  document.querySelectorAll("[data-ai-action]").forEach(button => button.addEventListener("click", () => {
    const prompts = {
      split:"Разбей текст на короткие строки до 5 слов, сохрани смысл и порядок.",
      shorten:"Сделай каждую строку короче, сохрани смысл, ритм и настроение.",
      polish:"Исправь орфографию и пунктуацию, не меняй авторский смысл.",
      hook:"Сделай первые четыре строки сильнее и эмоциональнее, остальное сохрани.",
    };
    askAi(prompts[button.dataset.aiAction]);
  }));
  $("exportTop").addEventListener("click", () => {
    renderProjectInfo();
    els.exportDialog.showModal();
  });
  $("generateVideo").addEventListener("click", generateVideo);
  $("stopJob").addEventListener("click", async () => {
    if (state.activeJob) await fetch(`/api/stop/${state.activeJob}`, {method:"POST"});
  });
  $("openOutputTop").addEventListener("click", () => fetch("/api/open-output", {method:"POST"}));
  $("fps").addEventListener("change", renderProjectInfo);
  $("backgroundColor").addEventListener("input", updatePreview);
  bindHeaderMenus();
  bindInspector();
  window.addEventListener("keydown", event => {
    const editingText = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (event.key === "Escape") {
      closeContextMenu();
      closeTopMenus();
    }
    if (event.code === "Space" && !editingText) {
      event.preventDefault();
      togglePlay();
    }
    if ((event.key === "Delete" || event.key === "Backspace") && !editingText) deleteSelected();
    if (event.ctrlKey && event.code === "KeyZ") {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    }
    if (editingText) return;
    if (event.code === "KeyV" && !event.ctrlKey) setTool("select");
    if (event.code === "KeyB" && !event.ctrlKey) setTool("blade");
    if (event.code === "KeyS" && !event.ctrlKey) {
      event.preventDefault();
      splitSelected();
    }
    if (event.ctrlKey && event.code === "KeyD") {
      event.preventDefault();
      duplicateSelected();
    }
    if (event.ctrlKey && event.code === "KeyC") {
      event.preventDefault();
      copySelected();
    }
    if (event.ctrlKey && event.code === "KeyV") {
      event.preventDefault();
      pasteClipboard();
    }
  });
}

bind();
fitCanvas();
renderAll();
loadOutputs();
checkAi();
