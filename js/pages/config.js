/**
 * config.js - 配置页面
 *
 * 数据机制（与固件 Driver/msp/msp_handler.c 对应）：
 * - 连接后自动读取设备信息（API/变体/固件版本）与所有配置组
 * - 配置组：
 *   1 joystick_calib（24 字节）：LX/LY/RX/RY 各 {min, center, max}（u16 LE）
 *   2 gamepad_settings（6 字节）：deadzone_left / deadzone_right（u16 LE，0~2047 ADC count）
 *                                + invert_mask（u8，bit0~3 = LX/LY/RX/RY）+ debounce_ms（u8，0~50ms）
 *   3 polling_rate（1 字节）：level
 *   4 button_map（104 字节）：uint32_t mask[26] 小端，每项为逻辑功能位掩码（bit1~18，0=禁用）
 *   5~12 macro_slot[0~7]（每个 236 字节）：MacroSlotConfig（见 §3.2 注释）
 * - 修改后点击 [保存] 写入固件（CONFIG_SET + CONFIG_SAVE）
 */

import { serial } from '../serial.js';
import { msp, MSP_CMD, MSP_STATUS_NAME } from '../msp.js';
import { renderTabBar, setActiveTab } from '../components/tabs.js';
import { showMessage, showConfirm } from '../components/dialog.js';
import { renderButtonsTab } from '../tabs/buttons.js';
import { renderJoystickTab, GROUP_JOYSTICK_CALIB, GROUP_GAMEPAD_SETTINGS } from '../tabs/joystick.js';
import { renderTriggerTab } from '../tabs/trigger.js';
import { DEFAULT_BUTTON_MASKS, DS4_LOGICAL_MASK_ALL } from '../tabs/button_map.js';
import {
    renderMacroTab,
    stopMacroRecording,
    createDefaultMacroSlots,
    MACRO_SLOT_COUNT,
    MACRO_GROUP_BASE,
    MACRO_SLOT_BYTES,
    MACRO_STEP_BYTES,
    MACRO_MAX_STEPS,
    MACRO_TRIGGER_MASK_ALL,
    MACRO_FLAG_BLOCK_TRIGGER,
    MACRO_HOLD_MS_MAX,
    MACRO_AXIS_MIN,
    MACRO_AXIS_MAX,
    MACRO_STEP_MS_MIN,
    MACRO_STEP_MS_MAX,
    MACRO_MODE_MAX,
} from '../tabs/macro.js';
import {
    buildSingleProfileExport,
    buildFullBackupExport,
    triggerJsonDownload,
    inspectImportJson,
    DEFAULT_PROFILE_NAMES,
} from '../profile_io.js';

const GROUP_POLLING_RATE = 3;
const GROUP_BUTTON_MAP = 4;
// 组 4 负载长度：26 个 uint32 小端 = 104 字节
const BUTTON_MAP_BYTES = 26 * 4;

//--------------------------------------------------------------------+
// 多配置（与固件 Config/config.h 的 Group 13 / 14 一致）
//   13 system_global（4 字节）：[active_profile, shortcut_switch_enable, 0, 0]
//   14 profile_meta（32 字节）：UTF-8 定长配置名，name[0] != 0 且 name[31] == 0
//--------------------------------------------------------------------+
const CONFIG_GROUP_SYSTEM_GLOBAL = 13;
const CONFIG_GROUP_PROFILE_META = 14;
const PROFILE_COUNT = 4;
const PROFILE_NAME_BYTES = 32;
// 可用 UTF-8 字节数：留 1 字节给结尾的 0x00（固件校验 name[31] == 0）
const PROFILE_NAME_MAX_BYTES = PROFILE_NAME_BYTES - 1;

// 默认配置名（"配置 N"）直接复用 profile_io.js 导出的同一份常量，
// 避免两处各写一份字符串后悄悄不一致。

const APP_VERSION = 'v0.1.0';
const MSP_REBOOT_MAGIC = 0x52; // 'R'（与固件 msp_protocol.h 一致）

const POLL_RATE_NAMES = ['250 Hz', '500 Hz', '1000 Hz', '2000 Hz', '4000 Hz', '8000 Hz'];

// 死区上限：12-bit ADC 半量程计数（与固件 Config/config.h 的 CONFIG_DEADZONE_MAX 一致）
const DEADZONE_MAX = 2047;
// 出厂默认死区（与固件 Config/config.c 的 gamepadSettingsDefault 一致）
const DEADZONE_DEFAULT = 40;

// 四轴反转位掩码（与固件 Config/config.h 的 JOYSTICK_INVERT_* 严格一致）
//   bit0=LX bit1=LY bit2=RX bit3=RY，对应轴编号枚举 0~3
const INVERT_LX = 1 << 0; // 0x01
const INVERT_LY = 1 << 1; // 0x02
const INVERT_RX = 1 << 2; // 0x04
const INVERT_RY = 1 << 3; // 0x08
const INVERT_MASK_ALL = 0x0f;

// 按键消抖时间边界（与固件 Config/config.h 的 CONFIG_DEBOUNCE_MAX_MS、
// Config/config.c 的 gamepadSettingsDefault.debounce_ms 一致）
const DEBOUNCE_MAX_MS = 50;
const DEBOUNCE_DEFAULT_MS = 4;

//--------------------------------------------------------------------+
// 固件响应中的状态码位置（按命令码索引）
//   固件从不发 '$ M !'：失败帧与成功帧共用 '>' 方向字节，状态码塞在 payload 里
//   （Driver/msp/msp_handler.c 的 msp_send_error() 直接复用 msp_send_reply()）。
//     [status]             → 下标 0
//     [config_id, status]  → 下标 1（CONFIG_SET / CONFIG_RESET）
//   未列出的命令（CONFIG_GET / CONFIG_STATUS / JOYSTICK_RAW / API_VERSION 等）
//   payload 是纯数据，不做状态码判断。
//--------------------------------------------------------------------+
const MSP_STATUS_INDEX = {
    [MSP_CMD.REBOOT]: 0,
    [MSP_CMD.CONFIG_SET]: 1,
    [MSP_CMD.CONFIG_SAVE]: 0,
    [MSP_CMD.CONFIG_RESET]: 1,
    [MSP_CMD.CALIB_START]: 0,
    [MSP_CMD.CALIB_TRACK]: 0,
    [MSP_CMD.CALIB_END]: 0,
    [MSP_CMD.CALIB_CANCEL]: 0,
    // 切换配置：响应 [active_profile, status]，状态码在下标 1。
    //   不加这一条的话，固件回 FLASH_ERROR(4) 会被当成"切换成功"。
    //   ⚠️ 对照：0x1C（PROFILE_GET）的首字节是 active_profile，**不是状态码**，
    //      绝对不能加进本表，否则 active=1..4 会被误判成失败/成功。
    [MSP_CMD.PROFILE_SWITCH]: 1,
};

