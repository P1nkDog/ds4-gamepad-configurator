/**
 * joystick.js - 摇杆 Tab
 *
 * 二级 Tab：左摇杆 / 右摇杆
 * - 死区：12-bit ADC 计数死区（0~2047），左右独立（左页签写 deadzone_left，右页签写 deadzone_right）
 * - 中心校准：手动输入 min/center/max + 四步校准向导
 * - 校准向导：CALIB_START → CALIB_SAMPLE(回中采样) → CALIB_TRACK(转满圈) → CALIB_END(保存)
 * - 实时显示：轮询 JOYSTICK_RAW 显示 4 轴逻辑原始值 / 映射值
 */

import { serial } from '../serial.js';
import { msp, MSP_CMD } from '../msp.js';

// 摇杆配置组 ID（与固件 config.h 一致）
const GROUP_JOYSTICK_CALIB = 1;
const GROUP_GAMEPAD_SETTINGS = 2;

// 死区上限/默认值：12-bit ADC 半量程计数
//   与固件 Config/config.h 的 CONFIG_DEADZONE_MAX、Config/config.c 的
//   gamepadSettingsDefault 严格对齐。
const DEADZONE_MAX = 2047;
const DEADZONE_DEFAULT = 40;

// 校准命令中状态码所在的下标：固件失败帧同样用 '>' 方向字节，
// 只能靠 payload 里的状态码区分（CALIB_SAMPLE 成功才回数据，无状态码）。
const CALIB_STATUS_INDEX = {
    [MSP_CMD.CALIB_START]: 0,
    [MSP_CMD.CALIB_TRACK]: 0,
    [MSP_CMD.CALIB_END]: 0,
    [MSP_CMD.CALIB_CANCEL]: 0,
};

// 轴顺序（与固件 joystick.c 一致：LX/LY/RX/RY）
const AXES = [
    { key: 'lx', name: 'LX' },
    { key: 'ly', name: 'LY' },
    { key: 'rx', name: 'RX' },
    { key: 'ry', name: 'RY' },
];

// 校准向导步骤（客户端状态）：0=空闲 1=已开始 2=已采样中心 3=跟踪中
let wizardStep = 0;
// 实时轮询
let liveTimer = null;
let livePollFn = null;

//--------------------------------------------------------------------+
// MSP 请求封装（带错误处理）
//--------------------------------------------------------------------+
async function calibRequest(cmd, data = []) {
    const resp = await msp.request(serial, cmd, data, 2000);
    if (resp === null) throw new Error(`MSP 超时 cmd=0x${cmd.toString(16).padStart(2, '0')}`);
    if (resp.isError) throw new Error(`MSP 错误 cmd=0x${cmd.toString(16).padStart(2, '0')} status=${resp.payload[0]}`);
    // 固件失败帧同样走 '>'，必须再看 payload 里的状态码，否则
    // "越阶调用被拒绝"会被当成校准步骤成功。
    const statusIdx = CALIB_STATUS_INDEX[cmd];
    if (statusIdx !== undefined && resp.payload[statusIdx] !== 0) {
        throw new Error(`固件拒绝 cmd=0x${cmd.toString(16).padStart(2, '0')} status=${resp.payload[statusIdx]}`);
    }
    return resp;
}

//解析 JOYSTICK_RAW 响应：[count, raw×4(u16LE), out×4(u16LE)]
function parseRawResp(payload) {
    const raw = [];
    const out = [];
    for (let i = 0; i < 4; i++) {
        raw.push(payload[1 + i * 2] | (payload[2 + i * 2] << 8));
        out.push(payload[9 + i * 2] | (payload[10 + i * 2] << 8));
    }
    return { raw, out };
}

