/**
 * device.js - 芯片数据库与配置寄存器解析
 * 移植自 wchisp-web/src/device.ts
 */

import { readLe32 } from './protocol.js';

export class ChipDatabase {
    constructor(families) {
        this.families = families || BUILTIN_CHIPS;
    }

    /**
     * 根据 chipId 和 deviceType 查找芯片
     * @returns {object|undefined}
     */
    find(chipId, deviceType) {
        for (const family of this.families) {
            const familyDeviceTypeMatch = (family.deviceType & 0xff) === (deviceType & 0xff);
            for (const variant of family.variants) {
                if (!familyDeviceTypeMatch && (variant.deviceType & 0xff) !== (deviceType & 0xff)) {
                    continue;
                }
                const ids = variant.altChipIds === '*' ? [] : variant.altChipIds ?? [];
                if (variant.altChipIds === '*' || variant.chipId === chipId || ids.includes(chipId)) {
                    return mergeFamilyChip(family, variant);
                }
            }
        }
        return undefined;
    }
}

/**
 * 解析配置寄存器（用于展示）
 */
export function explainConfig(raw, registers = []) {
    const out = [];
    for (const reg of registers) {
        if (raw.length < reg.offset + 4) continue;
        const value = readLe32(raw, reg.offset);
        out.push({
            name: reg.name,
            offset: reg.offset,
            value,
            explanation: lookupExplanation(value, reg.explanation),
            fields: (reg.fields ?? []).map(f => {
                const [hi, lo] = f.bitRange;
                const width = hi - lo + 1;
                const fv = (value >>> lo) & (width >= 32 ? 0xffffffff : (2 ** width) - 1);
                return { name: f.name, range: f.bitRange, value: fv >>> 0, explanation: lookupExplanation(fv >>> 0, f.explanation) };
            }),
        });
    }
    return out;
}

/**
 * 最小擦除扇区数
 */
export function minEraseSectorNumber(chip, deviceType) {
    if (chip?.minEraseSectors) return chip.minEraseSectors;
    const dt = chip?.deviceType ?? deviceType ?? 0;
    return dt === 0x11 || dt === 0x12 ? 4 : 8;
}

/**
 * 芯片显示名称
 */
export function chipDisplayName(chip, chipId, deviceType) {
    return chip
        ? `${chip.name}[0x${hex2(chip.chipId)}${hex2(chip.deviceType)}]`
        : `Unknown[0x${hex2(chipId)}${hex2(deviceType)}]`;
}

function mergeFamilyChip(family, chip) {
    return {
        ...chip,
        mcuType: chip.mcuType ?? family.mcuType,
        deviceType: chip.deviceType ?? family.deviceType,
        supportUsb: chip.supportUsb ?? family.supportUsb,
        supportSerial: chip.supportSerial ?? family.supportSerial,
        supportNet: chip.supportNet ?? family.supportNet,
        configRegisters: [...(family.configRegisters ?? []), ...(chip.configRegisters ?? [])],
    };
}

function lookupExplanation(value, map) {
    if (!map) return undefined;
    const keys = [`0x${value.toString(16).toUpperCase()}`, `0x${value.toString(16)}`, String(value), '_'];
    for (const k of keys) if (map[k] !== undefined) return map[k];
    return undefined;
}

function hex2(n) {
    return (n & 0xff).toString(16).padStart(2, '0');
}

const basicConfig = [
    {
        offset: 0,
        name: 'RDPR_USER',
        reset: 0x9f605aa5,
        fields: [
            { name: 'RDPR', bitRange: [7, 0], explanation: { '0xA5': 'Unprotected', '_': 'Protected' } },
            { name: 'IWDG_SW', bitRange: [16, 16] },
            { name: 'STOP_RST', bitRange: [17, 17] },
            { name: 'STANDBY_RST', bitRange: [18, 18] },
        ],
    },
    { offset: 4, name: 'DATA' },
    { offset: 8, name: 'WRP', explanation: { '0xFFFFFFFF': 'Unprotected' } },
];

function normalizeFamilies(families) {
    return families.map(f => ({
        ...f,
        deviceType: f.deviceType & 0xff,
        mcuType: f.mcuType & 0xff,
        variants: (f.variants ?? []).map(c => ({
            ...c,
            deviceType: (c.deviceType ?? f.deviceType) & 0xff,
            mcuType: (c.mcuType ?? f.mcuType) & 0xff,
        })),
    }));
}

const BUILTIN_CHIPS = normalizeFamilies([
    {
        name: 'CH32V20x', mcuType: 0x02, deviceType: 0x12, supportUsb: true, supportSerial: true,
        variants: [
            { name: 'CH32V203', chipId: 0x20, deviceType: 0x12, flashSize: 64 * 1024 },
            { name: 'CH32V208', chipId: 0x21, deviceType: 0x12, flashSize: 128 * 1024 },
        ],
        configRegisters: basicConfig,
    },
    {
        name: 'CH32V30x', mcuType: 0x00, deviceType: 0x10, supportUsb: true, supportSerial: true,
        variants: [
            { name: 'CH32V307', chipId: 0x70, deviceType: 0x17, flashSize: 256 * 1024, eepromSize: 0 },
            { name: 'CH32V305', chipId: 0x70, deviceType: 0x15, flashSize: 256 * 1024, eepromSize: 0 },
        ],
        configRegisters: basicConfig,
    },
    {
        name: 'CH55x', mcuType: 0x05, deviceType: 0x11, supportUsb: true, supportSerial: true,
        variants: [
            { name: 'CH552', chipId: 0x52, deviceType: 0x11, flashSize: 16 * 1024, eepromSize: 128 },
            { name: 'CH554', chipId: 0x54, deviceType: 0x11, flashSize: 16 * 1024, eepromSize: 128 },
            { name: 'CH559', chipId: 0x59, deviceType: 0x11, flashSize: 56 * 1024, eepromSize: 1024 },
        ],
        configRegisters: basicConfig,
    },
    {
        name: 'CH57x/CH58x/CH59x', mcuType: 0x08, deviceType: 0x18, supportUsb: true, supportSerial: true,
        variants: [
            { name: 'CH573', chipId: 0x73, deviceType: 0x18, flashSize: 448 * 1024 },
            { name: 'CH579', chipId: 0x79, deviceType: 0x18, flashSize: 448 * 1024 },
            { name: 'CH582', chipId: 0x82, deviceType: 0x18, flashSize: 448 * 1024 },
            { name: 'CH592', chipId: 0x92, deviceType: 0x18, flashSize: 448 * 1024 },
        ],
        configRegisters: basicConfig,
    },
]);
