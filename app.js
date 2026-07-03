const preferredMimeTypes = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm"
];

const state = {
  status: "idle",
  recorder: null,
  chunks: [],
  displayStream: null,
  micStream: null,
  recordingStream: null,
  audioContext: null,
  audioNodes: [],
  objectUrl: null,
  startedAt: 0,
  pausedAt: 0,
  pausedDuration: 0,
  timerId: 0,
  warning: ""
};

const elements = {
  recorder: document.querySelector(".recorder"),
  timer: document.querySelector("#timer"),
  statusText: document.querySelector("#status-text"),
  message: document.querySelector("#message"),
  recordToggle: document.querySelector("#record-toggle"),
  pauseToggle: document.querySelector("#pause-toggle"),
  downloadLink: document.querySelector("#download-link"),
  audioModes: Array.from(document.querySelectorAll("input[name='audioMode']"))
};

const statusLabels = {
  idle: "Ready",
  starting: "Starting",
  recording: "Recording",
  paused: "Paused",
  stopping: "Stopping",
  complete: "Ready to download",
  error: "Ready after error"
};

initialize();

function initialize() {
  elements.recordToggle.addEventListener("click", handleRecordToggle);
  elements.pauseToggle.addEventListener("click", handlePauseToggle);
  document.addEventListener("keydown", handleShortcut);

  const unsupportedReason = getUnsupportedReason();

  if (unsupportedReason) {
    setState("error");
    setMessage(unsupportedReason, "error");
    elements.recordToggle.disabled = true;
    return;
  }

  setState("idle");
}

function getUnsupportedReason() {
  if (!window.isSecureContext) {
    return "Screen capture requires HTTPS or localhost.";
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    return "This browser does not support screen capture.";
  }

  if (typeof MediaRecorder === "undefined") {
    return "This browser does not support MediaRecorder.";
  }

  return "";
}

function handleRecordToggle() {
  if (state.status === "idle" || state.status === "complete" || state.status === "error") {
    startRecording();
    return;
  }

  if (state.status === "recording" || state.status === "paused") {
    stopRecording();
  }
}

function handlePauseToggle() {
  if (state.status === "recording") {
    pauseRecording();
    return;
  }

  if (state.status === "paused") {
    resumeRecording();
  }
}

function handleShortcut(event) {
  if (event.defaultPrevented || event.repeat || isEditableTarget(event.target)) {
    return;
  }

  if (event.key.toLowerCase() === "r") {
    event.preventDefault();
    handleRecordToggle();
    return;
  }

  if (event.key.toLowerCase() === "p") {
    event.preventDefault();
    handlePauseToggle();
    return;
  }

  if (event.key === "Escape" && (state.status === "recording" || state.status === "paused")) {
    event.preventDefault();
    stopRecording();
  }
}

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();

  return target.isContentEditable || tagName === "textarea" || tagName === "select";
}

async function startRecording() {
  if (state.status === "starting" || state.status === "recording" || state.status === "paused") {
    return;
  }

  clearMessage();
  setState("starting");

  try {
    const mode = getSelectedAudioMode();
    state.displayStream = await requestDisplayStream(mode.system);
    state.micStream = mode.mic ? await requestMicStream() : null;

    const recordingStream = await buildRecordingStream(mode);
    const recorder = createRecorder(recordingStream);

    state.recordingStream = recordingStream;
    state.recorder = recorder;
    state.chunks = [];

    attachRecorderEvents(recorder);
    attachDisplayEndHandler();

    recorder.start(1000);
    resetDownload();
    state.startedAt = performance.now();
    state.pausedAt = 0;
    state.pausedDuration = 0;
    setState("recording");
    startTimer();

    if (state.warning) {
      setMessage(state.warning, "warning");
    }
  } catch (error) {
    cleanupCapture();
    setState("error");
    setMessage(toUserMessage(error), "error");
  }
}

