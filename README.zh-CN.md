# DS4 手柄配置器

基于 CH32V307 的 8kHz DS4 手柄配套网页工具。纯浏览器端运行，无需安装、无需后端——用 **Web Serial** 配置参数，用 **WebUSB** 烧录固件。

`v0.1.0` · 配套固件：[8khz-ds4-gamepad-ch32v307](https://github.com/P1nkDog/8khz-ds4-gamepad-ch32v307)

[English](./README.md) | 中文

---

## 快速开始

### 前提

- **Chrome 或 Edge 89+**（必须支持 WebUSB 与 Web Serial）
- 页面必须通过 **`https://`** 或 **`http://localhost`** 访问，不能直接双击 `index.html`
- Windows 首次烧录需要 [Zadig](https://zadig.akeo.ie/) 安装一次 WinUSB 驱动

### 0. 打开网页（二选一）

**方式一：用在线版**

如果作者已经部署，直接用 Chrome / Edge 打开那个网址就行，本机不需要装任何东西。

**方式二：在本机运行**（离线使用，或改了代码想马上看效果）

浏览器不允许用 `file://` 直接打开这类页面，所以需要起一个本地小服务器。项目自带脚本，不需要敲命令；前提是本机装有 **Python 3 或 Node.js**（二选一），都没有的话照下面的提示装一个就行。

1. 下载整个项目：在 GitHub 页面点 **`Code` → `Download ZIP`**，解压到任意目录。
   ⚠️ 要解压出**整个文件夹**——页面需要加载 `js/`、`css/`、`images/`，只拷 `index.html` 是打不开的。
2. 双击文件夹里的 **`start.bat`**。会弹出一个黑色窗口，自动挑好运行环境、启动服务器，并打开浏览器。
3. 地址是 `http://localhost:8080`。浏览器没自动弹出就手动输一次。
4. 用完后在黑色窗口里按 **`Ctrl + C`** 停止，或直接关掉窗口。

> ⚠️ **不要双击 `index.html`**。那会以 `file://` 打开，脚本模块被浏览器安全策略拦掉，页面一片空白。必须用 `start.bat` 起的 `http://localhost` 地址。

**双击后提示「未找到 python / py / npx」？** 说明本机还没有运行环境。装一个 Python 就够了（不需要 Node）：到 [python.org/downloads](https://www.python.org/downloads/) 下载安装，**安装第一页记得勾上 `Add python.exe to PATH`**，装完重新双击 `start.bat`。

**macOS / Linux**（没有 `start.bat`）：

```bash
cd dsv4
python3 -m http.server 8080
```

然后浏览器打开 `http://localhost:8080`，按 `Ctrl + C` 停止。

### 1. 烧录固件（仅首次）

1. 主板底下的 **BOOT1** 开关拨到 **1**
2. 用 USB 线连接电脑
3. 下载并安装 [Zadig](https://zadig.akeo.ie/)
4. 打开 Zadig → `Options` → `List All Devices`
5. 在设备下拉框里选中 **USB ID 为 `4348 55E0`** 的设备，为其安装 **WinUSB** 驱动
6. 等待安装完成
7. 进入网页「固件烧录」页，点右上角 **[连接]**，选择「来自 WinChipHead 的未知设备」
8. 选固件（本地文件，或「在线烧录」里列出的版本）→ 点 **[烧录]**
9. **把 BOOT1 拨回 0，重新上电**

### 2. 进入配置模式

按住手柄的 **Share** 按键（触摸板左上角那个键），再插入 USB 线；或按 **RST** 键。主板会以 CDC 模式启动。

### 3. 配置与保存

改动只存在于内存，**必须点底边栏的 [保存]** 才会写入设备。改完回报率还要点 **[重启设备]**。

---

## 功能说明

| 页面 / Tab | 能做什么 | 状态 |
|---|---|---|
| **按键** | 查看固件中写死的按键映射 | 只读 |
| **摇杆** | 死区（0–50%）、四轴中心/行程手动校准、四步校准向导、实时波形 | 可配置（死区为全局单值） |
| **扳机** | 扳机曲线与死区 | 占位——当前固件为数字扳机 |
| **主板** | 回报率 250 / 500 / 1k / 2k / 4k / 8kHz、设备信息、重启设备 | 可配置 |
| **本地烧录** | 选择 `.bin` / `.hex` / `.elf` 烧录，可选擦除 / 校验 / 重置 / 解除保护 | 可用 |
| **在线烧录** | 从站点 `firmware/` 目录选版本烧录，带 SHA-256 校验 | 可用 |

---

## 常见问题

**页面白屏、图片不出来？**
用 `file://` 直接打开了。必须通过 HTTP 访问。

**点「连接」没有任何反应？**
浏览器不支持，或地址不是安全上下文。用 Chrome/Edge，且地址是 `https://` 或 `localhost`。

**连接成功但设备无响应？**
设备不在配置模式。按住 **Share** 插 USB（或按 **RST**），再重新连接。

**手柄能当 PS4 手柄用，但网页连不上？**
正常插线是 HID 手柄模式，配置需要 CDC 模式，两者只能二选一。

**改了参数没生效？**
没点底边栏 **[保存]**。改的是回报率的话，保存后还要点 **[重启设备]**。

**烧完设备不启动？**
BOOT1 还停在 1。拨回 0 再重新上电。

**在线烧录列表是空的？**
`firmware/manifest.json` 没有条目。维护方法见 [`technical.md`](./docs/technical.md) 里的固件版本维护一节。

---

## 技术架构

```
┌─────────────────────────┐   ┌─────────────────────────┐   ┌──────────────────┐
│ 表现层                   │   │ 协议 / 传输层            │   │ 设备（CH32V307） │
│ app.js      路由 / 主题  │   │ serial.js   Web Serial  │   │ CDC 虚拟串口     │
│ pages/      4 个页面     │ → │ msp.js      MSP v1      │ → │  → 配置模式      │
│ components/ 侧栏/弹窗/Tab│   │ webusb.js   USB 传输    │   │ WCH ISP（USB）   │
│ tabs/       配置 Tab     │   │ protocol.js ISP 命令    │ → │  → Bootloader    │
│                          │   │ flasher.js  烧录流程    │   │  4348:55E0       │
└─────────────────────────┘   └─────────────────────────┘   └──────────────────┘
```

| | 配置 | 烧录 |
|---|---|---|
| 通道 | Web Serial（CDC 虚拟串口） | WebUSB（WCH ISP，`4348:55E0`） |
| 协议 | MSP v1，`$M<` / `$M>` + XOR 校验 | WCH ISP 命令 |
| 设备状态 | 固件正常运行 | **固件未运行**，芯片停在 Bootloader |
| 入口 | `js/serial.js` → `js/msp.js` | `js/webusb.js` → `js/protocol.js` → `js/flasher.js` |

两条链无法合并：烧录时芯片在 Bootloader 里，固件中的 MSP 服务端根本不存在，没法用 MSP 下发固件。

零构建——没有 `package.json`、没有打包器、没有框架，`index.html` 直接加载原生 ES Module。协议细节、配置组结构、固件版本维护、已知限制都在 [`technical.md`](./docs/technical.md)。

---

## 部署

纯静态站点，把整个目录（含 `firmware/`）传到任意静态托管即可。唯一硬要求是 **HTTPS**——否则 `navigator.usb` 不存在，点「连接」拿不到设备（`localhost` 是唯一例外）。仓库根目录就是站点根目录，GitHub Pages、Nginx、对象存储都能直接用。

本地运行方式见「快速开始」第 0 步。

---

## 相关链接

- 固件仓库 —— [P1nkDog/8khz-ds4-gamepad-ch32v307](https://github.com/P1nkDog/8khz-ds4-gamepad-ch32v307)
- 技术文档 —— [`technical.md`](./docs/technical.md)
- 致谢 —— WCH ISP 烧录实现参考 [wchisp-web](https://github.com/P1nkDog/wchisp-web)
