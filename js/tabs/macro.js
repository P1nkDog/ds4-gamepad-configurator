/**
 * macro.js - 宏 Tab（8 槽位可视化编辑 + 0x1B 快照在线录制器）
 *
 * 与固件严格对齐（Driver/msp/msp_protocol.h、Config/config.h、Driver/gamepad/gamepad.c）：
 *   - 宏槽位 0~7 对应配置组 ID 5~12，每槽固定 236 字节（MacroSlotConfig），最多 16 步；
 *   - 每步 packed 14 字节（MacroStep）：u32 mask + 4 × int16 摇杆偏移 + u16 duration_ms；
 *   - 触发键是 26 路物理键位掩码（bit0~25，0 = 未绑定），步内 mask 是 DS4 逻辑位掩码（bit1~18）；
 *   - MSP_CMD.INPUT_SNAPSHOT(0x1B) 返回 16 字节快照：u32 buttons + 4 × u16 摇杆 + u32 微秒时间戳。
 *
 * 本模块只负责界面与录制，二进制编解码在 pages/config.js（parseMacroSlot / buildMacroSlotBytes），
 * 两者共用本文件导出的字节级常量与默认值工厂，避免两处常量漂移。
 */

import { serial } from '../serial.js';
import { msp, MSP_CMD } from '../msp.js';
import { showMessage, showConfirm } from '../components/dialog.js';
import {
    PHYSICAL_BUTTONS,
    DS4_LOGICAL_BUTTONS,
    DS4_LOGICAL_MASK_ALL,
    ds4BtnBit,
    formatButtonMask,
} from './button_map.js';
import {
    physicalIconKey,
    logicalIconKey,
    iconTag,
    fillMaskTags,
} from '../utils/button_icons.js';

//--------------------------------------------------------------------+
// 字节级常量（与固件 Config/config.h 严格一致）
//--------------------------------------------------------------------+
export const MACRO_SLOT_COUNT = 8;              // MACRO_SLOT_COUNT
export const MACRO_GROUP_BASE = 5;              // CONFIG_ID_MACRO_BASE：5 ~ 12
export const MACRO_MAX_STEPS = 16;              // MACRO_MAX_STEPS
export const MACRO_SLOT_BYTES = 236;            // sizeof(MacroSlotConfig)
export const MACRO_STEP_BYTES = 14;             // sizeof(MacroStep)（packed）
export const MACRO_TRIGGER_MASK_ALL = 0x03FFFFFF; // MACRO_TRIGGER_MASK_ALL（26 位）
export const MACRO_FLAG_BLOCK_TRIGGER = 0x01;   // MACRO_FLAG_BLOCK_TRIGGER
export const MACRO_HOLD_MS_MAX = 10000;         // MACRO_HOLD_MS_MAX
export const MACRO_AXIS_MIN = -2048;            // MACRO_AXIS_OFFSET_MIN
export const MACRO_AXIS_MAX = 2047;             // MACRO_AXIS_OFFSET_MAX
export const MACRO_STEP_MS_MIN = 1;
export const MACRO_STEP_MS_MAX = 65535;
export const MACRO_MODE_MAX = 2;                // MACRO_MODE_TOGGLE

// 执行模式（与固件 MacroPlayMode 同序）
const MODE_NAMES = ['单次执行', '按住循环', '开关切换'];
const MODE_DETAIL = ['ONCE', 'HOLD', 'TOGGLE'];

// 在线录制：抖动过滤阈值（同一状态持续不足 5ms 视为抖动）
const REC_MIN_STEP_MS = 5;
// 在线录制：单帧快照超时（ms）。超时静默跳过，不弹窗。
const REC_SNAPSHOT_TIMEOUT_MS = 120;
// 在线录制：摇杆量化步进与死区（12-bit 原始值 → 相对中点偏移）
const REC_STICK_STEP = 64;
const REC_STICK_DEADZONE = 128;
// 录制实时预览的 UI 节流间隔（ms）
const REC_UI_INTERVAL_MS = 80;
// 单帧失败（超时 / 串口已失效）后下一帧的退避间隔（ms）。
// 正常帧用 0 立即续帧；失败帧若不退避，串口 write 立刻返回 false 会变成 100% CPU 空转。
const REC_FAIL_BACKOFF_MS = 60;

// 弹窗内分组（物理键 26 路 / 逻辑键 18 位）
const PHYS_GROUPS = [
    { title: '十字方向键', bits: [0, 1, 2, 3] },
    { title: '动作键', bits: [4, 5, 6, 7] },
    { title: '肩键与扳机', bits: [8, 9, 10, 11] },
    { title: '摇杆与系统键', bits: [12, 13, 14, 15, 16, 17] },
    { title: '扩展键 BTN1 ~ BTN8', bits: [18, 19, 20, 21, 22, 23, 24, 25] },
];
const LOGICAL_GROUPS = [
    { title: '方向键', bits: [1, 2, 3, 4] },
    { title: '动作键', bits: [5, 6, 7, 8] },
    { title: '肩键与扳机', bits: [9, 10, 11, 12] },
    { title: '摇杆与系统键', bits: [13, 14, 15, 16, 17, 18] },
];

//--------------------------------------------------------------------+
// 模块级状态（保存重渲染后仍保持当前编辑槽位）
//--------------------------------------------------------------------+
let activeSlot = 0;          // 当前编辑槽位 0~7
let showStickCols = false;   // 步骤表是否展开四列摇杆微调

let containerRef = null;
let modelRef = null;
let ctxRef = {};

// 各区块 DOM 引用（区块内重建时刷新）
let slotGridEl = null;
let triggerBodyEl = null;
let recBodyEl = null;
let stepsBodyEl = null;
let stepsTitleEl = null;
let addStepBtnRef = null;
let stickToggleRef = null;

// 录制实时预览的文本节点
let recStepsEl = null;
let recTimeEl = null;
let recStateEl = null;

// 录制运行时状态
const rec = {
    running: false,      // 轮询是否在跑（单飞标志）
    captureSticks: false,// 是否同时录制摇杆轨迹
    started: false,      // 是否已捕获到首个有效动作
    steps: [],           // [{ mask, lx, ly, rx, ry, durationMs }]
    pending: null,       // 当前挂起态 { mask, lx, ly, rx, ry }
    pendingMs: 0,        // 挂起态已累计毫秒
    prevTs: null,        // 上一帧设备微秒时间戳
    lastState: null,     // 最新一帧的捕获态（预览用）
};
let recTimer = null;
let lastRecUiTs = 0;
// 上一次录制的落库结果（停止后在面板里回显，切走槽位即失效）
let lastRecResult = null;

