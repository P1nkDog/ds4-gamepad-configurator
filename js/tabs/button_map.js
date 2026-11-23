/**
 * button_map.js - 26 路物理按键定义 + DS4 逻辑功能位掩码 + 出厂默认掩码表
 *
 * 与固件严格对齐：
 *   物理位序 —— Driver/input/input.h 的 INPUT_MASK_*（bit0 ~ bit25）
 *   逻辑功能 —— Config/config.h 的 Ds4LogicalButton（bit1 ~ bit18 为合法功能位）
 *   默认掩码 —— Config/config.c 的 buttonMapDefault（26 × uint32，逐项一致）
 *
 * 注意位序陷阱：物理位 bit4~7 是 X/A/B/Y，而 DS4 逻辑位 5~8 是 A/B/Y/X，
 * 两者**不是同序**，默认表已逐项对齐（bit4=X→8、bit5=A→5、bit6=B→6、bit7=Y→7）。
 *
 * 一个物理键的映射是**位掩码**：0 = 禁用，单个位 = 单功能，多个位 = 同时触发多个功能。
 */

// DS4 逻辑功能上限（与固件 DS4_BTN_MAX 一致）
export const DS4_BTN_MAX = 18;
// 合法位掩码：bit1 ~ bit18（bit0 是 DS4_BTN_NONE 的编号，不是功能位）
export const DS4_LOGICAL_MASK_ALL = 0x0007FFFE;

/**
 * 构造单个逻辑功能的位掩码（>>> 0 保证是 32 位无符号数）
 * @param {number} btn - 1 ~ 18
 * @returns {number}
 */
export const ds4BtnBit = (btn) => (1 << btn) >>> 0;

// 物理按键表：数组下标 == 固件物理位号（0 ~ 25）
//   name 给用户看的物理按键名，pin 为 v0.2.0 实测引脚（见固件 README.zh-CN.md）
export const PHYSICAL_BUTTONS = [
    { bit: 0,  name: '十字键上 (UP)',      pin: 'PE9'  },
    { bit: 1,  name: '十字键右 (RIGHT)',   pin: 'PE8'  },
    { bit: 2,  name: '十字键下 (DOWN)',    pin: 'PE11' },
    { bit: 3,  name: '十字键左 (LEFT)',    pin: 'PE10' },
    { bit: 4,  name: 'X / □ (Square)',     pin: 'PB11' },
    { bit: 5,  name: 'A / × (Cross)',      pin: 'PE13' },
    { bit: 6,  name: 'B / ○ (Circle)',     pin: 'PE14' },
    { bit: 7,  name: 'Y / △ (Triangle)',   pin: 'PE15' },
    { bit: 8,  name: 'L1',                 pin: 'PE7'  },
    { bit: 9,  name: 'R1',                 pin: 'PB10' },
    { bit: 10, name: 'L2',                 pin: 'PB0'  },
    { bit: 11, name: 'R2',                 pin: 'PB1'  },
    { bit: 12, name: 'L3（左摇杆按下）',    pin: 'PA7'  },
    { bit: 13, name: 'R3（右摇杆按下）',    pin: 'PE1'  },
    { bit: 14, name: 'PS',                 pin: 'PE12' },
    { bit: 15, name: 'Share (SELECT)',     pin: 'PB12' },
    { bit: 16, name: 'Options (START)',    pin: 'PB14' },
    { bit: 17, name: 'Touchpad（按下）',    pin: 'PB13' },
    { bit: 18, name: '扩展键 BTN1',         pin: 'PD1'  },
    { bit: 19, name: '扩展键 BTN2',         pin: 'PD2'  },
    { bit: 20, name: '扩展键 BTN3',         pin: 'PD3'  },
    { bit: 21, name: '扩展键 BTN4',         pin: 'PD4'  },
    { bit: 22, name: '扩展键 BTN5',         pin: 'PD5'  },
    { bit: 23, name: '扩展键 BTN6',         pin: 'PD6'  },
    { bit: 24, name: '扩展键 BTN7',         pin: 'PD7'  },
    { bit: 25, name: '扩展键 BTN8',         pin: 'PB3'  },
];

// 18 个可触发的 DS4 逻辑功能（bit 1 ~ 18，不含 0=禁用）
//   short 用于组合摘要（如 "L1 + R1"），label 用于悬停提示
export const DS4_LOGICAL_BUTTONS = [
    { bit: 1,  short: '↑',        label: '方向上 (UP)' },
    { bit: 2,  short: '→',        label: '方向右 (RIGHT)' },
    { bit: 3,  short: '↓',        label: '方向下 (DOWN)' },
    { bit: 4,  short: '←',        label: '方向左 (LEFT)' },
    { bit: 5,  short: '× (A)',    label: '× Cross (A)' },
    { bit: 6,  short: '○ (B)',    label: '○ Circle (B)' },
    { bit: 7,  short: '△ (Y)',    label: '△ Triangle (Y)' },
    { bit: 8,  short: '□ (X)',    label: '□ Square (X)' },
    { bit: 9,  short: 'L1',       label: 'L1' },
    { bit: 10, short: 'R1',       label: 'R1' },
    { bit: 11, short: 'L2',       label: 'L2' },
    { bit: 12, short: 'R2',       label: 'R2' },
    { bit: 13, short: 'L3',       label: 'L3 (左摇杆按下)' },
    { bit: 14, short: 'R3',       label: 'R3 (右摇杆按下)' },
    { bit: 15, short: 'PS',       label: 'PS 键' },
    { bit: 16, short: 'Share',    label: 'Share (SELECT)' },
    { bit: 17, short: 'Options',  label: 'Options (START)' },
    { bit: 18, short: 'Touchpad', label: 'Touchpad (触摸板按下)' },
];

// 出厂默认位掩码表（26 个 uint32，与固件 buttonMapDefault 逐项一致）
//   0~17：标准键单功能；18~25：BTN1~BTN8 禁用（0）
export const DEFAULT_BUTTON_MASKS = [
    1, 2, 3, 4, 8, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    0, 0, 0, 0, 0, 0, 0, 0,
].map((btn) => (btn > 0 ? ds4BtnBit(btn) : 0));

/**
 * 把位掩码格式化成可读摘要
 *   ！按 DS4_LOGICAL_BUTTONS 的固定顺序输出，与固件报告顺序无关但稳定可比。
 * @param {number} mask - 32 位无符号掩码
 * @returns {string} 例如 '无（禁用）' / 'L1' / 'L1 + R1' / '× (A) + □ (X)'
 */
export function formatButtonMask(mask) {
    const m = (Number(mask) & DS4_LOGICAL_MASK_ALL) >>> 0;
    if (m === 0) return '无（禁用）';

    const parts = [];
    for (const item of DS4_LOGICAL_BUTTONS) {
        if ((m & ds4BtnBit(item.bit)) !== 0) parts.push(item.short);
    }
    return parts.length ? parts.join(' + ') : '无（禁用）';
}
