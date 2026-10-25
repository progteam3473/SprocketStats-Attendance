# SprocketStats-Attendance

Attendance kiosk for FRC Team Sprocket 3473. Members tap their NFC ID card on an
ACR122U reader and the kiosk checks them in against the SprocketStats backend.

It is a Tauri 2 desktop app: a React 19 + Vite + Tailwind 4 frontend, with a Rust
side (`src-tauri/`) that talks to the card reader. The same frontend is also
deployed to Vercel as a web build.

## How it works

1. A background Rust thread polls the ACR122U over PC/SC (the `pcsc` crate).
2. When a card is presented it reads the NDEF text record holding the member's
   21-digit ID.
3. Rust emits a Tauri `nfc-scan` event with the ID to the React frontend.
4. The frontend POSTs the ID to the backend at `/kiosk/verify_id`.
5. The frontend reports the result back through the `nfc_feedback` command. The
   reader LED turns green if the backend accepted the scan, or blinks red if not.

A hidden, always-focused keyboard-capture input stays on the kiosk page as a
fallback for USB keyboard-wedge readers, which "type" the ID followed by Enter.
This is also how the Vercel web build receives scans, since it has no PC/SC access.

## Kiosk flow

- **Setup page**: on first start, a captain authorizes the kiosk by entering their
  offline code. The backend answers with an httponly `kiosk_auth` cookie that is
  sent with every later request.
- **Kiosk page**: the main screen. It waits for card taps and shows each check-in
  result.
- **Manual check-in**: for members without their card. The member enters their
  offline code, then an admin countersigns by entering their own code or tapping
  their card.

## Prerequisites

- Node.js 22
- Rust (stable toolchain)
- Tauri 2 system dependencies for your OS. See the
  [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). On
  Debian/Ubuntu:
  `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev build-essential pkg-config`
- PC/SC:
  - **Linux**: install `pcscd` and `libpcsclite-dev`, then make sure the service
    is running (`sudo systemctl enable --now pcscd`).
  - **Windows / macOS**: PC/SC is built in.

### ACR122U notes

- Windows and macOS usually work with the built-in CCID driver. If the reader is
  not detected, install the driver from ACS.
- On Linux, the `pn533_usb` / `pn533` / `nfc` kernel modules can claim the
  ACR122U before `pcscd` sees it. If so, blacklist them:

  ```sh
  printf 'blacklist pn533_usb\nblacklist pn533\nblacklist nfc\n' | \
    sudo tee /etc/modprobe.d/blacklist-acr122u.conf
  sudo modprobe -r pn533_usb pn533 nfc
  sudo systemctl restart pcscd
  ```

## Setup

```sh
cp .env.example .env   # then set VITE_BACKEND_URL to the SprocketStats backend
npm ci
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Frontend only in the browser (no NFC, keyboard-wedge input only) |
| `npm run tauri dev` | Full desktop app with hot reload |
| `npm run tauri build` | Production desktop bundle |
| `cargo test` (in `src-tauri/`) | Rust unit tests |

CI (`.github/workflows/ci.yml`) builds the frontend and runs `cargo clippy` and
`cargo test` on every pull request and push to `main`. Pushes to `main` also
deploy the web build to Vercel.

## Kiosk behavior

- The window is fullscreen, undecorated and always on top.
- Closing the window is blocked. To quit, kill the process (for example from a
  terminal or the task manager).
- Logs go to stdout and to the OS app log directory for the identifier
  `org.team3473.attendance`:
  - Linux: `~/.local/share/org.team3473.attendance/logs/`
  - macOS: `~/Library/Logs/org.team3473.attendance/`
  - Windows: `%LOCALAPPDATA%\org.team3473.attendance\logs\`

## Releasing

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds Windows
(`.msi`/`.exe`), macOS (universal `.dmg`) and Linux (`.deb`/`.rpm`/`.AppImage`)
installers and publishes them as a GitHub release.

1. Set the repository variable `VITE_BACKEND_URL` (Settings > Secrets and
   variables > Actions > Variables) to the production backend URL. It is baked
   into the installers, and the release fails if it is missing.
2. Bump `version` in both `package.json` and `src-tauri/Cargo.toml`
   (`tauri.conf.json` reads `package.json`). The workflow refuses a tag that
   doesn't match both.
3. Commit, then tag and push: `git tag v1.0.1 && git push origin v1.0.1`.