//--------------------------------------------------------------------+
// 小工具
//--------------------------------------------------------------------+
function clampInt(value, min, max, fallback = min) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/** 物理键短名：'十字键上 (UP)' → '十字键上'，'扩展键 BTN1' → 'BTN1' */
function shortPhysName(name) {
    const cut = String(name).split(/[（(]/)[0].trim();
    return cut.replace(/^扩展键\s*/, '') || cut;
}

function isZeroStep(step) {
    return !step || (step.mask === 0 && step.lx === 0 && step.ly === 0 && step.rx === 0 && step.ry === 0);
}

function sameState(a, b) {
    return !!a && !!b
        && a.mask === b.mask && a.lx === b.lx && a.ly === b.ly && a.rx === b.rx && a.ry === b.ry;
}

//--------------------------------------------------------------------+
// 默认值与模型维护
//--------------------------------------------------------------------+
/**
 * 单步默认值：纯延时 100ms（无按键、不干预摇杆）
 * durationMs 取 100 而非 0：固件拒绝 duration_ms = 0 的步。
 */
export function createDefaultMacroStep() {
    return { mask: 0, lx: 0, ly: 0, rx: 0, ry: 0, durationMs: 100 };
}

/**
 * 单槽默认值（与固件 macroSlotDefault 一致）：
 *   triggerMask 0（未绑定）、holdMs 0、mode ONCE、flags = BLOCK_TRIGGER、stepCount 0。
 */
export function createDefaultMacroSlot() {
    return {
        triggerMask: 0,
        holdMs: 0,
        mode: 0,
        flags: MACRO_FLAG_BLOCK_TRIGGER,
        stepCount: 0,
        steps: Array.from({ length: MACRO_MAX_STEPS }, createDefaultMacroStep),
    };
}

export function createDefaultMacroSlots() {
    return Array.from({ length: MACRO_SLOT_COUNT }, createDefaultMacroSlot);
}

/** 字段级规整：把任意来源的步对象收敛到合法范围 */
function normalizeStep(raw) {
    const src = raw || {};
    return {
        mask: (Number(src.mask) & DS4_LOGICAL_MASK_ALL) >>> 0,
        lx: clampInt(src.lx, MACRO_AXIS_MIN, MACRO_AXIS_MAX, 0),
        ly: clampInt(src.ly, MACRO_AXIS_MIN, MACRO_AXIS_MAX, 0),
        rx: clampInt(src.rx, MACRO_AXIS_MIN, MACRO_AXIS_MAX, 0),
        ry: clampInt(src.ry, MACRO_AXIS_MIN, MACRO_AXIS_MAX, 0),
        durationMs: clampInt(src.durationMs, MACRO_STEP_MS_MIN, MACRO_STEP_MS_MAX, 100),
    };
}

/** 模型初始化容错：macros 缺失 / 长度不对 / 槽字段越界时原地收敛 */
function ensureModel(model) {
    if (!model) return;
    if (!Array.isArray(model.macros) || model.macros.length !== MACRO_SLOT_COUNT) {
        model.macros = createDefaultMacroSlots();
        return;
    }
    for (const slot of model.macros) {
        if (!slot || typeof slot !== 'object') continue;
        slot.triggerMask = (Number(slot.triggerMask) & MACRO_TRIGGER_MASK_ALL) >>> 0;
        slot.holdMs = clampInt(slot.holdMs, 0, MACRO_HOLD_MS_MAX, 0);
        slot.mode = clampInt(slot.mode, 0, MACRO_MODE_MAX, 0);
        slot.flags = Number(slot.flags) & MACRO_FLAG_BLOCK_TRIGGER;
        slot.stepCount = clampInt(slot.stepCount, 0, MACRO_MAX_STEPS, 0);
        ensureStepsArray(slot);
    }
}

/** 保证 slot.steps 恒为 16 项（未用步保留默认值，编码时由 config.js 整体清零） */
function ensureStepsArray(slot) {
    if (!Array.isArray(slot.steps)) slot.steps = [];
    const out = [];
    for (let i = 0; i < MACRO_MAX_STEPS; i++) out.push(normalizeStep(slot.steps[i]));
    slot.steps = out;
}

/**
 * 把任意来源的宏对象（JSON 导入 / 手改文件 / 旧版本数据）收敛到固件 validate_macro_slot() 的合法域
 *
 * 与 UI 的 ensureModel() 共用同一套 clampInt / normalizeStep，保证"导入得到的槽位"
 * 与"界面上现存的槽位"在编码后是完全同构的 236 字节。
 *
 * 处理规则（逐条对应固件 Config/config.c 的 macro_slot_validate）：
 *   - triggerMask : 只保留 bit0~25（MACRO_TRIGGER_MASK_ALL）
 *   - holdMs      : 0 ~ 10000
 *   - mode        : 0 ~ 2
 *   - flags       : 只保留 bit0（BLOCK_TRIGGER），其余位清零
 *   - stepCount   : 0 ~ 16；输入未给 stepCount 时按 steps 数组长度推断
 *   - 每步        : mask 只留 bit1~18、四轴 -2048~2047、durationMs 1~65535（严禁 0）
 *
 * 返回值里的 valid 表示"这是不是一条会被固件真正执行的宏"（绑了触发键且至少 1 步）；
 * 导入时用它决定是否列进"逐条勾选"清单，空槽位不会被误当成可导入项。
 *
 * @param {*} rawSlot - 任意来源的宏对象
 * @returns {{ slot: Object, valid: boolean, reason: string }}
 */
export function normalizeMacroSlot(rawSlot) {
    const slot = createDefaultMacroSlot();

    if (!rawSlot || typeof rawSlot !== 'object' || Array.isArray(rawSlot)) {
        return { slot, valid: false, reason: '不是宏对象' };
    }

    const rawSteps = Array.isArray(rawSlot.steps) ? rawSlot.steps : [];

    slot.triggerMask = (Number(rawSlot.triggerMask) & MACRO_TRIGGER_MASK_ALL) >>> 0;
    slot.holdMs = clampInt(rawSlot.holdMs, 0, MACRO_HOLD_MS_MAX, 0);
    // mode 是枚举而不是连续量：非法值不能"钳到最大值"（那会变成 TOGGLE 开关切换，
    //   语义完全不同），一律回落到默认的 0 = 单次执行。
    {
        const rawMode = Number(rawSlot.mode);
        slot.mode = (Number.isInteger(rawMode) && rawMode >= 0 && rawMode <= MACRO_MODE_MAX) ? rawMode : 0;
    }
    slot.flags = Number(rawSlot.flags) & MACRO_FLAG_BLOCK_TRIGGER;

    // 没给 stepCount 就按 steps 数组长度推断（精简片段里常见：只给 steps 数组）
    const stepCount = (rawSlot.stepCount === undefined || rawSlot.stepCount === null)
        ? Math.min(MACRO_MAX_STEPS, rawSteps.length)
        : clampInt(rawSlot.stepCount, 0, MACRO_MAX_STEPS, 0);

    slot.stepCount = stepCount;
    slot.steps = Array.from({ length: MACRO_MAX_STEPS }, (_, i) => normalizeStep(rawSteps[i]));

    const valid = (slot.triggerMask !== 0) && (slot.stepCount > 0);
    let reason = '';
    if (slot.triggerMask === 0) reason = '未绑定触发键';
    else if (slot.stepCount === 0) reason = '步数为 0';

    return { slot, valid, reason };
}

function getSlot() {
    const model = modelRef;
    if (!model) return createDefaultMacroSlot();
    if (!Array.isArray(model.macros) || model.macros.length !== MACRO_SLOT_COUNT) {
        model.macros = createDefaultMacroSlots();
    }
    if (!model.macros[activeSlot]) model.macros[activeSlot] = createDefaultMacroSlot();
    ensureStepsArray(model.macros[activeSlot]);
    return model.macros[activeSlot];
}

function slotGroupId(slotIdx) {
    return MACRO_GROUP_BASE + slotIdx;
}

function notifyDirty(slotIdx = activeSlot) {
    const fn = ctxRef && ctxRef.markDirty;
    if (typeof fn === 'function') fn(slotGroupId(slotIdx));
}

/** 槽位有效步总时长 */
function stepTotalMs(slot) {
    if (!slot || !Array.isArray(slot.steps)) return 0;
    const count = clampInt(slot.stepCount, 0, MACRO_MAX_STEPS, 0);
    let total = 0;
    for (let i = 0; i < count; i++) total += Number(slot.steps[i] && slot.steps[i].durationMs) || 0;
    return total;
}

/** 触发物理键摘要（'未绑定' / 'L1 + R1' / '十字键上 + L1 等 4 键'） */
function slotTriggerText(slot) {
    const mask = (Number(slot && slot.triggerMask) & MACRO_TRIGGER_MASK_ALL) >>> 0;
    if (mask === 0) return '未绑定';
    const names = [];
    for (const item of PHYSICAL_BUTTONS) {
        if ((mask & (1 << item.bit)) !== 0) names.push(shortPhysName(item.name));
    }
    if (names.length === 0) return '未绑定';
    if (names.length <= 3) return names.join(' + ');
    return `${names.slice(0, 3).join(' + ')} 等 ${names.length} 键`;
}

function modeName(mode) {
    return MODE_NAMES[clampInt(mode, 0, MACRO_MODE_MAX, 0)];
}

//--------------------------------------------------------------------+
// 快照解析 / 物理键 → 逻辑键
//--------------------------------------------------------------------+
/** 26 路物理键位图 → DS4 逻辑位掩码（按当前 model.buttonMap 映射，未映射的扩展键保留 0） */
function physToLogical(buttons) {
    const map = (modelRef && Array.isArray(modelRef.buttonMap)) ? modelRef.buttonMap : [];
    let out = 0;
    for (let bit = 0; bit < PHYSICAL_BUTTONS.length; bit++) {
        if ((buttons >>> bit) & 1) out |= Number(map[bit]) || 0;
    }
    return (out & DS4_LOGICAL_MASK_ALL) >>> 0;
}

/** 12-bit 原始值 → 相对中点偏移（死区 128，量化 64 步进，钳位 [-2048, 2047]） */
function quantizeAxis(raw) {
    let off = Math.round((Number(raw) || 0) - 2048);
    if (Math.abs(off) < REC_STICK_DEADZONE) return 0;
    off = Math.round(off / REC_STICK_STEP) * REC_STICK_STEP;
    return clampInt(off, MACRO_AXIS_MIN, MACRO_AXIS_MAX, 0);
}

/** 解析 16 字节快照（小端）。长度不足返回 null。 */
function parseSnapshot(payload) {
    if (!payload || payload.length < 16) return null;
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = payload[i] & 0xff;
    const dv = new DataView(bytes.buffer);
    return {
        buttons: dv.getUint32(0, true),
        lx: dv.getUint16(4, true),
        ly: dv.getUint16(6, true),
        rx: dv.getUint16(8, true),
        ry: dv.getUint16(10, true),
        ts: dv.getUint32(12, true),
    };
}

function formatCaptureState(state) {
    if (!state) return '等待数据…';
    const parts = [];
    parts.push(state.mask === 0 ? '无按键' : formatButtonMask(state.mask));
    if (state.lx || state.ly) parts.push(`左摇杆 ${state.lx >= 0 ? '+' : ''}${state.lx},${state.ly >= 0 ? '+' : ''}${state.ly}`);
    if (state.rx || state.ry) parts.push(`右摇杆 ${state.rx >= 0 ? '+' : ''}${state.rx},${state.ry >= 0 ? '+' : ''}${state.ry}`);
    return parts.join(' · ');
}

//--------------------------------------------------------------------+
// 渲染入口
//--------------------------------------------------------------------+
/**
 * 渲染【宏】页签
 * @param {HTMLElement} container - 内容容器（config-content）
 * @param {Object} model - 共享配置模型（含 macros[8] 与 buttonMap[26]）
 * @param {Object} ctx - { markDirty(groupId) }
 */
export function renderMacroTab(container, model, ctx) {
    containerRef = container;
    modelRef = model;
    ctxRef = ctx || {};

    if (!Number.isInteger(activeSlot) || activeSlot < 0 || activeSlot >= MACRO_SLOT_COUNT) activeSlot = 0;
    ensureModel(model);

    // 引用清零，避免指向已移除的旧节点
    slotGridEl = null; triggerBodyEl = null; recBodyEl = null;
    stepsBodyEl = null; stepsTitleEl = null; addStepBtnRef = null;
    stickToggleRef = null; recStepsEl = null; recTimeEl = null; recStateEl = null;

    container.innerHTML = '';

    // ---- 顶部说明 ----
    const banner = document.createElement('div');
    banner.className = 'notice-banner';
    banner.innerHTML = '宏功能支持 <b>8 个独立槽位</b>（配置组 5 ~ 12，每槽最多 <b>16 步</b>）：'
        + '先绑定<b>触发物理按键</b>（可组合），再选择执行模式，然后用<b>在线录制器</b>把手柄上的实际操作用 0x1B 快照录下来，'
        + '或直接在下方表格里逐步编辑。宏保存后<b>立即生效</b>，无需重启；'
        + '注意触发键屏蔽（BLOCK_TRIGGER）默认开启，触发期间该键不会再输出原生按键。';
    container.appendChild(banner);

    // ---- 1. 8 槽位总览 ----
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn';
    clearBtn.textContent = '清空当前宏';
    clearBtn.addEventListener('click', onClearSlot);

    const slotCard = buildCard('宏槽位（8 个 · 点击切换）', [clearBtn]);
    slotGridEl = document.createElement('div');
    slotGridEl.className = 'macro-slot-grid';
    slotCard.appendChild(slotGridEl);
    container.appendChild(slotCard);

    // ---- 2. 触发条件与运行模式 ----
    const triggerCard = buildCard('触发条件与运行模式');
    triggerBodyEl = document.createElement('div');
    triggerCard.appendChild(triggerBodyEl);
    container.appendChild(triggerCard);

    // ---- 3. 在线录制器 ----
    const recCard = buildCard('在线录制器（手柄实操 · 0x1B 实时快照）');
    recBodyEl = document.createElement('div');
    recCard.appendChild(recBodyEl);
    container.appendChild(recCard);

    // ---- 4. 16 步动作序列 ----
    const stepsStickToggle = document.createElement('label');
    stepsStickToggle.className = 'macro-check';
    const stickCb = document.createElement('input');
    stickCb.type = 'checkbox';
    stickCb.checked = showStickCols;
    stickCb.addEventListener('change', () => {
        showStickCols = stickCb.checked;
        refreshStepsSection();
    });
    stickToggleRef = stickCb;
    stepsStickToggle.appendChild(stickCb);
    stepsStickToggle.appendChild(document.createTextNode('显示摇杆微调列'));

    addStepBtnRef = document.createElement('button');
    addStepBtnRef.className = 'btn';
    addStepBtnRef.textContent = '+ 添加步骤';
    addStepBtnRef.addEventListener('click', onAddStep);

    const stepsCard = buildCard('动作序列', [stepsStickToggle, addStepBtnRef]);
    stepsTitleEl = stepsCard.querySelector('h3');
    stepsBodyEl = document.createElement('div');
    stepsCard.appendChild(stepsBodyEl);
    container.appendChild(stepsCard);

    refreshAll();
}

/** 区块卡片：标题 + 右侧工具条（标题文案由调用方注入，可后续通过 textContent 更新） */
function buildCard(titleText, rightNodes = []) {
    const card = document.createElement('div');
    card.className = 'section-card';

    const head = document.createElement('div');
    head.className = 'macro-card-head';

    const title = document.createElement('h3');
    title.textContent = titleText;
    head.appendChild(title);

    if (rightNodes && rightNodes.length) {
        const tools = document.createElement('div');
        tools.className = 'macro-card-tools';
        for (const node of rightNodes) tools.appendChild(node);
        head.appendChild(tools);
    }

    card.appendChild(head);
    return card;
}

function refreshAll() {
    refreshSlotCards();
    refreshTriggerSection();
    refreshRecSection();
    refreshStepsSection();
}

//--------------------------------------------------------------------+
// 1. 槽位总览
//--------------------------------------------------------------------+
function refreshSlotCards() {
    if (!slotGridEl || !slotGridEl.isConnected) return;
    const model = modelRef;
    slotGridEl.innerHTML = '';

    for (let i = 0; i < MACRO_SLOT_COUNT; i++) {
        const slot = (model.macros && model.macros[i]) || createDefaultMacroSlot();
        const bound = ((Number(slot.triggerMask) & MACRO_TRIGGER_MASK_ALL) >>> 0) !== 0;
        const count = clampInt(slot.stepCount, 0, MACRO_MAX_STEPS, 0);
        const total = stepTotalMs(slot);

        const card = document.createElement('button');
        card.type = 'button';
        card.className = `macro-slot-card${i === activeSlot ? ' active' : ''}`;
        card.dataset.slot = String(i);

        const top = document.createElement('div');
        top.className = 'macro-slot-top';

        const name = document.createElement('span');
        name.className = 'macro-slot-name';
        name.textContent = `宏 ${i + 1}`;
        top.appendChild(name);

        const badge = document.createElement('span');
        badge.className = `macro-slot-badge ${bound ? 'on' : 'off'}`;
        badge.textContent = bound ? '已启用' : '未绑定';
        top.appendChild(badge);
        card.appendChild(top);

        const trigger = document.createElement('div');
        trigger.className = 'macro-slot-trigger';
        trigger.title = slotTriggerText(slot);
        // 槽位卡片同样用图标表达触发键，与触发条件区 / 选择弹窗保持同一套视觉语言
        const triggerTags = document.createElement('span');
        triggerTags.className = 'ds-btn-tags';
        fillMaskTags(triggerTags, 'physical', slot.triggerMask, '未绑定',
            (bit) => (PHYSICAL_BUTTONS[bit] ? shortPhysName(PHYSICAL_BUTTONS[bit].name) : `bit${bit}`),
            { max: 3 });
        trigger.appendChild(triggerTags);
        card.appendChild(trigger);

        const meta = document.createElement('div');
        meta.className = 'macro-slot-meta';
        meta.textContent = `${modeName(slot.mode)} · ${count}/${MACRO_MAX_STEPS} 步 · ${total} ms`;
        card.appendChild(meta);

        card.addEventListener('click', () => onSelectSlot(i));
        slotGridEl.appendChild(card);
    }
}

function onSelectSlot(index) {
    if (index === activeSlot) return;
    if (rec.running) {
        showMessage('录制进行中', '请先点击 [停止并写入当前宏] 结束当前录制，再切换宏槽位。');
        return;
    }
    activeSlot = index;
    // 整页重建：触发配置、录制面板、步骤表都跟随槽位切换
    const container = containerRef;
    if (container && container.isConnected) {
        renderMacroTab(container, modelRef, ctxRef);
    }
}

async function onClearSlot() {
    if (rec.running) {
        await showMessage('录制进行中', '请先点击 [停止并写入当前宏] 结束当前录制，再清空槽位。');
        return;
    }
    const slot = getSlot();
    const ok = await showConfirm(`清空宏 ${activeSlot + 1}`, '将把该槽位重置为「未绑定、0 步、单次执行、默认屏蔽触发键」。确定继续吗？');
    if (!ok) return;

    const fresh = createDefaultMacroSlot();
    slot.triggerMask = fresh.triggerMask;
    slot.holdMs = fresh.holdMs;
    slot.mode = fresh.mode;
    slot.flags = fresh.flags;
    slot.stepCount = fresh.stepCount;
    slot.steps = fresh.steps;

    notifyDirty();
    refreshAll();
}

//--------------------------------------------------------------------+
// 2. 触发条件与运行模式
//--------------------------------------------------------------------+
function refreshTriggerSection() {
    if (!triggerBodyEl || !triggerBodyEl.isConnected) return;
    const slot = getSlot();
    triggerBodyEl.innerHTML = '';

    // ---- 触发物理按键（多选组合） ----
    const triggerRow = document.createElement('div');
    triggerRow.className = 'config-row';

    const triggerLabel = document.createElement('span');
    triggerLabel.className = 'config-label';
    triggerLabel.textContent = '触发按键';
    triggerRow.appendChild(triggerLabel);

    const triggerInput = document.createElement('div');
    triggerInput.className = 'config-input';

    const triggerBtn = document.createElement('button');
    triggerBtn.type = 'button';
    triggerBtn.className = 'macro-trigger-btn';
    const bound = ((Number(slot.triggerMask) & MACRO_TRIGGER_MASK_ALL) >>> 0) !== 0;
    // 触发键是 26 路物理键位掩码 → 用物理位图标表（与按键映射表同一套图形语言）
    const triggerTags = document.createElement('span');
    triggerTags.className = 'ds-btn-tags';
    fillMaskTags(triggerTags, 'physical', slot.triggerMask, '未绑定',
        (bit) => (PHYSICAL_BUTTONS[bit] ? shortPhysName(PHYSICAL_BUTTONS[bit].name) : `bit${bit}`),
        { max: 4 });
    triggerBtn.appendChild(triggerTags);
    triggerBtn.classList.toggle('is-empty', !bound);
    triggerBtn.title = '点击选择触发物理按键（支持单键或组合键）';
    triggerBtn.addEventListener('click', () => openPhysicalPicker());
    triggerInput.appendChild(triggerBtn);

    const clearBindBtn = document.createElement('button');
    clearBindBtn.type = 'button';
    clearBindBtn.className = 'btn';
    clearBindBtn.textContent = '清除绑定';
    clearBindBtn.disabled = !bound;
    clearBindBtn.addEventListener('click', () => {
        slot.triggerMask = 0;
        notifyDirty();
        refreshSlotCards();
        refreshTriggerSection();
    });
    triggerInput.appendChild(clearBindBtn);

    triggerRow.appendChild(triggerInput);
    triggerBodyEl.appendChild(triggerRow);

    // ---- 触发模式 ----
    const modeRow = document.createElement('div');
    modeRow.className = 'config-row';

    const modeLabel = document.createElement('span');
    modeLabel.className = 'config-label';
    modeLabel.textContent = '执行模式';
    modeRow.appendChild(modeLabel);

    const modeInput = document.createElement('div');
    modeInput.className = 'config-input';

    const modeSelect = document.createElement('select');
    MODE_NAMES.forEach((name, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = `${i}：${name} (${MODE_DETAIL[i]})`;
        modeSelect.appendChild(opt);
    });
    modeSelect.value = String(clampInt(slot.mode, 0, MACRO_MODE_MAX, 0));
    modeSelect.addEventListener('change', () => {
        slot.mode = clampInt(modeSelect.value, 0, MACRO_MODE_MAX, 0);
        notifyDirty();
        refreshSlotCards();
    });
    modeInput.appendChild(modeSelect);
    modeRow.appendChild(modeInput);
    triggerBodyEl.appendChild(modeRow);

    // ---- 长按触发阈值 ----
    const holdRow = document.createElement('div');
    holdRow.className = 'config-row';

    const holdLabel = document.createElement('span');
    holdLabel.className = 'config-label';
    holdLabel.textContent = '长按阈值';
    holdRow.appendChild(holdLabel);

    const holdInput = document.createElement('div');
    holdInput.className = 'config-input';

    const holdField = document.createElement('div');
    holdField.className = 'number-stepper';
    const holdNum = document.createElement('input');
    holdNum.type = 'number';
    holdNum.min = '0';
    holdNum.max = String(MACRO_HOLD_MS_MAX);
    holdNum.step = '10';
    holdNum.value = String(clampInt(slot.holdMs, 0, MACRO_HOLD_MS_MAX, 0));
    holdField.appendChild(holdNum);
    holdInput.appendChild(holdField);

    const holdRange = document.createElement('span');
    holdRange.className = 'config-range';
    holdRange.textContent = `0 ~ ${MACRO_HOLD_MS_MAX} ms（0 = 按下立即触发）`;
    holdInput.appendChild(holdRange);

    // 失去焦点（change）时钳位，越界值固件会判 INVALID_DATA
    const applyHold = () => {
        if (holdNum.value === '') {
            holdNum.value = String(slot.holdMs);
            return;
        }
        slot.holdMs = clampInt(holdNum.value, 0, MACRO_HOLD_MS_MAX, 0);
        holdNum.value = String(slot.holdMs);
        notifyDirty();
        refreshSlotCards();
    };
    holdNum.addEventListener('change', applyHold);
    holdNum.addEventListener('blur', applyHold);

    holdRow.appendChild(holdInput);
    triggerBodyEl.appendChild(holdRow);

    // ---- 屏蔽触发键原始输出 ----
    const flagRow = document.createElement('div');
    flagRow.className = 'config-row';

    const flagLabel = document.createElement('span');
    flagLabel.className = 'config-label';
    flagLabel.textContent = '屏蔽触发键';
    flagRow.appendChild(flagLabel);

    const flagInput = document.createElement('div');
    flagInput.className = 'config-input';

    const flagWrap = document.createElement('label');
    flagWrap.className = 'macro-check';
    const flagCb = document.createElement('input');
    flagCb.type = 'checkbox';
    flagCb.checked = (Number(slot.flags) & MACRO_FLAG_BLOCK_TRIGGER) !== 0;
    flagCb.addEventListener('change', () => {
        slot.flags = flagCb.checked ? MACRO_FLAG_BLOCK_TRIGGER : 0;
        notifyDirty();
        refreshSlotCards();
    });
    flagWrap.appendChild(flagCb);
    flagWrap.appendChild(document.createTextNode('触发期间屏蔽该触发键的原生按键输出（BLOCK_TRIGGER）'));
    flagInput.appendChild(flagWrap);
    flagRow.appendChild(flagInput);
    triggerBodyEl.appendChild(flagRow);

    const hint = document.createElement('p');
    hint.className = 'placeholder-text';
    hint.textContent = '触发键支持组合（同时按下才算触发）。修改后点击底边栏 [保存] 写入固件；宏保存后立即生效，无需重启。';
    triggerBodyEl.appendChild(hint);
}

// 物理键多选弹窗（26 路）
function openPhysicalPicker() {
    const slot = getSlot();
    openBitPicker({
        title: `选择触发物理按键 · 宏 ${activeSlot + 1}`,
        subtitle: `26 路物理键 · 组合键需同时按下 · 当前 ${slotTriggerText(slot)}`,
        groups: PHYS_GROUPS.map((g) => ({
            title: g.title,
            items: g.bits.map((bit) => {
                const info = PHYSICAL_BUTTONS[bit];
                return { bit, short: shortPhysName(info.name), label: `${info.name}（bit${info.bit} · ${info.pin}）` };
            }),
        })),
        getMask: () => (Number(slot.triggerMask) & MACRO_TRIGGER_MASK_ALL) >>> 0,
        bitValue: (bit) => (1 << bit) >>> 0,
        // 触发键 = 物理位序，查 PHYSICAL 图标表
        iconOf: (bit) => physicalIconKey(bit),
        // 掩码 → 文案（物理键走槽位摘要，逻辑键走 DS4 逻辑功能名）
        formatMask: (mask) => (mask === 0 ? '未绑定' : slotTriggerText({ triggerMask: mask })),
        onToggle: (bit) => {
            slot.triggerMask = (((Number(slot.triggerMask) & MACRO_TRIGGER_MASK_ALL) ^ ((1 << bit) >>> 0)) & MACRO_TRIGGER_MASK_ALL) >>> 0;
            notifyDirty();
            refreshSlotCards();
            refreshTriggerSection();
        },
        onClear: () => {
            slot.triggerMask = 0;
            notifyDirty();
            refreshSlotCards();
            refreshTriggerSection();
        },
        clearLabel: '清除绑定',
    });
}

// 逻辑键多选弹窗（18 位，步骤 mask 用）
function openLogicalPicker(stepIndex) {
    const slot = getSlot();
    const step = slot.steps[stepIndex];
    if (!step) return;
    openBitPicker({
        title: `第 ${stepIndex + 1} 步 · 输出 DS4 按键`,
        subtitle: '可勾选 0 个（纯延时等待）、1 个或多个逻辑按键',
        groups: LOGICAL_GROUPS.map((g) => ({
            title: g.title,
            items: g.bits.map((bit) => {
                const info = DS4_LOGICAL_BUTTONS.find((x) => x.bit === bit);
                return { bit, short: info ? info.short : String(bit), label: info ? info.label : `bit${bit}` };
            }),
        })),
        getMask: () => (Number(step.mask) & DS4_LOGICAL_MASK_ALL) >>> 0,
        bitValue: (bit) => ds4BtnBit(bit),
        // 步内 mask = DS4 逻辑位序，查 LOGICAL 图标表
        iconOf: (bit) => logicalIconKey(bit),
        formatMask: (mask) => (mask === 0 ? '无（纯延时等待）' : formatButtonMask(mask)),
        onToggle: (bit) => {
            step.mask = (((Number(step.mask) & DS4_LOGICAL_MASK_ALL) ^ ds4BtnBit(bit)) & DS4_LOGICAL_MASK_ALL) >>> 0;
            notifyDirty();
            refreshSlotCards();
            refreshStepsSection();
        },
        onClear: () => {
            step.mask = 0;
            notifyDirty();
            refreshSlotCards();
            refreshStepsSection();
        },
        clearLabel: '设为无（纯延时）',
    });
}

/**
 * 通用位掩码多选弹窗
 * @param {Object} opts
 *   title/subtitle, groups:[{title, items:[{bit, short, label}]}],
 *   getMask(), bitValue(bit), onToggle(bit), onClear(), clearLabel
 */
function openBitPicker(opts) {
    const overlay = document.createElement('div');
    overlay.className = 'macro-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const card = document.createElement('div');
    card.className = 'macro-picker';

    // 头部
    const head = document.createElement('div');
    head.className = 'macro-picker-head';

    const titleBox = document.createElement('div');
    titleBox.className = 'macro-picker-title-box';
    const title = document.createElement('h3');
    title.textContent = opts.title;
    const sub = document.createElement('span');
    sub.className = 'macro-picker-sub';
    sub.textContent = opts.subtitle || '';
    titleBox.appendChild(title);
    titleBox.appendChild(sub);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'macro-picker-close';
    closeBtn.textContent = '×';
    closeBtn.title = '关闭（Esc）';
    closeBtn.addEventListener('click', () => close());

    head.appendChild(titleBox);
    head.appendChild(closeBtn);
    card.appendChild(head);

    // 当前掩码预览
    const preview = document.createElement('div');
    preview.className = 'macro-picker-preview';
    const previewLabel = document.createElement('span');
    previewLabel.textContent = '当前：';
    const previewValue = document.createElement('b');
    preview.appendChild(previewLabel);
    preview.appendChild(previewValue);
    card.appendChild(preview);

    // 分组芯片
    const chips = [];
    for (const group of opts.groups) {
        const section = document.createElement('div');
        section.className = 'macro-picker-group';

        const groupLabel = document.createElement('div');
        groupLabel.className = 'macro-picker-group-title';
        groupLabel.textContent = group.title;
        section.appendChild(groupLabel);

        const wrap = document.createElement('div');
        wrap.className = 'macro-chips';

        for (const item of group.items) {
            const bitValue = opts.bitValue(item.bit);
            // 物理键 / 逻辑键两套位序各自查表，由调用方通过 iconOf 注入
            const chipIconKey = (typeof opts.iconOf === 'function') ? opts.iconOf(item.bit) : null;
            const chip = document.createElement('button');
            chip.type = 'button';
            // 18 枚标准按键 → 44px 正圆按钮；BTN1~BTN8 无图标 → 文字胶囊（避免文字被圆形裁切）
            chip.className = chipIconKey
                ? 'macro-chip ds-pick ds-pick-circle'
                : 'macro-chip ds-pick ds-pick-text';
            chip.title = item.label;
            chip.setAttribute('aria-pressed', 'false');
            chip._bit = bitValue;
            chip.appendChild(iconTag(chipIconKey, item.short, { size: 50 }));
            chip.addEventListener('click', () => {
                opts.onToggle(item.bit);
                refresh();
            });
            chips.push(chip);
            wrap.appendChild(chip);
        }

        section.appendChild(wrap);
        card.appendChild(section);
    }

    // 底部
    const footer = document.createElement('div');
    footer.className = 'macro-picker-footer';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn';
    clearBtn.textContent = opts.clearLabel || '清除';
    clearBtn.addEventListener('click', () => {
        opts.onClear();
        refresh();
    });

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'btn-primary';
    doneBtn.textContent = '完成';
    doneBtn.addEventListener('click', () => close());

    footer.appendChild(clearBtn);
    footer.appendChild(doneBtn);
    card.appendChild(footer);

    overlay.appendChild(card);

    function refresh() {
        const mask = opts.getMask();
        for (const chip of chips) {
            const on = (mask & chip._bit) !== 0;
            chip.classList.toggle('on', on);
            chip.classList.toggle('is-selected', on);
            chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        previewValue.textContent = opts.formatMask ? opts.formatMask(mask) : String(mask);
        previewValue.classList.toggle('is-empty', mask === 0);
    }

    let closed = false;
    function close() {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKeydown);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    function onKeydown(ev) {
        if (ev.key === 'Escape' || ev.key === 'Esc') close();
    }

    overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay) close();
    });
    document.addEventListener('keydown', onKeydown);

    refresh();
    document.body.appendChild(overlay);
    return close;
}

