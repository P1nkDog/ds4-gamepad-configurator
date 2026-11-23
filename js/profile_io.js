/**
 * profile_io.js - 配置导入/导出引擎（纯逻辑，无 UI）
 *
 * 职责边界（与 TASK-07C 的分工）：
 *   本文件只负责"数据"：把 model / 4 套配置打包成 JSON、生成文件名、触发下载，
 *   以及把任意来源的 JSON 解析成"已经过固件级边界校验"的结构，并给每条宏算出
 *   人类可读的触发键与摘要。所有弹窗、按钮、勾选交互都在 TASK-07C 里接。
 *
 * 与固件严格对齐的边界（Config/config.h、Config/config.c）：
 *   - 校准 4 轴：0 <= min < center < max <= 4095（validate_joystick_calib）
 *   - 死区 0~2047、反转掩码 0~15、消抖 0~50（validate_gamepad_settings）
 *   - 按键映射 26 × u32，合法位 0x0007FFFE（validate_button_map）
 *   - 宏槽位 236 字节 / 16 步，逐槽走 normalizeMacroSlot()（validate_macro_slot）
 *   - 配置名 32 字节定长 UTF-8：<= 31 字节 + 结尾 0x00（validate_profile_meta）
 *   - 回报率 0~5；盲切开关 0/1
 *
 * 导出格式（schema: "p1nkd-ds4-config", schemaVersion: 1）：
 *   kind = "single_profile" → { profile: { name, gamepadSettings, buttonMap, macros } }
 *   kind = "full_backup"    → { activeProfile, systemGlobal, hardware, profiles[4] }
 */

import {
    MACRO_SLOT_COUNT,
    MACRO_GROUP_BASE,
    normalizeMacroSlot,
} from './tabs/macro.js';
import { PHYSICAL_BUTTONS, DS4_LOGICAL_MASK_ALL } from './tabs/button_map.js';

//--------------------------------------------------------------------+
// 常量
//--------------------------------------------------------------------+

export const SCHEMA_NAME = 'p1nkd-ds4-config';
export const SCHEMA_VERSION = 1;

/** 配置套数（与固件 CONFIG_PROFILE_COUNT 一致） */
export const PROFILE_COUNT = 4;

/** 默认配置名（与固件 fill_default_profile_meta 一致） */
export const DEFAULT_PROFILE_NAMES = ['配置 1', '配置 2', '配置 3', '配置 4'];

const BUTTON_MAP_LEN = 26;
const CALIB_MAX = 4095;
const DEADZONE_MAX = 2047;
const DEADZONE_DEFAULT = 40;
const DEBOUNCE_MAX = 50;
const DEBOUNCE_DEFAULT = 4;
const INVERT_MASK_ALL = 0x0f;
const POLL_RATE_MAX = 5;
const POLL_RATE_DEFAULT = 2;

const PROFILE_NAME_BYTES = 32;
const PROFILE_NAME_MAX_BYTES = PROFILE_NAME_BYTES - 1; // 31

const TRIGGER_MASK_ALL = 0x03ffffff;
const MACRO_FLAG_BLOCK_TRIGGER = 0x01;

// 摘要里用的短模式名（与 macro.js 的 MODE_NAMES 同序：ONCE / HOLD / TOGGLE）
const MODE_SHORT = ['单次', '按住', '开关'];

const utf8Encoder = new TextEncoder();

//--------------------------------------------------------------------+
// 基础工具
//--------------------------------------------------------------------+

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 按 UTF-8 字节安全截断配置名（最多 31 字节，绝不切半个多字节字符）
 * 与 config.js 的 encodeProfileMetaBytes 同规则：剔除控制字符 → 按码点整体判断。
 *
 * @param {*} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function truncateProfileName(name, fallback = DEFAULT_PROFILE_NAMES[0]) {
    const fb = String(fallback == null ? DEFAULT_PROFILE_NAMES[0] : fallback);
    let s = String(name == null ? '' : name).replace(/[\u0000-\u001F\u007F]/g, '').trim();
    if (!s) return fb;

    let out = '';
    let used = 0;
    for (const ch of s) {
        const cp = utf8Encoder.encode(ch);
        if (used + cp.length > PROFILE_NAME_MAX_BYTES) break;
        out += ch;
        used += cp.length;
    }
    return out || fb;
}