async function requestDisplayStream(wantsSystemAudio) {
  const displayOptions = {
    video: {
      frameRate: { ideal: 30, max: 60 },
      width: { max: 3840 },
      height: { max: 2160 }
    },
    audio: wantsSystemAudio
      ? {
          systemAudio: "include",
          suppressLocalAudioPlayback: false
        }
      : false
  };

  return navigator.mediaDevices.getDisplayMedia(displayOptions);
}

async function requestMicStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true
      },
      video: false
    });
  } catch (error) {
    error.captureStep = "microphone";
    throw error;
  }
}

async function buildRecordingStream(mode) {
  const videoTracks = state.displayStream.getVideoTracks();

  if (videoTracks.length === 0) {
    throw new Error("Screen capture did not include a video track.");
  }

  const screenAudioTracks = state.displayStream.getAudioTracks();
  const micAudioTracks = state.micStream?.getAudioTracks() ?? [];

  state.warning = "";

  if (mode.system && screenAudioTracks.length === 0) {
    state.warning = "Chrome did not provide system or tab audio for the selected source.";
  }

  const audioTracks = [...screenAudioTracks, ...micAudioTracks];

  if (audioTracks.length === 0) {
    return new MediaStream(videoTracks);
  }

  if (audioTracks.length === 1) {
    return new MediaStream([...videoTracks, audioTracks[0]]);
  }

  const mixedAudioTrack = await mixAudioTracks(audioTracks);

  return new MediaStream([...videoTracks, mixedAudioTrack]);
}

async function mixAudioTracks(audioTracks) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;

  if (!AudioContextCtor) {
    throw new Error("This browser cannot mix microphone and system audio.");
  }

  state.audioContext = new AudioContextCtor();

  if (state.audioContext.state === "suspended") {
    await state.audioContext.resume();
  }

  const destination = state.audioContext.createMediaStreamDestination();

  audioTracks.forEach((track) => {
    const sourceStream = new MediaStream([track]);
    const sourceNode = state.audioContext.createMediaStreamSource(sourceStream);
    sourceNode.connect(destination);
    state.audioNodes.push(sourceNode);
  });

  const [mixedTrack] = destination.stream.getAudioTracks();

  if (!mixedTrack) {
    throw new Error("Audio mixing failed.");
  }

  return mixedTrack;
}

function createRecorder(stream) {
  const mimeType = pickMimeType();
  const options = {
    audioBitsPerSecond: 128000,
    videoBitsPerSecond: 6000000
  };

  if (mimeType) {
    options.mimeType = mimeType;
  }

  return new MediaRecorder(stream, options);
}

function attachRecorderEvents(recorder) {
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      state.chunks.push(event.data);
    }
  });

  recorder.addEventListener("stop", handleRecorderStop, { once: true });

  recorder.addEventListener("error", (event) => {
    setMessage(toUserMessage(event.error ?? event), "error");

    if (state.status === "recording" || state.status === "paused") {
      stopRecording();
    }
  });
}

function attachDisplayEndHandler() {
  const [videoTrack] = state.displayStream.getVideoTracks();

  videoTrack.addEventListener(
    "ended",
    () => {
      if (state.status === "recording" || state.status === "paused") {
        stopRecording();
      }
    },
    { once: true }
  );
}

function pauseRecording() {
  if (state.recorder?.state !== "recording") {
    return;
  }

  state.recorder.pause();
  state.pausedAt = performance.now();
  setState("paused");
  updateTimer();
}

function resumeRecording() {
  if (state.recorder?.state !== "paused") {
    return;
  }

  state.pausedDuration += performance.now() - state.pausedAt;
  state.pausedAt = 0;
  state.recorder.resume();
  setState("recording");
  updateTimer();
}

function stopRecording() {
  if (!state.recorder || state.recorder.state === "inactive") {
    cleanupCapture();
    setState("idle");
    return;
  }

  if (state.status === "paused" && state.pausedAt) {
    state.pausedDuration += performance.now() - state.pausedAt;
    state.pausedAt = 0;
  }

  setState("stopping");
  stopTimer();
  state.recorder.stop();
}

