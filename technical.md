# DS4 手柄配置器 - 技术文档

> 版本：v1.0.0 · 最后更新：2026-08-08
> 本文档描述网页配置器的完整实现，包括架构、协议、数据模型与已知限制。

---

## 1. 项目概述

DS4 手柄配置器是一个**纯浏览器端**的配置工具，用于配置基于 CH32V307VCT 的 DS4 手柄。通过 Web Serial / WebUSB API 与设备通信，无任何后端依赖，纯静态部署即可运行。

| 项 | 说明 |
|---|---|
| 前端 | 原生 HTML / CSS / JavaScript（ES 模块，无框架） |
| 配置通信 | Web Serial API + **MSP v1** 协议（配置页） |
| 固件烧录 | WebUSB（统一入口）+ **WCH ISP** 协议（烧录页） |
| 浏览器 | Chrome / Edge 89+（需支持 Web Serial / WebUSB，且需 localhost 或 HTTPS） |
| 目标固件 | `CH32V307VCT_tinyusb_ds4_A`（基于 TinyUSB 的 PS4 手柄） |

> ⚠️ **运行前提**：本项目使用 ES 模块且依赖 Web Serial/WebUSB，二者都要求**安全上下文**（http://localhost 或 HTTPS）。**不能直接双击 `index.html` 打开**（模块会被浏览器拦截，页面空白无响应）。

---

## 2. 目录结构

代码位于 `ds4-gamepad-configurator/dsv4/`：

```
dsv4/
├── index.html                  # 入口：侧边栏 + 主题开关 + 对话框 + 启动提示
├── start.bat                   # Windows 一键启动本地服务器（自动选 python/py/npx）
├── css/
│   └── style.css               # 全局样式：主题变量、按钮体系、布局、各页面样式
├── images/
│   ├── p1nkd.png               # P1NKD 字标原图（约 3.46:1，透明底，品牌粉 #F70069），侧边栏/首页 Logo
│   ├── favicon.ico             # 站点图标（内嵌 16/32/48/64，粉色字标 + 透明底）
│   ├── favicon-32/48/192/512.png  # 站点图标各尺寸（粉色字标 + 透明底）
│   ├── apple-touch-icon.png    # iOS 主屏图标（180×180，白底粉色字标）
│   └── guide/                  # 固件烧录指南配图（Zadig 装驱动 5 张分步截图）
└── js/
    ├── app.js                  # 主入口：页面路由、初始化、启动提示处理
    ├── msp.js                  # MSP v1 协议编解码 + 请求队列（配置页）
    ├── serial.js               # WebSerial 封装（配置页，MSP 通信）
    ├── protocol.js             # WCH ISP 协议命令编解码（烧录页）
    ├── transport.js            # 传输层通用方法（transfer/assertOk）
    ├── webusb.js               # WebUSB 传输层（含端点自动检测）
    ├── webserial.js            # WCH ISP 的 WebSerial 传输层（带帧封装，当前未引用）
    ├── device.js               # 芯片数据库（CH32V307 等）
    ├── format.js               # 固件格式解析（.bin/.hex/.elf）
    ├── flasher.js              # 烧录器核心（WchIspFlasher）
    ├── pages/
    │   ├── home.js             # 欢迎页
    │   ├── config.js           # 配置页（连接、MSP 读写、4 个 Tab、保存）
    │   ├── flash.js            # 固件烧录页
    │   └── docs.js             # 文档&支持页（占位）
    ├── tabs/
    │   ├── buttons.js          # 按键 Tab（只读显示固件固定映射）
    │   ├── button_map.js       # 固件固定按键映射表（只读数据）
    │   ├── joystick.js         # 摇杆 Tab（死区/中心校准）
    │   └── trigger.js          # 扳机 Tab（占位）
    └── components/
        ├── sidebar.js          # 侧边栏导航 + 主题管理
        ├── tabs.js             # Tab 栏组件
        └── dialog.js           # 对话框组件（确认/消息/选择）
```

相关文档：
- `docs/requirements.md` — 需求文档（UI 布局、页面设计、协议说明）
- `docs/ui-components.md` — UI 组件库（颜色变量、按钮、Radio、主题开关）

