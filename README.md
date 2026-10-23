# DS4 Gamepad Configurator

Browser-based configurator for the CH32V307 8 kHz DS4 gamepad. No install, no backend — configure over **Web Serial**, flash firmware over **WebUSB**.

`v0.1.0` · Companion firmware: [8khz-ds4-gamepad-ch32v307](https://github.com/P1nkDog/8khz-ds4-gamepad-ch32v307)

English | [中文](./README.zh-CN.md)

---

## Getting started

### Prerequisites

- **Chrome or Edge 89+** (WebUSB + Web Serial are required)
- The page must be served over **`https://`** or **`http://localhost`** — double-clicking `index.html` will not work
- Windows needs [Zadig](https://zadig.akeo.ie/) once, to bind the WinUSB driver

### 0. Open the page (pick one)

**Option A — use the hosted version** 

If the author has deployed it, open that URL in Chrome / Edge. Nothing needs to be installed.

**Option B — run it on your own machine** (offline use, or to see your code changes immediately)

Browsers do not allow pages like this to run over `file://`, so a tiny local web server is needed. The repo ships a script for it, so there are no commands to type — but it does require **Python 3 or Node.js** (either one) on your machine. If you have neither, install Python as described below.

1. Download the whole project: click **`Code` → `Download ZIP`** on GitHub, then extract it anywhere.
   ⚠️ Extract the **whole folder** — the page loads `js/`, `css/`, `images/`. Copying only `index.html` will not work.
2. Double-click **`start.bat`** inside the folder. A console window opens, picks a runtime automatically, starts the server and opens your browser.
3. The address is `http://localhost:8080` — type it manually if the browser did not open.
4. Press **`Ctrl + C`** in that window to stop, or just close it.

> ⚠️ **Never double-click `index.html`** — it opens over `file://`, the ES modules are blocked by the browser's security policy, and you get a blank page. Always use the `http://localhost` URL started by `start.bat`.

**See "python / py / npx not found"?** No runtime is installed yet. Python alone is enough (Node is not required): download it from [python.org/downloads](https://www.python.org/downloads/) and **tick `Add python.exe to PATH`** on the first installer page, then double-click `start.bat` again.

**macOS / Linux** (there is no `start.bat`):

```bash
cd dsv4
python3 -m http.server 8080
```

Then open `http://localhost:8080` and press `Ctrl + C` to stop.

### 1. Flash the firmware (first time only)

1. Set the **BOOT1** switch (bottom of the board) to **1**
2. Connect the board with a USB cable
3. Install and open [Zadig](https://zadig.akeo.ie/)
4. `Options` → `List All Devices`
5. Select the device whose **USB ID is `4348 55E0`**, install the **WinUSB** driver
6. Wait for it to finish
7. In the **Flash** page, click **[Connect]** and pick "Unknown Device from WinChipHead"
8. Choose a firmware — a local file, or a version listed under **Online flash** — then click **[Flash]**
9. **Set BOOT1 back to 0 and power-cycle the board**

### 2. Enter configuration mode

Hold the **Share** button (upper-left of the touchpad) and plug in the USB cable — or press **RST** — so the board boots in CDC mode.

### 3. Configure and save

Changes stay in memory until you click **[Save]** in the bottom bar. After changing the polling rate, click **[Reboot device]**.

---

## What you can configure

| Tab | What it does | Status |
|---|---|---|
| **Buttons** | Read-only table of the firmware's fixed button mapping | Read-only |
| **Joysticks** | Deadzone (0–50%), manual center/travel calibration for 4 axes, 4-step wizard, live trace | Configurable (deadzone is one global value) |
| **Triggers** | Trigger curve and deadzone | Placeholder — firmware uses digital triggers |
| **Board** | Polling rate 250 / 500 / 1k / 2k / 4k / 8 kHz, device info, reboot | Configurable |
| **Local flash** | Flash `.bin` / `.hex` / `.elf` with erase / verify / reset / unprotect | Available |
| **Online flash** | Pick a firmware from the site's `firmware/` folder, SHA-256 verified | Available |

---

## FAQ

**Blank page, no images?**
You opened it over `file://`. Serve it over HTTP.

**Clicking Connect does nothing?**
Unsupported browser, or not a secure context. Use Chrome/Edge on `https://` or `localhost`.

**Connected, but the device does not answer?**
It is not in configuration mode. Hold **Share** while plugging in USB (or press **RST**), then connect again.

**The pad works as a PS4 controller but the page cannot connect?**
A normally plugged-in device runs in HID mode. Configuration needs CDC mode — one at a time.

**Parameters did not take effect?**
Press **[Save]** in the bottom bar. For the polling rate, press **[Reboot device]** afterwards.

**Device does not boot after flashing?**
BOOT1 is still at 1. Set it to 0 and power-cycle.

**Online flash list is empty?**
`firmware/manifest.json` has no entries. See the firmware-maintenance section in [`technical.md`](./docs/technical.md).

---

## Architecture

```
┌─────────────────────────┐   ┌─────────────────────────┐   ┌──────────────────┐
│ Presentation            │   │ Protocol / transport    │   │ Device (CH32V307)│
│ app.js      routing     │   │ serial.js   Web Serial  │   │ CDC serial       │
│ pages/      home/config │ → │ msp.js      MSP v1      │ → │  → config mode   │
│             /flash/docs │   │ webusb.js   USB         │   │ WCH ISP (USB)    │
│ components/ sidebar etc.│   │ protocol.js ISP commands│ → │  → bootloader    │
│ tabs/       config tabs │   │ flasher.js  flash flow  │   │  4348:55E0       │
└─────────────────────────┘   └─────────────────────────┘   └──────────────────┘
```

| | Configuration | Flashing |
|---|---|---|
| Channel | Web Serial (CDC) | WebUSB (WCH ISP, `4348:55E0`) |
| Protocol | MSP v1, `$M<` / `$M>` with XOR checksum | WCH ISP commands |
| Device state | Firmware running | **Firmware not running** — chip is in the bootloader |
| Entry | `js/serial.js` → `js/msp.js` | `js/webusb.js` → `js/protocol.js` → `js/flasher.js` |

The two links cannot be merged: while flashing, the chip sits in the bootloader and the firmware's MSP server does not exist, so firmware cannot be pushed over MSP.

Zero build step — no `package.json`, no bundler, no framework. Native ES modules straight from `index.html`. Protocol details, config-group structures, firmware maintenance and known limitations live in [`technical.md`](./docs/technical.md).

---

## Deploy

Fully static: upload the whole folder (including `firmware/`) to any static host. The only hard requirement is **HTTPS** — otherwise `navigator.usb` does not exist and the Connect button cannot see the device (`localhost` is the only exception). The repository root is the site root, so GitHub Pages, Nginx or object storage work as-is.

For running it locally, see step 0 above.

---

## Links

- Firmware repository — [P1nkDog/8khz-ds4-gamepad-ch32v307](https://github.com/P1nkDog/8khz-ds4-gamepad-ch32v307)
- Technical documentation — [`technical.md`](./docs/technical.md) (Chinese)
- Credits — WCH ISP implementation adapted from [wchisp-web](https://github.com/P1nkDog/wchisp-web)