//--------------------------------------------------------------------+
// 3. 在线录制器（0x1B 单飞串行轮询）
//--------------------------------------------------------------------+
function refreshRecSection() {
    if (!recBodyEl || !recBodyEl.isConnected) return;
    recBodyEl.innerHTML = '';
    recStepsEl = null; recTimeEl = null; recStateEl = null;

    // 选项：同时录制摇杆轨迹
    const optRow = document.createElement('div');
    optRow.className = 'config-row';

    const optLabel = document.createElement('span');
    optLabel.className = 'config-label';
    optLabel.textContent = '录制选项';
    optRow.appendChild(optLabel);

    const optInput = document.createElement('div');
    optInput.className = 'config-input';

    const stickWrap = document.createElement('label');
    stickWrap.className = 'macro-check';
    const stickCb = document.createElement('input');
    stickCb.type = 'checkbox';
    stickCb.checked = rec.captureSticks;
    stickCb.addEventListener('change', () => {
        rec.captureSticks = stickCb.checked;
    });
    stickWrap.appendChild(stickCb);
    stickWrap.appendChild(document.createTextNode('同时录制摇杆轨迹（默认关闭，避免正常推杆被录入）'));
    optInput.appendChild(stickWrap);
    optRow.appendChild(optInput);
    recBodyEl.appendChild(optRow);

    // 操作按钮
    const btnRow = document.createElement('div');
    btnRow.className = 'config-row';

    const btnLabel = document.createElement('span');
    btnLabel.className = 'config-label';
    btnLabel.textContent = '录制操作';
    btnRow.appendChild(btnLabel);

    const btnInput = document.createElement('div');
    btnInput.className = 'config-input';

    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'btn-primary';
    startBtn.textContent = rec.running ? '录制中…' : '开始录制';
    startBtn.disabled = rec.running;
    startBtn.addEventListener('click', () => startRecording());

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'btn';
    stopBtn.textContent = '停止并写入当前宏';
    stopBtn.disabled = !rec.running;
    stopBtn.addEventListener('click', () => finishRecording(false));

    btnInput.appendChild(startBtn);
    btnInput.appendChild(stopBtn);
    btnRow.appendChild(btnInput);
    recBodyEl.appendChild(btnRow);

    // 实时预览
    const statRow = document.createElement('div');
    statRow.className = 'macro-rec-stats';

    const mkStat = (labelText, wide = false) => {
        const box = document.createElement('div');
        box.className = `macro-rec-stat${wide ? ' wide' : ''}`;
        const l = document.createElement('span');
        l.className = 'macro-rec-stat-label';
        l.textContent = labelText;
        const v = document.createElement('b');
        v.className = 'macro-rec-stat-value';
        v.textContent = '-';
        box.appendChild(l);
        box.appendChild(v);
        statRow.appendChild(box);
        return v;
    };

    recStepsEl = mkStat('已录步数');
    recTimeEl = mkStat('累计时长');
    recStateEl = mkStat('当前捕获', true);
    recBodyEl.appendChild(statRow);

    if (!rec.running) {
        // 停止后回显上一次写入结果（同槽位内有效），否则显示未开始
        const res = (lastRecResult && lastRecResult.slot === activeSlot) ? lastRecResult : null;
        recStepsEl.textContent = `${res ? res.steps : 0} / ${MACRO_MAX_STEPS}`;
        recTimeEl.textContent = `${res ? res.ms : 0} ms`;
        recStateEl.textContent = res
            ? `上次录制已写入「宏 ${res.slot + 1}」（${res.steps} 步 / ${res.ms} ms）`
            : '未开始录制';
    } else {
        updateRecUi(true);
    }

    const hint = document.createElement('p');
    hint.className = 'placeholder-text';
    hint.textContent = '录制原理：以 0x1B 快照逐帧串行轮询（单飞，上一帧回来后才排下一帧），'
        + '用固件微秒时间戳的无符号差值累加每个状态的持续毫秒数，自动忽略开头的空等待、'
        + '合并连续同态、过滤小于 5ms 的抖动，停止时裁掉尾部空等待。'
        + '录制的按键按当前「按键映射」（组 4）转换到 DS4 逻辑键，最多 16 步。';
    recBodyEl.appendChild(hint);
}