//--------------------------------------------------------------------+
// 渲染入口
//--------------------------------------------------------------------+
export function renderJoystickTab(container, model, ctx) {
    container.innerHTML = '';
    stopLive();   // 清理上次的轮询定时器

    // 二级 Tab：左/右摇杆
    const subTabBar = document.createElement('div');
    subTabBar.className = 'sub-tab-bar';
    const sticks = [
        { key: 'left', label: '左摇杆' },
        { key: 'right', label: '右摇杆' },
    ];
    let currentStick = 'left';
    const buttons = sticks.map((s) => {
        const btn = document.createElement('button');
        btn.className = `sub-tab ${s.key === currentStick ? 'active' : ''}`;
        btn.textContent = s.label;
        btn.dataset.stick = s.key;
        btn.addEventListener('click', () => {
            currentStick = s.key;
            buttons.forEach(b => b.classList.toggle('active', b.dataset.stick === currentStick));
            renderPanel(panel, currentStick);
        });
        subTabBar.appendChild(btn);
        return btn;
    });
    container.appendChild(subTabBar);

    const panel = document.createElement('div');
    panel.className = 'joystick-panel';
    container.appendChild(panel);
    renderPanel(panel, currentStick);

    container.appendChild(renderWizardSection(model, ctx));
    container.appendChild(renderLiveSection());

    //--------------------------------------------------------------------+
    // 单个摇杆面板：死区（12-bit ADC count，左右独立）+ 手动校准值
    //--------------------------------------------------------------------+
    function renderPanel(parent, stick) {
        parent.innerHTML = '';
        const xAxis = stick === 'left' ? 'lx' : 'rx';
        const yAxis = stick === 'left' ? 'ly' : 'ry';
        const isLeft = (stick === 'left');

        // 固件侧 LX/LY 共用 deadzone_left、RX/RY 共用 deadzone_right，故每侧只渲染一行
        const sectionDeadzone = section('死区（12-bit ADC count）');
        sectionDeadzone.appendChild(isLeft
            ? deadzoneRow('deadzoneLeft', '左摇杆死区（LX / LY 共用）')
            : deadzoneRow('deadzoneRight', '右摇杆死区（RX / RY 共用）'));
        parent.appendChild(sectionDeadzone);

        const sectionCalib = section('中心校准（手动）');
        sectionCalib.appendChild(calibRow('中心值 X', model.calib[xAxis], 'center'));
        sectionCalib.appendChild(calibRow('中心值 Y', model.calib[yAxis], 'center'));
        sectionCalib.appendChild(calibRow('最小值 X', model.calib[xAxis], 'min'));
        sectionCalib.appendChild(calibRow('最小值 Y', model.calib[yAxis], 'min'));
        sectionCalib.appendChild(calibRow('最大值 X', model.calib[xAxis], 'max'));
        sectionCalib.appendChild(calibRow('最大值 Y', model.calib[yAxis], 'max'));
        parent.appendChild(sectionCalib);

        const hint = document.createElement('p');
        hint.className = 'placeholder-text';
        hint.textContent = '修改后请点击底边栏 [保存] 写入固件。校准向导会自动写入并保存。';
        parent.appendChild(hint);
    }

    // 死区行：12-bit ADC 计数（0~2047，步进 1），滑块与数字输入框双向同步
    //   field = 'deadzoneLeft' | 'deadzoneRight'，直接读写 config.js 的 model
    function deadzoneRow(field, labelText) {
        if (!Number.isFinite(model[field])) model[field] = DEADZONE_DEFAULT;

        const row = document.createElement('div');
        row.className = 'config-row';
        const labelEl = document.createElement('span');
        labelEl.className = 'config-label';
        labelEl.textContent = labelText;
        row.appendChild(labelEl);

        const input = document.createElement('div');
        input.className = 'config-input';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = String(DEADZONE_MAX);
        slider.step = '1';
        slider.value = String(model[field]);

        const stepper = document.createElement('div');
        stepper.className = 'number-stepper';
        const num = document.createElement('input');
        num.type = 'number';
        num.min = '0';
        num.max = String(DEADZONE_MAX);
        num.step = '1';
        num.value = String(model[field]);
        stepper.appendChild(num);

        const rangeEl = document.createElement('span');
        rangeEl.className = 'config-range';
        rangeEl.textContent = `ADC count 0-${DEADZONE_MAX}`;

        // 边界钳位：手动输入越界会被固件判 INVALID_DATA，这里先在 UI 侧收口
        const clamp = (v) => Math.min(DEADZONE_MAX, Math.max(0, v));
        const apply = (v) => {
            const raw = Number.isFinite(v) ? v : model[field];
            model[field] = clamp(Math.round(raw));
            slider.value = String(model[field]);
            num.value = String(model[field]);
            ctx.markDirty(GROUP_GAMEPAD_SETTINGS);
        };

        slider.addEventListener('input', () => apply(parseInt(slider.value, 10)));
        num.addEventListener('change', () => {
            if (num.value === '') { num.value = String(model[field]); return; }
            const v = parseInt(num.value, 10);
            apply(Number.isNaN(v) ? model[field] : v);
        });

        input.appendChild(slider);
        input.appendChild(stepper);
        input.appendChild(rangeEl);
        row.appendChild(input);
        return row;
    }

    // 手动校准行（数字输入 + ▲▼ 微调）
    function calibRow(label, axis, field) {
        const row = document.createElement('div');
        row.className = 'config-row';
        const labelEl = document.createElement('span');
        labelEl.className = 'config-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const input = document.createElement('div');
        input.className = 'config-input';
        const stepper = document.createElement('div');
        stepper.className = 'number-stepper';
        const num = document.createElement('input');
        num.type = 'number';
        num.min = '0';
        num.max = '4095';
        num.value = axis[field];
        const stepBtns = document.createElement('div');
        stepBtns.className = 'step-btns';
        const btnUp = stepButton('▲');
        const btnDown = stepButton('▼');
        const clamp = (v) => Math.min(4095, Math.max(0, v));
        const applyValue = (v) => {
            v = clamp(Math.round(v));
            axis[field] = v;
            num.value = v;
            ctx.markDirty(GROUP_JOYSTICK_CALIB);
        };
        num.addEventListener('change', () => {
            if (num.value === '') { num.value = axis[field]; return; }
            const v = parseInt(num.value, 10);
            applyValue(isNaN(v) ? axis[field] : v);
        });
        btnUp.addEventListener('click', () => applyValue((parseInt(num.value, 10) || 0) + 1));
        btnDown.addEventListener('click', () => applyValue((parseInt(num.value, 10) || 0) - 1));
        stepBtns.appendChild(btnUp);
        stepBtns.appendChild(btnDown);
        stepper.appendChild(num);
        stepper.appendChild(stepBtns);
        input.appendChild(stepper);
        row.appendChild(input);
        return row;
    }

    function stepButton(text) {
        const btn = document.createElement('button');
        btn.className = 'step-btn';
        btn.textContent = text;
        return btn;
    }

    function section(title) {
        const s = document.createElement('div');
        s.className = 'section-card';
        s.style.marginBottom = '12px';
        const h = document.createElement('h3');
        h.textContent = title;
        s.appendChild(h);
        return s;
    }
}

