/**
 * protocol.js - WCH ISP 协议
 * 移植自 wchisp-web/src/protocol.ts
 *
 * 注意：本文件是协议层的完整移植，不按「是否被调用」裁剪。
 * 数据区读写擦（DATA_PROGRAM / DATA_READ / DATA_ERASE）、SET_BAUD、
 * 串口帧封装（frameSerialRequest / parseSerialResponse）当前烧录流程用不到，
 * 属于预留能力，后续可能会调用——不要当成死代码删掉。
 */

export const MAX_PACKET_SIZE = 64;
export const SECTOR_SIZE = 1024;
export const CODE_CHUNK_SIZE = 56;
export const EEPROM_READ_CHUNK_SIZE = 0x3a;

export const CFG_MASK_RDPR_USER_DATA_WPR = 0x07;
export const CFG_MASK_BTVER = 0x08;
export const CFG_MASK_UID = 0x10;
export const CFG_MASK_ALL = 0x1f;

export const CMD = {
    IDENTIFY: 0xa1,
    ISP_END: 0xa2,
    ISP_KEY: 0xa3,
    ERASE: 0xa4,
    PROGRAM: 0xa5,
    VERIFY: 0xa6,
    READ_CONFIG: 0xa7,
    WRITE_CONFIG: 0xa8,
    DATA_ERASE: 0xa9,
    DATA_PROGRAM: 0xaa,
    DATA_READ: 0xab,
    WRITE_OTP: 0xc3,
    READ_OTP: 0xc4,
    SET_BAUD: 0xc5,
};

/** u16 小端编码 */
export function le16(n) {
    assertUint(n, 0xffff, 'u16');
    return [n & 0xff, (n >>> 8) & 0xff];
}

