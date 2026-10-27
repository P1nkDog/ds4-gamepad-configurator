/**
 * flash.js - 固件烧录页面
 *
 * 连接方式（WCH ISP，参考 wchisp-web/test-site/main.js）：
 * - 统一使用 WebUSB 直接 USB 通信，WCH ISP 设备（USB ID 4348 55E0）
 *
 * 烧录流程：识别芯片 → (解除保护) → 擦除 → 写入 → 校验 → 重置
 */

import { renderTabBar, setActiveTab } from '../components/tabs.js';
import { showMessage } from '../components/dialog.js';
import { parseFirmware } from '../format.js';

const APP_VERSION = 'v0.1.0';

// 在线烧录：只读站点 firmware/ 目录下的固件清单（同源，无 CORS）
// 固件由 tools/sync_firmware.py 从 GitHub Release 同步进来，页面不直接访问 GitHub
const FIRMWARE_DIR = 'firmware';
const MANIFEST_URL = `${FIRMWARE_DIR}/manifest.json`;

// 刷新按钮图标（细线旋转箭头）
const REFRESH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="21 4 21 9.5 15.5 9.5"></polyline>
    <path d="M18.9 15a7.5 7.5 0 1 1-1.77-7.8L21 9.5"></path>
</svg>`;

let containerRef = null;
let connected = false;
let flasher = null;
let chipInfo = null;
let currentFlashTab = 'local';
let firmwareCache = null;          // 固件清单数组（来自 firmware/manifest.json）
let selectedFirmwareFile = null;   // 当前选中的固件文件名

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

        // 统一使用 WebUSB 连接，不再询问连接方式
        const { WchIspFlasher } = await import('../flasher.js');
        const { WebUsbTransport } = await import('../webusb.js');

        const transport = await WebUsbTransport.request();

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

    if (currentFlashTab === 'online') {
        await handleOnlineFlash();
        return;
    }

    const fileInput = document.getElementById('firmware-file');
    const file = fileInput && fileInput.files[0];
    if (!file) {
        await showMessage('提示', '请先选择固件文件');
        return;
    }

    const options = readFlashOptions();

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
            <p class="guide-intro">固件烧录前需要为芯片更改驱动以连接浏览器。</p>
            <ol class="guide-steps">
                <li>
                    <div class="step-title">将主板底下的 <b>BOOT1</b> 开关拨到 <b>1</b></div>
                </li>
                <li>
                    <div class="step-title">用 USB 线连接到电脑</div>
                </li>
                <li>
                    <div class="step-title">下载并安装 <a href="https://zadig.akeo.ie/" target="_blank" rel="noopener noreferrer">Zadig</a></div>
                </li>
                <li>
                    <div class="step-title">双击打开 Zadig</div>
                    <figure class="guide-figure">
                        <img src="images/guide/zadig-1-open.png" alt="Zadig 主界面" loading="lazy">
                    </figure>
                </li>
                <li>
                    <div class="step-title">点击 <b>Options</b>，再点击 <b>List All Devices</b></div>
                    <figure class="guide-figure">
                        <img src="images/guide/zadig-2-list-all-devices.png" alt="Options 菜单中点击 List All Devices" loading="lazy">
                    </figure>
                </li>
                <li>
                    <div class="step-title">在设备选择框里面找到一个 USB ID 为 <b>4348 55E0</b> 的一个设备，为其安装 <b>WinUSB</b> 驱动</div>
                    <figure class="guide-figure">
                        <img src="images/guide/zadig-3-install-driver.png" alt="选中 USB ID 4348 55E0 的设备并安装 WinUSB 驱动" loading="lazy">
                    </figure>
                </li>
                <li>
                    <div class="step-title">等待其安装完成</div>
                    <figure class="guide-figure">
                        <img src="images/guide/zadig-4-installed.png" alt="驱动安装完成提示" loading="lazy">
                    </figure>
                </li>
                <li>
                    <div class="step-title">回到网页，点击右上角的连接按钮，在右上角的框框里面选择“来自 WinChipHead 的未知设备”，然后点击连接</div>
                    <figure class="guide-figure">
                        <img src="images/guide/zadig-5-webusb-connect.png" alt="浏览器设备选择框中选择 WinChipHead 设备" loading="lazy">
                    </figure>
                </li>
                <li>
                    <div class="step-title">即可连接上设备进行烧录</div>
                </li>
            </ol>
            <div class="guide-note">
                <b>烧录完成后，请把 BOOT1 拨回 0 再重新上电，设备才会以新固件正常启动。</b>
            </div>
        </div>
    `;
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
            </div>
            <div class="local-file-card" id="local-file-card">
                <div class="release-hint">未选择文件（支持 .bin / .hex / .elf）</div>
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

    const fileInput = document.getElementById('firmware-file');
    fileInput.addEventListener('change', () => {
        renderLocalFileCard(fileInput.files[0]);
    });

    renderLog();
}

