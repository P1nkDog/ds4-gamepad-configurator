/**
 * flash.js - 固件烧录页面
 *
 * 连接方式（WCH ISP，参考 wchisp-web/test-site/main.js）：
 * - WebUSB（默认）：直接 USB 通信，WCH ISP 设备（VID 0x4348/0x1a86，PID 0x55e0）
 * - Web Serial (CDC)：串口通信，需要驱动支持
 *
 * 烧录流程：识别芯片 → (解除保护) → 擦除 → 写入 → 校验 → 重置
 */

import { renderTabBar, setActiveTab } from '../components/tabs.js';
import { showMessage, showChoice } from '../components/dialog.js';

const APP_VERSION = 'v1.0.0';

let containerRef = null;
let connected = false;
let flasher = null;
let chipInfo = null;
let currentFlashTab = 'local';

// 日志（跨渲染保留）
const logLines = [];

//--------------------------------------------------------------------+
// 日志与进度
//--------------------------------------------------------------------+
function appendLog(message, isError = false) {
    const time = new Date().toLocaleTimeString();
    logLines.push({ time, message, isError });
    renderLog();
}

function renderLog() {
    const area = document.getElementById('flash-log');
    if (!area) return;
    area.innerHTML = '';
    for (const line of logLines) {
        const entry = document.createElement('div');
        entry.className = `log-entry ${line.isError ? 'log-err' : 'log-info'}`;
        entry.textContent = `[${line.time}] ${line.message}`;
        area.appendChild(entry);
    }
    area.scrollTop = area.scrollHeight;
}

let lastPhase = '';
let lastMilestone = -1;
function onProgress(event) {
    const total = event.total || 0;
    const done = event.done || 0;
    const pct = total > 0 ? (done / total) * 100 : 0;
    const pctStr = pct.toFixed(1);
    const where = typeof event.address === 'number' ? ` @0x${event.address.toString(16)}` : '';

    // 更新进度条与状态（每个块实时更新）
    const progressBar = document.getElementById('flash-progress');
    if (progressBar) progressBar.style.width = `${pctStr}%`;

    const statusEl = document.getElementById('flash-status');
    if (statusEl) {
        statusEl.textContent = `状态: ${event.phase} ${done}/${total} (${pctStr}%)`;
    }

    // 阶段切换时重置里程碑，让每个阶段都从 0% 重新计数
    if (event.phase !== lastPhase) {
        lastPhase = event.phase;
        lastMilestone = -1;
    }

    // 每 5% 记一条日志（兼顾详细与可读性）
    const milestone = Math.floor(pct / 5);
    if (milestone > lastMilestone) {
        lastMilestone = milestone;
        appendLog(`${event.phase} ${done}/${total} (${pctStr}%)${where}${event.message ? ` ${event.message}` : ''}`);
    }
}

//--------------------------------------------------------------------+
// 连接 / 断开
//--------------------------------------------------------------------+
async function handleConnect() {
    const btn = document.getElementById('flash-btn-connect');
    try {
        if (btn) { btn.disabled = true; btn.textContent = '连接中...'; }

        // 选择连接方式
        const type = await showChoice('选择连接方式', '请选择与芯片 RAM Bootloader 的通信方式：', [
            { label: 'WebUSB 连接', value: 'usb', hint: '直接 USB 通信（需 WinUSB 驱动，推荐）' },
            { label: 'Web Serial 连接', value: 'serial', hint: '串口通信（需 CDC 驱动）' },
        ]);

        if (!type) return;

        const { WchIspFlasher } = await import('../flasher.js');
        const { WebUsbTransport } = await import('../webusb.js');
        const { WebSerialTransport } = await import('../webserial.js');

        const transport = type === 'usb'
            ? await WebUsbTransport.request()
            : await WebSerialTransport.request({ baudRate: 115200 });

        flasher = new WchIspFlasher(transport);
        flasher.onLog = appendLog;
        flasher.onProgress = onProgress;

        chipInfo = await flasher.connect();
        connected = true;
        currentFlashTab = 'local';
    } catch (err) {
        if (err && err.name === 'NotFoundError') {
            // 用户取消选择设备
            return;
        }
        if (flasher) {
            try { await flasher.close(); } catch (e) {}
        }
        flasher = null;
        connected = false;
        chipInfo = null;
        await showMessage('连接失败', err && err.message ? err.message : String(err));
    } finally {
        rerenderIfActive();
    }
}