//--------------------------------------------------------------------+
// 校准向导
//--------------------------------------------------------------------+
function renderWizardSection(model, ctx) {
    const card = document.createElement('div');
    card.className = 'section-card';
    card.style.marginBottom = '12px';
    card.innerHTML = '<h3>校准向导</h3>';

    // 状态行
    const statusEl = document.createElement('p');
    statusEl.className = 'placeholder-text';
    statusEl.textContent = '空闲：点击 [① 开始校准] 开始。';
    card.appendChild(statusEl);

    // 按钮行
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;';
    card.appendChild(btnRow);

    const btns = {};
    const mkBtn = (id, label, onClick) => {
        const b = document.createElement('button');
        b.className = 'btn';
        b.textContent = label;
        b.addEventListener('click', onClick);
        btnRow.appendChild(b);
        btns[id] = b;
        return b;
    };

    mkBtn('start', '① 开始校准', async () => {
        try {
            await calibRequest(MSP_CMD.CALIB_START);
            wizardStep = 1;
            setStatus('已开始。请把摇杆拨到中间位置。');
            refreshButtons();
        } catch (e) { setStatus('失败：' + e.message); }
    });

    mkBtn('sample', '② 采样中心', async () => {
        try {
            const resp = await calibRequest(MSP_CMD.CALIB_SAMPLE);
            const centers = readCenters(resp.payload);
            AXES.forEach((a, i) => { model.calib[a.key].center = centers[i]; });
            ctx.markDirty(GROUP_JOYSTICK_CALIB);
            wizardStep = 2;
            setStatus('已采样中心：' + centers.join('/') + '。接下来把摇杆转到最大行程（画圈）。');
            refreshButtons();
        } catch (e) { setStatus('失败：' + e.message); }
    });

    mkBtn('track', '③ 开始跟踪', async () => {
        try {
            await calibRequest(MSP_CMD.CALIB_TRACK);
            wizardStep = 3;
            setStatus('跟踪中：请以最大行程画圈约 10 圈，完成后点 [④ 完成并保存]。');
            startLive();
            refreshButtons();
        } catch (e) { setStatus('失败：' + e.message); }
    });

    mkBtn('end', '④ 完成并保存', async () => {
        try {
            const resp = await calibRequest(MSP_CMD.CALIB_END);
            const values = readCalibAll(resp.payload);
            AXES.forEach((a, i) => {
                model.calib[a.key].min = values[i].min;
                model.calib[a.key].center = values[i].center;
                model.calib[a.key].max = values[i].max;
            });
            ctx.markDirty(GROUP_JOYSTICK_CALIB);
            wizardStep = 0;
            stopLive();
            setStatus('完成，已保存到 Flash。');
            refreshButtons();
        } catch (e) { setStatus('失败：' + e.message); }
    });

    mkBtn('cancel', '取消校准', async () => {
        try { await calibRequest(MSP_CMD.CALIB_CANCEL); } catch (e) {}
        wizardStep = 0;
        stopLive();
        setStatus('已取消。');
        refreshButtons();
    });

    function refreshButtons() {
        btns.sample.disabled = !(wizardStep >= 1);
        btns.track.disabled = !(wizardStep >= 2);
        btns.end.disabled = !(wizardStep >= 3);
        btns.cancel.disabled = (wizardStep === 0);
    }
    function setStatus(t) { statusEl.textContent = t; }
    refreshButtons();

    return card;
}

