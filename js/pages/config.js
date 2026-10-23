/**
 * config.js - 配置页面
 *
 * 数据机制（与固件 Driver/msp/msp_handler.c 对应）：
 * - 连接后自动读取设备信息（API/变体/固件版本）与所有配置组
 * - 配置组：
 *   1 joystick_calib（24 字节）：LX/LY/RX/RY 各 {min, center, max}（u16 LE）
 *   2 gamepad_settings（2 字节）：deadzone（u16 LE）
 *   3 polling_rate（1 字节）：level
 * - 修改后点击 [保存] 写入固件（CONFIG_SET + CONFIG_SAVE）
 */

import { serial } from '../serial.js';
import { msp, MSP_CMD, MSP_STATUS_NAME } from '../msp.js';
import { renderTabBar, setActiveTab } from '../components/tabs.js';
import { showMessage, showConfirm } from '../components/dialog.js';
import { renderButtonsTab } from '../tabs/buttons.js';
import { renderJoystickTab, GROUP_JOYSTICK_CALIB, GROUP_GAMEPAD_SETTINGS } from '../tabs/joystick.js';
import { renderTriggerTab } from '../tabs/trigger.js';

const GROUP_POLLING_RATE = 3;
const APP_VERSION = 'v1.0.0';
const MSP_REBOOT_MAGIC = 0x52; // 'R'（与固件 msp_protocol.h 一致）

const POLL_RATE_NAMES = ['250 Hz', '500 Hz', '1000 Hz', '2000 Hz', '4000 Hz', '8000 Hz'];

// 配置模型（默认值来自固件 config.c；连接后会被固件实际值覆盖）
const model = {
    calib: {
        lx: { min: 0, center: 2048, max: 4095 },
        ly: { min: 0, center: 2048, max: 4095 },
        rx: { min: 0, center: 2048, max: 4095 },
        ry: { min: 0, center: 2048, max: 4095 },
    },
    deadzone: 3,   // 死区百分比（0-50），默认 3%
    pollRate: 2,
    port: '未连接',
    device: { variant: '-', api: '-', fw: '-' },
};

let connected = false;
let currentTab = 'buttons';
let containerRef = null;
let saveBtnRef = null;
let dirtyHintRef = null;
const dirty = new Set();

//--------------------------------------------------------------------+
// MSP 请求封装
//--------------------------------------------------------------------+
async function mspRequest(cmd, data = [], timeoutMs = 2000) {
    const resp = await msp.request(serial, cmd, data, timeoutMs);
    if (resp === null) {
        console.error(`MSP 超时: cmd=0x${cmd.toString(16).padStart(2, '0')}`);
        return null;
    }
    if (resp.isError) {
        const statusName = MSP_STATUS_NAME[resp.payload[0]] || 'UNKNOWN';
        console.error(`MSP 错误: cmd=0x${resp.cmd.toString(16).padStart(2, '0')} status=${statusName}`);
        return null;
    }
    return resp;
}

//--------------------------------------------------------------------+
// 读取配置
//--------------------------------------------------------------------+
async function readDeviceInfo() {
    let ok = false;
    const api = await mspRequest(MSP_CMD.API_VERSION);
    if (api && api.payload.length >= 2) {
        ok = true;
        model.device.api = `${api.payload[0]}.${api.payload[1]}`;
    }
    const variant = await mspRequest(MSP_CMD.FC_VARIANT);
    if (variant && variant.payload.length > 0) model.device.variant = String.fromCharCode(...variant.payload);
    const version = await mspRequest(MSP_CMD.FC_VERSION);
    if (version && version.payload.length >= 3) {
        model.device.fw = `V${version.payload[0]}.${version.payload[1]}.${version.payload[2]}`;
    }
    return ok;
}

async function readAllConfigs() {
    const status = await mspRequest(MSP_CMD.CONFIG_STATUS);
    if (!status) return false;

    const count = status.payload[0];
    const groups = [];
    for (let i = 0; i < count; i++) {
        const base = 1 + i * 3;
        groups.push({
            id: status.payload[base],
            size: status.payload[base + 1] | (status.payload[base + 2] << 8),
        });
    }

    for (const g of groups) {
        const resp = await mspRequest(MSP_CMD.CONFIG_GET, [g.id]);
        if (resp && resp.payload.length >= 2) {
            const data = resp.payload.slice(2);
            if (g.id === GROUP_JOYSTICK_CALIB) parseCalib(data);
            else if (g.id === GROUP_GAMEPAD_SETTINGS) parseGamepadSettings(data);
            else if (g.id === GROUP_POLLING_RATE) parsePollingRate(data);
        }
    }

    dirty.clear();
    updateDirtyHint();
    return true;
}

function u16(data, off) {
    return data[off] | (data[off + 1] << 8);
}

