"use strict";

const APP = "Recording_Export";
const RECORD = "/axis-cgi/record";
const $ = (id) => document.getElementById(id);

// Edge Storage reports these mime types; the probes are what the MP4 export contains.
const CODECS = {
  "video/x-h264": { label: "H.264", probe: 'video/mp4; codecs="avc1.640028"' },
  "video/x-h265": { label: "H.265", probe: 'video/mp4; codecs="hev1.1.6.L120.90"' },
  "video/x-av1": { label: "AV1", probe: 'video/mp4; codecs="av01.0.08M.08"' },
};

const state = {
  recordings: [],
  shown: [],
  selected: new Set(),
  clips: new Map(), // recording id -> { start: Date, stop: Date }
  anchor: null,
  sortDesc: true,
  abort: null,
};

const player = { rec: null, base: 0, token: 0, dragging: false };

/* ------------------------------------------------------------------ helpers */

function setStatus(message, isError) {
  $("status").textContent = message;
  $("status").classList.toggle("error", Boolean(isError));
}

function log(message, kind) {
  const item = document.createElement("li");
  item.textContent = message;
  if (kind) item.className = kind;
  $("log").prepend(item);
}

async function fetchXml(url) {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(`${url.split("?")[0]} returned HTTP ${response.status}`);
  const doc = new DOMParser().parseFromString(await response.text(), "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("unexpected response from camera");
  return doc;
}

const pad = (n) => String(n).padStart(2, "0");

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

// Camera-local UTC offset of a recording, taken from its starttimelocal suffix.
function offsetMinutes(rec) {
  const match = /([+-])(\d\d):(\d\d)$/.exec(rec.startLocal);
  if (!match) return 0;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

function cameraTime(date, rec) {
  return new Date(date.getTime() + offsetMinutes(rec) * 60000).toISOString().slice(0, 19).replace("T", " ");
}

function fileStamp(date, rec) {
  return cameraTime(date, rec).replace(" ", "_").replace(/:/g, "-");
}

// datetime-local filter values are camera time; convert them with the recording's offset.
function filterDate(id, rec) {
  const value = $(id).value;
  if (!value) return null;
  const base = value.length === 16 ? `${value}:00` : value;
  return new Date(Date.parse(`${base}Z`) - offsetMinutes(rec) * 60000);
}

const recEnd = (rec) => rec.stop || new Date();
const codecLabel = (rec) => (CODECS[rec.mime] ? CODECS[rec.mime].label : rec.mime.replace(/^video\/(x-)?/, ""));

function browserDecodes(mime) {
  const codec = CODECS[mime];
  if (!codec) return true;
  return document.createElement("video").canPlayType(codec.probe) !== "";
}

function codecAdvice(rec) {
  const label = codecLabel(rec);
  if (rec.mime === "video/x-av1")
    return `This browser cannot play ${label}. Use a current Chrome or Edge (Windows: install the free "AV1 Video Extension" from the Microsoft Store). Export still works.`;
  if (rec.mime === "video/x-h265")
    return `This browser cannot play ${label}. Edge on Windows needs the "HEVC Video Extensions" from the Microsoft Store and hardware support. Export still works.`;
  return `This browser cannot play ${label}. Export still works.`;
}

/* ------------------------------------------------------------- recordings */

function parseRecording(el) {
  const attr = (name) => el.getAttribute(name) || "";
  const video = el.getElementsByTagName("video")[0];
  return {
    id: attr("recordingid"),
    disk: attr("diskid"),
    start: new Date(attr("starttime")),
    stop: attr("stoptime") ? new Date(attr("stoptime")) : null,
    startLocal: attr("starttimelocal"),
    type: attr("recordingtype"),
    trigger: attr("eventtrigger") || attr("eventid"),
    status: attr("recordingstatus"),
    mime: video ? video.getAttribute("mimetype") || "" : "",
    resolution: video ? video.getAttribute("resolution") || "" : "",
  };
}

async function loadDisks() {
  const doc = await fetchXml("/axis-cgi/disks/list.cgi?diskid=all");
  const select = $("disk");
  select.replaceChildren();
  for (const disk of doc.getElementsByTagName("disk")) {
    const id = disk.getAttribute("diskid");
    const status = disk.getAttribute("status");
    const option = new Option(status === "OK" ? id : `${id} (${status})`, id);
    option.disabled = status !== "OK";
    select.add(option);
  }
  const usable = [...select.options].filter((option) => !option.disabled);
  if (!usable.length) throw new Error("no storage is mounted on this camera");
  select.value = (usable.find((option) => option.value === "SD_DISK") || usable[0]).value;
}

async function loadRecordings() {
  const disk = $("disk").value;
  setStatus("Loading recordings...");
  const doc = await fetchXml(`${RECORD}/list.cgi?recordingid=all&diskid=${encodeURIComponent(disk)}`);
  state.recordings = [...doc.getElementsByTagName("recording")].map(parseRecording);
  const ids = new Set(state.recordings.map((rec) => rec.id));
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
  for (const id of [...state.clips.keys()]) if (!ids.has(id)) state.clips.delete(id);
  render();
  setStatus("");
}

function matchesFilters(rec) {
  const from = filterDate("from", rec);
  const to = filterDate("to", rec);
  if (from && recEnd(rec) < from) return false;
  if (to && rec.start > to) return false;
  if ($("type").value && rec.type !== $("type").value) return false;
  if ($("codec").value && rec.mime !== $("codec").value) return false;
  const search = $("search").value.trim().toLowerCase();
  if (search && !`${rec.trigger} ${rec.id} ${rec.type}`.toLowerCase().includes(search)) return false;
  return true;
}

function cell(row, text, className) {
  const td = row.insertCell();
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function render() {
  state.shown = state.recordings.filter(matchesFilters).sort((a, b) => (state.sortDesc ? b.start - a.start : a.start - b.start));
  $("sort-start").textContent = state.sortDesc ? "Start (newest first)" : "Start (oldest first)";

  const body = $("rows");
  body.replaceChildren();
  for (const rec of state.shown) {
    const row = body.insertRow();
    row.dataset.id = rec.id;
    row.classList.toggle("selected", state.selected.has(rec.id));

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = state.selected.has(rec.id);
    check.setAttribute("aria-label", "Select recording");
    row.insertCell().append(check);

    cell(row, cameraTime(rec.start, rec));
    cell(row, rec.stop ? cameraTime(rec.stop, rec) : "recording");
    cell(row, formatDuration(recEnd(rec) - rec.start));
    cell(row, rec.type);
    cell(row, rec.trigger);
    const codec = cell(row, codecLabel(rec));
    if (!browserDecodes(rec.mime)) {
      codec.className = "codec-unsupported";
      codec.title = "This browser cannot play this codec; export still works";
    }
    cell(row, rec.resolution);
    cell(row, rec.status);
    const clip = state.clips.get(rec.id);
    cell(row, clip ? `${cameraTime(clip.start, rec).slice(11)} - ${cameraTime(clip.stop, rec).slice(11)}` : "");

    const play = document.createElement("button");
    play.type = "button";
    play.className = "secondary";
    play.dataset.play = "1";
    play.textContent = "Play";
    row.insertCell().append(play);
  }

  if (!state.shown.length) {
    const row = body.insertRow();
    const td = cell(row, state.recordings.length ? "No recordings match the filters." : "No recordings on this storage.", "empty");
    td.colSpan = 11;
  }
  updateSummary();
}

function updateSummary() {
  const selected = state.recordings.filter((rec) => state.selected.has(rec.id));
  const hidden = selected.filter((rec) => !state.shown.includes(rec)).length;
  const total = selected.reduce((sum, rec) => {
    const range = exportRange(rec);
    return sum + (range ? range.stop - range.start : recEnd(rec) - rec.start);
  }, 0);
  let text = `${state.shown.length} of ${state.recordings.length} recordings shown, ${selected.length} selected`;
  if (selected.length) text += ` (${formatDuration(total)})`;
  if (hidden) text += `, ${hidden} of them hidden by filters`;
  $("summary").textContent = text;
  $("export").disabled = !selected.length || Boolean(state.abort);
  const shownSelected = state.shown.filter((rec) => state.selected.has(rec.id)).length;
  $("check-all").checked = state.shown.length > 0 && shownSelected === state.shown.length;
  $("check-all").indeterminate = shownSelected > 0 && shownSelected < state.shown.length;
}

function setSelected(rec, on) {
  if (on) state.selected.add(rec.id);
  else state.selected.delete(rec.id);
  const row = $("rows").querySelector(`tr[data-id="${CSS.escape(rec.id)}"]`);
  if (row) {
    row.classList.toggle("selected", on);
    row.querySelector("input").checked = on;
  }
}

function onRowClick(event) {
  const row = event.target.closest("tr[data-id]");
  if (!row) return;
  const index = state.shown.findIndex((rec) => rec.id === row.dataset.id);
  const rec = state.shown[index];
  if (event.target.dataset.play) {
    openPlayer(rec);
    return;
  }
  const on = !state.selected.has(rec.id);
  if (event.shiftKey && state.anchor !== null) {
    const [from, to] = [Math.min(state.anchor, index), Math.max(state.anchor, index)];
    for (let i = from; i <= to; i++) setSelected(state.shown[i], on);
    window.getSelection().removeAllRanges();
  } else {
    setSelected(rec, on);
  }
  state.anchor = index;
  updateSummary();
}

/* ----------------------------------------------------------------- export */

function exportRange(rec) {
  const clip = state.clips.get(rec.id);
  if (clip) return clip;
  if (!$("trim").checked) return null;
  const from = filterDate("from", rec);
  const to = filterDate("to", rec);
  if (!from && !to) return null;
  return {
    start: from && from > rec.start ? from : rec.start,
    stop: to && to < recEnd(rec) ? to : recEnd(rec),
  };
}

// The camera ignores starttime unless stoptime is also given.
function exportUrl(rec, format, range) {
  const params = new URLSearchParams({ schemaversion: "1", recordingid: rec.id, diskid: rec.disk, exportformat: format });
  if (range) {
    params.set("starttime", range.start.toISOString());
    params.set("stoptime", range.stop.toISOString());
  }
  return `${RECORD}/export/exportrecording.cgi?${params}`;
}

function fileName(rec, extension, range) {
  const host = location.hostname.replace(/[^\w.-]/g, "_");
  return `${host}_${fileStamp(range ? range.start : rec.start, rec)}_${rec.id}.${extension}`;
}

const folderSupported = () => typeof window.showDirectoryPicker === "function";

function setupDestination() {
  const destination = $("destination");
  if (!folderSupported()) {
    destination.querySelector('option[value="folder"]').disabled = true;
    destination.value = "downloads";
  }
  const update = () => {
    if (destination.value === "folder") {
      $("destination-hint").textContent =
        "You choose a folder once; recordings stream straight into it and files already there are skipped.";
    } else if (folderSupported()) {
      $("destination-hint").textContent = "Each recording is saved as a separate browser download.";
    } else {
      $("destination-hint").textContent =
        "Each recording is saved as a separate browser download; allow multiple downloads if the browser asks. " +
        "To save straight into a folder, open the camera over HTTPS in Edge or Chrome.";
    }
  };
  destination.addEventListener("change", update);
  update();
}

async function fileExists(directory, name) {
  try {
    const file = await (await directory.getFileHandle(name)).getFile();
    return file.size > 0;
  } catch {
    return false;
  }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function exportSelected() {
  const items = state.recordings.filter((rec) => state.selected.has(rec.id)).sort((a, b) => a.start - b.start);
  if (!items.length) return;
  const format = $("format").value;
  const extension = format === "matroska" ? "mkv" : "mp4";
  const toFolder = $("destination").value === "folder" && folderSupported();

  let directory = null;
  if (toFolder) {
    try {
      directory = await window.showDirectoryPicker({ id: APP, mode: "readwrite", startIn: "videos" });
    } catch {
      return; // picker dismissed
    }
  }

  state.abort = new AbortController();
  $("cancel").hidden = false;
  $("progress").hidden = false;
  $("progress").max = items.length;
  $("progress").value = 0;
  updateSummary();

  let ok = 0;
  let failed = 0;
  let skipped = 0;

  for (const [index, rec] of items.entries()) {
    if (state.abort.signal.aborted) break;
    const range = exportRange(rec);
    const name = fileName(rec, extension, range);
    const prefix = `${index + 1}/${items.length}`;

    if (directory && (await fileExists(directory, name))) {
      log(`${name}: already in folder, skipped`);
      skipped++;
      $("progress").value = index + 1;
      continue;
    }

    let writable = null;
    try {
      setStatus(`Exporting ${prefix}: ${name}`);
      const response = await fetch(exportUrl(rec, format, range), { credentials: "same-origin", signal: state.abort.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      const started = performance.now();
      if (directory) writable = await (await directory.getFileHandle(name, { create: true })).createWritable();

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (writable) await writable.write(value);
        else chunks.push(value);
        const seconds = (performance.now() - started) / 1000;
        setStatus(`Exporting ${prefix}: ${name} - ${(bytes / 1048576).toFixed(1)} MB (${(bytes / 1048576 / Math.max(seconds, 0.1)).toFixed(1)} MB/s)`);
      }
      if (!bytes) throw new Error("camera returned an empty file");

      if (writable) await writable.close();
      else saveBlob(new Blob(chunks, { type: format === "matroska" ? "video/x-matroska" : "video/mp4" }), name);
      writable = null;
      log(`${name}: ${(bytes / 1048576).toFixed(1)} MB`, "ok");
      ok++;
    } catch (error) {
      if (writable) await writable.abort().catch(() => {});
      if (state.abort.signal.aborted) {
        log(`${name}: cancelled`, "error");
        break;
      }
      log(`${name}: failed (${error.message})`, "error");
      failed++;
    }
    $("progress").value = index + 1;
  }

  const cancelled = state.abort.signal.aborted;
  state.abort = null;
  $("cancel").hidden = true;
  updateSummary();
  const summary = `${ok} exported${skipped ? `, ${skipped} skipped` : ""}${failed ? `, ${failed} failed` : ""}`;
  setStatus(cancelled ? `Cancelled: ${summary}.` : `Done: ${summary}.`, failed > 0);
}

/* ----------------------------------------------------------------- player */

const video = $("video");
const playerDuration = () => (player.rec ? (recEnd(player.rec) - player.rec.start) / 1000 : 0);
const playerPosition = () => player.base + (video.currentTime || 0);

// Matroska DateUTC (EBML id 0x4461, 8-byte signed ns since 2001-01-01).
function findDateUtc(bytes) {
  for (let i = 0; i + 11 <= bytes.length; i++) {
    if (bytes[i] === 0x44 && bytes[i + 1] === 0x61 && bytes[i + 2] === 0x88) {
      const ns = new DataView(bytes.buffer, bytes.byteOffset + i + 3, 8).getBigInt64(0);
      return new Date(Date.UTC(2001, 0, 1) + Number(ns / 1000000n));
    }
  }
  return null;
}

// A ranged export starts at the keyframe before the requested time and its
// timestamps restart at 0. Only the Matroska header says exactly where, so
// read that header and drop the rest of the response.
async function actualExportStart(rec, range) {
  const controller = new AbortController();
  try {
    const response = await fetch(exportUrl(rec, "matroska", range), { credentials: "same-origin", signal: controller.signal });
    if (!response.ok) return null;
    const reader = response.body.getReader();
    let bytes = new Uint8Array(0);
    while (bytes.length < 8192) {
      const { value, done } = await reader.read();
      if (done) break;
      const merged = new Uint8Array(bytes.length + value.length);
      merged.set(bytes);
      merged.set(value, bytes.length);
      bytes = merged;
      const date = findDateUtc(bytes);
      if (date) return date;
    }
    return null;
  } catch {
    return null;
  } finally {
    controller.abort();
  }
}

async function loadAt(offset, autoplay) {
  const rec = player.rec;
  const token = ++player.token;
  const duration = playerDuration();
  offset = Math.min(Math.max(0, offset), Math.max(0, duration - 1));

  let range = null;
  let base = 0;
  if (offset >= 0.5) {
    range = { start: new Date(rec.start.getTime() + offset * 1000), stop: recEnd(rec) };
    setPlayerTime(offset);
    const actual = await actualExportStart(rec, range);
    if (token !== player.token) return;
    base = actual ? Math.max(0, (actual - rec.start) / 1000) : offset;
  }
  player.base = base;
  video.src = exportUrl(rec, "mp4", range);
  video.playbackRate = Number($("speed").value);
  if (autoplay) video.play().catch(() => {});
}

// The camera's export has no Range support, so even seeks inside the buffered
// part restart the stream in Chrome; always reload from the target instead.
function seek(offset) {
  loadAt(offset, !video.paused || video.ended);
}

function setPlayerTime(position) {
  if (!player.rec) return;
  const duration = playerDuration();
  if (!player.dragging) $("timeline").value = String(position);
  const at = new Date(player.rec.start.getTime() + position * 1000);
  $("time").textContent = `${cameraTime(at, player.rec).slice(11)}  ${formatDuration(position * 1000)} / ${formatDuration(duration * 1000)}`;
}

function renderClip() {
  const rec = player.rec;
  const clip = rec && state.clips.get(rec.id);
  const region = $("clip-region");
  if (!clip) {
    region.hidden = true;
    $("clip-info").textContent = rec ? "Exports include the whole recording. Use Set clip start/end to export only part of it." : "";
    return;
  }
  const duration = playerDuration() * 1000;
  region.hidden = false;
  region.style.left = `${((clip.start - rec.start) / duration) * 100}%`;
  region.style.width = `${((clip.stop - clip.start) / duration) * 100}%`;
  $("clip-info").textContent =
    `Clip ${cameraTime(clip.start, rec).slice(11)} - ${cameraTime(clip.stop, rec).slice(11)} (${formatDuration(clip.stop - clip.start)}). ` +
    "Exports of this recording use the clip; it may start slightly earlier, at the previous keyframe.";
}

function markClip(which) {
  const rec = player.rec;
  if (!rec) return;
  const at = new Date(rec.start.getTime() + playerPosition() * 1000);
  const clip = state.clips.get(rec.id) || { start: rec.start, stop: recEnd(rec) };
  if (which === "start") {
    clip.start = at;
    if (clip.stop <= at) clip.stop = recEnd(rec);
  } else {
    clip.stop = at;
    if (clip.start >= at) clip.start = rec.start;
  }
  state.clips.set(rec.id, clip);
  state.selected.add(rec.id);
  render();
  renderClip();
}

function openPlayer(rec) {
  player.rec = rec;
  $("player").hidden = false;
  $("player-title").textContent = `${cameraTime(rec.start, rec)}  ${rec.type}  ${codecLabel(rec)} ${rec.resolution}`;
  $("timeline").max = String(Math.max(1, playerDuration()));
  const warning = $("player-warning");
  warning.hidden = browserDecodes(rec.mime);
  warning.textContent = warning.hidden ? "" : codecAdvice(rec);
  setPlayerTime(0);
  renderClip();
  $("player").scrollIntoView({ behavior: "smooth", block: "start" });
  loadAt(0, true);
}

function closePlayer() {
  player.token++;
  player.rec = null;
  video.pause();
  video.removeAttribute("src");
  video.load();
  $("player").hidden = true;
}

function stepPlayer(direction) {
  if (!player.rec) return;
  const index = state.shown.findIndex((rec) => rec.id === player.rec.id);
  const next = state.shown[index + direction];
  if (next) openPlayer(next);
}

function setupPlayer() {
  video.addEventListener("timeupdate", () => setPlayerTime(playerPosition()));
  video.addEventListener("play", () => ($("play").textContent = "Pause"));
  video.addEventListener("pause", () => ($("play").textContent = "Play"));
  video.addEventListener("error", () => {
    if (!player.rec || !video.getAttribute("src")) return;
    const warning = $("player-warning");
    warning.hidden = false;
    warning.textContent = browserDecodes(player.rec.mime)
      ? "Playback failed. The recording may still be available for export."
      : codecAdvice(player.rec);
  });

  $("play").addEventListener("click", () => (video.paused ? video.play().catch(() => {}) : video.pause()));
  $("back").addEventListener("click", () => seek(playerPosition() - 10));
  $("forward").addEventListener("click", () => seek(playerPosition() + 10));
  $("speed").addEventListener("change", () => (video.playbackRate = Number($("speed").value)));
  $("timeline").addEventListener("input", () => {
    player.dragging = true;
    setPlayerTime(Number($("timeline").value));
  });
  $("timeline").addEventListener("change", () => {
    player.dragging = false;
    seek(Number($("timeline").value));
  });
  $("mark-in").addEventListener("click", () => markClip("start"));
  $("mark-out").addEventListener("click", () => markClip("stop"));
  $("clip-clear").addEventListener("click", () => {
    if (!player.rec) return;
    state.clips.delete(player.rec.id);
    render();
    renderClip();
  });
  $("fullscreen").addEventListener("click", () => video.requestFullscreen && video.requestFullscreen());
  $("prev").addEventListener("click", () => stepPlayer(-1));
  $("next").addEventListener("click", () => stepPlayer(1));
  $("close-player").addEventListener("click", closePlayer);
}

/* ------------------------------------------------------------------- init */

function setupTheme() {
  const stored = localStorage.getItem(`${APP}.theme`);
  if (stored) document.documentElement.setAttribute("data-theme", stored);
  $("theme").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(`${APP}.theme`, next);
  });
}

async function refresh() {
  try {
    await loadRecordings();
  } catch (error) {
    setStatus(`Could not load recordings: ${error.message}`, true);
  }
}

async function init() {
  setupTheme();
  setupDestination();
  setupPlayer();

  $("rows").addEventListener("click", onRowClick);
  $("rows").addEventListener("dblclick", (event) => {
    const row = event.target.closest("tr[data-id]");
    if (row && !event.target.closest("input,button")) openPlayer(state.recordings.find((rec) => rec.id === row.dataset.id));
  });
  $("check-all").addEventListener("change", () => {
    for (const rec of state.shown) setSelected(rec, $("check-all").checked);
    updateSummary();
  });
  $("select-all").addEventListener("click", () => {
    for (const rec of state.shown) setSelected(rec, true);
    updateSummary();
  });
  $("select-none").addEventListener("click", () => {
    state.selected.clear();
    render();
  });
  $("sort-start").addEventListener("click", () => {
    state.sortDesc = !state.sortDesc;
    state.anchor = null;
    render();
  });
  for (const id of ["from", "to", "type", "codec", "search"]) {
    $(id).addEventListener("input", () => {
      state.anchor = null;
      render();
    });
  }
  $("trim").addEventListener("change", updateSummary);
  $("disk").addEventListener("change", refresh);
  $("refresh").addEventListener("click", refresh);
  $("export").addEventListener("click", exportSelected);
  $("cancel").addEventListener("click", () => state.abort && state.abort.abort());

  try {
    await loadDisks();
    await loadRecordings();
  } catch (error) {
    setStatus(`Could not load recordings: ${error.message}`, true);
  }
}

init();