function recTotalMs() {
    let total = 0;
    for (const s of rec.steps) total += Number(s.durationMs) || 0;
    return total + Math.round(rec.pendingMs || 0);
}

function resetRecState() {
    rec.started = false;
    rec.steps = [];
    rec.pending = null;
    rec.pendingMs = 0;
    rec.prevTs = null;
    rec.lastState = null;
}

function startRecording() {
    if (rec.running) return;
    lastRecResult = null;
    resetRecState();
    rec.running = true;
    lastRecUiTs = 0;
    refreshRecSection();
    scheduleNextFrame();
}

function scheduleNextFrame(delay = 0) {
    if (!rec.running) return;
    recTimer = setTimeout(pollOnce, delay);
}

function stopPolling() {
    if (recTimer !== null) {
        clearTimeout(recTimer);
        recTimer = null;
    }
}

/**
 * 单帧：请求 0x1B 快照 → 处理 → 再排下一帧。
 * 超时 / 断连（msp.request 返回 null）时静默跳过，绝不弹窗。
 */
async function pollOnce() {
    recTimer = null;
    if (!rec.running) return;

    let resp = null;
    try {
        resp = await msp.request(serial, MSP_CMD.INPUT_SNAPSHOT, [], REC_SNAPSHOT_TIMEOUT_MS);
    } catch (e) {
        resp = null;
    }
    if (!rec.running) return;

    const snap = (resp && resp.payload) ? parseSnapshot(resp.payload) : null;
    if (snap) {
        try {
            consumeSnapshot(snap);
        } catch (e) {
            // 单帧解析异常不影响后续轮询
        }
    }
    updateRecUi(false);
    scheduleNextFrame(snap ? 0 : REC_FAIL_BACKOFF_MS);
}