function parseCalib(data) {
    const axes = ['lx', 'ly', 'rx', 'ry'];
    for (let i = 0; i < 4; i++) {
        const axis = model.calib[axes[i]];
        axis.min = u16(data, i * 6 + 0);
        axis.center = u16(data, i * 6 + 2);
        axis.max = u16(data, i * 6 + 4);
    }
}

function parseGamepadSettings(data) {
    if (data.length >= 2) model.deadzone = u16(data, 0);
}

function parsePollingRate(data) {
    if (data.length >= 1) model.pollRate = data[0];
}

function buildCalibBytes() {
    const out = [];
    const axes = ['lx', 'ly', 'rx', 'ry'];
    for (const a of axes) {
        const c = model.calib[a];
        out.push(c.min & 0xff, (c.min >> 8) & 0xff);
        out.push(c.center & 0xff, (c.center >> 8) & 0xff);
        out.push(c.max & 0xff, (c.max >> 8) & 0xff);
    }
    return out;
}

//--------------------------------------------------------------------+
// 保存
//--------------------------------------------------------------------+
function markDirty(groupId) {
    dirty.add(groupId);
    updateDirtyHint();
}

function updateDirtyHint() {
    if (dirtyHintRef) {
        dirtyHintRef.textContent = dirty.size > 0 ? '有未保存修改' : '';
    }
}

/**
 * 保存配置到固件（唯一写入口：只写有修改的配置组）
 * @returns {number[]} 本次保存的配置组 id 列表
 */
async function saveAll() {
    if (!connected) throw new Error('未连接设备');
    if (dirty.size === 0) throw new Error('没有需要保存的修改');

    const savedGroups = [...dirty];

    if (dirty.has(GROUP_JOYSTICK_CALIB)) {
        const ok = await mspRequest(MSP_CMD.CONFIG_SET, [GROUP_JOYSTICK_CALIB, ...buildCalibBytes()]);
        if (!ok) throw new Error('写入摇杆校准失败');
    }
    if (dirty.has(GROUP_GAMEPAD_SETTINGS)) {
        const ok = await mspRequest(MSP_CMD.CONFIG_SET, [GROUP_GAMEPAD_SETTINGS, model.deadzone & 0xff, (model.deadzone >> 8) & 0xff]);
        if (!ok) throw new Error('写入死区失败');
    }
    if (dirty.has(GROUP_POLLING_RATE)) {
        const ok = await mspRequest(MSP_CMD.CONFIG_SET, [GROUP_POLLING_RATE, model.pollRate]);
        if (!ok) throw new Error('写入回报率失败');
    }

    const okSave = await mspRequest(MSP_CMD.CONFIG_SAVE);
    if (!okSave) throw new Error('保存到 Flash 失败');

    dirty.clear();
    updateDirtyHint();
    return savedGroups;
}

/**
 * 重启设备（参考 ds4_configurator：MSP_CMD_REBOOT + 魔术字 0x52）
 * 部分配置（如回报率）在固件启动时才生效，重启后即可生效。
 */
async function rebootDevice() {
    if (!connected) throw new Error('未连接设备');

    const ok = await mspRequest(MSP_CMD.REBOOT, [MSP_REBOOT_MAGIC]);
    if (!ok) throw new Error('重启命令发送失败');

    // 设备即将重启，USB 会断开，主动清理连接状态
    connected = false;
    try { await serial.close(); } catch (e) {}
    rerenderIfActive();
}

//--------------------------------------------------------------------+
// 连接 / 断开
//--------------------------------------------------------------------+
async function handleConnect() {
    const btn = document.getElementById('config-btn-connect');
    try {
        if (btn) { btn.disabled = true; btn.textContent = '连接中...'; }

        await serial.open(115200);
        serial.onData = (data) => msp.processData(data);
        serial.onDisconnect = () => {
            connected = false;
            rerenderIfActive();
        };

        connected = true;
        // 记录端口信息（USB 设备的 VID:PID）
        try {
            const info = serial.port.getInfo();
            if (info && (info.usbVendorId !== undefined || info.usbProductId !== undefined)) {
                const vid = (info.usbVendorId ?? 0).toString(16).padStart(4, '0');
                const pid = (info.usbProductId ?? 0).toString(16).padStart(4, '0');
                model.port = `USB ${vid}:${pid}`;
            } else {
                model.port = '串口';
            }
        } catch (e) {
            model.port = '串口';
        }

        const deviceOk = await readDeviceInfo();
        if (!deviceOk) {
            // 设备无响应：很可能处于 HID（手柄）模式而非 CDC（配置）模式
            connected = false;
            try { await serial.close(); } catch (e) {}
            await showMessage(
                '通信失败',
                '连接成功但设备无响应。\n\n请确认设备已进入配置（CDC）模式：按住主板的 Select 按键，同时插入 USB 线，然后再连接。'
            );
            rerenderIfActive();
            return;
        }
        await readAllConfigs();
        currentTab = 'buttons';
    } catch (err) {
        if (err && err.name === 'NotFoundError') {
            // 用户取消选择串口
            return;
        }
        connected = false;
        try { await serial.close(); } catch (e) {}
        await showMessage('连接失败', err.message || String(err));
    } finally {
        rerenderIfActive();
    }
}