---

## 3. 网页端架构

### 3.1 SPA 页面路由

`app.js` 定义 4 个页面（欢迎/配置/固件烧录/文档&支持），侧边栏导航点击后通过 `navigateTo(pageId)` 切换，无刷新渲染。

**页面切换断开逻辑**（需求文档约定）：
- 进入**配置页 / 烧录页** → 自动断开所有连接（两种功能需设备以不同模式启动）
- 进入**欢迎页 / 文档页** → 不影响连接

### 3.2 主题系统

- 亮色/暗色两套 CSS 变量（`[data-theme="dark"]` 切换）
- 默认跟随系统（`prefers-color-scheme`），用户手动切换后保存到 `localStorage`
- 强调色：粉色 `#ff6b9d`（`--accent`）

### 3.3 页面内固定顶/底边栏

配置页与烧录页采用**纵向 flex 布局**：顶部 Tab 栏与底部状态栏 `flex-shrink: 0` 固定，中间内容区 `flex: 1; overflow-y: auto` 滚动——滚轮只滚动中间内容。

### 3.4 按钮体系

| 样式类 | 外观 | 用途 |
|---|---|---|
| `.btn-primary` | 粉色阴影实心（粉色底 + 深粉/黑双阴影，按下下沉） | 保存、确定、烧录、重启设备 |
| `.btn` | 卡通实心（粉色底 + 深色描边 + 立体阴影） | 连接方式选项等普通按钮 |
| `.btn-connect` | 粉色实心圆角 | 右上角 [连接] |
| `.btn-disconnect` | 红色描边（透明底 + 红边，悬停填充红色） | 右上角 [断开] / [断开连接] |

### 3.5 对话框组件

`dialog.js` 提供三个 API：`showConfirm`（确定/取消）、`showMessage`（消息）、`showChoice`（多选一，烧录连接方式用）。遮罩层必须配合 CSS `[hidden]` 规则才能正确隐藏（详见 §9 已知问题）。

---

## 4. MSP v1 协议（配置页）

参考前代配置器实现（`ds4_configurator` 项目）与固件 `Driver/msp/msp_handler.c`，两者完全一致。

### 4.1 帧格式

```
请求：$ M < [size] [cmd] [data...] [crc]
响应：$ M > [size] [cmd] [data...] [crc]
错误：$ M ! [size] [cmd] [status] [crc]
```

- `crc` = `size ^ cmd ^ data[0] ^ data[1] ^ ...`（XOR 校验）
- `size` 为 1 字节（载荷最大 254）

### 4.2 命令码

| 命令码 | 名称 | 说明 |
|---|---|---|
| 0x01 | API_VERSION | 返回 API 主/次版本 |
| 0x02 | FC_VARIANT | 返回设备类型字符串（`DS4P`） |
| 0x03 | FC_VERSION | 返回固件版本 3 字节 |
| 0x04 | REBOOT | 重启设备（载荷需魔术字 `0x52`） |
| 0x10 | CONFIG_GET | 读取配置组，响应 `[id, version, data...]` |
| 0x11 | CONFIG_SET | 写入配置组，请求 `[id, data...]`（`len-1` 必须等于该组 size） |
| 0x12 | CONFIG_SAVE | 保存所有脏配置组到 Flash，响应 `[status]` |
| 0x13 | CONFIG_RESET | 重置某配置组为默认值 |
| 0x14 | CONFIG_STATUS | 列出配置组，响应 `[count, {id, size_lo, size_hi}...]` |

### 4.3 配置组数据模型（与固件 `Config/config.h` 对应）

| 组 ID | 名称 | 大小 | 结构 |
|---|---|---|---|
| 1 | joystick_calib | 24 字节 | `calib[4]`，每项 `{min:u16, center:u16, max:u16}`；顺序 LX/LY/RX/RY |
| 2 | gamepad_settings | 2 字节 | `deadzone:u16`（左右摇杆共用，单字段） |
| 3 | polling_rate | 1 字节 | `level:u8`（0=250Hz…5=8000Hz） |

**校准字节布局**（组 1）：