function consumeSnapshot(snap) {
    const state = {
        mask: physToLogical(snap.buttons),
        lx: rec.captureSticks ? quantizeAxis(snap.lx) : 0,
        ly: rec.captureSticks ? quantizeAxis(snap.ly) : 0,
        rx: rec.captureSticks ? quantizeAxis(snap.rx) : 0,
        ry: rec.captureSticks ? quantizeAxis(snap.ry) : 0,
    };
    rec.lastState = state;

    // 首帧只用来打时间戳基线
    if (rec.prevTs === null) {
        rec.prevTs = snap.ts;
        if (!rec.started && !isIdleState(state)) {
            rec.started = true;
            rec.pending = state;
            rec.pendingMs = 0;
        }
        return;
    }

    // 微秒时间戳回绕安全：按无符号差值算真实毫秒间隔
    const deltaUs = (snap.ts - rec.prevTs) >>> 0;
    rec.prevTs = snap.ts;
    const dtMs = Math.round(deltaUs / 1000);

    if (!rec.started) {
        // 忽略开头的空等待帧（无按键且摇杆居中）
        if (isIdleState(state)) return;
        rec.started = true;
        rec.pending = state;
        rec.pendingMs = 0;
        return;
    }

    // 把这一帧的间隔记到"上一状态"的账上
    rec.pendingMs += dtMs;
    if (rec.pendingMs > MACRO_STEP_MS_MAX) rec.pendingMs = MACRO_STEP_MS_MAX;

    // 已录满 16 步：立刻收尾（不必等下一次状态切换）
    if (rec.steps.length >= MACRO_MAX_STEPS) {
        finishRecording(true);
        return;
    }

    if (!sameState(state, rec.pending)) {
        flushPending();
        if (!rec.running) return;   // 触达 16 步上限，已自动收尾
        rec.pending = state;
    }
}

