// Fictional recording metadata for the offline UI; refresh the copied UI and sample XML from the app's camera-facing screen/API when it changes.
"use strict";

const recordingsXml = `<?xml version="1.0" encoding="UTF-8"?>
<root><recordinglist>
  <recording recordingid="sample-0003" diskid="SD_DISK" starttime="2026-01-11T09:18:00Z" starttimelocal="2026-01-11T10:18:00+01:00" stoptime="2026-01-11T09:31:42Z" recordingtype="triggered" eventtrigger="Sample motion event" recordingstatus="completed"><video mimetype="video/x-h264" resolution="1920x1080"/></recording>
  <recording recordingid="sample-0002" diskid="SD_DISK" starttime="2026-01-11T08:42:15Z" starttimelocal="2026-01-11T09:42:15+01:00" stoptime="2026-01-11T08:57:15Z" recordingtype="continuous" eventtrigger="Scheduled sample" recordingstatus="completed"><video mimetype="video/x-h265" resolution="1920x1080"/></recording>
  <recording recordingid="sample-0001" diskid="SD_DISK" starttime="2026-01-10T18:05:00Z" starttimelocal="2026-01-10T19:05:00+01:00" stoptime="2026-01-10T18:06:28Z" recordingtype="triggered" eventtrigger="Sample door contact" recordingstatus="completed"><video mimetype="video/x-h264" resolution="1280x720"/></recording>
</recordinglist></root>`;

const disksXml = `<?xml version="1.0" encoding="UTF-8"?><root><disklist><disk diskid="SD_DISK" status="OK"/></disklist></root>`;
const cameraValues = {
  "root.Network.HostName": "camera-sample.example.invalid",
  "root.Brand.ProdShortName": "Sample Camera Model",
  "root.Properties.System.SerialNumber": "SAMPLE-000000",
};

function response(body, status = 200, type = "text/plain") {
  return new Response(body, { status, headers: { "Content-Type": type } });
}

window.fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input.url, location.href);
  if (url.origin !== location.origin) return response("Offline preview blocks external requests.", 403);
  if (url.pathname.endsWith("/axis-cgi/disks/list.cgi")) return response(disksXml, 200, "application/xml");
  if (url.pathname.endsWith("/axis-cgi/record/list.cgi")) return response(recordingsXml, 200, "application/xml");
  if (url.pathname.endsWith("/axis-cgi/param.cgi")) {
    const group = url.searchParams.get("group") || "";
    return response(`${group}=${cameraValues[group] || "Fictional sample"}\n`);
  }
  if (url.pathname.endsWith("/axis-cgi/record/export/exportrecording.cgi"))
    return response("Offline preview: no recording media is available or generated.", 403);
  return response("Offline preview: this endpoint is not available.", 404);
};

const exportButton = document.getElementById("export");
const disableExport = () => {
  if (!exportButton.disabled) exportButton.disabled = true;
  exportButton.title = "Offline preview: recording export is disabled.";
  document.querySelectorAll("#rows button[data-play]").forEach((button) => {
    button.disabled = true;
    button.title = "Offline preview: recording playback is disabled.";
  });
};
new MutationObserver(disableExport).observe(document.getElementById("rows"), { childList: true });
new MutationObserver(disableExport).observe(exportButton, { attributes: true, attributeFilter: ["disabled"] });
disableExport();

document.addEventListener(
  "click",
  (event) => {
    const target = event.target.closest("#rows [data-play], #export, #retry, #report");
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    document.getElementById("status").textContent =
      target.id === "report"
        ? "Offline preview: reports are disabled."
        : "Offline preview: playback and export are disabled; no video file is supplied.";
  },
  true,
);

document.addEventListener(
  "dblclick",
  (event) => {
    if (!event.target.closest("#rows tr[data-id]")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    document.getElementById("status").textContent = "Offline preview: playback is disabled; no video file is supplied.";
  },
  true,
);
