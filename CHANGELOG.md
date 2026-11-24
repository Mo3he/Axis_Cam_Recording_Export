# Changelog

## 0.2.1

- Avoid incomplete regular-expression escaping when reading camera parameters
  by matching parameter names exactly.

## 0.2.0

- Filters for time of day, minimum and maximum length, and event.
- Expected size per recording and for the selection, from a short sample of
  each codec and resolution.
- File name pattern with camera name, model, serial number, date, time, codec,
  event and more, plus a custom name per recording.
- Optional metadata file (`.json`) next to each recording, and a CSV report of
  every export.
- Per-recording export status, two automatic retries, and a *Retry failed*
  button. Failed or cancelled exports no longer leave an empty file in the
  folder.

## 0.1.0

- Initial release: list Edge Storage recordings, filter by date, type, codec
  and text, select many, and export them as MP4 or MKV into a chosen folder or
  as browser downloads.
- Built-in player to review recordings (H.264, H.265, AV1) with seeking and
  clip start/end marks that limit what gets exported.