//解析 CALIB_SAMPLE 响应：[count, center×4(u16LE)]
function readCenters(payload) {
    const out = [];
    for (let i = 0; i < 4; i++) out.push(payload[1 + i * 2] | (payload[2 + i * 2] << 8));
    return out;
}

//解析 CALIB_END 响应：[status, count, {min,center,max}×4(u16LE)]
function readCalibAll(payload) {
    const out = [];
    for (let i = 0; i < 4; i++) {
        const base = 2 + i * 6;
        out.push({
            min: payload[base] | (payload[base + 1] << 8),
            center: payload[base + 2] | (payload[base + 3] << 8),
            max: payload[base + 4] | (payload[base + 5] << 8),
        });
    }
    return out;
}

//--------------------------------------------------------------------+
// 实时显示
//--------------------------------------------------------------------+
function renderLiveSection() {
    const card = document.createElement('div');
    card.className = 'section-card';
    card.innerHTML = '<h3>实时显示（跟踪时自动刷新）</h3>';

    const rowsEl = document.createElement('div');
    card.appendChild(rowsEl);

    const rowEls = AXES.map((a) => {
        const row = document.createElement('div');
        row.className = 'config-row';
        row.innerHTML = `
            <span class="config-label">${a.name}</span>
            <div class="config-input" style="display:flex;align-items:center;gap:8px;flex:1;">
                <span class="live-raw" style="min-width:36px;">--</span>
                <div style="flex:1;height:8px;background:var(--border);border-radius:4px;position:relative;overflow:hidden;">
                    <div class="live-bar" style="position:absolute;top:0;left:0;width:0%;height:100%;background:var(--accent);border-radius:4px;"></div>
                    <div style="position:absolute;top:0;left:50%;width:1px;height:100%;background:var(--text-secondary);"></div>
                </div>
                <span class="live-out" style="min-width:36px;">--</span>
            </div>
        `;
        rowsEl.appendChild(row);
        return {
            raw: row.querySelector('.live-raw'),
            out: row.querySelector('.live-out'),
            bar: row.querySelector('.live-bar'),
        };
    });

    // 轮询 JOYSTICK_RAW
    async function poll() {
        try {
            const resp = await calibRequest(MSP_CMD.JOYSTICK_RAW);
            const { raw, out } = parseRawResp(resp.payload);
            for (let i = 0; i < 4; i++) {
                rowEls[i].raw.textContent = String(raw[i]);
                rowEls[i].out.textContent = String(out[i]);
                const pct = Math.round(out[i] / 4095 * 100);
                rowEls[i].bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
            }
        } catch (e) { /* 超时/断开时静默 */ }
    }

    livePollFn = poll;
    return card;
}

function startLive() {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(() => {
        if (livePollFn) livePollFn();
    }, 100);
}

function stopLive() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}

export { GROUP_JOYSTICK_CALIB, GROUP_GAMEPAD_SETTINGS };