function isIdleState(state) {
    return !!state && state.mask === 0 && state.lx === 0 && state.ly === 0 && state.rx === 0 && state.ry === 0;
}

/** 把挂起态落成一步（不含 16 步上限判断） */
function pushPendingStep() {
    if (!rec.pending) {
        rec.pendingMs = 0;
        return;
    }
    const duration = Math.round(rec.pendingMs);
    rec.pendingMs = 0;
    if (duration < REC_MIN_STEP_MS) return;   // 抖动过滤：< 5ms 的瞬时态丢弃

    const step = {
        mask: rec.pending.mask,
        lx: rec.pending.lx,
        ly: rec.pending.ly,
        rx: rec.pending.rx,
        ry: rec.pending.ry,
        durationMs: clampInt(duration, MACRO_STEP_MS_MIN, MACRO_STEP_MS_MAX, 1),
    };

    const last = rec.steps[rec.steps.length - 1];
    if (last && sameState(last, step)) {
        // 连续同态合并
        last.durationMs = clampInt(last.durationMs + step.durationMs, MACRO_STEP_MS_MIN, MACRO_STEP_MS_MAX, 1);
        return;
    }
    rec.steps.push(step);
}

/** 状态切换时落步，并在触达 16 步上限时自动收尾 */
function flushPending() {
    pushPendingStep();
    if (rec.steps.length >= MACRO_MAX_STEPS) {
        finishRecording(true);
    }
}

