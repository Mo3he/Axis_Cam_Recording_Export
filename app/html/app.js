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
  names: new Map(), // recording id -> custom file name (may contain fields)
  rates: new Map(), // codec|resolution -> sampled bytes per second
  recRates: new Map(), // recording id -> measured bytes per second from an export
  exportState: new Map(), // recording id -> { text, kind }
  camera: { name: location.hostname, model: "", serial: "" },
  anchor: null,
  sortDesc: true,
  abort: null,
  sampling: null,
  directory: null,
  failed: [],
  results: [],
};

const player = { rec: null, base: 0, token: 0, dragging: false };
const DEFAULT_TEMPLATE = "{camera}_{date}_{time}_{id}";

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function concat(a, b) {
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a);
  merged.set(b, a.length);
  return merged;
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

// ISO 8601 in camera time with its UTC offset, e.g. 2026-11-20T09:54:47.123+01:00.
function cameraIso(date, rec) {
  const offset = offsetMinutes(rec);
  const local = new Date(date.getTime() + offset * 60000).toISOString().slice(0, 23);
  const sign = offset < 0 ? "-" : "+";
  return `${local}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

// datetime-local filter values are camera time; convert them with the recording's offset.
function filterDate(id, rec) {
  const value = $(id).value;
  if (!value) return null;
  const base = value.length === 16 ? `${value}:00` : value;
  return new Date(Date.parse(`${base}Z`) - offsetMinutes(rec) * 60000);
}

// Accepts 90, 1:30, 1:02:03, 30s, 5m, 2h, 1h30m. Returns ms, null when empty, NaN when invalid.
function parseLength(text) {
  const value = text.trim().toLowerCase().replace(/\s+/g, "");
  if (!value) return null;
  if (/^\d+(:\d{1,2}){1,2}$/.test(value)) return value.split(":").reduce((total, part) => total * 60 + Number(part), 0) * 1000;
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s?)?$/.exec(value);
  if (!match || !(match[1] || match[2] || match[3])) return NaN;
  return ((Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0)) * 1000;
}

function lengthFilter(id) {
  const value = parseLength($(id).value);
  $(id).classList.toggle("invalid", Number.isNaN(value));
  return Number.isNaN(value) ? null : value;
}

const timeOfDay = (value) => (Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))) * 60000;

// True when the recording overlaps the daily window (which may wrap past midnight).
function inDailyWindow(rec, from, to) {
  if (!from && !to) return true;
  const day = 86400000;
  const offset = offsetMinutes(rec) * 60000;
  const start = rec.start.getTime() + offset;
  const end = recEnd(rec).getTime() + offset;
  if (end - start >= day) return true;
  const a = from ? timeOfDay(from) : 0;
  const b = to ? timeOfDay(to) : day;
  for (let d = Math.floor(start / day) * day - day; d <= end; d += day) {
    const windowStart = d + a;
    const windowEnd = b > a ? d + b : d + day + b;
    if (start < windowEnd && end > windowStart) return true;
  }
  return false;
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

// Viewers may not be allowed to read every group, so each is optional.
async function loadCamera() {
  const groups = { name: "root.Network.HostName", model: "root.Brand.ProdShortName", serial: "root.Properties.System.SerialNumber" };
  await Promise.all(
    Object.entries(groups).map(async ([key, group]) => {
      try {
        const response = await fetch(`/axis-cgi/param.cgi?action=list&group=${group}`, { credentials: "same-origin" });
        const match = new RegExp(`^${group.replace(/\./g, "\\.")}=(.*)$`, "m").exec(await response.text());
        if (response.ok && match && match[1].trim()) state.camera[key] = match[1].trim();
      } catch {
        /* keep the default */
      }
    }),
  );
  updateTemplatePreview();
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

function fillEvents() {
  const select = $("event");
  const current = select.value;
  const triggers = [...new Set(state.recordings.map((rec) => rec.trigger).filter(Boolean))].sort();
  select.replaceChildren(new Option("All", ""), ...triggers.map((trigger) => new Option(trigger, trigger)));
  select.value = triggers.includes(current) ? current : "";
}

async function loadRecordings() {
  const disk = $("disk").value;
  setStatus("Loading recordings...");
  const doc = await fetchXml(`${RECORD}/list.cgi?recordingid=all&diskid=${encodeURIComponent(disk)}`);
  state.recordings = [...doc.getElementsByTagName("recording")].map(parseRecording);
  const ids = new Set(state.recordings.map((rec) => rec.id));
  for (const map of [state.clips, state.names, state.exportState, state.recRates]) {
    for (const id of [...map.keys()]) if (!ids.has(id)) map.delete(id);
  }
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
  fillEvents();
  render();
  setStatus("");
  sampleRates();
}

function matchesFilters(rec) {
  const from = filterDate("from", rec);
  const to = filterDate("to", rec);
  if (from && recEnd(rec) < from) return false;
  if (to && rec.start > to) return false;
  if ($("type").value && rec.type !== $("type").value) return false;
  if ($("codec").value && rec.mime !== $("codec").value) return false;
  if ($("event").value && rec.trigger !== $("event").value) return false;
  if (!inDailyWindow(rec, $("tod-from").value, $("tod-to").value)) return false;
  const length = recEnd(rec) - rec.start;
  const min = lengthFilter("min-length");
  const max = lengthFilter("max-length");
  if (min !== null && length < min) return false;
  if (max !== null && length > max) return false;
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
    cell(row, "").dataset.size = "1";
    const clip = state.clips.get(rec.id);
    cell(row, clip ? `${cameraTime(clip.start, rec).slice(11)} - ${cameraTime(clip.stop, rec).slice(11)}` : "");

    const name = document.createElement("input");
    name.type = "text";
    name.className = "name";
    name.spellcheck = false;
    name.dataset.name = "1";
    name.value = state.names.get(rec.id) || "";
    name.setAttribute("aria-label", "File name");
    row.insertCell().append(name);

    cell(row, "").dataset.export = "1";

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
    td.colSpan = 13;
  }
  updateSummary();
}

// Size estimates, name placeholders and export status change without the list
// changing, so update those cells in place (keeps focus in a name being typed).
function refreshRows() {
  const order = new Map(
    state.recordings
      .filter((rec) => state.selected.has(rec.id))
      .sort((a, b) => a.start - b.start)
      .map((rec, index) => [rec.id, index + 1]),
  );
  for (const row of $("rows").querySelectorAll("tr[data-id]")) {
    const rec = state.recordings.find((item) => item.id === row.dataset.id);
    if (!rec) continue;
    const size = row.querySelector("td[data-size]");
    const bytes = estimateBytes(rec);
    size.textContent = bytes === null ? (state.sampling ? "..." : "") : `${state.recRates.has(rec.id) ? "" : "~"}${formatBytes(bytes)}`;
    size.className = state.recRates.has(rec.id) ? "" : "estimate";
    row.querySelector("input[data-name]").placeholder = fileBase(rec, exportRange(rec), order.get(rec.id) || 1);
    const status = state.exportState.get(rec.id);
    const td = row.querySelector("td[data-export]");
    td.textContent = status ? status.text : "";
    td.className = status ? `st-${status.kind}` : "";
    td.title = status && status.title ? status.title : "";
  }
}

function setExportState(rec, text, kind, title) {
  state.exportState.set(rec.id, { text, kind, title });
  const td = $("rows").querySelector(`tr[data-id="${CSS.escape(rec.id)}"] td[data-export]`);
  if (td) {
    td.textContent = text;
    td.className = `st-${kind}`;
    td.title = title || "";
  }
}

function updateSummary() {
  refreshRows();
  const selected = state.recordings.filter((rec) => state.selected.has(rec.id));
  const hidden = selected.filter((rec) => !state.shown.includes(rec)).length;
  const total = selected.reduce((sum, rec) => sum + exportSeconds(rec) * 1000, 0);
  let text = `${state.shown.length} of ${state.recordings.length} recordings shown, ${selected.length} selected`;
  if (selected.length) {
    const estimates = selected.map(estimateBytes);
    const bytes = estimates.reduce((sum, value) => sum + (value || 0), 0);
    text += ` (${formatDuration(total)}`;
    if (estimates.every((value) => value !== null)) text += `, about ${formatBytes(bytes)}`;
    else if (bytes) text += `, more than ${formatBytes(bytes)}`;
    text += ")";
  }
  if (hidden) text += `, ${hidden} of them hidden by filters`;
  $("summary").textContent = text;
  $("export").disabled = !selected.length || Boolean(state.abort);
  const shownSelected = state.shown.filter((rec) => state.selected.has(rec.id)).length;
  $("check-all").checked = state.shown.length > 0 && shownSelected === state.shown.length;
  $("check-all").indeterminate = shownSelected > 0 && shownSelected < state.shown.length;
  updateTemplatePreview();
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
  if (!row || event.target.dataset.name) return;
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

/* ------------------------------------------------------------ file names */

const template = () => $("template").value.trim() || DEFAULT_TEMPLATE;

function fields(rec, range, n) {
  const start = range ? range.start : rec.start;
  const stop = range ? range.stop : recEnd(rec);
  const seconds = Math.round((stop - start) / 1000);
  return {
    camera: state.camera.name,
    model: state.camera.model,
    serial: state.camera.serial,
    date: cameraTime(start, rec).slice(0, 10),
    time: cameraTime(start, rec).slice(11).replace(/:/g, "-"),
    end: cameraTime(stop, rec).slice(11).replace(/:/g, "-"),
    duration: `${pad(Math.floor(seconds / 3600))}h${pad(Math.floor(seconds / 60) % 60)}m${pad(seconds % 60)}s`,
    type: rec.type,
    trigger: rec.trigger,
    codec: codecLabel(rec),
    resolution: rec.resolution,
    id: rec.id,
    n: String(n || 1).padStart(3, "0"),
  };
}

// Windows forbids <>:"/\|?* and control characters, and trailing dots or spaces.
function sanitize(name) {
  const clean = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.(mp4|mkv)$/i, "")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 180);
  return clean || "recording";
}

function fileBase(rec, range, n) {
  const values = fields(rec, range, n);
  const pattern = state.names.get(rec.id) || template();
  return sanitize(pattern.replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match)));
}

function updateTemplatePreview() {
  const selected = state.recordings.filter((item) => state.selected.has(item.id)).sort((a, b) => a.start - b.start);
  const rec = selected[0] || state.shown[0];
  const extension = $("format").value === "matroska" ? "mkv" : "mp4";
  $("template-preview").textContent = rec ? `${fileBase(rec, exportRange(rec), 1)}.${extension}` : "";
}

/* -------------------------------------------------------- size estimates */

const groupKey = (rec) => `${rec.mime}|${rec.resolution}`;
const exportSeconds = (rec) => {
  const range = exportRange(rec);
  return ((range ? range.stop - range.start : recEnd(rec) - rec.start) || 0) / 1000;
};

function estimateBytes(rec) {
  const rate = state.recRates.get(rec.id) || state.rates.get(groupKey(rec));
  return rate ? rate * exportSeconds(rec) : null;
}

// MP4 mvhd creation_time (seconds since 1904), which the camera sets to the first frame.
function findMvhdTime(bytes) {
  for (let i = 0; i + 20 <= bytes.length; i++) {
    if (bytes[i] === 0x6d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + i + 4);
      const seconds = view.getUint8(0) === 1 ? Number(view.getBigUint64(4)) : view.getUint32(4);
      return seconds ? new Date(Date.UTC(1904, 0, 1) + seconds * 1000) : null;
    }
  }
  return null;
}

const findStart = (bytes) => findDateUtc(bytes) || findMvhdTime(bytes);

// Bytes per second of a short ranged export. The export starts at the keyframe
// before the range, which the header reveals, so that part is counted too.
async function measureRate(rec, range, signal) {
  try {
    const response = await fetch(exportUrl(rec, "matroska", range), { credentials: "same-origin", signal });
    if (!response.ok) return null;
    const reader = response.body.getReader();
    let head = new Uint8Array(0);
    let actual = null;
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (!actual && head.length < 16384) {
        head = concat(head, value);
        actual = findDateUtc(head);
      }
    }
    const start = actual && actual < range.start ? actual : range.start;
    const seconds = (range.stop - start) / 1000;
    return bytes && seconds > 0.5 ? bytes / seconds : null;
  } catch {
    return null;
  }
}

// One sample per codec and resolution, from the middle of the newest finished recording.
async function sampleRates() {
  if (state.sampling || state.abort) return;
  const groups = new Map();
  for (const rec of state.recordings) {
    if (!rec.stop || rec.stop - rec.start < 3000 || state.rates.has(groupKey(rec))) continue;
    const best = groups.get(groupKey(rec));
    if (!best || rec.start > best.start) groups.set(groupKey(rec), rec);
  }
  if (!groups.size) return;
  state.sampling = new AbortController();
  refreshRows();
  try {
    for (const rec of groups.values()) {
      if (state.sampling.signal.aborted) break;
      const length = Math.min(10000, rec.stop - rec.start);
      const middle = rec.start.getTime() + (rec.stop - rec.start) / 2;
      const range = { start: new Date(middle - length / 2), stop: new Date(middle + length / 2) };
      const rate = await measureRate(rec, range, state.sampling.signal);
      if (rate) state.rates.set(groupKey(rec), rate);
      refreshRows();
      updateSummary();
    }
  } finally {
    state.sampling = null;
    refreshRows();
  }
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

async function saveText(directory, name, text, type) {
  if (directory) {
    const writable = await (await directory.getFileHandle(name, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  } else {
    saveBlob(new Blob([text], { type }), name);
  }
}

function metadata(job, bytes, actualStart) {
  const { rec, range } = job;
  const at = (date) => (date ? { utc: date.toISOString(), camera: cameraIso(date, rec) } : null);
  return {
    file: job.name,
    camera: { name: state.camera.name, model: state.camera.model, serial: state.camera.serial, address: location.host },
    recording: {
      id: rec.id,
      disk: rec.disk,
      type: rec.type,
      trigger: rec.trigger,
      codec: codecLabel(rec),
      mimeType: rec.mime,
      resolution: rec.resolution,
      start: at(rec.start),
      stop: at(rec.stop),
    },
    export: {
      format: job.format === "matroska" ? "mkv" : "mp4",
      requestedStart: range ? at(range.start) : null,
      requestedStop: range ? at(range.stop) : null,
      firstFrame: at(actualStart),
      bytes,
      exportedAt: new Date().toISOString(),
    },
  };
}

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    // Client errors will not change on retry, except timeouts and rate limits.
    this.permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
}

async function exportOnce(job, directory, signal, onBytes) {
  const response = await fetch(exportUrl(job.rec, job.format, job.range), { credentials: "same-origin", signal });
  if (!response.ok) throw new HttpError(response.status);

  const reader = response.body.getReader();
  const chunks = [];
  let head = new Uint8Array(0);
  let actualStart = null;
  let bytes = 0;
  // A file handle's writable only replaces the file on close, so a failed or
  // cancelled export never leaves partial data behind.
  const writable = directory ? await (await directory.getFileHandle(job.name, { create: true })).createWritable() : null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (!actualStart && head.length < 16384) {
        head = concat(head, value);
        actualStart = findStart(head);
      }
      if (writable) await writable.write(value);
      else chunks.push(value);
      onBytes(bytes);
    }
    if (!bytes) throw new Error("camera returned an empty file");
    if (writable) await writable.close();
  } catch (error) {
    if (writable) {
      await writable.abort().catch(() => {});
      // Opening the handle created an empty file; remove it so a retry or rerun is not skipped.
      await directory.removeEntry(job.name).catch(() => {});
    }
    throw error;
  }
  if (!writable) saveBlob(new Blob(chunks, { type: job.format === "matroska" ? "video/x-matroska" : "video/mp4" }), job.name);
  return { bytes, actualStart };
}

function buildJobs(items) {
  const format = $("format").value;
  const extension = format === "matroska" ? "mkv" : "mp4";
  const used = new Set();
  return items.map((rec, index) => {
    const range = exportRange(rec);
    const base = fileBase(rec, range, index + 1);
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base}_${k}`;
    used.add(name.toLowerCase());
    return { rec, range, format, base: name, name: `${name}.${extension}` };
  });
}