| 偏移 | 含义 |
|---|---|
| 0-5 | LX {min, center, max} |
| 6-11 | LY {min, center, max} |
| 12-17 | RX {min, center, max} |
| 18-23 | RY {min, center, max} |

默认值（固件）：min=0、center=2048、max=4095；deadzone=3；polling_rate=1000Hz(level=2)。

### 4.4 配置页读写流程

1. **连接**：`navigator.serial.requestPort()` → `open(115200)` → 设备信息（API/变体/版本）+ 读取全部配置组
2. **设备无响应检测**：若 `API_VERSION` 超时，提示"请确认进入配置（CDC）模式"
3. **修改**：控件变更只改内存模型 + 标记 dirty（底边栏显示"有未保存修改"）
4. **保存**：`saveAll()` 只发送有修改的配置组（`CONFIG_SET`），再发 `CONFIG_SAVE`
5. **重启**：主板 Tab [重启设备] 发送 `REBOOT [0x52]`

> 回报率修改保存后**需重启设备才生效**（固件在启动时读取一次回报率间隔）。

---

## 5. WCH ISP 协议（烧录页）

参考开源项目 `wchisp-web`（`WchIspFlasher` 完整移植）。

### 5.1 传输层

| 方式 | 说明 |
|---|---|
| **WebUSB**（默认） | VID `0x4348`/`0x1a86`，PID `0x55e0`；EP OUT `0x02`、EP IN `0x82`；含端点自动检测 |
| **Web Serial (CDC)** | 原始命令外包帧：请求 `[0x57][0xAB][命令...][校验和]`，响应 `[0x55][0xAA][...][校验和]` |

### 5.2 命令码

| 命令码 | 名称 | 说明 |
|---|---|---|
| 0xA1 | IDENTIFY | 识别芯片（返回 chipId/deviceType） |
| 0xA2 | ISP_END | 结束 ISP（重置芯片） |
| 0xA3 | ISP_KEY | 建立加密通道（校验和校验） |
| 0xA4 | ERASE | 擦除 Flash |
| 0xA5 | PROGRAM | 写入数据（XOR 加密） |
| 0xA6 | VERIFY | 校验数据 |
| 0xA7 | READ_CONFIG | 读取配置寄存器 |
| 0xA8 | WRITE_CONFIG | 写入配置寄存器 |

### 5.3 XOR 加密

- 密钥 8 字节：`sum = checksum8(chipUID)`，`key = [sum×8]`，`key[7] += chipId`
- 写入/校验时，每个 56 字节块与密钥循环异或

### 5.4 烧录流程

```
识别芯片 → 读取配置 → (解除保护) → 擦除 → ISP密钥 → 写入(分块56B) → ISP密钥 → 校验(分块56B) → 重置
```

- 擦除扇区数 = `max(minEraseSectorNumber(芯片), ceil(固件大小/1024))`
- 固件格式：`.bin`（原始）、`.hex`（Intel HEX）、`.elf`（32/64 位解析）
- 仅支持基地址为 0 的固件

---

## 6. 固件配置系统（背景）

配置存于 Flash 双扇区（A: `0x08046000`，B: `0x08047000`，各 4KB），采用 TLV 记录 + CRC16 校验。

### 6.1 已修复的双扇区 bug

**问题**：原 `config_save()` 将数据写入"非活动扇区"（A↔B 交替），活动扇区记录在 RAM，重启即丢失；而 `config_init()` 开机**只要 A 有效就优先加载 A**。导致一旦 A、B 均有效，单次保存落入 B，重启仍加载 A 旧数据——必须连续保存两次才能生效。

**修复**（`Config/config.c` 的 `config_save()`）：**固定先写 B → 校验 B → 再写 A → 校验 A**，`active_sector` 固定为 A。`config_init()` 保持不变（A 优先、B 兜底）。

- 读始终走 A，A 永远是最新已提交数据
- 写 A 瞬间断电 → A 可能损坏 → 开机回退读 B（新数据不丢）
- 代价：每次保存写两个扇区（磨损翻倍，但配置写入低频，可忽略）

### 6.2 模式切换（固件启动按键）

