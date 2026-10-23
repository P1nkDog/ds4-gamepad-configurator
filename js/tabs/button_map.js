/**
 * button_map.js - 固件固定按键映射表（只读）
 *
 * 来源：映射取自固件 Driver/gamepad/gamepad.c 的 gamepad_process()，
 *      引脚取自 Driver/input/input.c 的 input_read_buttons() 与 input.h 的掩码注释。
 *
 * 动作键（对应固件 West/South/East/North 布局）：
 *   X = PB11 → DS4 □
 *   A = PE13 → DS4 ×
 *   B = PE14 → DS4 ○
 *   Y = PE15 → DS4 △
 *
 * 其余引脚：
 *   十字键  UP=PE9  RIGHT=PE8  DOWN=PE11  LEFT=PE10
 *   肩键/扳机 L1=PE7  R1=PB10  L2=PB0  R2=PB1
 *   摇杆按下  L3=PA5（左摇杆）  R3=PE1（右摇杆）
 *   功能键  Select=PB12(SW2)  Start=PB14(SW4)  PS=PE12  Touchpad=PB13(SW3)
 *
 * 拓展按键 BTN1~BTN8（PD3/PD4/PD5/PD6/PD7/PB3/PB4/PE0）固件只做扫描，
 * 未映射到任何 DS4 输出，因此 target 为 null。
 */

export const PHYSICAL_BUTTONS = [
    // 动作键（对应固件 West/South/East/North）
    { name: 'X',   target: 'DS4 □ (Square)' },
    { name: 'A',   target: 'DS4 × (Cross)' },
    { name: 'B',   target: 'DS4 ○ (Circle)' },
    { name: 'Y',   target: 'DS4 △ (Triangle)' },

    // 肩键
    { name: 'L1',  target: 'DS4 L1' },
    { name: 'R1',  target: 'DS4 R1' },

    // 扳机
    { name: 'L2',  target: 'DS4 L2' },
    { name: 'R2',  target: 'DS4 R2' },

    // 摇杆按下
    { name: 'L3',  target: 'DS4 L3' },
    { name: 'R3',  target: 'DS4 R3' },

    // 功能键
    { name: 'Start',    target: 'DS4 Options' },
    { name: 'Select',   target: 'DS4 Share' },
    { name: 'PS',       target: 'DS4 PS' },
    { name: 'Touchpad', target: 'DS4 Touchpad' },

    // 十字键
    { name: '十字键上', target: '十字键上' },
    { name: '十字键下', target: '十字键下' },
    { name: '十字键左', target: '十字键左' },
    { name: '十字键右', target: '十字键右' },

    // 拓展按键（固件已扫描，未映射到 DS4）
    { name: '拓展1', target: null },
    { name: '拓展2', target: null },
    { name: '拓展3', target: null },
    { name: '拓展4', target: null },
    { name: '拓展5', target: null },
    { name: '拓展6', target: null },
    { name: '拓展7', target: null },
    { name: '拓展8', target: null },
];