function exportSelected() {
  const items = state.recordings.filter((rec) => state.selected.has(rec.id)).sort((a, b) => a.start - b.start);
  if (items.length) runExport(buildJobs(items), true);
}

async function runExport(jobs, pickFolder) {
  const toFolder = $("destination").value === "folder" && folderSupported();
  let directory = null;
  if (toFolder) {
    directory = pickFolder ? null : state.directory;
    if (!directory) {
      try {
        directory = await window.showDirectoryPicker({ id: APP, mode: "readwrite", startIn: "videos" });
      } catch {
        return; // picker dismissed
      }
    }
  }
  state.directory = directory;
  if (state.sampling) state.sampling.abort();

  state.abort = new AbortController();
  const signal = state.abort.signal;
  const sidecar = $("sidecar").checked;
  $("cancel").hidden = false;
  $("retry").hidden = true;
  $("report").hidden = true;
  $("progress").hidden = false;
  $("progress").max = 1;
  $("progress").value = 0;
  updateSummary();

  const estimates = jobs.map((job) => estimateBytes(job.rec));
  const totalEstimate = estimates.every((value) => value !== null) ? estimates.reduce((a, b) => a + b, 0) : null;
  for (const job of jobs) setExportState(job.rec, "queued", "busy");

  const started = performance.now();
  let doneBytes = 0;
  const results = [];
  const counts = { ok: 0, skipped: 0, failed: 0 };

  const showProgress = (index, job, bytes) => {
    const transferred = doneBytes + bytes;
    const seconds = (performance.now() - started) / 1000;
    const speed = transferred / Math.max(seconds, 0.1);
    let text = `Exporting ${index + 1}/${jobs.length}: ${job.name} - ${formatBytes(bytes)}`;
    if (estimates[index]) text += ` of ~${formatBytes(estimates[index])}`;
    text += ` (${(speed / 1048576).toFixed(1)} MB/s)`;
    if (totalEstimate && speed > 0) {
      const left = Math.max(0, totalEstimate - transferred) / speed;
      text += `. Total ${formatBytes(transferred)} of ~${formatBytes(totalEstimate)}, about ${formatDuration(left * 1000)} left`;
    }
    setStatus(text);
    $("progress").value = totalEstimate ? Math.min(0.99, transferred / totalEstimate) : index / jobs.length;
    setExportState(job.rec, estimates[index] ? `${Math.min(99, Math.round((bytes / estimates[index]) * 100))}%` : formatBytes(bytes), "busy");
  };

  for (const [index, job] of jobs.entries()) {
    if (signal.aborted) break;
    const result = { job, status: "", bytes: 0, error: "" };
    results.push(result);

    if (directory && (await fileExists(directory, job.name))) {
      log(`${job.name}: already in folder, skipped`);
      setExportState(job.rec, "skipped", "ok", "A file with this name is already in the folder");
      result.status = "skipped";
      counts.skipped++;
      continue;
    }

    for (let attempt = 1; ; attempt++) {
      try {
        showProgress(index, job, 0);
        const { bytes, actualStart } = await exportOnce(job, directory, signal, (bytes) => showProgress(index, job, bytes));
        const seconds = exportSeconds(job.rec) + (actualStart && job.range ? Math.max(0, (job.range.start - actualStart) / 1000) : 0);
        if (seconds > 1) state.recRates.set(job.rec.id, bytes / seconds);
        if (sidecar) {
          await saveText(directory, `${job.base}.json`, `${JSON.stringify(metadata(job, bytes, actualStart), null, 2)}\n`, "application/json").catch(
            (error) => log(`${job.base}.json: could not be saved (${error.message})`, "error"),
          );
        }
        doneBytes += bytes;
        log(`${job.name}: ${formatBytes(bytes)}`, "ok");
        setExportState(job.rec, `done, ${formatBytes(bytes)}`, "ok");
        Object.assign(result, { status: "exported", bytes });
        counts.ok++;
        break;
      } catch (error) {
        if (signal.aborted) {
          log(`${job.name}: cancelled`, "error");
          setExportState(job.rec, "cancelled", "error");
          result.status = "cancelled";
          break;
        }
        if (attempt < 3 && !error.permanent) {
          log(`${job.name}: ${error.message}, retrying (${attempt + 1}/3)`, "error");
          setExportState(job.rec, `retry ${attempt + 1}/3`, "busy", error.message);
          await sleep(2000 * attempt);
          if (!signal.aborted) continue;
        }
        log(`${job.name}: failed (${error.message})`, "error");
        setExportState(job.rec, "failed", "error", error.message);
        Object.assign(result, { status: "failed", error: error.message });
        counts.failed++;
        break;
      }
    }
  }

  const cancelled = signal.aborted;
  for (const job of jobs.slice(results.length)) {
    setExportState(job.rec, "not exported", "error");
    results.push({ job, status: "cancelled", bytes: 0, error: "" });
  }
  state.abort = null;
  // A retry updates the rows of the earlier run, so the report covers both.
  const merged = new Map(pickFolder ? [] : state.results.map((result) => [result.job.rec.id, result]));
  for (const result of results) merged.set(result.job.rec.id, result);
  state.results = [...merged.values()].sort((a, b) => a.job.rec.start - b.job.rec.start);
  state.failed = state.results.filter((result) => result.status === "failed").map((result) => result.job);
  $("cancel").hidden = true;
  $("progress").value = cancelled ? $("progress").value : 1;
  $("retry").hidden = !state.failed.length;
  $("retry").textContent = `Retry failed (${state.failed.length})`;
  $("report").hidden = false;
  refreshRows();
  updateSummary();
  const summary = `${counts.ok} exported (${formatBytes(doneBytes)})${counts.skipped ? `, ${counts.skipped} skipped` : ""}${counts.failed ? `, ${counts.failed} failed` : ""}`;
  setStatus(cancelled ? `Cancelled: ${summary}.` : `Done: ${summary}.`, counts.failed > 0);
  sampleRates();
}