async function handleDisconnect() {
    connected = false;
    try { await serial.close(); } catch (e) {}
    rerenderIfActive();
}

function rerenderIfActive() {
    if (containerRef && containerRef.isConnected) {
        renderConfigPage(containerRef);
    }
}

//--------------------------------------------------------------------+
// 渲染
//--------------------------------------------------------------------+
export function renderConfigPage(container) {
    containerRef = container;
    container.innerHTML = '';
    saveBtnRef = null;
    dirtyHintRef = null;

    const page = document.createElement('div');
    page.className = 'content-area config-page';
    container.appendChild(page);

    // Tab 栏
    const tabs = connected
        ? [
            { key: 'buttons', label: '按键' },
            { key: 'joystick', label: '摇杆' },
            { key: 'trigger', label: '扳机' },
            { key: 'board', label: '主板' },
        ]
        : [];

    const rightHtml = connected
        ? '<button class="btn-disconnect" id="config-btn-disconnect">断开</button>'
        : '<button class="btn-connect" id="config-btn-connect">连接</button>';

    const bar = renderTabBar(tabs, currentTab, (key) => {
        currentTab = key;
        setActiveTab(bar, key);
        renderContent(contentEl);
    }, rightHtml);
    page.appendChild(bar);

    // 内容区
    const contentEl = document.createElement('div');
    contentEl.className = 'config-content';
    page.appendChild(contentEl);

    // 底边栏
    const statusBar = buildStatusBar();
    page.appendChild(statusBar);

    // 事件绑定
    const connectBtn = document.getElementById('config-btn-connect');
    if (connectBtn) connectBtn.addEventListener('click', handleConnect);

    const disconnectBtn = document.getElementById('config-btn-disconnect');
    if (disconnectBtn) disconnectBtn.addEventListener('click', handleDisconnect);

    renderContent(contentEl);
}

function renderContent(contentEl) {
    if (!connected) {
        contentEl.innerHTML = `
            <div class="guide-card">
                <h3>开始指南</h3>
                <ol>
                    <li>已烧录最新固件（可通过固件烧录页面烧录）</li>
                    <li>设备已通过 USB 连接电脑</li>
                    <li>使用 Chrome 或 Edge 浏览器（需支持 Web Serial API）</li>
                </ol>
                <div class="guide-note">
                    <strong>进入配置模式：</strong>配置功能通过串口（CDC）通信。请<b>按住主板的 Select 按键</b>，
                    同时插入 USB 线，使设备以配置（CDC）模式启动，然后再点击右上角 [连接]。
                </div>
            </div>
        `;
        return;
    }

    switch (currentTab) {
        case 'buttons':
            renderButtonsTab(contentEl);
            break;
        case 'joystick': {
            const ctx = {
                markDirty,
            };
            renderJoystickTab(contentEl, model, ctx);
            break;
        }
        case 'trigger':
            renderTriggerTab(contentEl);
            break;
        case 'board':
            renderBoardTab(contentEl);
            break;
        default:
            renderButtonsTab(contentEl);
            break;
    }
}

function buildStatusBar() {
    const bar = document.createElement('div');
    bar.className = 'status-bar';

    const info = document.createElement('div');
    info.className = 'status-info';

    const dot = document.createElement('div');
    dot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;

    const text = document.createElement('span');
    text.textContent = connected ? `${model.port} · 固件 ${model.device.fw}` : '未连接';

    info.appendChild(dot);
    info.appendChild(text);

    const right = document.createElement('div');
    right.style.cssText = 'display:flex;align-items:center;gap:12px;';

    if (connected && model.device.variant !== '-') {
        const deviceInfo = document.createElement('span');
        deviceInfo.className = 'status-chip';
        deviceInfo.textContent = `设备: ${model.device.variant}`;
        right.appendChild(deviceInfo);
    }

    const version = document.createElement('span');
    version.className = 'status-chip';
    version.textContent = `配置器 ${APP_VERSION}`;
    right.appendChild(version);

    if (connected) {
        const dirtyHint = document.createElement('span');
        dirtyHint.style.cssText = 'font-size:12px;color:var(--warning);';
        dirtyHintRef = dirtyHint;

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn-primary';
        saveBtn.textContent = '保存';
        saveBtnRef = saveBtn;
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            saveBtn.textContent = '保存中...';
            try {
                const savedGroups = await saveAll();
                // 若本次保存包含回报率，提示需重启生效
                const needReboot = savedGroups.includes(GROUP_POLLING_RATE);
                await showMessage(
                    '保存成功',
                    '配置已写入固件 Flash。' + (needReboot
                        ? '\n\n提示：回报率需设备重新上电后生效，可在主板页点击 [重启设备]。'
                        : '')
                );
            } catch (err) {
                if (err && err.message === '没有需要保存的修改') {
                    await showMessage('提示', '没有需要保存的修改。');
                } else {
                    await showMessage('保存失败', err.message || String(err));
                }
            } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = '保存';
            }
        });

        right.appendChild(dirtyHint);
        right.appendChild(saveBtn);
    }

    bar.appendChild(info);
    bar.appendChild(right);
    updateDirtyHint();
    return bar;
}

