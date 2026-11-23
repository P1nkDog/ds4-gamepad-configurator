/**
 * button_map.js - 26 路物理按键定义 + DS4 逻辑功能枚举 + 出厂默认映射
 *
 * 与固件严格对齐：
 *   物理位序 —— Driver/input/input.h 的 INPUT_MASK_*（bit0 ~ bit25）
 *   逻辑功能 —— Config/config.h 的 Ds4LogicalButton（0 ~ 18）
 *   默认映射 —— Config/config.c 的 buttonMapDefault（逐项一致）
 *
 * 注意位序陷阱：物理位 bit4~7 是 X/A/B/Y，而 DS4 逻辑枚举 5~8 是 A/B/Y/X，
 * 两者**不是同序**，默认表已逐项对齐（bit4=X→8、bit5=A→5、bit6=B→6、bit7=Y→7）。
 */

// DS4 逻辑功能上限（与固件 DS4_BTN_MAX 一致）
export const DS4_BTN_MAX = 18;

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

// DS4 逻辑功能选项（value 与固件 Ds4LogicalButton 枚举严格一致）
export const DS4_LOGICAL_BUTTONS = [
    { value: 0,  label: '无（禁用）' },
    { value: 1,  label: '方向上 (UP)' },
    { value: 2,  label: '方向右 (RIGHT)' },
    { value: 3,  label: '方向下 (DOWN)' },
    { value: 4,  label: '方向左 (LEFT)' },
    { value: 5,  label: '× Cross (A)' },
    { value: 6,  label: '○ Circle (B)' },
    { value: 7,  label: '△ Triangle (Y)' },
    { value: 8,  label: '□ Square (X)' },
    { value: 9,  label: 'L1' },
    { value: 10, label: 'R1' },
    { value: 11, label: 'L2' },
    { value: 12, label: 'R2' },
    { value: 13, label: 'L3 (左摇杆按下)' },
    { value: 14, label: 'R3 (右摇杆按下)' },
    { value: 15, label: 'PS 键' },
    { value: 16, label: 'Share (SELECT)' },
    { value: 17, label: 'Options (START)' },
    { value: 18, label: 'Touchpad (触摸板按下)' },
];

// 出厂默认映射（与固件 buttonMapDefault 逐字节一致）
//   0~17：标准键按原硬编码映射；18~25：BTN1~BTN8 默认禁用
export const DEFAULT_BUTTON_MAP = [
    1, 2, 3, 4, 8, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    0, 0, 0, 0, 0, 0, 0, 0,
];

/**
 * 取逻辑功能的中文标签（越界或未定义时返回占位文本）
 * @param {number} value - 0 ~ 18
 * @returns {string}
 */
export function logicalButtonLabel(value) {
    const item = DS4_LOGICAL_BUTTONS.find((b) => b.value === value);
    return item ? item.label : '未知';
}