async function saveReport() {
  const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const lines = [["file", "recording id", "start (camera time)", "stop (camera time)", "duration", "codec", "resolution", "status", "bytes", "error"]];
  for (const { job, status, bytes, error } of state.results) {
    const start = job.range ? job.range.start : job.rec.start;
    const stop = job.range ? job.range.stop : recEnd(job.rec);
    lines.push([job.name, job.rec.id, cameraTime(start, job.rec), cameraTime(stop, job.rec), formatDuration(stop - start), codecLabel(job.rec), job.rec.resolution, status, bytes, error]);
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const name = `${sanitize(state.camera.name)}_export-report_${stamp}.csv`;
  try {
    await saveText(state.directory, name, `\ufeff${lines.map((line) => line.map(quote).join(",")).join("\r\n")}\r\n`, "text/csv");
    log(`${name}: report saved`, "ok");
  } catch (error) {
    log(`${name}: could not be saved (${error.message})`, "error");
  }
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
      bytes = concat(bytes, value);
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
  for (const id of ["from", "to", "type", "codec", "event", "tod-from", "tod-to", "min-length", "max-length", "search"]) {
    $(id).addEventListener("input", () => {
      state.anchor = null;
      render();
    });
  }
  $("clear-filters").addEventListener("click", () => {
    for (const id of ["from", "to", "type", "codec", "event", "tod-from", "tod-to", "min-length", "max-length", "search"]) $(id).value = "";
    state.anchor = null;
    render();
  });
  $("rows").addEventListener("input", (event) => {
    const row = event.target.closest("tr[data-id]");
    if (!row || !event.target.dataset.name) return;
    const value = event.target.value.trim();
    if (value) state.names.set(row.dataset.id, value);
    else state.names.delete(row.dataset.id);
    updateTemplatePreview();
  });
  $("template").value = localStorage.getItem(`${APP}.template`) || DEFAULT_TEMPLATE;
  $("template").addEventListener("input", () => {
    localStorage.setItem(`${APP}.template`, $("template").value);
    refreshRows();
    updateTemplatePreview();
  });
  $("sidecar").checked = localStorage.getItem(`${APP}.sidecar`) === "1";
  $("sidecar").addEventListener("change", () => localStorage.setItem(`${APP}.sidecar`, $("sidecar").checked ? "1" : "0"));
  $("format").addEventListener("change", updateTemplatePreview);
  $("trim").addEventListener("change", render);
  $("disk").addEventListener("change", refresh);
  $("refresh").addEventListener("click", refresh);
  $("export").addEventListener("click", exportSelected);
  $("cancel").addEventListener("click", () => state.abort && state.abort.abort());
  $("retry").addEventListener("click", () => state.failed.length && runExport(state.failed, false));
  $("report").addEventListener("click", saveReport);

  loadCamera();
  try {
    await loadDisks();
    await loadRecordings();
  } catch (error) {
    setStatus(`Could not load recordings: ${error.message}`, true);
  }
}

init();