async function handleDisconnect() {
    connected = false;
    if (flasher) {
        try { await flasher.close(); } catch (e) {}
    }
    flasher = null;
    chipInfo = null;
    rerenderIfActive();
}

//--------------------------------------------------------------------+
// 烧录
//--------------------------------------------------------------------+
async function handleFlash() {
    if (!connected || !flasher) {
        await showMessage('提示', '请先连接设备');
        return;
    }

    const fileInput = document.getElementById('firmware-file');
    const file = fileInput && fileInput.files[0];
    if (!file) {
        await showMessage('提示', '请先选择固件文件');
        return;
    }

    const options = {
        erase: getOptionChecked('opt-erase', true),
        verify: getOptionChecked('opt-verify', true),
        reset: getOptionChecked('opt-reset', true),
        unprotect: getOptionChecked('opt-unprotect', false),
    };

    const flashBtn = document.getElementById('btn-flash');
    const statusEl = document.getElementById('flash-status');

    try {
        if (flashBtn) { flashBtn.disabled = true; flashBtn.textContent = '烧录中...'; }
        if (statusEl) statusEl.textContent = '状态: 烧录中';

        lastPhase = '';
        lastMilestone = -1;
        await flasher.flash(file, options);

        if (statusEl) statusEl.textContent = '状态: 烧录完成';
        appendLog('烧录完成');
        await showMessage('烧录完成', '固件烧录成功，设备已重置。');

        // 烧录完成后断开连接
        await handleDisconnect();
    } catch (err) {
        if (statusEl) statusEl.textContent = '状态: 烧录失败';
        appendLog(`烧录失败: ${err.message}`, true);
        await showMessage('烧录失败', err.message || String(err));
    } finally {
        if (flashBtn) { flashBtn.disabled = false; flashBtn.textContent = '烧录'; }
    }
}

function getOptionChecked(id, fallback) {
    const el = document.getElementById(id);
    if (!el) return fallback;
    return el.checked;
}

//--------------------------------------------------------------------+
// 渲染
//--------------------------------------------------------------------+
function rerenderIfActive() {
    if (containerRef && containerRef.isConnected) {
        renderFlashPage(containerRef);
    }
}

export function renderFlashPage(container) {
    containerRef = container;
    container.innerHTML = '';

    const page = document.createElement('div');
    page.className = 'content-area flash-page';
    container.appendChild(page);

    // Tab 栏
    const tabs = connected
        ? [
            { key: 'local', label: '本地烧录' },
            { key: 'online', label: '在线烧录' },
        ]
        : [];

    const rightHtml = connected
        ? '<button class="btn-disconnect" id="flash-btn-disconnect">断开连接</button>'
        : '<button class="btn-connect" id="flash-btn-connect">连接</button>';

    const bar = renderTabBar(tabs, currentFlashTab, (key) => {
        currentFlashTab = key;
        setActiveTab(bar, key);
        renderContent(contentEl);
    }, rightHtml);
    page.appendChild(bar);

    // 内容区
    const contentEl = document.createElement('div');
    contentEl.className = 'flash-content';
    page.appendChild(contentEl);

    // 底边栏
    const statusBar = buildStatusBar();
    page.appendChild(statusBar);

    // 事件绑定
    const connectBtn = document.getElementById('flash-btn-connect');
    if (connectBtn) connectBtn.addEventListener('click', handleConnect);

    const disconnectBtn = document.getElementById('flash-btn-disconnect');
    if (disconnectBtn) disconnectBtn.addEventListener('click', handleDisconnect);

    renderContent(contentEl);
}

function renderContent(contentEl) {
    if (!connected) {
        renderFlashGuide(contentEl);
        return;
    }

    if (currentFlashTab === 'online') {
        renderOnlineTab(contentEl);
    } else {
        renderLocalTab(contentEl);
    }
}

/**
 * 未连接状态：固件烧录指南
 */