function updateRecUi(force) {
    if (!rec.running) return;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (!force && now - lastRecUiTs < REC_UI_INTERVAL_MS) return;
    lastRecUiTs = now;

    if (recStepsEl && recStepsEl.isConnected) recStepsEl.textContent = `${rec.steps.length} / ${MACRO_MAX_STEPS}`;
    if (recTimeEl && recTimeEl.isConnected) recTimeEl.textContent = `${recTotalMs()} ms`;
    if (recStateEl && recStateEl.isConnected) recStateEl.textContent = formatCaptureState(rec.lastState);
}

/**
 * 停止录制并写入当前槽位
 * @param {boolean} auto - true 表示因 16 步上限自动停止
 */
async function finishRecording(auto) {
    if (!rec.running && !auto) return;

    stopPolling();
    rec.running = false;

    // 收尾：把最后一个挂起态按已累计时长落成一步
    pushPendingStep();

    // 自动裁掉末尾全零等待帧
    while (rec.steps.length > 0 && isZeroStep(rec.steps[rec.steps.length - 1])) rec.steps.pop();

    const captured = rec.steps.slice(0, MACRO_MAX_STEPS);
    const slot = getSlot();

    if (captured.length === 0) {
        resetRecState();
        refreshRecSection();
        await showMessage('录制结束', '本次没有捕获到任何有效动作（未检测到按键或摇杆输入），当前宏保持不变。');
        return;
    }

    // 写入槽位：有效步逐个规范，其余补默认值（编码时会被整体清零）
    const steps = [];
    for (let i = 0; i < MACRO_MAX_STEPS; i++) {
        steps.push(captured[i] ? normalizeStep(captured[i]) : createDefaultMacroStep());
    }
    slot.steps = steps;
    slot.stepCount = captured.length;
    lastRecResult = { slot: activeSlot, steps: captured.length, ms: stepTotalMs(slot) };

    notifyDirty();
    resetRecState();

    refreshSlotCards();
    refreshRecSection();
    refreshStepsSection();

    const needTrigger = ((Number(slot.triggerMask) & MACRO_TRIGGER_MASK_ALL) >>> 0) === 0;
    const tail = needTrigger ? '\n\n注意：该槽位尚未绑定触发按键，请在上方「触发按键」里选择后才能使用。' : '';

    if (auto) {
        await showMessage('录制已自动停止', `已录满 ${MACRO_MAX_STEPS} 步，录制自动停止并写入「宏 ${activeSlot + 1}」。${tail}\n\n点击底边栏 [保存] 写入固件 Flash。`);
    } else {
        await showMessage('录制完成', `已写入「宏 ${activeSlot + 1}」：${captured.length} 步，总时长 ${stepTotalMs(slot)} ms。${tail}\n\n点击底边栏 [保存] 写入固件 Flash。`);
    }
}

/**
 * 停止后台轮询并丢弃本次未提交的录制数据。
 * 页签切换、断开连接、离开配置页时由 pages/config.js 调用。
 */
export function stopMacroRecording() {
    const wasRunning = rec.running;
    rec.running = false;
    stopPolling();
    resetRecState();
    if (wasRunning) refreshRecSection();
}