// 配置模型（默认值来自固件 config.c；连接后会被固件实际值覆盖）
const model = {
    calib: {
        lx: { min: 0, center: 2048, max: 4095 },
        ly: { min: 0, center: 2048, max: 4095 },
        rx: { min: 0, center: 2048, max: 4095 },
        ry: { min: 0, center: 2048, max: 4095 },
    },
    deadzoneLeft: DEADZONE_DEFAULT,    // 左摇杆死区（0~2047 ADC count，LX/LY 共用）
    deadzoneRight: DEADZONE_DEFAULT,   // 右摇杆死区（0~2047 ADC count，RX/RY 共用）
    invertMask: 0,                     // 轴向反转位掩码（bit0=LX bit1=LY bit2=RX bit3=RY）
    debounceMs: DEBOUNCE_DEFAULT_MS,   // 按键消抖时间（0~50ms，0 = 关闭消抖直通）
    buttonMap: [...DEFAULT_BUTTON_MASKS], // 26 路物理键 → DS4 逻辑功能位掩码（下标即物理位号）
    // 8 个宏槽位（配置组 5~12），每槽 236 字节 / 最多 16 步
    macros: createDefaultMacroSlots(),
    pollRate: 2,
    // 多配置状态（组 13 / 14 + 0x1C 概览）
    activeProfile: 0,                 // 当前激活配置 0~3
    shortcutEnable: true,             // 手柄快捷键盲切总开关（默认开启）
    profileNames: [...DEFAULT_PROFILE_NAMES], // 4 套配置名（0x1C 与组 14 共同维护）
    profileName: DEFAULT_PROFILE_NAMES[0],    // 当前激活配置的编辑态名称（对应组 14）
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

    // 固件错误帧与成功帧共用 '>' 方向字节，失败与否只能看 payload 里的状态码。
    // 不判这一层，固件拒绝写入（INVALID_ID / INVALID_DATA / FLASH_ERROR）会被当成成功。
    const statusIndex = MSP_STATUS_INDEX[cmd];
    if (statusIndex !== undefined) {
        const status = resp.payload[statusIndex];
        if (status !== 0) {
            const statusName = MSP_STATUS_NAME[status] || 'UNKNOWN';
            console.error(`MSP 拒绝: cmd=0x${cmd.toString(16).padStart(2, '0')} status=${statusName}(${status})`);
            return null;
        }
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
    // 先取多配置概览（0x1C）：激活槽位 / 盲切开关 / 4 套名称都要在渲染 Tab 栏前就位。
    //  老固件不认 0x1C 时这里返回 false，后续组 13/14 仍能把状态补齐（不视为失败）。
    await readProfiles();

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

    // 串行逐组读取：msp.request() 按命令码匹配响应，同命令不能并发，
    //  否则两帧 CONFIG_GET 会互相"抢走"对方的响应。
    for (const g of groups) {
        const resp = await mspRequest(MSP_CMD.CONFIG_GET, [g.id]);
        if (resp && resp.payload.length >= 2) {
            const data = resp.payload.slice(2);
            if (g.id === GROUP_JOYSTICK_CALIB) parseCalib(data);
            else if (g.id === GROUP_GAMEPAD_SETTINGS) parseGamepadSettings(data);
            else if (g.id === GROUP_POLLING_RATE) parsePollingRate(data);
            else if (g.id === GROUP_BUTTON_MAP) parseButtonMap(data);
            else if (g.id === CONFIG_GROUP_SYSTEM_GLOBAL) parseSystemGlobal(data);
            else if (g.id === CONFIG_GROUP_PROFILE_META) parseProfileMeta(data);
            else if (g.id >= MACRO_GROUP_BASE && g.id < MACRO_GROUP_BASE + MACRO_SLOT_COUNT) parseMacroSlot(data, g.id - MACRO_GROUP_BASE);
        }
    }

    // 组 13/14 与 0x1C 表达的是同一份状态，但组 14 是"当前套的权威名称"：
    // 若本次没有读到组 14（老固件），用 0x1C 的结果补齐 model.profileName。
    if (!model.profileName) model.profileName = model.profileNames[model.activeProfile] || DEFAULT_PROFILE_NAMES[0];
    model.profileNames[model.activeProfile] = model.profileName;

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
    // 固件 GamepadSettings = { u16 deadzone_left; u16 deadzone_right;
    //                          u8 invert_mask; u8 debounce_ms; }（6 字节小端）
    if (!data || data.length < 6) {
        console.warn(`gamepad_settings 负载长度异常（${data ? data.length : 0} 字节，期望 6），回落到默认 ${DEADZONE_DEFAULT}/${DEADZONE_DEFAULT}/0/${DEBOUNCE_DEFAULT_MS}`);
        model.deadzoneLeft = DEADZONE_DEFAULT;
        model.deadzoneRight = DEADZONE_DEFAULT;
        model.invertMask = 0;
        model.debounceMs = DEBOUNCE_DEFAULT_MS;
        return;
    }
    model.deadzoneLeft = u16(data, 0);
    model.deadzoneRight = u16(data, 2);
    model.invertMask = data[4] & INVERT_MASK_ALL;
    model.debounceMs = Math.min(DEBOUNCE_MAX_MS, data[5]);   // 固件侧上限 50，读时再兜一层
}

function parsePollingRate(data) {
    if (data.length >= 1) model.pollRate = data[0];
}

// 组 4：26 × uint32 小端位掩码；长度不足或单项含非法位时回落到默认/过滤非法位
function parseButtonMap(data) {
    if (!data || data.length < BUTTON_MAP_BYTES) {
        console.warn(`button_map 负载长度异常（${data ? data.length : 0} 字节，期望 ${BUTTON_MAP_BYTES}），回落到出厂默认映射`);
        model.buttonMap = [...DEFAULT_BUTTON_MASKS];
        return;
    }
    const map = new Array(26);
    for (let i = 0; i < 26; i++) {
        const off = i * 4;
        // 小端拼 32 位，>>> 0 保证无符号（否则 bit31 会变成负数）
        const raw = ((data[off]
            | (data[off + 1] << 8)
            | (data[off + 2] << 16)
            | (data[off + 3] << 24)) >>> 0);
        map[i] = (raw & DS4_LOGICAL_MASK_ALL) >>> 0;
    }
    model.buttonMap = map;
}

//--------------------------------------------------------------------+
// 多配置：组 13 / 14 编解码 + 0x1C 概览解析
//--------------------------------------------------------------------+

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

/** HTML 转义：配置名来自用户输入，拼进 innerHTML 前必须转义 */
function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

/**
 * 解码 32 字节定长配置名：遇到 0x00 截断，按 UTF-8 解码
 * @param {ArrayLike<number>} bytes - 长度可不足 32（不足部分按 0 处理）
 * @param {string} fallbackName - 解出来是空串时使用的兜底名
 * @returns {string}
 */
function decodeUtf8Name(bytes, fallbackName) {
    const src = bytes || [];
    // 最多只认前 31 字节：第 32 字节按固件约定恒为 0x00（防止脏数据解码出 32 字节，
    // 再保存时又被截到 31 字节，造成"读出来和存回去不一致"）
    const len = Math.min(src.length, PROFILE_NAME_MAX_BYTES);

    let end = len;
    for (let i = 0; i < len; i++) {
        if ((src[i] & 0xff) === 0) { end = i; break; }
    }

    if (end <= 0) return fallbackName;

    let text = '';
    try {
        text = utf8Decoder.decode(Uint8Array.from(Array.from({ length: end }, (_, i) => src[i] & 0xff)));
    } catch (e) {
        text = '';
    }

    // 去掉可能混入的控制字符（含半截解码出的 \u0000），再判空
    text = text.replace(/\u0000/g, '').trim();
    return text || fallbackName;
}

/**
 * 把名称编码成 32 字节定长负载（组 14）
 *
 * 关键点：**按码点迭代**（for...of 对字符串是按码点，不是按 UTF-16 码元），
 * 每个码点整体判断"放进去会不会超过 31 字节"，放不下就停。
 * 因此永远不会把某个中文字符切成一半（半个 UTF-8 序列会被固件的
 * validate_profile_meta() 判为非法，或被上位机解成 U+FFFD 乱码）。
 *
 * 保证：返回长度恒为 32；下标 31 恒为 0x00；下标 0 非 0（空输入回填默认名）。
 *
 * @param {string} nameStr
 * @returns {number[]} 32 字节
 */
function encodeProfileMetaBytes(nameStr) {
    const fallback = DEFAULT_PROFILE_NAMES[model.activeProfile] || DEFAULT_PROFILE_NAMES[0];

    // 先剔除控制字符（含 \u0000）：名称若以 0x00 开头，固件 validate_profile_meta()
    //  会因 name[0] == 0 直接拒收；这些字符也无法在输入框里正常显示。
    let name = String(nameStr == null ? '' : nameStr).replace(/[\u0000-\u001F\u007F]/g, '').trim();
    if (!name) name = fallback;

    const out = new Array(PROFILE_NAME_BYTES).fill(0);
    let used = 0;

    for (const ch of name) {
        const cp = utf8Encoder.encode(ch);
        if (used + cp.length > PROFILE_NAME_MAX_BYTES) break;
        for (let i = 0; i < cp.length; i++) out[used++] = cp[i];
    }

    // 兜底：极端输入（全是不足 1 字节的怪字符）也绝不让 name[0] == 0
    if (used === 0) {
        const cp = utf8Encoder.encode(fallback);
        for (let i = 0; i < cp.length && i < PROFILE_NAME_MAX_BYTES; i++) {
            out[i] = cp[i];
            used++;
        }
    }

    return out;
}

/** 名称的 UTF-8 字节长度（用于界面上的 "XX / 31 字节" 提示） */
function utf8ByteLength(nameStr) {
    return utf8Encoder.encode(String(nameStr == null ? '' : nameStr)).length;
}

// 组 13：系统全局 [active_profile, shortcut_switch_enable, reserved0, reserved1]
function parseSystemGlobal(data) {
    if (!data || data.length < 4) {
        console.warn(`system_global 负载长度异常（${data ? data.length : 0} 字节，期望 4），保持当前状态`);
        return;
    }
    const active = data[0];
    model.activeProfile = (active >= 0 && active < PROFILE_COUNT) ? active : 0;
    model.shortcutEnable = data[1] !== 0;
}

// 组 14：当前激活配置的名称（32 字节定长）
function parseProfileMeta(data) {
    const name = decodeUtf8Name(
        (data || []).slice(0, PROFILE_NAME_BYTES),
        DEFAULT_PROFILE_NAMES[model.activeProfile] || DEFAULT_PROFILE_NAMES[0],
    );
    model.profileName = name;
    model.profileNames[model.activeProfile] = name;
}

/**
 * 读取多配置概览（MSP 0x1C，131 字节）
 *   [0] active_profile  [1] profile_count  [2] shortcut_enable  [3..130] 4 × 32B 名称
 *   老固件不支持该命令时返回 false（不视为致命错误，继续走组 13/14 的读法）
 */
async function readProfiles() {
    const resp = await mspRequest(MSP_CMD.PROFILE_GET, [], 1200);
    if (!resp || resp.payload.length < 3 + PROFILE_NAME_BYTES) return false;

    const p = resp.payload;

    const active = p[0];
    model.activeProfile = (active >= 0 && active < PROFILE_COUNT) ? active : 0;
    model.shortcutEnable = p[2] !== 0;

    // p[1] 是固件的 CONFIG_PROFILE_COUNT：比本端少的话只覆盖它给出的前几套
    const count = Math.min(PROFILE_COUNT, p[1] || PROFILE_COUNT);
    for (let i = 0; i < count; i++) {
        const off = 3 + i * PROFILE_NAME_BYTES;
        if (p.length < off + PROFILE_NAME_BYTES) break;
        model.profileNames[i] = decodeUtf8Name(p.slice(off, off + PROFILE_NAME_BYTES), DEFAULT_PROFILE_NAMES[i]);
    }

    model.profileName = model.profileNames[model.activeProfile];
    return true;
}

/** 顶部下拉框的 <option> 列表（当前激活项 selected） */
function profileOptionsHtml() {
    let html = '';
    for (let i = 0; i < PROFILE_COUNT; i++) {
        const name = model.profileNames[i] || DEFAULT_PROFILE_NAMES[i];
        const selected = (i === model.activeProfile) ? ' selected' : '';
        html += `<option value="${i}"${selected}>${i + 1}: ${escapeHtml(name)}</option>`;
    }
    return html;
}

//--------------------------------------------------------------------+
// 宏槽位编解码（组 5~12，每槽 236 字节）
//   布局（全部小端，**不是** 16 字节对齐，MacroStep 是 packed 14 字节）：
//     0  u32 trigger_mask   26 路物理键位掩码（bit0~25，0 = 未绑定）
//     4  u16 hold_ms        0 ~ 10000（0 = 按下立即触发）
//     6  u8  mode           0=ONCE 1=HOLD 2=TOGGLE
//     7  u8  flags          bit0 = BLOCK_TRIGGER，其余位必须 0
//     8  u8  step_count     0 ~ 16
//     9  u8  reserved[3]    必须全 0
//     12 + i*14  步 i（i = 0..15）：
//        +0 u32 mask（DS4 逻辑位 bit1~18，0 = 纯延时/仅摇杆）
//        +4 i16 lx / +6 i16 ly / +8 i16 rx / +10 i16 ry（相对中点 -2048 ~ +2047）
//        +12 u16 duration_ms（1 ~ 65535）
//   未启用步（i >= step_count）必须全 0，否则固件 macro_slot_validate() 回 INVALID_DATA。
//--------------------------------------------------------------------+
function parseMacroSlot(data, slotIdx) {
    if (slotIdx < 0 || slotIdx >= MACRO_SLOT_COUNT) return;

    if (!data || data.length < MACRO_SLOT_BYTES) {
        console.warn(`macro_slot[${slotIdx}] 负载长度异常（${data ? data.length : 0} 字节，期望 ${MACRO_SLOT_BYTES}），回落到默认空槽位`);
        model.macros[slotIdx] = createDefaultMacroSlots()[slotIdx];
        return;
    }

    // 先拷进独立 ArrayBuffer 再按小端 DataView 读，避免依赖传入数组的对齐/长度
    const bytes = new Uint8Array(MACRO_SLOT_BYTES);
    for (let i = 0; i < MACRO_SLOT_BYTES; i++) bytes[i] = data[i] & 0xff;
    const dv = new DataView(bytes.buffer);

    const mode = dv.getUint8(6);
    const slot = {
        triggerMask: (dv.getUint32(0, true) & MACRO_TRIGGER_MASK_ALL) >>> 0,
        holdMs: Math.min(MACRO_HOLD_MS_MAX, dv.getUint16(4, true)),
        mode: mode <= MACRO_MODE_MAX ? mode : 0,
        flags: dv.getUint8(7) & MACRO_FLAG_BLOCK_TRIGGER,
        stepCount: Math.min(MACRO_MAX_STEPS, dv.getUint8(8)),
        steps: [],
    };

    for (let i = 0; i < MACRO_MAX_STEPS; i++) {
        const off = 12 + i * MACRO_STEP_BYTES;
        const used = i < slot.stepCount;
        if (!used) {
            // 未启用步统一回落默认值（编码时必然写 0，不影响往返一致性）
            slot.steps.push({ mask: 0, lx: 0, ly: 0, rx: 0, ry: 0, durationMs: 100 });
            continue;
        }
        slot.steps.push({
            mask: (dv.getUint32(off, true) & DS4_LOGICAL_MASK_ALL) >>> 0,
            lx: clampAxisOffset(dv.getInt16(off + 4, true)),
            ly: clampAxisOffset(dv.getInt16(off + 6, true)),
            rx: clampAxisOffset(dv.getInt16(off + 8, true)),
            ry: clampAxisOffset(dv.getInt16(off + 10, true)),
            durationMs: Math.min(MACRO_STEP_MS_MAX, Math.max(MACRO_STEP_MS_MIN, dv.getUint16(off + 12, true))),
        });
    }

    model.macros[slotIdx] = slot;
}

/**
 * 把槽位模型编码成 236 字节（CONFIG_SET 载荷除 id 外的部分）
 * @param {Object} slot
 * @returns {number[]} 长度恒为 236
 */
function buildMacroSlotBytes(slot) {
    const buf = new ArrayBuffer(MACRO_SLOT_BYTES);
    const dv = new DataView(buf); // ArrayBuffer 初值全 0：reserved 与未用步天然为 0

    if (slot) {
        const count = Math.min(MACRO_MAX_STEPS, Math.max(0, Math.round(Number(slot.stepCount) || 0)));
        const hold = Math.min(MACRO_HOLD_MS_MAX, Math.max(0, Math.round(Number(slot.holdMs) || 0)));
        const modeRaw = Math.round(Number(slot.mode) || 0);
        const mode = (modeRaw >= 0 && modeRaw <= MACRO_MODE_MAX) ? modeRaw : 0;
        const flags = (Number(slot.flags) || 0) & MACRO_FLAG_BLOCK_TRIGGER;

        dv.setUint32(0, (Number(slot.triggerMask) || 0) & MACRO_TRIGGER_MASK_ALL, true);
        dv.setUint16(4, hold, true);
        dv.setUint8(6, mode);
        dv.setUint8(7, flags);
        dv.setUint8(8, count);
        dv.setUint8(9, 0);
        dv.setUint8(10, 0);
        dv.setUint8(11, 0);

        const steps = Array.isArray(slot.steps) ? slot.steps : [];
        for (let i = 0; i < count; i++) {
            const step = steps[i] || {};
            const off = 12 + i * MACRO_STEP_BYTES;
            dv.setUint32(off, (Number(step.mask) || 0) & DS4_LOGICAL_MASK_ALL, true);
            dv.setInt16(off + 4, clampAxisOffset(step.lx), true);
            dv.setInt16(off + 6, clampAxisOffset(step.ly), true);
            dv.setInt16(off + 8, clampAxisOffset(step.rx), true);
            dv.setInt16(off + 10, clampAxisOffset(step.ry), true);
            dv.setUint16(off + 12, clampDuration(step.durationMs), true);
        }
    }

    return Array.from(new Uint8Array(buf));
}

/** 摇杆偏移：int16 符号无损，钳位到 [-2048, 2047] */
function clampAxisOffset(value) {
    const n = Math.round(Number(value) || 0);
    return Math.min(MACRO_AXIS_MAX, Math.max(MACRO_AXIS_MIN, n));
}

/** 步时长：有效步严禁 0，钳位到 [1, 65535] */
function clampDuration(value) {
    const n = Math.round(Number(value) || 0);
    return Math.min(MACRO_STEP_MS_MAX, Math.max(MACRO_STEP_MS_MIN, n));
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

// 组 2 负载：{ deadzone_left: u16 LE, deadzone_right: u16 LE, invert_mask: u8, debounce_ms: u8 } = 6 字节
//   第 6 字节是按键消抖时间（0~50ms），必须钳位后再发：固件 validate_gamepad_settings()
//   会拒绝 > 50 的取值，直接回 INVALID_DATA。
function buildGamepadSettingsBytes() {
    const l = model.deadzoneLeft & 0xffff;
    const r = model.deadzoneRight & 0xffff;
    const inv = model.invertMask & INVERT_MASK_ALL;
    const deb = Math.min(DEBOUNCE_MAX_MS, Math.max(0, Math.round(Number(model.debounceMs) || 0))) & 0xff;
    return [l & 0xff, (l >> 8) & 0xff, r & 0xff, (r >> 8) & 0xff, inv, deb];
}

// 组 4 负载：26 × uint32 小端 = 104 字节；每项先掩掉非法位再拆字节
function buildButtonMapBytes() {
    const out = new Array(BUTTON_MAP_BYTES);
    for (let i = 0; i < 26; i++) {
        const m = (Number(model.buttonMap[i]) & DS4_LOGICAL_MASK_ALL) >>> 0;
        const off = i * 4;
        out[off]     = m & 0xff;
        out[off + 1] = (m >>> 8) & 0xff;
        out[off + 2] = (m >>> 16) & 0xff;
        out[off + 3] = (m >>> 24) & 0xff;
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
        const ok = await mspRequest(MSP_CMD.CONFIG_SET, [GROUP_GAMEPAD_SETTINGS, ...buildGamepadSettingsBytes()]);
        if (!ok) throw new Error('写入摇杆设置失败');
    }
    if (dirty.has(GROUP_POLLING_RATE)) {
        const ok = await mspRequest(MSP_CMD.CONFIG_SET, [GROUP_POLLING_RATE, model.pollRate]);
        if (!ok) throw new Error('写入回报率失败');
    }
    if (dirty.has(GROUP_BUTTON_MAP)) {
        const ok = await mspRequest(MSP_CMD.CONFIG_SET, [GROUP_BUTTON_MAP, ...buildButtonMapBytes()]);
        if (!ok) throw new Error('写入按键映射失败');
    }

    // 宏槽位（组 5~12）：只写有修改的槽位，每帧载荷 1 + 236 = 237 字节。
    // 宏保存后立即生效（播放引擎每帧读 RAM 里的槽位），不必提示重启。
    for (let slot = 0; slot < MACRO_SLOT_COUNT; slot++) {
        const groupId = MACRO_GROUP_BASE + slot;
        if (!dirty.has(groupId)) continue;
        const ok = await mspRequest(MSP_CMD.CONFIG_SET, [groupId, ...buildMacroSlotBytes(model.macros[slot])]);
        if (!ok) throw new Error(`写入宏 ${slot + 1} 失败`);
    }

    // 全局层（组 13）：激活配置号 + 盲切开关。4 字节，reserved 必须补 0。
    if (dirty.has(CONFIG_GROUP_SYSTEM_GLOBAL)) {
        const payload = [
            CONFIG_GROUP_SYSTEM_GLOBAL,
            model.activeProfile & 0xff,
            model.shortcutEnable ? 1 : 0,
            0,
            0,
        ];
        const ok = await mspRequest(MSP_CMD.CONFIG_SET, payload);
        if (!ok) throw new Error('写入全局系统设置失败');
    }

    // 独立配置层（组 14）：当前套的 32 字节定长名称（按 UTF-8 字节截断到 <= 31B）
    if (dirty.has(CONFIG_GROUP_PROFILE_META)) {
        const ok = await mspRequest(MSP_CMD.CONFIG_SET, [CONFIG_GROUP_PROFILE_META, ...encodeProfileMetaBytes(model.profileName)]);
        if (!ok) throw new Error('写入配置名称失败');
    }

    const okSave = await mspRequest(MSP_CMD.CONFIG_SAVE);
    if (!okSave) throw new Error('保存到 Flash 失败');

    // 名称已落盘 → 顶部下拉框与槽位卡片立即跟上（不必等下一次 readAllConfigs）
    model.profileNames[model.activeProfile] = model.profileName;

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
// 配置切换（MSP 0x1D）
//--------------------------------------------------------------------+
/**
 * 仅发送 0x1D 切换命令（不重读、不重绘）
 * @returns {Promise<boolean>} 是否成功（含固件 FLASH_ERROR 判读）
 */
async function sendProfileSwitch(target) {
    const resp = await mspRequest(MSP_CMD.PROFILE_SWITCH, [target]);
    return !!resp;
}

/**
 * 静默切换 + 整份重读（不弹窗、不重绘）
 *
 * 从 switchProfile() 里抽出来，供"全板备份逐个槽位采集"复用：
 *   那条流程不能走 switchProfile()，否则每切一套都会弹"未保存修改"确认框、
 *   每切一次都整页重绘（备份过程中页面会闪 4 次）。
 *
 * @returns {Promise<boolean>} 切换并读取成功
 */
async function readProfileIntoRam(target) {
    if (!(await sendProfileSwitch(target))) return false;
    return await readAllConfigs();
}

/**
 * 切换到指定配置槽位
 *
 * 固件侧 config_switch_profile() 的行为：
 *   1) 不自动保存"当前套尚未 CONFIG_SAVE 的改动"——那些改动只存在 RAM 里，
 *      会在"配置层回落为目标槽位默认值"这一步被覆盖（= 丢失）；
 *   2) 切换成功后 RAM 工作集整体换成目标槽位，激活号写入全局层 Flash。
 * 所以这里必须：先问用户要不要保存 → 再发 0x1D → 再整份重读 → 重绘。
 *
 * @param {number} targetIdx - 0 ~ 3
 */
async function switchProfile(targetIdx) {
    const target = Number(targetIdx);

    if (!Number.isInteger(target) || target < 0 || target >= PROFILE_COUNT) return;
    if (target === model.activeProfile) return;
    if (!connected) return;

    //--- 1) 未保存改动保护
    if (dirty.size > 0) {
        const confirmed = await showConfirm(
            '切换配置',
            '当前配置有未保存修改，是否先保存到主板再切换？\n\n选择「取消」将中止切换；若强行切换，这些修改会丢失。'
        );
        if (!confirmed) return;

        try {
            await saveAll();
        } catch (err) {
            await showMessage('保存失败', err.message || String(err));
            return;
        }
    }

    //--- 2) 发送切换命令 + 3) 整份重读
    const ok = await readProfileIntoRam(target);
    if (!ok) {
        await showMessage(
            '切换失败',
            '设备未响应切换命令，或激活配置号写入 Flash 失败。\n\n请确认设备处于配置（CDC）模式后重试。'
        );
        rerenderIfActive();
        return;
    }

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
                '连接成功但设备无响应。\n\n请确认设备已进入配置（CDC）模式：按住手柄的 Share 按键，再插入 USB 线（或按 RST 按键），然后再连接。'
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
    stopMacroRecording();
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
    // 页面重绘前先停掉宏录制轮询，避免旧 DOM 被替换后仍在后台发 0x1B
    stopMacroRecording();

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
            { key: 'macro', label: '宏' },
            { key: 'board', label: '主板' },
        ]
        : [];

    // Tab 栏右侧：已连接时放"配置切换下拉框 + 断开"
    //   .tab-right 是 renderTabBar() 的现成插槽，样式上不会挤压左侧 Tab 项
    const rightHtml = connected
        ? `<select class="profile-select" id="header-profile-select" title="切换配置槽位（切换后自动重读该套配置）">${profileOptionsHtml()}</select>`
          + '<button class="btn-disconnect" id="config-btn-disconnect">断开</button>'
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

    const profileSelect = document.getElementById('header-profile-select');
    if (profileSelect) {
        profileSelect.addEventListener('change', () => {
            const target = Number(profileSelect.value);
            // 切回原值（例如用户点了同一项）不必走切换流程
            if (target === model.activeProfile) return;
            switchProfile(target);
        });
    }

    renderContent(contentEl);
}

function renderContent(contentEl) {
    // 任何一次内容重绘都会销毁宏页签的 DOM，先把 0x1B 轮询停掉
    stopMacroRecording();

    if (!connected) {
        contentEl.innerHTML = `
            <div class="guide-card">
                <h3>配置指南</h3>
                <ol>
                    <li>请先确保主板已经烧录最新固件</li>
                    <li>按住手柄的 <b>Share</b> 按键（触摸板左上边的按键），再插入 USB 线（或者按 <b>RST</b> 按键），主板会进入配置模式</li>
                    <li>点击连接，即可连接主板进行配置</li>
                </ol>
            </div>
        `;
        return;
    }

    switch (currentTab) {
        case 'buttons':
            // 按键页签除只读映射表外，还承载"按键消抖时间"设置（组 2 的一部分），
            // 因此需要 model 与 markDirty，调用规范与摇杆页签保持一致。
            renderButtonsTab(contentEl, model, { markDirty });
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
        case 'macro':
            renderMacroTab(contentEl, model, { markDirty });
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
// 配置导入 / 导出（UI 接线；数据逻辑全在 js/profile_io.js）
//--------------------------------------------------------------------+

/** 深拷贝一个宏槽：导入后不能与 inspected 里的对象共享引用 */
function cloneMacroSlot(slot) {
    const src = slot || {};
    const steps = Array.isArray(src.steps) ? src.steps : [];

    return {
        triggerMask: Number(src.triggerMask) >>> 0,
        holdMs: Number(src.holdMs) || 0,
        mode: Number(src.mode) || 0,
        flags: Number(src.flags) || 0,
        stepCount: Number(src.stepCount) || 0,
        steps: Array.from({ length: MACRO_MAX_STEPS }, (_, i) => {
            const s = steps[i] || {};
            return {
                mask: Number(s.mask) >>> 0,
                lx: Number(s.lx) || 0,
                ly: Number(s.ly) || 0,
                rx: Number(s.rx) || 0,
                ry: Number(s.ry) || 0,
                durationMs: Number(s.durationMs) || 100,
            };
        }),
    };
}

/** 深拷贝校准表（4 轴 × min/center/max） */
function cloneCalib(calib) {
    const out = {};
    for (const axis of ['lx', 'ly', 'rx', 'ry']) {
        const c = (calib && calib[axis]) || {};
        out[axis] = {
            min: Number(c.min) || 0,
            center: Number(c.center) || 2048,
            max: Number(c.max) || 4095,
        };
    }
    return out;
}

/** 当前 model 的"配置层快照"（全板备份逐槽采集用） */
function snapshotCurrentProfile() {
    return {
        name: model.profileName,
        deadzoneLeft: model.deadzoneLeft,
        deadzoneRight: model.deadzoneRight,
        invertMask: model.invertMask,
        debounceMs: model.debounceMs,
        buttonMap: [...model.buttonMap],
        macros: model.macros.map(cloneMacroSlot),
    };
}

/** [导出当前配置] → `<配置名>_<YYYY-MM-DD>.json` */
async function handleExportSingle() {
    if (!connected) {
        await showMessage('未连接', '请先连接主板后再导出配置。');
        return;
    }

    const out = buildSingleProfileExport(model);
    triggerJsonDownload(out.filename, out.jsonText);
}

/**
 * [全板完整备份] → `全板备份_<YYYY-MM-DD>.json`
 *
 * 全板备份必须拿到 4 套配置的内容，而设备同一时刻只有一套在 RAM 里，
 * 所以只能"逐套切过去读一遍"：
 *   1) 先记下原槽位并把当前套快照下来；
 *   2) 其余 3 套用 **静默切换**（readProfileIntoRam：不发确认框、不重绘）逐个采集；
 *   3) finally 里无论成败都切回原槽位并重绘 —— 否则用户会发现自己的配置被悄悄换掉了。
 */
async function handleExportFullBackup() {
    if (!connected) {
        await showMessage('未连接', '请先连接主板后再备份。');
        return;
    }

    if (dirty.size > 0) {
        const confirmed = await showConfirm(
            '全板完整备份',
            '当前配置有未保存修改，全板备份将从主板读取最新已保存数据，是否先保存当前修改？'
        );
        if (!confirmed) return;

        try {
            await saveAll();
        } catch (err) {
            await showMessage('保存失败', err.message || String(err));
            return;
        }
    }

    const originSlot = model.activeProfile;
    const allProfiles = new Array(PROFILE_COUNT).fill(null);

    allProfiles[originSlot] = snapshotCurrentProfile();

    let restoreFailed = false;

    try {
        for (let i = 0; i < PROFILE_COUNT; i++) {
            if (i === originSlot) continue;

            const readOk = await readProfileIntoRam(i);
            if (!readOk) continue; // 读不到就留空：导出时按默认值填充并在 warnings 里标注

            allProfiles[i] = snapshotCurrentProfile();
        }
    } finally {
        restoreFailed = !(await readProfileIntoRam(originSlot));
        rerenderIfActive();
    }

    const out = buildFullBackupExport(model, allProfiles);
    triggerJsonDownload(out.filename, out.jsonText);

    if (restoreFailed) {
        await showMessage(
            '备份已下载，但未切回原配置',
            '全板备份文件已下载，但切回原配置槽位失败。\n\n请断开后重新连接设备，确认当前处于目标配置。'
        );
    } else if (out.data && Array.isArray(out.data.warnings) && out.data.warnings.length) {
        await showMessage('全板备份已完成', `已下载 ${out.filename}\n\n${out.data.warnings.join('\n')}`);
    }
}

/** [导入配置文件...]：选文件 → 解析 → 打开选择性导入弹窗 */
function handleImportFile() {
    if (!connected) {
        showMessage('未连接', '请先连接主板后再导入配置。');
        return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';

    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) return;

        try {
            const text = await file.text();
            const inspected = inspectImportJson(text);

            if (!inspected.ok) {
                await showMessage('导入失败', inspected.error || '文件格式无法识别');
                return;
            }

            openImportModal(inspected);
        } catch (err) {
            await showMessage('导入失败', err.message || String(err));
        }
    });

    document.body.appendChild(input);

    // 用户点了"取消"（关闭文件选择框）时不会触发 change，靠 cancel 事件回收这个临时 input，
    // 否则反复取消会在 body 里堆积一堆隐藏元素
    input.addEventListener('cancel', () => input.remove());

    input.click();
}

/**
 * 把一个已解析的导入结果展开成"可勾选的模块清单"
 *
 * 每个模块 = 一个配置组（1/2/3/4/13/14 或 5~12 的某一槽宏），
 * 勾选后由 applyImport() 依次调用 apply() 写入 model 并 markDirty(groupId)。
 *
 * @param {Object} inspected - inspectImportJson() 的结果
 * @param {number} sourceSlot - full_backup 时用户选的源槽位；其它类型传 0
 * @returns {Array<{key:string, groupId:number, label:string, checked:boolean, note?:string, apply:Function}>}
 */
function buildImportModules(inspected, sourceSlot) {
    const modules = [];

    //--- 全局硬件层（仅全板备份有）
    if (inspected.kind === 'full_backup') {
        const g = inspected.systemGlobal || {};
        const hw = inspected.hardware || {};

        if (g.shortcutEnable !== null && g.shortcutEnable !== undefined) {
            modules.push({
                key: 'shortcut',
                groupId: CONFIG_GROUP_SYSTEM_GLOBAL,
                label: `手柄快捷键盲切开关（${g.shortcutEnable ? '开启' : '关闭'}）`,
                checked: true,
                apply: () => { model.shortcutEnable = !!g.shortcutEnable; },
            });
        }

        if (hw.pollRate !== null && hw.pollRate !== undefined) {
            modules.push({
                key: 'pollRate',
                groupId: GROUP_POLLING_RATE,
                label: `USB 回报率设置（${POLL_RATE_NAMES[hw.pollRate] || `档位 ${hw.pollRate}`}）`,
                checked: true,
                apply: () => { model.pollRate = hw.pollRate; },
            });
        }

        if (hw.calib) {
            modules.push({
                key: 'calib',
                groupId: GROUP_JOYSTICK_CALIB,
                label: '摇杆硬件中心与极限校准',
                // 默认不勾：不同主板的电位器零点/极限都不一样，照搬别人主板的校准会让摇杆偏移
                checked: false,
                note: '警告：不同主板电位器零点不同，除非恢复到原同一块主板，否则请勿勾选',
                apply: () => { model.calib = cloneCalib(hw.calib); },
            });
        }
    }

    //--- 独立宏片段：只有宏
    if (inspected.kind === 'macros_fragment') {
        for (const m of inspected.macros) {
            if (!m.valid) continue;
            modules.push({
                key: `macro:${m.slotIndex}`,
                groupId: MACRO_GROUP_BASE + m.slotIndex,
                label: `宏 ${m.slotIndex + 1}：${m.summary}`,
                checked: true,
                apply: () => { model.macros[m.slotIndex] = cloneMacroSlot(m.slot); },
            });
        }
        return modules;
    }

    //--- 配置层（single_profile 的本体 / full_backup 的源槽位）
    const profile = inspected.profiles[sourceSlot] || inspected.profiles[0];
    if (!profile) return modules;

    modules.push({
        key: 'meta',
        groupId: CONFIG_GROUP_PROFILE_META,
        label: `配置名称（${profile.name}）`,
        checked: true,
        apply: () => {
            model.profileName = profile.name;
            model.profileNames[model.activeProfile] = profile.name;
        },
    });

    modules.push({
        key: 'settings',
        groupId: GROUP_GAMEPAD_SETTINGS,
        label: '摇杆死区、轴反转与按键消抖',
        checked: true,
        apply: () => {
            const s = profile.gamepadSettings;
            model.deadzoneLeft = s.deadzoneLeft;
            model.deadzoneRight = s.deadzoneRight;
            model.invertMask = s.invertMask;
            model.debounceMs = s.debounceMs;
        },
    });

    modules.push({
        key: 'buttons',
        groupId: GROUP_BUTTON_MAP,
        label: '26 路按键映射表',
        checked: true,
        apply: () => { model.buttonMap = [...profile.buttonMap]; },
    });

    for (const m of profile.macroList) {
        if (!m.valid) continue;   // 空槽位不列出来，避免用户误以为"导入了空宏"
        modules.push({
            key: `macro:${m.slotIndex}`,
            groupId: MACRO_GROUP_BASE + m.slotIndex,
            label: `宏 ${m.slotIndex + 1}：${m.summary}`,
            checked: true,
            apply: () => { model.macros[m.slotIndex] = cloneMacroSlot(m.slot); },
        });
    }

    return modules;
}

/**
 * 选择性导入弹窗
 *
 * 只改内存（model）+ 点亮 dirty，绝不在这里写 Flash：用户还能点底边栏 [保存] 二次确认，
 * 也能直接切走页签放弃。
 *
 * @param {Object} inspected - inspectImportJson() 的结果
 */
function openImportModal(inspected) {
    const KIND_LABEL = {
        single_profile: '单套配置',
        full_backup: '全板完整备份',
        macros_fragment: '独立宏片段',
    };

    const state = {
        sourceSlot: (inspected.kind === 'full_backup' && Number.isInteger(inspected.activeProfile))
            ? inspected.activeProfile
            : 0,
        checked: new Map(),
    };

    const overlay = document.createElement('div');
    overlay.className = 'import-overlay';

    const modal = document.createElement('div');
    modal.className = 'import-modal';
    overlay.appendChild(modal);

    //---- 头部：标题 + 识别徽章 + 关闭
    const head = document.createElement('div');
    head.className = 'import-head';

    const titleBox = document.createElement('div');
    titleBox.className = 'import-title-box';

    const title = document.createElement('h3');
    title.textContent = '导入配置';

    const badge = document.createElement('span');
    badge.className = 'import-badge';
    badge.textContent = KIND_LABEL[inspected.kind] || '未知格式';

    titleBox.appendChild(title);
    titleBox.appendChild(badge);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'import-close';
    closeBtn.textContent = '×';
    closeBtn.title = '关闭';

    head.appendChild(titleBox);
    head.appendChild(closeBtn);
    modal.appendChild(head);

    //---- 解析告警（折叠，默认收起）
    if (inspected.warnings && inspected.warnings.length) {
        const warn = document.createElement('details');
        warn.className = 'import-warn';

        const summary = document.createElement('summary');
        summary.textContent = `解析告警（${inspected.warnings.length} 条，点击展开）`;
        warn.appendChild(summary);

        const ul = document.createElement('ul');
        for (const w of inspected.warnings) {
            const li = document.createElement('li');
            li.textContent = w;
            ul.appendChild(li);
        }
        warn.appendChild(ul);
        modal.appendChild(warn);
    }

    //---- 主体（随源槽位切换重建）
    const body = document.createElement('div');
    body.className = 'import-body';
    modal.appendChild(body);

    //---- 底部操作栏
    const foot = document.createElement('div');
    foot.className = 'import-foot';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn';
    toggleBtn.textContent = '全选 / 取消全选';

    const rightBox = document.createElement('div');
    rightBox.className = 'import-foot-right';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = '取消';

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'btn-primary';
    applyBtn.textContent = '应用到当前配置';

    rightBox.appendChild(cancelBtn);
    rightBox.appendChild(applyBtn);
    foot.appendChild(toggleBtn);
    foot.appendChild(rightBox);
    modal.appendChild(foot);

    let modules = [];

    const close = () => overlay.remove();

    const renderBody = (resetChecks) => {
        modules = buildImportModules(inspected, state.sourceSlot);

        // 每次重建视图都回到"默认勾选"（校准仍然默认不勾），避免切换源槽位后残留上一次的勾选
        if (resetChecks) {
            state.checked.clear();
            for (const m of modules) state.checked.set(m.key, m.checked !== false);
        }

        body.innerHTML = '';

        // 源槽位选择器（仅全板备份）
        if (inspected.kind === 'full_backup') {
            const slotRow = document.createElement('div');
            slotRow.className = 'import-slot-row';

            const slotLabel = document.createElement('span');
            slotLabel.className = 'import-slot-label';
            slotLabel.textContent = '选择源配置槽位';

            const select = document.createElement('select');
            select.className = 'import-slot-select';

            for (let i = 0; i < PROFILE_COUNT; i++) {
                const p = inspected.profiles[i];
                const opt = document.createElement('option');
                opt.value = String(i);
                opt.textContent = `${i + 1}: ${p ? p.name : DEFAULT_PROFILE_NAMES[i]}`;
                if (i === state.sourceSlot) opt.selected = true;
                select.appendChild(opt);
            }

            select.addEventListener('change', () => {
                state.sourceSlot = Number(select.value) || 0;
                renderBody(true);   // 换源配置 → 勾选列表重新按默认初始化
            });

            slotRow.appendChild(slotLabel);
            slotRow.appendChild(select);
            body.appendChild(slotRow);
        }

        const list = document.createElement('div');
        list.className = 'import-list';

        if (!modules.length) {
            const empty = document.createElement('p');
            empty.className = 'placeholder-text';
            empty.textContent = (inspected.kind === 'macros_fragment')
                ? '这个片段里没有可导入的有效宏。'
                : '这个文件里没有可导入的配置项。';
            list.appendChild(empty);
        }

        for (const m of modules) {
            const row = document.createElement('label');
            row.className = 'import-item';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = state.checked.get(m.key) !== false;

            const text = document.createElement('span');
            text.className = 'import-item-text';
            text.textContent = m.label;

            cb.addEventListener('change', () => {
                state.checked.set(m.key, cb.checked);
                row.classList.toggle('checked', cb.checked);
            });

            row.appendChild(cb);
            row.appendChild(text);

            if (m.note) {
                const note = document.createElement('span');
                note.className = 'import-item-note';
                note.textContent = m.note;
                row.appendChild(note);
            }

            row.classList.toggle('checked', cb.checked);
            list.appendChild(row);
        }

        body.appendChild(list);
    };

    toggleBtn.addEventListener('click', () => {
        const allChecked = modules.length > 0
            && modules.every((m) => state.checked.get(m.key) !== false);

        for (const m of modules) state.checked.set(m.key, !allChecked);
        renderBody(false);   // 保留刚设置的勾选状态，只重建 DOM
    });

    applyBtn.addEventListener('click', async () => {
        const picked = modules.filter((m) => state.checked.get(m.key) !== false);

        if (!picked.length) {
            await showMessage('未选择任何项目', '请至少勾选一项后再应用。');
            return;
        }

        // 只改内存 + 点亮脏标记：写 Flash 由用户点底边栏 [保存] 触发
        for (const m of picked) {
            if (typeof m.apply === 'function') m.apply();
            markDirty(m.groupId);
        }

        close();
        rerenderIfActive();

        await showMessage(
            '已应用',
            '已应用勾选的配置项，请点击页面底部 [保存] 按钮写入主板 Flash。'
        );
    });

    cancelBtn.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay) close();   // 点遮罩空白处关闭
    });

    renderBody(true);
    document.body.appendChild(overlay);
}