| 模式 | 启动方式 | 用途 |
|---|---|---|
| CDC（配置） | 按住主板的 **Select** 键插 USB | 配置页 MSP 通信 |
| HID（手柄） | 正常插 USB | 游戏模式 |
| RAM Bootloader | 按住 **PS** 键插 USB + zadig 装 WinUSB 驱动 | 烧录页 |

---

## 7. UI 设计体系

### 7.1 颜色变量

```css
:root {           /* 亮色 */
  --bg-primary: #f5f5f7;  --bg-secondary: #ffffff;
  --text-primary: #1d1d1f; --text-secondary: #6e6e73;
  --accent: #ff6b9d; --border: #d2d2d7;
}
[data-theme="dark"] {
  --bg-primary: #1c1c1e;  --bg-secondary: #2c2c2e;
  --text-primary: #f5f5f7; --text-secondary: #98989d;
  --accent: #ff6b9d; --border: #38383a;
}
```

### 7.2 布局

- 左侧固定边栏 200px：Logo + 导航 + 底部主题开关
- 右侧内容区：页面内顶/底边栏固定，中间滚动
- 移动端（≤760px）侧边栏折叠为顶部横条

### 7.3 主题开关

采用 ui-components.md 原版太阳/月亮开关（蓝底黄太阳 → 黑底白月亮）。注意：原版 `animation: rotate-center` 引用了**未定义的 `@keyframes rotate-center`**，因此月亮实际不旋转，仅滑动——已按原版保留此行为。

---

## 8. 核心交互流程

### 8.1 配置页

```
连接(CDC模式) → 读设备信息+全部配置组 → 改摇杆/回报率(改内存+标记dirty)
→ 底边栏[保存](只写脏组+CONFIG_SAVE) → 改回报率则[重启设备]使其生效
```

### 8.2 烧录页

```
点击[连接]（固定走 WebUSB，弹浏览器设备框选 WinChipHead 设备）→ 连接识别芯片 → 选固件文件(.bin/.hex/.elf)
→ 勾选擦除/校验/重置/解除保护 → [烧录] → 进度条+日志 → 完成后自动断开
```

---

## 9. 已知限制与注意事项

1. **必须本地服务器访问**：ES 模块 + Web Serial/WebUSB 需要 localhost/HTTPS，`file://` 直接打开会空白。可用 `start.bat`、`python -m http.server` 或 `npx serve`。
2. **模式匹配**：配置需 CDC 模式（按住模式键上电，见 `Driver/usb/usb_descriptors.c`），烧录需 Bootloader 模式（主板 BOOT1 拨到 1 + Zadig 装 WinUSB 驱动）。
3. **回报率重启生效**：改回报率保存后需重启设备。
4. **按键/扳机/宏/曲线/在线烧录/文档页**：固件暂不支持，界面为只读/占位。
5. **摇杆死区为单字段**：固件只有一个 `deadzone`，网页用 X/Y 双滑块读写同一值（联动）。
6. **对话框遮罩**：`.dialog-overlay` 必须配合 `.dialog-overlay[hidden]{display:none}`，否则遮罩会一直盖住页面、吞掉所有点击。
7. **配置保存在底边栏统一提交**：各 Tab 的控件只改内存，唯一的 Flash 写入口是 [保存]。

---

## 10. 启动与部署

```bash
# 方式一：Windows 双击 dsv4/start.bat
# 方式二：Python
cd dsv4 && python -m http.server 8080
# 方式三：Node
cd dsv4 && npx serve
```

浏览器访问 `http://localhost:8080`（Chrome / Edge）。

---

## 11. 参考资料

| 来源 | 用途 |
|---|---|
| 前代配置器实现（`ds4_configurator` 项目） | MSP 协议客户端、WebSerial 封装 |
| 开源项目 `wchisp-web` | WCH ISP 烧录库（协议/传输/烧录器） |
| 配套固件工程 `CH32V307VCT_tinyusb_ds4_A`（基于 TinyUSB 的 PS4 手柄） | 固件源码、MSP 服务端、配置系统 |
| `docs/requirements.md` | 需求文档 |
| `docs/ui-components.md` | UI 组件库 |