//--------------------------------------------------------------------+
// 4. 16 步动作序列编辑器
//--------------------------------------------------------------------+
function updateStepsTitle() {
    if (!stepsTitleEl) return;
    const slot = getSlot();
    const count = clampInt(slot.stepCount, 0, MACRO_MAX_STEPS, 0);
    stepsTitleEl.textContent = `动作序列（${count} / ${MACRO_MAX_STEPS} 步 · 总时长 ${stepTotalMs(slot)} ms）`;
    if (addStepBtnRef) addStepBtnRef.disabled = count >= MACRO_MAX_STEPS;
}

function refreshStepsSection() {
    if (!stepsBodyEl || !stepsBodyEl.isConnected) return;
    const slot = getSlot();
    ensureStepsArray(slot);
    slot.stepCount = clampInt(slot.stepCount, 0, MACRO_MAX_STEPS, 0);

    if (stickToggleRef) stickToggleRef.checked = showStickCols;
    updateStepsTitle();

    stepsBodyEl.innerHTML = '';

    const count = slot.stepCount;
    if (count === 0) {
        const empty = document.createElement('p');
        empty.className = 'placeholder-text';
        empty.textContent = '当前宏还没有动作步：可以用上方在线录制器录一段，或点击 [+ 添加步骤] 手动添加（默认 100 ms 纯延时步）。';
        stepsBodyEl.appendChild(empty);
        return;
    }

    const head = document.createElement('div');
    head.className = `macro-step-head${showStickCols ? ' with-sticks' : ''}`;
    const headCells = ['步', '输出 DS4 按键', ...(showStickCols ? ['LX', 'LY', 'RX', 'RY'] : []), '时长 (ms)', '操作'];
    for (const text of headCells) {
        const cell = document.createElement('span');
        cell.textContent = text;
        head.appendChild(cell);
    }
    stepsBodyEl.appendChild(head);

    for (let i = 0; i < count; i++) {
        stepsBodyEl.appendChild(buildStepRow(slot, i, count));
    }

    const hint = document.createElement('p');
    hint.className = 'placeholder-text';
    hint.textContent = '步内按键为 DS4 逻辑位（bit1~18），与「按键映射」表里的功能位同一套编码；'
        + '摇杆为相对中点的偏移（-2048 ~ +2047，0 = 不干预物理摇杆）；时长 1 ~ 65535 ms。'
        + '未使用的步会被编码成全 0，固件校验要求如此。';
    stepsBodyEl.appendChild(hint);
}

function buildStepRow(slot, index, count) {
    const step = slot.steps[index];

    const row = document.createElement('div');
    row.className = `macro-step-row${showStickCols ? ' with-sticks' : ''}`;

    // 序号
    const idx = document.createElement('span');
    idx.className = 'macro-step-idx';
    idx.textContent = String(index + 1);
    row.appendChild(idx);

    // 逻辑按键按钮
    const maskBtn = document.createElement('button');
    maskBtn.type = 'button';
    maskBtn.className = 'macro-step-mask';
    // 步内 mask 是 DS4 逻辑位 → 用逻辑位图标表，与多选弹窗完全一致
    const maskTags = document.createElement('span');
    maskTags.className = 'ds-btn-tags';
    fillMaskTags(maskTags, 'logical', step.mask, '无（纯延时等待）',
        (bit) => {
            const fb = DS4_LOGICAL_BUTTONS.find((x) => x.bit === bit);
            return fb ? fb.short : `bit${bit}`;
        },
        { max: 4 });
    maskBtn.appendChild(maskTags);
    maskBtn.title = '点击选择本步输出的 DS4 逻辑按键';
    maskBtn.classList.toggle('is-empty', step.mask === 0);
    maskBtn.addEventListener('click', () => openLogicalPicker(index));
    row.appendChild(maskBtn);

    // 四轴微调
    if (showStickCols) {
        const axes = ['lx', 'ly', 'rx', 'ry'];
        for (const axis of axes) {
            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'macro-num macro-axis';
            input.min = String(MACRO_AXIS_MIN);
            input.max = String(MACRO_AXIS_MAX);
            input.step = '64';
            input.value = String(step[axis]);
            const apply = () => {
                if (input.value === '') {
                    input.value = String(step[axis]);
                    return;
                }
                step[axis] = clampInt(input.value, MACRO_AXIS_MIN, MACRO_AXIS_MAX, 0);
                input.value = String(step[axis]);
                notifyDirty();
                refreshSlotCards();
            };
            input.addEventListener('change', apply);
            input.addEventListener('blur', apply);
            row.appendChild(input);
        }
    }

    // 时长
    const durField = document.createElement('div');
    durField.className = 'macro-dur';
    const durInput = document.createElement('input');
    durInput.type = 'number';
    durInput.className = 'macro-num';
    durInput.min = String(MACRO_STEP_MS_MIN);
    durInput.max = String(MACRO_STEP_MS_MAX);
    durInput.step = '10';
    durInput.value = String(step.durationMs);
    const applyDur = () => {
        if (durInput.value === '') {
            durInput.value = String(step.durationMs);
            return;
        }
        step.durationMs = clampInt(durInput.value, MACRO_STEP_MS_MIN, MACRO_STEP_MS_MAX, 1);
        durInput.value = String(step.durationMs);
        notifyDirty();
        updateStepsTitle();
        refreshSlotCards();
    };
    durInput.addEventListener('change', applyDur);
    durInput.addEventListener('blur', applyDur);
    durField.appendChild(durInput);
    row.appendChild(durField);

    // 行操作
    const actions = document.createElement('div');
    actions.className = 'macro-step-actions';

    const mkBtn = (label, title, disabled, handler, danger = false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `macro-icon-btn${danger ? ' danger' : ''}`;
        b.textContent = label;
        b.title = title;
        b.disabled = !!disabled;
        b.addEventListener('click', handler);
        return b;
    };

    actions.appendChild(mkBtn('↑', '上移', index === 0, () => onMoveStep(index, -1)));
    actions.appendChild(mkBtn('↓', '下移', index >= count - 1, () => onMoveStep(index, 1)));
    actions.appendChild(mkBtn('⧉', '复制本步', count >= MACRO_MAX_STEPS, () => onCopyStep(index)));
    actions.appendChild(mkBtn('✕', '删除本步', false, () => onDeleteStep(index), true));
    row.appendChild(actions);

    return row;
}

function onAddStep() {
    const slot = getSlot();
    if (slot.stepCount >= MACRO_MAX_STEPS) return;
    slot.steps[slot.stepCount] = createDefaultMacroStep();
    slot.stepCount += 1;
    notifyDirty();
    refreshStepsSection();
    refreshSlotCards();
}

function onMoveStep(index, delta) {
    const slot = getSlot();
    const target = index + delta;
    if (target < 0 || target >= slot.stepCount) return;
    const tmp = slot.steps[index];
    slot.steps[index] = slot.steps[target];
    slot.steps[target] = tmp;
    notifyDirty();
    refreshStepsSection();
    refreshSlotCards();
}

function onCopyStep(index) {
    const slot = getSlot();
    if (slot.stepCount >= MACRO_MAX_STEPS) return;
    const clone = normalizeStep(slot.steps[index]);
    for (let i = slot.stepCount; i > index + 1; i--) slot.steps[i] = slot.steps[i - 1];
    slot.steps[index + 1] = clone;
    slot.stepCount += 1;
    notifyDirty();
    refreshStepsSection();
    refreshSlotCards();
}

function onDeleteStep(index) {
    const slot = getSlot();
    if (slot.stepCount <= 0) return;
    for (let i = index; i < slot.stepCount - 1; i++) slot.steps[i] = slot.steps[i + 1];
    slot.steps[slot.stepCount - 1] = createDefaultMacroStep();
    slot.stepCount -= 1;
    notifyDirty();
    refreshStepsSection();
    refreshSlotCards();
}