/**
 * 「配置导入与导出」卡片（主板页）
 * 三个入口：导出当前配置 / 全板完整备份 / 导入配置文件
 */
function buildImportExportCard() {
    const card = document.createElement('div');
    card.className = 'section-card';
    card.innerHTML = '<h3>配置导入与导出</h3>';

    const row = document.createElement('div');
    row.className = 'import-actions';

    const mk = (label, cls, onClick) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = cls;
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        return btn;
    };

    row.appendChild(mk('导出当前配置', 'btn', handleExportSingle));
    row.appendChild(mk('全板完整备份', 'btn', handleExportFullBackup));
    row.appendChild(mk('导入配置文件...', 'btn-primary', handleImportFile));
    card.appendChild(row);

    const hint = document.createElement('p');
    hint.className = 'placeholder-text';
    hint.textContent = '「导出当前配置」只包含当前激活的那一套；「全板完整备份」会逐套切换读取（过程中请勿操作手柄），'
        + '完成后自动切回原配置。导入只写入本页内存，勾选后仍需点击页面底部 [保存] 才会写入主板 Flash。';
    card.appendChild(hint);

    return card;
}

//--------------------------------------------------------------------+
// 主板 Tab
//--------------------------------------------------------------------+

/**
 * 「配置与快捷键」卡片（组 13 / 14 + 0x1D）
 *   - 4 个槽位按钮：显示 "配置 N" + 自定义名，高亮当前槽位，点击切换
 *   - 当前配置名称：输入框 + "XX / 31 字节" 实时提示（超长按字节截断，防多字节中文被切半）
 *   - 手柄快捷键盲切总开关：写组 13 的 shortcut_switch_enable
 */