function handleRecorderStop() {
  stopTimer();
  updateTimer();

  const mimeType = state.recorder?.mimeType || "video/webm";
  const blob = new Blob(state.chunks, { type: mimeType });
  state.chunks = [];

  cleanupCapture();

  if (blob.size === 0) {
    setState("error");
    setMessage("Recording finished without any captured data.", "error");
    return;
  }

  state.objectUrl = URL.createObjectURL(blob);
  elements.downloadLink.href = state.objectUrl;
  elements.downloadLink.download = createFilename();
  elements.downloadLink.classList.remove("is-hidden");
  setState("complete");
  clearMessage();
}

function cleanupCapture() {
  const streams = [state.recordingStream, state.displayStream, state.micStream].filter(Boolean);

  streams.forEach((stream) => {
    stream.getTracks().forEach((track) => track.stop());
  });

  state.audioNodes.forEach((node) => node.disconnect());
  state.audioNodes = [];

  if (state.audioContext) {
    void state.audioContext.close().catch(() => {});
  }

  state.recorder = null;
  state.displayStream = null;
  state.micStream = null;
  state.recordingStream = null;
  state.audioContext = null;
  state.warning = "";
}

function resetDownload() {
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
  }

  state.objectUrl = null;
  elements.downloadLink.removeAttribute("href");
  elements.downloadLink.removeAttribute("download");
  elements.downloadLink.classList.add("is-hidden");
}

function startTimer() {
  stopTimer();
  updateTimer();
  state.timerId = window.setInterval(updateTimer, 1000);
}

function stopTimer() {
  if (state.timerId) {
    window.clearInterval(state.timerId);
    state.timerId = 0;
  }
}

function updateTimer() {
  elements.timer.value = formatElapsed(getElapsedMilliseconds());
}

function getElapsedMilliseconds() {
  if (!state.startedAt) {
    return 0;
  }

  const endTime = state.status === "paused" && state.pausedAt ? state.pausedAt : performance.now();

  return Math.max(0, endTime - state.startedAt - state.pausedDuration);
}

function setState(nextStatus) {
  state.status = nextStatus;
  elements.recorder.dataset.state = nextStatus;
  elements.statusText.value = statusLabels[nextStatus];
  updateControls();
}

function updateControls() {
  const isBusy = state.status === "starting" || state.status === "stopping";
  const isActive = state.status === "recording" || state.status === "paused";
  const canStart = state.status === "idle" || state.status === "complete" || state.status === "error";

  elements.recordToggle.disabled = isBusy;
  elements.recordToggle.textContent = canStart ? "Start" : isBusy ? statusLabels[state.status] : "Stop";
  elements.pauseToggle.disabled = state.status !== "recording" && state.status !== "paused";
  elements.pauseToggle.textContent = state.status === "paused" ? "Resume" : "Pause";

  elements.audioModes.forEach((input) => {
    input.disabled = isActive || isBusy;
  });
}

function setMessage(text, tone) {
  elements.message.textContent = text;

  if (tone) {
    elements.message.dataset.tone = tone;
  } else {
    delete elements.message.dataset.tone;
  }
}

function clearMessage() {
  setMessage("", "");
}

function getSelectedAudioMode() {
  const value = elements.audioModes.find((input) => input.checked)?.value ?? "screen";

  return {
    mic: value === "mic" || value === "mic-system",
    system: value === "system" || value === "mic-system"
  };
}

function pickMimeType() {
  return preferredMimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function createFilename() {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "");

  return `screeny-${timestamp}.webm`;
}

function toUserMessage(error) {
  if (error?.captureStep === "microphone") {
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      return "Microphone access was denied.";
    }

    return `Microphone capture failed: ${error.message || error.name || "unknown error"}.`;
  }

  if (error?.name === "NotAllowedError" || error?.name === "AbortError") {
    return "Screen selection was cancelled or denied.";
  }

  if (error?.name === "NotReadableError") {
    return "Chrome could not read the selected screen source.";
  }

  return error?.message || "Recording failed.";
}
