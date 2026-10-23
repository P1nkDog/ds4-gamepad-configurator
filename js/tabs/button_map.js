/**
 * button_map.js - 固件固定按键映射表（只读）
 *
 * 来源：固件 Driver/gamepad/gamepad.c 中硬编码的 GPIO → DS4 按键映射。
 *
 * 物理按键命名与需求文档保持一致（A/B/X/Y 等），
 * 对应关系：A=West(PE2) → □，B=South(PE1) → ×，X=East(PE0) → ○，Y=North(PC12) → △
 * （与固件 West/South/East/North = □/×/○/△ 的布局一致）
 *
 * 拓展按键 1~8 当前固件未定义。
 */

export const PHYSICAL_BUTTONS = [
    // 动作键（对应固件 West/South/East/North）
    { name: 'A',   target: 'DS4 □ (Square)' },
    { name: 'B',   target: 'DS4 × (Cross)' },
    { name: 'X',   target: 'DS4 ○ (Circle)' },
    { name: 'Y',   target: 'DS4 △ (Triangle)' },

    // 肩键
    { name: 'LB',  target: 'DS4 L1' },
    { name: 'RB',  target: 'DS4 R1' },

    // 扳机
    { name: 'LT',  target: 'DS4 L2' },
    { name: 'RT',  target: 'DS4 R2' },

    // 功能键
    { name: 'Start',  target: 'DS4 Options' },
    { name: 'Select', target: 'DS4 Share' },

    // 摇杆按下
    { name: 'L3',  target: 'DS4 L3' },
    { name: 'R3',  target: 'DS4 R3' },

    // 十字键
    { name: '十字键上', target: '十字键上' },
    { name: '十字键下', target: '十字键下' },
    { name: '十字键左', target: '十字键左' },
    { name: '十字键右', target: '十字键右' },

    // PS 键
    { name: 'PS',  target: 'DS4 PS' },

    // 拓展按键（固件未定义）
    { name: '拓展1', target: null },
    { name: '拓展2', target: null },
    { name: '拓展3', target: null },
    { name: '拓展4', target: null },
    { name: '拓展5', target: null },
    { name: '拓展6', target: null },
    { name: '拓展7', target: null },
    { name: '拓展8', target: null },
];