function buildProfileCard() {
    const card = document.createElement('div');
    card.className = 'section-card';
    card.innerHTML = '<h3>配置与快捷键</h3>';

    //--- 1) 槽位切换
    const grid = document.createElement('div');
    grid.className = 'profile-slot-grid';

    for (let i = 0; i < PROFILE_COUNT; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `profile-slot${i === model.activeProfile ? ' active' : ''}`;

        const idxEl = document.createElement('span');
        idxEl.className = 'profile-slot-index';
        idxEl.textContent = `配置 ${i + 1}`;

        const nameEl = document.createElement('span');
        nameEl.className = 'profile-slot-name';
        nameEl.textContent = model.profileNames[i] || DEFAULT_PROFILE_NAMES[i];

        btn.appendChild(idxEl);
        btn.appendChild(nameEl);
        btn.addEventListener('click', () => {
            if (i === model.activeProfile) return;
            switchProfile(i);
        });

        grid.appendChild(btn);
    }
    card.appendChild(grid);

    //--- 2) 当前配置名称
    const nameRow = document.createElement('div');
    nameRow.className = 'config-row';

    const nameLabel = document.createElement('span');
    nameLabel.className = 'config-label';
    nameLabel.textContent = '当前配置名称';
    nameRow.appendChild(nameLabel);

    const nameInputBox = document.createElement('div');
    nameInputBox.className = 'config-input profile-name-box';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'profile-name-input';
    nameInput.value = model.profileName;
    nameInput.placeholder = `最多 ${PROFILE_NAME_MAX_BYTES} 字节（约 10 个汉字）`;
    nameInput.spellcheck = false;

    const nameCount = document.createElement('span');
    nameCount.className = 'profile-name-count';

    const updateNameCount = () => {
        const bytes = utf8ByteLength(nameInput.value);
        nameCount.textContent = `${bytes} / ${PROFILE_NAME_MAX_BYTES} 字节`;
        nameCount.classList.toggle('over', bytes > PROFILE_NAME_MAX_BYTES);
    };

    nameInput.addEventListener('input', () => {
        model.profileName = nameInput.value;
        markDirty(CONFIG_GROUP_PROFILE_META);
        updateNameCount();
    });

    // 失焦时按"UTF-8 字节安全截断"规整一次：
    //   用户可能输入超长文本，直接在保存时静默截断会造成"看到的 ≠ 存下的"，
    //   这里立刻把输入框改成真正会被写进 Flash 的内容。
    nameInput.addEventListener('blur', () => {
        const normalized = decodeUtf8Name(
            encodeProfileMetaBytes(model.profileName),
            DEFAULT_PROFILE_NAMES[model.activeProfile] || DEFAULT_PROFILE_NAMES[0],
        );
        if (normalized !== model.profileName) {
            model.profileName = normalized;
            nameInput.value = normalized;
            markDirty(CONFIG_GROUP_PROFILE_META);
        }
        updateNameCount();
    });

    updateNameCount();

    nameInputBox.appendChild(nameInput);
    nameInputBox.appendChild(nameCount);
    nameRow.appendChild(nameInputBox);
    card.appendChild(nameRow);

    const nameHint = document.createElement('p');
    nameHint.className = 'placeholder-text';
    nameHint.textContent = '名称按 UTF-8 字节定长存储（最多 31 字节 + 结尾 0），修改后点击底边栏 [保存] 写入当前配置；'
        + '顶部下拉框与槽位卡片会立即同步显示。';
    card.appendChild(nameHint);

    //--- 3) 手柄快捷键盲切总开关
    const swRow = document.createElement('div');
    swRow.className = 'config-row';

    const swLabel = document.createElement('span');
    swLabel.className = 'config-label';
    swLabel.textContent = '手柄快捷键盲切';
    swRow.appendChild(swLabel);

    const swInputBox = document.createElement('div');
    swInputBox.className = 'config-input';

    const swWrap = document.createElement('label');
    swWrap.className = 'profile-switch';

    const swInput = document.createElement('input');
    swInput.type = 'checkbox';
    swInput.checked = !!model.shortcutEnable;

    const swText = document.createElement('span');
    swText.className = 'profile-switch-text';
    swText.textContent = swInput.checked ? '已开启' : '已关闭';

    swInput.addEventListener('change', () => {
        model.shortcutEnable = swInput.checked;
        swText.textContent = swInput.checked ? '已开启' : '已关闭';
        markDirty(CONFIG_GROUP_SYSTEM_GLOBAL);
    });

    swWrap.appendChild(swInput);
    swWrap.appendChild(swText);
    swInputBox.appendChild(swWrap);
    swRow.appendChild(swInputBox);
    card.appendChild(swRow);

    const swHint = document.createElement('p');
    swHint.className = 'placeholder-text';
    swHint.textContent = '开启后，在游戏模式下长按 Share + △ / □ / ○ / × 满 3 秒可盲切至配置 1 / 2 / 3 / 4'
        + '（切换后自动写入主板记忆，下次上电沿用）。';
    card.appendChild(swHint);

    return card;
}

function renderBoardTab(contentEl) {
    contentEl.innerHTML = '';

    // 配置与快捷键（组 13 / 14，MSP 0x1C / 0x1D）
    contentEl.appendChild(buildProfileCard());

    // 配置导入与导出（JSON 备份 / 选择性导入）
    contentEl.appendChild(buildImportExportCard());

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
            await showMessage('已重启', '设备已重启。如需继续配置，请按住手柄的 Share 按键重新插拔（或按 RST 按键）进入配置模式后再连接。');
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
    stopMacroRecording();
    if (connected) {
        connected = false;
        try { await serial.close(); } catch (e) {}
    }
}