//--------------------------------------------------------------------+
// 主板 Tab
//--------------------------------------------------------------------+
function renderBoardTab(contentEl) {
    contentEl.innerHTML = '';

    // 回报率设置
    const rateCard = document.createElement('div');
    rateCard.className = 'section-card';
    rateCard.innerHTML = '<h3>回报率设置</h3>';
    contentEl.appendChild(rateCard);

    const rateRow = document.createElement('div');
    rateRow.className = 'config-row';

    const rateLabel = document.createElement('span');
    rateLabel.className = 'config-label';
    rateLabel.textContent = '回报率';
    rateRow.appendChild(rateLabel);

    const rateInput = document.createElement('div');
    rateInput.className = 'config-input';

    const select = document.createElement('select');
    select.id = 'poll-rate';
    POLL_RATE_NAMES.forEach((name, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = name;
        select.appendChild(opt);
    });
    select.value = String(model.pollRate);
    select.addEventListener('change', () => {
        model.pollRate = parseInt(select.value, 10);
        markDirty(GROUP_POLLING_RATE);
    });

    rateInput.appendChild(select);
    rateRow.appendChild(rateInput);
    rateCard.appendChild(rateRow);

    // 提示：修改回报率后由底边栏 [保存] 写入，重启后生效
    const rateHint = document.createElement('p');
    rateHint.className = 'placeholder-text';
    rateHint.textContent = '修改回报率后，点击底边栏 [保存] 写入固件；写入后需设备重新上电（重启）后生效。';
    rateCard.appendChild(rateHint);

    // 设备信息
    const infoCard = document.createElement('div');
    infoCard.className = 'section-card';
    infoCard.innerHTML = '<h3>设备信息</h3>';
    contentEl.appendChild(infoCard);

    infoCard.appendChild(infoRow('设备类型', model.device.variant || '-'));
    infoCard.appendChild(infoRow('API 版本', model.device.api || '-'));
    infoCard.appendChild(infoRow('固件版本', model.device.fw || '-'));

    // 设备操作（重启）
    const opsCard = document.createElement('div');
    opsCard.className = 'section-card';
    opsCard.innerHTML = '<h3>设备操作</h3>';
    contentEl.appendChild(opsCard);

    const opsRow = document.createElement('div');
    opsRow.className = 'config-row';
    const opsLabel = document.createElement('span');
    opsLabel.className = 'config-label';
    opsLabel.textContent = '重启设备';
    opsRow.appendChild(opsLabel);

    const opsInput = document.createElement('div');
    opsInput.className = 'config-input';
    const rebootBtn = document.createElement('button');
    rebootBtn.className = 'btn-primary';
    rebootBtn.textContent = '重启设备';
    rebootBtn.addEventListener('click', async () => {
        const confirmed = await showConfirm('重启设备', '确定要重启设备吗？重启后需要重新连接。');
        if (!confirmed) return;
        rebootBtn.disabled = true;
        rebootBtn.textContent = '重启中...';
        try {
            await rebootDevice();
            await showMessage('已重启', '设备已重启。如需继续配置，请按住主板的 Select 按键重新插拔进入配置模式后再连接。');
        } catch (err) {
            await showMessage('重启失败', err.message || String(err));
        } finally {
            rebootBtn.disabled = false;
            rebootBtn.textContent = '重启设备';
        }
    });

    opsInput.appendChild(rebootBtn);
    opsRow.appendChild(opsInput);
    opsCard.appendChild(opsRow);
}

function infoRow(label, value) {
    const row = document.createElement('div');
    row.className = 'config-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'config-label';
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const input = document.createElement('div');
    input.className = 'config-input';
    const val = document.createElement('span');
    val.className = 'static-value';
    val.textContent = value;
    input.appendChild(val);
    row.appendChild(input);

    return row;
}

//--------------------------------------------------------------------+
// 外部：断开连接（供 app.js 在切换页面时调用）
//--------------------------------------------------------------------+
export async function disconnectConfig() {
    if (connected) {
        connected = false;
        try { await serial.close(); } catch (e) {}
    }
}
