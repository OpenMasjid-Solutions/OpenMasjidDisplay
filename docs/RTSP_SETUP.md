<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Connecting screens & sources (RTSP)

## Point a TV's decoder at a screen

1. On the **Screens** page, add a screen and press **Copy link**. There is nothing to configure first —
   the link is built from the address you opened the control panel with, so it already points at this
   server. It looks like:
   `rtsp://192.168.1.50:8554/tv_a1b2c3`
2. In your RTSP-to-HDMI decoder box (or a Raspberry Pi / VLC / mpv acting as one), paste that link and set
   the **transport to TCP**.
3. Choose what the screen shows from the Screens page.

That link never changes. Switching a screen between a timetable, a camera and an HDMI source is a live
change on the server — the decoder keeps the same URL and never needs touching again.

> **Why TCP?** Commodity decoders are most reliable over RTSP/TCP, and it passes firewalls/NAT without extra
> ports. The server only publishes `8554/tcp`.

### Test a link from a computer

```bash
ffplay -rtsp_transport tcp rtsp://192.168.1.50:8554/tv_a1b2c3
# or
vlc --rtsp-tcp rtsp://192.168.1.50:8554/tv_a1b2c3
```

A Raspberry Pi makes a fine decoder in kiosk mode:

```bash
mpv --rtsp-transport=tcp --fs --no-osc rtsp://192.168.1.50:8554/tv_a1b2c3
```

## Add a camera or HDMI source

In **Sources**, add the device's RTSP or secure RTSPS URL, for example:

- Camera (RTSP): `rtsp://user:pass@192.168.1.80:554/stream1`
- Camera (secure RTSPS): `rtsps://192.168.1.1:7441/abcd1234?enableSrtp`
- HDMI encoder: `rtsp://192.168.1.81:554/hdmi`

Both `rtsp://` and the secure `rtsps://` are supported. Use **Test link** before saving — it actually
connects and reads a frame, and tells you *why* it failed (wrong port, auth, transport, TLS) instead of
leaving you to find out at the screen.

**UniFi cameras:** RTSP is off by default in UniFi Protect. Open the camera's
settings → **RTSP**, enable a stream, and paste the link it shows (UniFi gives a
secure `rtsps://…` link). If a secure link won't connect on **Direct** mode (some
UniFi consoles present a self-signed certificate), switch the source to **Most
compatible (re-encode)** — that path connects over TLS without certificate
verification and also handles UniFi's `?enableSrtp` (SRTP) streams.

Credentials in the URL are stored but never displayed in the panel.

**Compatibility mode:**

- **Direct (lightest)** — MediaMTX relays the source as-is. Best on a Raspberry Pi. The screen must be able
  to play the camera's codec (many cameras are H.265).
- **Most compatible (re-encode)** — we transcode the source to a fixed-size H.264 stream so it plays on more
  decoders, and so switching to/from a timetable doesn't change resolution. Uses more CPU — best on a mini-PC.

## Troubleshooting

| Symptom | Try |
|---|---|
| **Black screen / no video** | Set the decoder transport to **TCP**, and check the TV's network can reach this server on `8554`. |
| **The copied link has the wrong address** | The link mirrors the address you opened the panel with. Open the panel using the server's LAN address (not `localhost`) and copy it again. |
| **Camera shows on a computer but not on the cheap box** | Switch that source to **Most compatible (re-encode)**. |
| **Brief freeze when switching** | Expected — the decoder re-reads the new stream. It recovers within a second or two. |
| **Stream never starts** | Use **Test link** on the source. Avoid `@ : / %` in passwords, or URL-encode them. |
| **Wrong RTSP port** | If `8554` was already in use, OpenMasjidOS may have published it on a different host port. Use the port shown in the copied link; it follows the published port. |
| **Screen dimmed with a red bar along the bottom** | Not a decoder fault — the app is telling you the picture is **not current** (the renderer stopped, or this machine's clock is wrong). Check the Screens page, which says which. |

## Networking notes

- Cameras, the server, and the TV decoders should be on the same LAN (or routable to each other).
- Sources are pulled **on demand** — a camera is only contacted while a screen is actually showing it.
- Audio is stripped from relayed video to avoid confusing decoders.
