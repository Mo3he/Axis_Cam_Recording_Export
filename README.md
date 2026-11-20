# Recording Export ACAP for Axis Cameras

[![Release](https://img.shields.io/github/v/release/Mo3he/Axis_Cam_Recording_Export?style=flat)](https://github.com/Mo3he/Axis_Cam_Recording_Export/releases)
[![Build](https://github.com/Mo3he/Axis_Cam_Recording_Export/actions/workflows/build.yml/badge.svg)](https://github.com/Mo3he/Axis_Cam_Recording_Export/actions/workflows/build.yml)
[![License](https://img.shields.io/github/license/Mo3he/Axis_Cam_Recording_Export?style=flat)](LICENSE)
[![Super-Linter](https://github.com/Mo3he/Axis_Cam_Recording_Export/actions/workflows/super-linter.yml/badge.svg)](https://github.com/Mo3he/Axis_Cam_Recording_Export/actions/workflows/super-linter.yml)
[![Sponsor](https://img.shields.io/badge/Sponsor%20My%20Work-EA4AAA?style=flat&logo=github&logoColor=white)](https://github.com/sponsors/Mo3he)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=flat&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/mo3he)

Select and bulk-export SD card recordings from the camera's web interface.

> **Disclaimer:** Independent, community-developed ACAP package. Not an official
> Axis product and not affiliated with, endorsed by, or supported by Axis
> Communications AB. Use at your own risk.

## Overview

- Lists every recording on the camera's SD card (or network share) in the
  camera's own web interface, with filters for date range, recording type,
  codec, and trigger text.
- Select any number of recordings (click, Shift-click, or select all shown) and
  export them in one go as MP4 or MKV.
- Review recordings in a built-in player before exporting: seek, play at up to
  8x, step to the previous or next recording, and mark a clip start and end so
  only that part is exported.
- Supports H.264, H.265, and AV1 recordings. AV1 and H.265 export on any
  browser; in-browser playback depends on the browser's decoders (see
  [Compatibility](#compatibility)).
- Stores nothing on the camera and needs no extra credentials: the page uses
  the signed-in user's session to call the camera's Edge Storage APIs.

## Compatibility

| Package | AXIS OS | Architecture | Status |
|---|---|---|---|
| ACAP 4 | 11.11 - 13 | aarch64 | Supported |
| ACAP 4 | 11.11 - 13 | armv7hf | Supported |

The app runs as the unprivileged `sdk` user. It does not require root access.
Tested on an AXIS P3288-LV (ARTPEC-9) with AXIS OS 12.11 and H.264, H.265, and
AV1 recordings.

| Browser | Export | Save into a folder | Play H.264 | Play H.265 | Play AV1 |
|---|---|---|---|---|---|
| Chrome / Edge, camera over HTTPS | Yes | Yes | Yes | Yes (1) | Yes (2) |
| Chrome / Edge, camera over HTTP | Yes | No, browser downloads | Yes | Yes (1) | Yes (2) |
| Firefox / Safari | Yes | No, browser downloads | Yes | Varies | Varies |

1. Needs hardware HEVC decoding; Edge on Windows also needs the HEVC Video
   Extensions from the Microsoft Store.
2. Edge on Windows uses the AV1 Video Extension from the Microsoft Store
   (preinstalled on most Windows 11 systems).

When the browser cannot decode a recording, the codec is shown in red and the
player says so; the recording can still be exported and played in VLC or
another desktop player.

## Installation

Download the EAP matching the camera architecture from the
[Releases page](https://github.com/Mo3he/Axis_Cam_Recording_Export/releases),
upload it in the camera web interface under **Apps -> Add app**, and start it.
Open the app with **Apps -> Recording Export -> Open**.

## Configuration

There is nothing to configure. Everything is chosen on the page:

- **Storage:** which disk to list (SD card or network share).
- **From / To:** camera local time. With **Cut recordings to From/To** checked,
  exports are trimmed to that window instead of including whole recordings.
- **Clip start / end:** set in the player for a single recording; it takes
  priority over From/To for that recording.
- **Format:** MP4 or MKV. Both keep the original video (no re-encoding).
- **Save to:** *A folder I choose* streams each file straight into a folder and
  skips files that are already there (Chrome or Edge with the camera opened
  over HTTPS). *Browser downloads* saves each recording as a normal download;
  allow multiple downloads if the browser asks.

Files are named `<camera>_<start time>_<recording id>.<ext>`, using camera local
time. Exports are processed one at a time to keep the load on the camera low,
and can be cancelled.

## Ports & security

- The app opens no ports and runs no network service; its process only keeps
  the app in the Running state.
- The page is served by the camera under `/local/Recording_Export/` and is
  only reachable after signing in to the camera.
- All data comes from the camera's own VAPIX Edge Storage APIs
  (`/axis-cgi/disks/list.cgi`, `/axis-cgi/record/list.cgi`, and
  `/axis-cgi/record/export/exportrecording.cgi`), called with the user's own
  session, so a user can only list and export what their account allows.
- Nothing is stored on the camera, and recordings are never modified or
  deleted.

## How it works

The camera's export API streams a fragmented MP4 or Matroska file without
support for HTTP range requests. The player therefore plays the export as a
stream and handles every seek by requesting a new export starting at the
chosen time. The camera starts such an export at the previous keyframe and
resets its timestamps, so the page first reads only the Matroska header of the
same range (which carries the exact start time) to keep the timeline and clip
marks accurate.

Trimmed exports (From/To or a clip) also start at the keyframe before the
requested time, so they can include a little extra video at the start.

## Build from source

Docker or Podman is required; the Axis ACAP Native SDK image does the build.

```sh
./build.sh                 # aarch64 and armv7hf into ./releases
ARCHES=aarch64 ./build.sh  # a single architecture
```

### CI

Every push builds both architectures and uploads the packages as workflow
artifacts. Pushing a `v*` tag creates a release with the packages attached.

## Links

- Releases: <https://github.com/Mo3he/Axis_Cam_Recording_Export/releases>
- Issues: <https://github.com/Mo3he/Axis_Cam_Recording_Export/issues>
- ACAP documentation: <https://developer.axis.com/acap/>
- Axis Communications: <https://www.axis.com/>

## License

The packaging and app code in this repository is licensed under BSD 3-Clause
(see [LICENSE](LICENSE)). Build-time dependencies are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