/**
 * 清洗文件名：剔除 Windows 禁用字符、压缩空白、去首尾点与空格，空串回退
 *
 * 禁用字符集合：[\\ / : * ? " < > |] 以及 U+0000~U+001F 控制字符。
 * 额外处理三个 Windows 上的常见坑：
 *   - 文件名不能以点或空格结尾（资源管理器会报错）
 *   - 不能以点开头（会被当成隐藏文件，且 ".." 有路径语义）
 *   - 过长会撑破 260 字符全路径限制，这里限制主体长度到 60
 *
 * @param {*} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function sanitizeFilename(name, fallback = '配置文件') {
    let s = String(name == null ? '' : name);
    s = s.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^\.+/, '').replace(/[. ]+$/, '');

    if (!s) {
        s = String(fallback == null ? '' : fallback).replace(/[\\/:*?"<>|\u0000-\u001F]/g, '').trim();
    }
    if (!s) s = '配置文件';

    if (s.length > 60) {
        s = s.slice(0, 60).trim();
        if (!s) s = '配置文件';
    }
    return s;
}

/**
 * 本地时区的 YYYY-MM-DD
 * （刻意不用 toISOString：那是 UTC，晚上 8 点后导出会变成"明天"）
 */
export function formatLocalDate(date = new Date()) {
    const d = (date instanceof Date && !Number.isNaN(date.getTime())) ? date : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

//--------------------------------------------------------------------+
// 导出：把 model 快照成干净的 JSON 结构
//--------------------------------------------------------------------+

/** 26 项按键映射 → 只保留合法逻辑位 */
function snapshotButtonMap(raw) {
    const src = Array.isArray(raw) ? raw : [];
    const out = new Array(BUTTON_MAP_LEN);
    for (let i = 0; i < BUTTON_MAP_LEN; i++) {
        out[i] = ((Number(src[i]) || 0) & DS4_LOGICAL_MASK_ALL) >>> 0;
    }
    return out;
}

/** 8 个宏槽位 → 走与导入同一套规整（保证导出文件永远能被自己重新导入） */
function snapshotMacros(raw) {
    const src = Array.isArray(raw) ? raw : [];
    const out = [];
    for (let i = 0; i < MACRO_SLOT_COUNT; i++) {
        out.push(normalizeMacroSlot(src[i]).slot);
    }
    return out;
}

/** 4 轴校准 → 数值化并钳位（导出的永远是固件能接受的形状） */
function snapshotCalib(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const out = {};
    for (const axis of ['lx', 'ly', 'rx', 'ry']) {
        const c = (src[axis] && typeof src[axis] === 'object') ? src[axis] : {};
        let min = clampInt(c.min, 0, CALIB_MAX, 0);
        let center = clampInt(c.center, 0, CALIB_MAX, 2048);
        let max = clampInt(c.max, 0, CALIB_MAX, CALIB_MAX);

        // 保持 min < center < max：设备读回来的值本来就合法，这里只是兜底，
        // 一旦被钳成相等（例如脏数据），回到出厂默认而不是导出非法结构。
        if (!(min < center && center < max)) {
            min = 0;
            center = 2048;
            max = CALIB_MAX;
        }
        out[axis] = { min, center, max };
    }
    return out;
}

/** 一个"配置对象"（导出用）：name + 手设置 + 按键映射 + 8 槽宏 */
function snapshotProfile(raw, fallbackName) {
    const p = (raw && typeof raw === 'object') ? raw : {};
    return {
        name: truncateProfileName(p.name != null ? p.name : p.profileName, fallbackName),
        gamepadSettings: {
            deadzoneLeft: clampInt(p.deadzoneLeft, 0, DEADZONE_MAX, DEADZONE_DEFAULT),
            deadzoneRight: clampInt(p.deadzoneRight, 0, DEADZONE_MAX, DEADZONE_DEFAULT),
            invertMask: clampInt(p.invertMask, 0, INVERT_MASK_ALL, 0),
            debounceMs: clampInt(p.debounceMs, 0, DEBOUNCE_MAX, DEBOUNCE_DEFAULT),
        },
        buttonMap: snapshotButtonMap(p.buttonMap),
        macros: snapshotMacros(p.macros),
    };
}

/**
 * 构建"单套配置"导出
 *
 * 文件名：`<清洗后的配置名>_<YYYY-MM-DD>.json`
 *
 * @param {Object} model - pages/config.js 的 model（读 profileName / 手设置 / buttonMap / macros）
 * @returns {{ filename: string, jsonText: string, data: Object }}
 */
export function buildSingleProfileExport(model) {
    const m = (model && typeof model === 'object') ? model : {};
    const idx = clampInt(m.activeProfile, 0, PROFILE_COUNT - 1, 0);
    const fallbackName = DEFAULT_PROFILE_NAMES[idx];
    const name = truncateProfileName(m.profileName, fallbackName);

    const data = {
        schema: SCHEMA_NAME,
        schemaVersion: SCHEMA_VERSION,
        kind: 'single_profile',
        exportedAt: new Date().toISOString(),
        profile: snapshotProfile({ ...m, name }, fallbackName),
    };

    return {
        filename: `${sanitizeFilename(name, fallbackName)}_${formatLocalDate()}.json`,
        jsonText: JSON.stringify(data, null, 2),
        data,
    };
}

/**
 * 构建"全板备份"导出（全局硬件层 + 4 套独立配置）
 *
 * 文件名：`全板备份_<YYYY-MM-DD>.json`
 *
 * @param {Object} activeModel - 当前连接的 model（提供 calib / pollRate / shortcutEnable / activeProfile，
 *                               以及 activeProfile 那一套的配置内容）
 * @param {Array<Object>} [allProfilesData] - 4 套配置对象数组（下标 = 槽位 0~3）。
 *        缺失的槽位：若是当前激活槽位则用 activeModel 填充，否则按默认值填充并在 warnings 里标注。
 * @returns {{ filename: string, jsonText: string, data: Object }}
 */
export function buildFullBackupExport(activeModel, allProfilesData) {
    const m = (activeModel && typeof activeModel === 'object') ? activeModel : {};
    const activeIdx = clampInt(m.activeProfile, 0, PROFILE_COUNT - 1, 0);
    const source = Array.isArray(allProfilesData) ? allProfilesData : [];

    const profiles = [];
    const missing = [];

    for (let i = 0; i < PROFILE_COUNT; i++) {
        let candidate = source[i];

        if (!candidate && i === activeIdx) candidate = m;
        if (!candidate) missing.push(i);

        profiles.push(snapshotProfile(candidate, DEFAULT_PROFILE_NAMES[i]));
    }

    const data = {
        schema: SCHEMA_NAME,
        schemaVersion: SCHEMA_VERSION,
        kind: 'full_backup',
        exportedAt: new Date().toISOString(),
        activeProfile: activeIdx,
        systemGlobal: { shortcutEnable: !!m.shortcutEnable },
        hardware: {
            calib: snapshotCalib(m.calib),
            pollRate: clampInt(m.pollRate, 0, POLL_RATE_MAX, POLL_RATE_DEFAULT),
        },
        profiles,
    };

    if (missing.length) {
        data.warnings = [`配置 ${missing.map((i) => i + 1).join('、')} 缺少数据，已按默认值导出`];
    }

    return {
        filename: `全板备份_${formatLocalDate()}.json`,
        jsonText: JSON.stringify(data, null, 2),
        data,
    };
}

/**
 * 触发浏览器下载（纯 UTF-8，带 BOM 以便 Windows 记事本直接双击可读）
 * 注意：导入侧 inspectImportJson() 会剥掉 BOM，所以自导自入不会因为 BOM 而 JSON.parse 失败。
 *
 * @param {string} filename
 * @param {string} jsonText
 * @returns {boolean} 是否真的触发了下载（非浏览器环境返回 false）
 */
export function triggerJsonDownload(filename, jsonText) {
    if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
        return false;
    }

    const name = sanitizeFilename(filename, '配置文件.json');
    const safeName = name.toLowerCase().endsWith('.json') ? name : `${name}.json`;

    const blob = new Blob(['\uFEFF' + String(jsonText == null ? '' : jsonText)], {
        type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = safeName;
    a.rel = 'noopener';
    a.style.display = 'none';

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // 立即 revoke 在部分浏览器上会让下载拿不到内容，推迟一帧再释放
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 0);

    return true;
}

//--------------------------------------------------------------------+
// 导入：触发键可读名
//--------------------------------------------------------------------+

const DPAD_LABELS = ['↑', '→', '↓', '←'];
const FACE_LABELS = { 4: '□', 5: '×', 6: '○', 7: '△' };

/**
 * 组合键里各键的显示优先级（小的在前）
 *   肩键/扳机/摇杆按键/系统键 → 动作键 → 十字键 → 扩展键
 * 这样 `L1 + △`、`Share + △` 会按人们习惯的顺序显示，而不是纯按位号
 * （纯按位号会得到 "△ + L1"、"△ + Share"）。
 */
function bitRank(bit) {
    if (bit >= 8 && bit <= 17) return 0;
    if (bit >= 4 && bit <= 7) return 1;
    if (bit <= 3) return 2;
    return 3;
}

/**
 * 单个物理位的短名（用于 `L1 + △` 这种摘要）
 *   0~3   → ↑ → ↓ ←
 *   4~7   → □ × ○ △（取物理键名里 '/' 后面的符号，避免出现 "Y / △"）
 *   8~17  → L1 / R1 / L2 / R2 / L3 / R3 / PS / Share / Options / Touchpad
 *   18~25 → BTN1 ~ BTN8
 */
function physicalLabel(bit) {
    if (bit >= 0 && bit <= 3) return DPAD_LABELS[bit];
    if (FACE_LABELS[bit]) return FACE_LABELS[bit];
    if (bit >= 18 && bit <= 25) return `BTN${bit - 17}`;

    const btn = PHYSICAL_BUTTONS[bit];
    if (!btn || !btn.name) return `bit${bit}`;
    return String(btn.name).split(/[（(]/)[0].trim();
}

/** 26 位物理掩码 → `L1 + △` / `未绑定` */
export function physicalMaskLabel(mask) {
    const m = (Number(mask) || 0) & TRIGGER_MASK_ALL;
    if (m === 0) return '未绑定';

    const bits = [];
    for (let bit = 0; bit < 26; bit++) {
        if ((m & (1 << bit)) !== 0) bits.push(bit);
    }
    bits.sort((a, b) => (bitRank(a) - bitRank(b)) || (a - b));

    return bits.length ? bits.map(physicalLabel).join(' + ') : '未绑定';
}

//--------------------------------------------------------------------+
// 导入：单条宏摘要
//--------------------------------------------------------------------+

/**
 * 把一条原始宏对象处理成"弹窗里能直接显示的一行"
 *
 * @param {*} rawSlot
 * @param {number} slotIndex - 0 ~ 7
 * @param {string[]|null} [warnings] - 传入时，把"被钳位/被过滤"的字段记一条说明
 * @returns {Object} 摘要对象（含规整后的 slot 本体）
 */
function buildMacroEntry(rawSlot, slotIndex, warnings = null) {
    const { slot, valid, reason } = normalizeMacroSlot(rawSlot);

    // 记录被固件级边界"悄悄改掉"的字段：导入时用户需要知道文件里有东西没被原样接受
    if (Array.isArray(warnings) && rawSlot && typeof rawSlot === 'object' && !Array.isArray(rawSlot)) {
        const tag = `宏 ${slotIndex + 1}`;

        const rawMode = Number(rawSlot.mode);
        if (rawSlot.mode !== undefined && rawSlot.mode !== null
            && !(Number.isInteger(rawMode) && rawMode >= 0 && rawMode <= 2)) {
            warnings.push(`${tag} 的执行模式 ${JSON.stringify(rawSlot.mode)} 非法，已按「单次执行」处理`);
        }

        const rawHold = Number(rawSlot.holdMs);
        if (rawSlot.holdMs !== undefined && rawSlot.holdMs !== null
            && (!Number.isFinite(rawHold) || rawHold < 0 || rawHold > 10000)) {
            warnings.push(`${tag} 的长按阈值 ${JSON.stringify(rawSlot.holdMs)} 超出 0~10000ms，已钳位`);
        }

        const rawCount = Number(rawSlot.stepCount);
        if (rawSlot.stepCount !== undefined && rawSlot.stepCount !== null
            && (!Number.isInteger(rawCount) || rawCount < 0 || rawCount > 16)) {
            warnings.push(`${tag} 的步数 ${JSON.stringify(rawSlot.stepCount)} 超出 0~16，已钳位`);
        }

        const rawTrigger = Number(rawSlot.triggerMask);
        if (Number.isFinite(rawTrigger) && ((rawTrigger >>> 0) & 0xfc000000) !== 0) {
            warnings.push(`${tag} 的触发掩码含 26 位以外的非法位，已过滤`);
        }

        if (Array.isArray(rawSlot.steps) && rawSlot.steps.length > 16) {
            warnings.push(`${tag} 有 ${rawSlot.steps.length} 步，超出上限 16，已截断`);
        }
    }

    const triggerLabel = physicalMaskLabel(slot.triggerMask);
    const modeName = MODE_SHORT[slot.mode] || MODE_SHORT[0];

    let summary;
    if (valid) {
        summary = `${slot.stepCount} 步 · ${modeName} · 触发: ${triggerLabel}`;
        if (slot.holdMs > 0) summary += ` · 长按 ${slot.holdMs}ms`;
    } else {
        summary = `空槽位（${reason}）`;
    }

    return {
        slotIndex,
        groupId: MACRO_GROUP_BASE + slotIndex,
        triggerMask: slot.triggerMask,
        triggerLabel,
        stepCount: slot.stepCount,
        mode: slot.mode,
        modeName,
        holdMs: slot.holdMs,
        blockTrigger: (slot.flags & MACRO_FLAG_BLOCK_TRIGGER) !== 0,
        valid,
        reason,
        summary,
        slot,
    };
}

//--------------------------------------------------------------------+
// 导入：逐组校验
//--------------------------------------------------------------------+

function parseCalib(raw, warnings) {
    if (!raw || typeof raw !== 'object') return null;

    const out = {};
    let kept = 0;

    for (const axis of ['lx', 'ly', 'rx', 'ry']) {
        const c = raw[axis];
        if (!c || typeof c !== 'object') {
            warnings.push(`校准 ${axis} 缺失，已跳过`);
            continue;
        }

        const min = Math.round(Number(c.min));
        const center = Math.round(Number(c.center));
        const max = Math.round(Number(c.max));

        const numeric = Number.isFinite(min) && Number.isFinite(center) && Number.isFinite(max);
        const inRange = numeric && min >= 0 && center <= CALIB_MAX && max <= CALIB_MAX;
        const ordered = numeric && min < center && center < max;

        if (!(inRange && ordered)) {
            warnings.push(`校准 ${axis} 非法（需 0 ≤ min < center < max ≤ 4095），已跳过`);
            continue;
        }

        out[axis] = { min, center, max };
        kept++;
    }

    return kept ? out : null;
}

function parseHardware(raw, warnings) {
    const h = (raw && typeof raw === 'object') ? raw : {};

    const calib = parseCalib(h.calib, warnings);

    let pollRate = null;
    if (h.pollRate !== undefined && h.pollRate !== null) {
        const n = Number(h.pollRate);
        if (Number.isInteger(n) && n >= 0 && n <= POLL_RATE_MAX) {
            pollRate = n;
        } else {
            warnings.push(`回报率 ${JSON.stringify(h.pollRate)} 非法（需 0~5 的整数），已忽略`);
        }
    }

    return { calib, pollRate };
}

function parseSystemGlobal(raw, warnings) {
    const g = (raw && typeof raw === 'object') ? raw : {};

    let shortcutEnable = null;
    if (typeof g.shortcutEnable === 'boolean') {
        shortcutEnable = g.shortcutEnable;
    } else if (g.shortcutEnable === 0 || g.shortcutEnable === 1) {
        shortcutEnable = g.shortcutEnable === 1;
    } else if (g.shortcutEnable !== undefined && g.shortcutEnable !== null) {
        warnings.push('盲切开关取值非法（需 true / false），已忽略');
    }

    return { shortcutEnable };
}

function parseGamepadSettings(raw, profileIndex, warnings) {
    const g = (raw && typeof raw === 'object') ? raw : {};

    const take = (key, min, max, dflt, label) => {
        if (g[key] === undefined || g[key] === null) return dflt;

        const n = Number(g[key]);
        if (!Number.isFinite(n)) {
            warnings.push(`配置 ${profileIndex + 1} 的${label}不是数值，已用默认 ${dflt}`);
            return dflt;
        }

        const clamped = clampInt(n, min, max, dflt);
        if (clamped !== Math.round(n)) {
            warnings.push(`配置 ${profileIndex + 1} 的${label} ${Math.round(n)} 超出 ${min}~${max}，已钳位为 ${clamped}`);
        }
        return clamped;
    };

    return {
        deadzoneLeft: take('deadzoneLeft', 0, DEADZONE_MAX, DEADZONE_DEFAULT, '左死区'),
        deadzoneRight: take('deadzoneRight', 0, DEADZONE_MAX, DEADZONE_DEFAULT, '右死区'),
        invertMask: take('invertMask', 0, INVERT_MASK_ALL, 0, '反转掩码'),
        debounceMs: take('debounceMs', 0, DEBOUNCE_MAX, DEBOUNCE_DEFAULT, '消抖时间'),
    };
}

function parseButtonMap(raw, profileIndex, warnings) {
    const out = new Array(BUTTON_MAP_LEN).fill(0);

    if (!Array.isArray(raw)) {
        if (raw !== undefined && raw !== null) {
            warnings.push(`配置 ${profileIndex + 1} 的 buttonMap 不是数组，已用全 0（禁用）`);
        }
        return out;
    }

    if (raw.length !== BUTTON_MAP_LEN) {
        warnings.push(`配置 ${profileIndex + 1} 的 buttonMap 长度 ${raw.length} ≠ ${BUTTON_MAP_LEN}，已按前 ${BUTTON_MAP_LEN} 项处理`);
    }

    let filtered = 0;
    for (let i = 0; i < BUTTON_MAP_LEN; i++) {
        const v = (Number(raw[i]) || 0) >>> 0;
        const masked = (v & DS4_LOGICAL_MASK_ALL) >>> 0;
        if (masked !== v) filtered++;
        out[i] = masked;
    }

    if (filtered) {
        warnings.push(`配置 ${profileIndex + 1} 的 buttonMap 有 ${filtered} 项含非法位，已按 0x${DS4_LOGICAL_MASK_ALL.toString(16).toUpperCase()} 过滤`);
    }

    return out;
}

/**
 * 解析一套配置（single_profile 的本体 / full_backup 的 profiles[i]）
 * @returns {Object} { index, name, gamepadSettings, buttonMap, macros, macroList, validMacroCount }
 */
function parseProfile(raw, index, warnings) {
    const fallbackName = DEFAULT_PROFILE_NAMES[index] || `配置 ${index + 1}`;
    const p = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;

    if (!p) warnings.push(`配置 ${index + 1} 数据缺失，已按默认值填充`);

    const rawMacros = (p && Array.isArray(p.macros)) ? p.macros : [];

    const macroList = [];
    const macros = [];
    for (let i = 0; i < MACRO_SLOT_COUNT; i++) {
        const entry = buildMacroEntry(rawMacros[i], i, warnings);
        macroList.push(entry);
        macros.push(entry.slot);
    }

    const validMacroCount = macroList.reduce((n, e) => n + (e.valid ? 1 : 0), 0);

    return {
        index,
        name: truncateProfileName(p ? p.name : '', fallbackName),
        gamepadSettings: parseGamepadSettings(p && p.gamepadSettings, index, warnings),
        buttonMap: parseButtonMap(p && p.buttonMap, index, warnings),
        macros,
        macroList,
        validMacroCount,
    };
}

//--------------------------------------------------------------------+
// 导入：结构识别
//--------------------------------------------------------------------+

function isMacroLike(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x)
        && ('triggerMask' in x || 'steps' in x || 'stepCount' in x || 'holdMs' in x);
}

/**
 * 智能识别文件结构
 * @returns {'full_backup'|'single_profile'|'macros_fragment'|null}
 */
export function detectImportKind(data) {
    if (Array.isArray(data)) {
        return (data.length && isMacroLike(data[0])) ? 'macros_fragment' : null;
    }
    if (!data || typeof data !== 'object') return null;

    if (data.kind === 'full_backup') return 'full_backup';
    if (Array.isArray(data.profiles)) return 'full_backup';

    if (data.kind === 'single_profile') return 'single_profile';
    if (data.profile && typeof data.profile === 'object') return 'single_profile';
    if (data.buttonMap || data.gamepadSettings) return 'single_profile';

    // 只有 macros（没有 buttonMap / gamepadSettings）→ 当作宏片段
    if (Array.isArray(data.macros)) return 'macros_fragment';
    if (isMacroLike(data)) return 'macros_fragment';

    return null;
}

/**
 * 解析一个已经 JSON.parse 过的对象（便于测试与复用）
 *
 * 返回结构：
 * {
 *   ok: true,
 *   kind: 'full_backup' | 'single_profile' | 'macros_fragment',
 *   schemaOk: boolean,              // schema + schemaVersion 是否匹配
 *   warnings: string[],             // 逐项过滤/钳位/缺失的说明（可直接显示给用户）
 *   activeProfile: number|null,     // full_backup 专有
 *   systemGlobal: { shortcutEnable } | null,
 *   hardware: { calib, pollRate } | null,
 *   profiles: Array<{ index, name, gamepadSettings, buttonMap, macros, macroList, validMacroCount }>,
 *   macros: Array<MacroEntry>,      // macros_fragment 专有
 *   validMacroCount: number         // profiles 内所有有效宏之和（fragment 时为有效条数）
 * }
 *
 * MacroEntry = { slotIndex, groupId, triggerMask, triggerLabel, stepCount, mode, modeName,
 *                holdMs, blockTrigger, valid, reason, summary, slot }
 */
export function inspectImportData(data) {
    const kind = detectImportKind(data);
    if (!kind) {
        return { ok: false, error: '无法识别的文件结构：既不是全板备份，也没有 profile / macros 字段' };
    }

    const warnings = [];
    const result = {
        ok: true,
        kind,
        schemaOk: false,
        warnings,
        activeProfile: null,
        systemGlobal: null,
        hardware: null,
        profiles: [],
        macros: [],
        validMacroCount: 0,
    };

    const schema = (data && typeof data === 'object' && !Array.isArray(data)) ? data.schema : undefined;
    const version = (data && typeof data === 'object' && !Array.isArray(data)) ? Number(data.schemaVersion) : undefined;

    result.schemaOk = (schema === SCHEMA_NAME) && (version === SCHEMA_VERSION);
    if (schema && schema !== SCHEMA_NAME) {
        warnings.push(`schema 为 "${schema}"（期望 "${SCHEMA_NAME}"），将尽力解析`);
    }
    if (Number.isFinite(version) && version > SCHEMA_VERSION) {
        warnings.push(`文件版本 ${version} 高于本页支持的 ${SCHEMA_VERSION}，未知字段会被忽略`);
    }

    if (kind === 'full_backup') {
        const rawActive = data.activeProfile;
        if (rawActive === undefined || rawActive === null) {
            result.activeProfile = 0;
        } else {
            const n = Number(rawActive);
            if (Number.isInteger(n) && n >= 0 && n < PROFILE_COUNT) {
                result.activeProfile = n;
            } else {
                result.activeProfile = 0;
                warnings.push(`activeProfile ${JSON.stringify(rawActive)} 非法（需 0~3），按配置 1 处理`);
            }
        }

        result.systemGlobal = parseSystemGlobal(data.systemGlobal, warnings);
        result.hardware = parseHardware(data.hardware, warnings);

        const list = Array.isArray(data.profiles) ? data.profiles : [];
        if (!list.length) warnings.push('文件里没有 profiles 数组，4 套配置都将按默认值处理');

        for (let i = 0; i < PROFILE_COUNT; i++) {
            result.profiles.push(parseProfile(list[i], i, warnings));
        }

        result.validMacroCount = result.profiles.reduce((n, p) => n + p.validMacroCount, 0);
    } else if (kind === 'single_profile') {
        const body = (data.profile && typeof data.profile === 'object') ? data.profile : data;
        result.profiles.push(parseProfile(body, 0, warnings));
        result.validMacroCount = result.profiles[0].validMacroCount;
    } else {
        const list = Array.isArray(data) ? data : data.macros;
        const arr = Array.isArray(list) ? list : [data];

        result.macros = arr.slice(0, MACRO_SLOT_COUNT).map((raw, i) => buildMacroEntry(raw, i, warnings));
        result.validMacroCount = result.macros.reduce((n, e) => n + (e.valid ? 1 : 0), 0);

        if (!result.macros.length) warnings.push('片段里没有可用的宏对象');
    }

    return result;
}

/**
 * 导入入口：从文本解析（自动剥 BOM、捕获语法错误）
 * @param {string} jsonText
 * @returns {Object} 同 inspectImportData 的返回结构；解析失败时 { ok:false, error }
 */
export function inspectImportJson(jsonText) {
    let text = String(jsonText == null ? '' : jsonText);

    // 导出时带过 UTF-8 BOM（方便 Windows 记事本），这里必须剥掉，
    // 否则 JSON.parse 会在第一个字符就抛 "Unexpected token"
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.trim();

    if (!text) return { ok: false, error: '文件内容为空' };

    let data;
    try {
        data = JSON.parse(text);
    } catch (err) {
        return { ok: false, error: `JSON 解析失败：${err && err.message ? err.message : String(err)}` };
    }

    return inspectImportData(data);
}