/**
 * 本地烧录：把已选文件渲染成与在线烧录一致的固件卡片
 */
function renderLocalFileCard(file) {
    const box = document.getElementById('local-file-card');
    if (!box) return;

    if (!file) {
        box.innerHTML = '<div class="release-hint">未选择文件（支持 .bin / .hex / .elf）</div>';
        return;
    }

    const fw = {
        tag: parseTagFromFileName(file.name),
        name: '',
        publishedAt: formatFileDate(file.lastModified),
        fileName: file.name,
        size: file.size,
        prerelease: false,
    };

    box.innerHTML = '';
    const item = document.createElement('div');
    item.className = 'release-item release-item-static selected';
    item.appendChild(buildFirmwareInfo(fw));
    box.appendChild(item);
}

/**
 * 在线烧录：读取站点 firmware/ 目录
 */
function renderOnlineTab(contentEl) {
    contentEl.innerHTML = `
        <div class="section-card">
            <h3>在线烧录</h3>
            <div class="online-repo">
                <span>固件来源：<b>${FIRMWARE_DIR}/</b></span>
                <button class="btn-ghost" id="btn-gh-refresh" title="重新读取固件列表">${REFRESH_SVG}<span>刷新固件</span></button>
            </div>
            <div class="release-list" id="gh-release-list">
                <div class="release-hint">正在读取固件列表…</div>
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

    renderLog();

    const refreshBtn = document.getElementById('btn-gh-refresh');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.disabled = true;
            refreshBtn.classList.add('is-loading');
            try {
                await loadFirmwareList(true);
            } finally {
                refreshBtn.classList.remove('is-loading');
                refreshBtn.disabled = false;
            }
        });
    }

    loadFirmwareList(false);
}

/**
 * 读取并渲染固件列表
 * @param {boolean} force - 是否跳过缓存
 */
async function loadFirmwareList(force) {
    const listEl = document.getElementById('gh-release-list');
    if (!listEl) return;

    if (force) {
        firmwareCache = null;
        listEl.innerHTML = '<div class="release-hint">正在读取固件列表…</div>';
    }

    try {
        const list = await fetchFirmwares(force);
        renderFirmwareList(listEl, list);
    } catch (err) {
        listEl.innerHTML = `<div class="release-hint release-hint-error">固件列表加载失败：${escapeHtml(err.message || String(err))}，可稍后点「刷新固件」重试。</div>`;
        console.warn('[在线烧录] 读取固件列表出错', err);
    }
}

/**
 * 从文件名推断版本号（与 tools/sync_firmware.py 规则一致）
 */
function parseTagFromFileName(name) {
    const m = /[vV](\d+(?:\.\d+){1,3})/.exec(name);
    if (m) return `v${m[1]}`;
    return name.replace(/\.[^.]+$/, '');
}

function formatFileDate(ms) {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 格式角标（BIN / HEX / ELF）
 */
function createFormatBadge(fileName) {
    const ext = (fileName.split('.').pop() || '').toUpperCase();
    if (!['BIN', 'HEX', 'ELF'].includes(ext)) return null;
    const badge = document.createElement('span');
    badge.className = 'release-badge release-badge-fmt';
    badge.textContent = ext;
    return badge;
}

/**
 * 构建固件信息块（在线列表与本地文件共用）
 * @param {{tag:string, name?:string, publishedAt?:string, fileName:string, size:number, prerelease?:boolean}} fw
 * @param {{isLatest?:boolean}} opts
 */
function buildFirmwareInfo(fw, opts = {}) {
    const info = document.createElement('div');
    info.className = 'release-info';

    const title = document.createElement('div');
    title.className = 'release-title';
    title.textContent = fw.tag;

    const fmt = createFormatBadge(fw.fileName);
    if (fmt) title.appendChild(fmt);

    if (opts.isLatest) {
        const badge = document.createElement('span');
        badge.className = 'release-badge';
        badge.textContent = '最新';
        title.appendChild(badge);
    }
    if (fw.prerelease) {
        const badge = document.createElement('span');
        badge.className = 'release-badge release-badge-pre';
        badge.textContent = '预发布';
        title.appendChild(badge);
    }

    const meta = document.createElement('div');
    meta.className = 'release-meta';
    const parts = [];
    if (fw.name && fw.name !== fw.tag) parts.push(fw.name);
    if (fw.publishedAt) parts.push(fw.publishedAt);
    if (fw.fileName) parts.push(fw.fileName);
    if (fw.size) parts.push(formatBytes(fw.size));
    meta.textContent = parts.join(' · ');

    info.appendChild(title);
    info.appendChild(meta);
    return info;
}

function renderFirmwareList(listEl, list) {
    if (!list.length) {
        listEl.innerHTML = '<div class="release-hint">暂无可用固件，请稍后点「刷新固件」重试。</div>';
        console.warn(`[在线烧录] ${MANIFEST_URL} 里没有可用条目`);
        return;
    }

    listEl.innerHTML = '';

    list.forEach((fw, index) => {
        const item = document.createElement('label');
        item.className = 'release-item';

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'fw-release';
        radio.value = fw.fileName;
        radio.checked = fw.fileName === selectedFirmwareFile
            || (!selectedFirmwareFile && index === 0);
        if (radio.checked) selectedFirmwareFile = fw.fileName;
        radio.addEventListener('change', () => {
            selectedFirmwareFile = fw.fileName;
            renderFirmwareSelection();
        });

        item.appendChild(radio);
        item.appendChild(buildFirmwareInfo(fw, { isLatest: index === 0 }));
        listEl.appendChild(item);
    });

    renderFirmwareSelection();
}

function renderFirmwareSelection() {
    document.querySelectorAll('#gh-release-list .release-item').forEach((el) => {
        const radio = el.querySelector('input[type="radio"]');
        el.classList.toggle('selected', !!(radio && radio.checked));
    });
}

/**
 * 取固件列表（只读站点 firmware/manifest.json）
 * @returns {Promise<Array>}
 */
async function fetchFirmwares(force) {
    if (firmwareCache && !force) return firmwareCache;
    firmwareCache = await fetchLocalManifest();
    return firmwareCache;
}

/**
 * 读站点 firmware/manifest.json
 */
async function fetchLocalManifest() {
    const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`清单 HTTP ${res.status}`);

    const data = await res.json();
    const list = Array.isArray(data.firmwares) ? data.firmwares : [];

    return list
        .filter((f) => f && f.tag && f.file)
        .map((f) => ({
            tag: String(f.tag),
            name: f.name || String(f.tag),
            publishedAt: f.date || '',
            fileName: String(f.file),
            size: Number(f.size) || 0,
            sha256: String(f.sha256 || '').toLowerCase(),
            prerelease: !!f.prerelease,
        }));
}

/**
 * 读取选中固件（站点同源），返回 Uint8Array
 *
 * 完整性靠清单里的 sha256：
 * - `.bin` 是裸数据，没有任何内部校验，必须靠它兜底；
 * - `.hex` 自带逐行校验和，清单里不填 sha256 就跳过这一步
 *   （.hex 是文本，git 的 CRLF/LF 规范化会改变字节数，登记了反而容易误报）。
 */
async function downloadFirmware(fw) {
    const url = `./${FIRMWARE_DIR}/${encodeURIComponent(fw.fileName)}?v=${encodeURIComponent(fw.tag)}`;
    appendLog(`正在读取固件 ${fw.tag}…`);

    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
        console.warn(`[在线烧录] 固件读取失败 ${url}`, res.status);
        throw new Error(`固件读取失败（HTTP ${res.status}）`);
    }

    const bytes = await readBodyWithProgress(res, fw.size);

    if (!fw.sha256) {
        appendLog('清单未登记 SHA-256，跳过完整性校验');
        return bytes;
    }

    const actual = await sha256Hex(bytes);
    if (actual !== fw.sha256) {
        console.warn(`[在线烧录] SHA-256 不匹配 expect=${fw.sha256} actual=${actual}`);
        throw new Error('固件完整性校验失败（SHA-256 不匹配），请刷新固件清单后重试');
    }
    appendLog(`SHA-256 校验通过（${actual.slice(0, 16)}…）`);
    return bytes;
}

/**
 * 计算字节流的 SHA-256（小写十六进制）
 */
async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 流式读取响应体，同时更新下载进度
 */
async function readBodyWithProgress(res, expectedSize) {
    const total = Number(res.headers.get('content-length')) || expectedSize || 0;

    if (!res.body) {
        return new Uint8Array(await res.arrayBuffer());
    }

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;

        const bar = document.getElementById('flash-progress');
        const statusEl = document.getElementById('flash-status');
        if (bar && total > 0) bar.style.width = `${((received / total) * 100).toFixed(1)}%`;
        if (statusEl) {
            statusEl.textContent = `状态: 下载中 ${formatBytes(received)}` + (total ? ` / ${formatBytes(total)}` : '');
        }
    }

    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

/**
 * 在线烧录：读取站点固件并烧录
 */
async function handleOnlineFlash() {
    const statusEl = document.getElementById('flash-status');
    const flashBtn = document.getElementById('btn-flash');

    if (!firmwareCache || !firmwareCache.length) {
        await showMessage('提示', '暂无可用固件，请稍后点「刷新固件」重试');
        return;
    }

    if (!selectedFirmwareFile) {
        await showMessage('提示', '请先选择一个固件版本');
        return;
    }
    const fw = firmwareCache.find((f) => f.fileName === selectedFirmwareFile);
    if (!fw) {
        await showMessage('提示', '版本信息已失效，请点「刷新固件」重试');
        return;
    }

    try {
        if (flashBtn) { flashBtn.disabled = true; flashBtn.textContent = '烧录中...'; }
        if (statusEl) statusEl.textContent = `状态: 读取 ${fw.tag} 固件`;

        const bytes = await downloadFirmware(fw);
        appendLog(`固件就绪: ${fw.fileName}（${formatBytes(bytes.length)}）`);

        // 必须带文件名解析：否则 .hex 会被当成裸二进制写入
        const image = parseFirmware(bytes, fw.fileName);
        appendLog(`解析格式: ${image.format}，基地址 0x${(image.baseAddress || 0).toString(16)}`);

        if (statusEl) statusEl.textContent = '状态: 烧录中';
        lastPhase = '';
        lastMilestone = -1;
        await flasher.flash(image, readFlashOptions());

        if (statusEl) statusEl.textContent = '状态: 烧录完成';
        appendLog('烧录完成');
        await showMessage('烧录完成', `${fw.tag} 固件烧录成功，设备已重置。`);
        await handleDisconnect();
    } catch (err) {
        if (statusEl) statusEl.textContent = '状态: 烧录失败';
        appendLog(`烧录失败: ${err.message || err}`, true);
        await showMessage('烧录失败', err.message || String(err));
    } finally {
        if (flashBtn) { flashBtn.disabled = false; flashBtn.textContent = '烧录'; }
    }
}

/**
 * 读取烧录选项
 */
function readFlashOptions() {
    return {
        erase: getOptionChecked('opt-erase', true),
        verify: getOptionChecked('opt-verify', true),
        reset: getOptionChecked('opt-reset', true),
        unprotect: getOptionChecked('opt-unprotect', false),
    };
}

function formatBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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