function renderFlashGuide(contentEl) {
    contentEl.innerHTML = `
        <div class="guide-card">
            <h3>固件烧录指南</h3>
            <ol>
                <li>下载并安装 <b>zadig</b> 工具</li>
                <li>按住主板的 <b>PS 按键</b>，同时插入 USB 线，进入芯片 RAM Bootloader</li>
                <li>使用 zadig 下载安装 <b>WinUSB 驱动</b></li>
                <li>点击右上角 [连接] 按钮连接主板</li>
            </ol>
            <div class="guide-note">
                <strong>连接方式：</strong><br>
                • <b>WebUSB</b>（默认）：直接 USB 通信，WCH ISP 设备（VID 0x4348/0x1a86，PID 0x55e0），推荐<br>
                • <b>Web Serial (CDC)</b>：串口通信，需要驱动支持
            </div>
        </div>
        <div class="log-area" id="flash-log"></div>
    `;
    renderLog();
}

/**
 * 本地烧录
 */
function renderLocalTab(contentEl) {
    contentEl.innerHTML = `
        <div class="section-card">
            <h3>本地烧录</h3>
            <div class="file-input-wrapper">
                <input type="file" id="firmware-file" accept=".bin,.hex,.elf">
                <label for="firmware-file" class="file-input-label">选择文件</label>
                <span class="file-name" id="file-name">未选择文件（支持 .bin / .hex / .elf）</span>
            </div>
            <div class="flash-options">
                <label class="flash-option"><input type="checkbox" id="opt-erase" checked><span>擦除</span></label>
                <label class="flash-option"><input type="checkbox" id="opt-verify" checked><span>校验</span></label>
                <label class="flash-option"><input type="checkbox" id="opt-reset" checked><span>重置</span></label>
                <label class="flash-option"><input type="checkbox" id="opt-unprotect"><span>解除保护</span></label>
            </div>
            <div class="status-line" id="flash-status">状态: 就绪</div>
            <div class="progress-track"><div class="progress-bar" id="flash-progress"></div></div>
        </div>
        <div class="log-area" id="flash-log"></div>
    `;

    // 文件选择显示文件名
    const fileInput = document.getElementById('firmware-file');
    fileInput.addEventListener('change', () => {
        const nameEl = document.getElementById('file-name');
        if (nameEl) {
            nameEl.textContent = fileInput.files[0]
                ? `已选择: ${fileInput.files[0].name}`
                : '未选择文件';
        }
    });

    renderLog();
}

/**
 * 在线烧录（待完善）
 */
function renderOnlineTab(contentEl) {
    contentEl.innerHTML = `
        <div class="section-card">
            <h3>在线烧录</h3>
            <p class="placeholder-text">待完善（从服务器下载固件并烧录）</p>
        </div>
    `;
}

function buildStatusBar() {
    const bar = document.createElement('div');
    bar.className = 'status-bar';

    const info = document.createElement('div');
    info.className = 'status-info';

    const dot = document.createElement('div');
    dot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;

    const text = document.createElement('span');
    if (connected && chipInfo) {
        text.textContent = `芯片型号: ${chipInfo.name}`;
    } else {
        text.textContent = '未连接';
    }

    info.appendChild(dot);
    info.appendChild(text);

    const right = document.createElement('div');
    right.style.cssText = 'display:flex;align-items:center;gap:12px;';

    const version = document.createElement('span');
    version.className = 'status-chip';
    version.textContent = `配置器 ${APP_VERSION}`;
    right.appendChild(version);

    if (connected) {
        const flashBtn = document.createElement('button');
        flashBtn.className = 'btn-primary';
        flashBtn.id = 'btn-flash';
        flashBtn.textContent = '烧录';
        flashBtn.addEventListener('click', handleFlash);
        right.appendChild(flashBtn);
    }

    bar.appendChild(info);
    bar.appendChild(right);
    return bar;
}

//--------------------------------------------------------------------+
// 外部：断开连接（供 app.js 在切换页面时调用）
//--------------------------------------------------------------------+
export async function disconnectFlash() {
    if (connected) {
        connected = false;
        if (flasher) {
            try { await flasher.close(); } catch (e) {}
        }
        flasher = null;
        chipInfo = null;
    }
}