/** u32 小端编码 */
export function le32(n) {
    assertUint(n, 0xffffffff, 'u32');
    return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** 读 u16 小端 */
export function readLe16(buf, off) {
    requireLength(buf, off + 2, 'u16');
    return buf[off] | (buf[off + 1] << 8);
}

/** 读 u32 小端 */
export function readLe32(buf, off) {
    requireLength(buf, off + 4, 'u32');
    return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

/** 构建识别命令 */
export function commandIdentify(deviceId = 0, deviceType = 0) {
    return concatBytes(
        Uint8Array.from([CMD.IDENTIFY, 0x12, 0x00, deviceId & 0xff, deviceType & 0xff]),
        ascii('MCU ISP & WCH.CN')
    );
}

/** 构建 ISP 结束命令 */
export function commandIspEnd(reason = 1) {
    return Uint8Array.from([CMD.ISP_END, 0x01, 0x00, reason & 0xff]);
}

/** 构建 ISP 密钥命令 */
export function commandIspKey(seed = 0x1e) {
    const key = typeof seed === 'number' ? new Uint8Array(seed) : seed;
    return concatBytes(Uint8Array.from([CMD.ISP_KEY, key.length & 0xff, 0x00]), key);
}

/** 构建擦除命令 */
export function commandErase(sectors) {
    return Uint8Array.from([CMD.ERASE, 0x04, 0x00, ...le32(sectors)]);
}

/** 构建读取配置命令 */
export function commandReadConfig(mask = CFG_MASK_ALL) {
    return Uint8Array.from([CMD.READ_CONFIG, 0x02, 0x00, mask & 0xff, 0x00]);
}

/** 构建写入配置命令 */
export function commandWriteConfig(mask, data) {
    const len = 1 + data.length;
    return concatBytes(Uint8Array.from([CMD.WRITE_CONFIG, ...le16(len), mask & 0xff, 0x00]), data);
}

/** 构建写入命令 */
export function commandProgram(address, data, padding = randomByte()) {
    return commandAddressData(CMD.PROGRAM, address, data, padding);
}

/** 构建校验命令 */
export function commandVerify(address, data, padding = randomByte()) {
    return commandAddressData(CMD.VERIFY, address, data, padding);
}

/** 构建数据写入命令 */
export function commandDataProgram(address, data, padding = randomByte()) {
    return commandAddressData(CMD.DATA_PROGRAM, address, data, padding);
}

/** 构建数据读取命令 */
export function commandDataRead(address, len) {
    return Uint8Array.from([CMD.DATA_READ, 0x06, 0x00, ...le32(address), ...le16(len)]);
}

/** 构建数据擦除命令 */
export function commandDataErase(sectors) {
    return Uint8Array.from([CMD.DATA_ERASE, 0x05, 0x00, 0, 0, 0, 0, sectors & 0xff]);
}

/** 构建设置波特率命令 */
export function commandSetBaud(baudrate) {
    return Uint8Array.from([CMD.SET_BAUD, 0x04, 0x00, ...le32(baudrate)]);
}

/** 解析原始响应 */
export function parseResponse(raw) {
    requireLength(raw, 4, 'response header');
    const command = raw[0];
    const status = raw[1];
    const len = readLe16(raw, 2);
    const payload = raw.slice(4);
    if (payload.length !== len) {
        throw new Error(`Invalid response length: expected ${len}, got ${payload.length}`);
    }
    const ok = status === 0x00 || status === 0x82;
    return ok
        ? { ok: true, command, status, payload, raw }
        : { ok: false, command, status, code: status, payload, raw };
}

/** 构建串口请求帧（Web Serial 传输层使用） */
export function frameSerialRequest(raw) {
    return concatBytes(Uint8Array.from([0x57, 0xab]), raw, Uint8Array.from([checksum8(raw)]));
}

/** 解析串口响应帧 */
export function parseSerialResponse(frame) {
    requireLength(frame, 7, 'serial response');
    if (frame[0] !== 0x55 || frame[1] !== 0xaa) {
        throw new Error(`Response has invalid serial header ${hex(frame.slice(0, 2))}`);
    }
    const raw = frame.slice(2, frame.length - 1);
    const expected = checksum8(raw);
    const actual = frame[frame.length - 1];
    if (expected !== actual) {
        throw new Error(`Response has incorrect checksum ${hexByte(actual)} != ${hexByte(expected)}`);
    }
    const len = readLe16(raw, 2);
    if (raw.length !== 4 + len) {
        throw new Error(`Invalid serial payload length: expected ${4 + len}, got ${raw.length}`);
    }
    return raw;
}

/** XOR 加密 */
export function xorWithKey(raw, key) {
    if (key.length !== 8) throw new Error(`XOR key must be 8 bytes, got ${key.length}`);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw[i] ^ key[i % 8];
    return out;
}

/** 生成 XOR 密钥（基于芯片 UID 和芯片 ID） */
export function makeXorKey(chipUid, chipId) {
    const sum = checksum8(chipUid);
    const key = new Uint8Array(8).fill(sum);
    key[7] = (key[7] + (chipId & 0xff)) & 0xff;
    return key;
}

/** 8 位校验和 */
export function checksum8(data) {
    let sum = 0;
    for (const b of data) sum = (sum + b) & 0xff;
    return sum;
}

/** ISP 密钥校验和 */
export function ispKeyChecksum(chipUid, chipId) {
    return checksum8(makeXorKey(chipUid, chipId));
}

/** 填充到扇区边界 */
export function padToSector(input, fill = 0x00) {
    const rem = input.length % SECTOR_SIZE;
    if (rem === 0) return input;
    const out = new Uint8Array(input.length + SECTOR_SIZE - rem);
    out.fill(fill & 0xff);
    out.set(input);
    return out;
}

/** 拼接字节数组 */
export function concatBytes(...chunks) {
    const len = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.length;
    }
    return out;
}

/** 字节数组转十六进制字符串 */
export function hex(data) {
    return Array.from(data, hexByte).join('');
}

/** 字节转十六进制字符串 */
export function hexByte(n) {
    return (n & 0xff).toString(16).padStart(2, '0');
}

/** 构建 地址+数据 命令 */
function commandAddressData(command, address, data, padding) {
    const len = 4 + 1 + data.length;
    return concatBytes(
        Uint8Array.from([command & 0xff, ...le16(len), ...le32(address), padding & 0xff]),
        data
    );
}

/** 字符串转 ASCII 字节数组 */
function ascii(text) {
    return Uint8Array.from(Array.from(text, c => c.charCodeAt(0) & 0xff));
}

/** 生成随机字节（XOR 填充用） */
function randomByte() {
    const a = new Uint8Array(1);
    if (globalThis.crypto?.getRandomValues) {
        globalThis.crypto.getRandomValues(a);
    } else {
        a[0] = Math.floor(Math.random() * 256);
    }
    return a[0];
}

function requireLength(buf, min, what) {
    if (buf.length < min) throw new Error(`Short ${what}: expected at least ${min}, got ${buf.length}`);
}

function assertUint(n, max, what) {
    if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`Expected ${what}, got ${n}`);
}
