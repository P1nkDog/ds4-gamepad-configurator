/**
 * format.js - 固件格式解析（.bin / .hex / .elf）
 * 移植自 wchisp-web/src/format.ts
 */

/**
 * 读取固件文件（根据扩展名自动选择解析方式）
 * @param {File} file
 * @returns {Promise<{data, baseAddress, format, segments}>}
 */
export async function readFirmwareFile(file) {
    const name = file.name.toLowerCase();
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (name.endsWith('.hex') || name.endsWith('.ihex')) {
        return parseIntelHex(new TextDecoder().decode(bytes));
    }
    if (name.endsWith('.elf') || looksLikeElf(bytes)) {
        return parseElf(bytes);
    }
    return { data: bytes, baseAddress: 0, format: 'bin', segments: [{ address: 0, data: bytes }] };
}

/**
 * 解析固件数据
 */
export function parseFirmware(input, filename = '') {
    const lower = filename.toLowerCase();
    if (typeof input === 'string' || lower.endsWith('.hex') || lower.endsWith('.ihex')) {
        return parseIntelHex(typeof input === 'string' ? input : new TextDecoder().decode(input));
    }
    if (lower.endsWith('.elf') || looksLikeElf(input)) {
        return parseElf(input);
    }
    return { data: input, baseAddress: 0, format: 'bin', segments: [{ address: 0, data: input }] };
}

/**
 * 解析 Intel HEX
 */
export function parseIntelHex(text) {
    let upperLinear = 0;
    let upperSegment = 0;
    const bytes = new Map();
    let startAddress = 0;

    for (const [lineNo, rawLine] of text.split(/\r?\n/).entries()) {
        const line = rawLine.trim();
        if (!line) continue;
        if (!line.startsWith(':')) throw new Error(`Intel HEX line ${lineNo + 1}: missing ':'`);

        const rec = hexBytes(line.slice(1));
        if (rec.length < 5) throw new Error(`Intel HEX line ${lineNo + 1}: short record`);

        const count = rec[0];
        if (rec.length !== count + 5) throw new Error(`Intel HEX line ${lineNo + 1}: length mismatch`);

        const sum = rec.reduce((a, b) => (a + b) & 0xff, 0);
        if (sum !== 0) throw new Error(`Intel HEX line ${lineNo + 1}: checksum mismatch`);

        const offset = (rec[1] << 8) | rec[2];
        const type = rec[3];
        const data = rec.slice(4, 4 + count);

        if (type === 0x00) {
            const base = (upperLinear + upperSegment + offset) >>> 0;
            for (let i = 0; i < data.length; i++) bytes.set(base + i, data[i]);
        } else if (type === 0x01) {
            break;
        } else if (type === 0x02) {
            upperSegment = (((data[0] << 8) | data[1]) << 4) >>> 0;
            upperLinear = 0;
        } else if (type === 0x04) {
            upperLinear = (((data[0] << 8) | data[1]) << 16) >>> 0;
            upperSegment = 0;
        } else if (type === 0x03 || type === 0x05) {
            startAddress = data.reduce((a, b) => ((a << 8) | b) >>> 0, 0);
        }
    }

    if (!bytes.size) {
        return { data: new Uint8Array(), baseAddress: startAddress, format: 'hex', segments: [] };
    }

    const addresses = [...bytes.keys()].sort((a, b) => a - b);
    const segments = [];
    let segStart = addresses[0];
    let prev = addresses[0] - 1;
    let cur = [];
    for (const addr of addresses) {
        if (addr !== prev + 1 && cur.length) {
            segments.push({ address: segStart, data: Uint8Array.from(cur) });
            segStart = addr;
            cur = [];
        }
        cur.push(bytes.get(addr));
        prev = addr;
    }
    if (cur.length) segments.push({ address: segStart, data: Uint8Array.from(cur) });

    return segmentsToImage(segments, 'hex');
}

/**
 * 解析 ELF
 */
export function parseElf(bytes) {
    if (!looksLikeElf(bytes)) throw new Error('Not an ELF file');
    const cls = bytes[4];
    const endian = bytes[5];
    if (endian !== 1) throw new Error('Only little-endian ELF files are supported');
    if (cls === 1) return parseElf32(bytes);
    if (cls === 2) return parseElf64(bytes);
    throw new Error(`Unsupported ELF class ${cls}`);
}

export function looksLikeElf(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
}

function parseElf32(b) {
    const phoff = u32(b, 28);
    const phentsize = u16(b, 42);
    const phnum = u16(b, 44);
    const segments = [];
    for (let i = 0; i < phnum; i++) {
        const off = phoff + i * phentsize;
        const type = u32(b, off);
        const pOffset = u32(b, off + 4);
        const pPaddr = u32(b, off + 12);
        const filesz = u32(b, off + 16);
        if (type === 1 && filesz > 0) segments.push({ address: pPaddr, data: b.slice(pOffset, pOffset + filesz) });
    }
    return segmentsToImage(segments, 'elf');
}

function parseElf64(b) {
    const phoff = Number(u64(b, 32));
    const phentsize = u16(b, 54);
    const phnum = u16(b, 56);
    const segments = [];
    for (let i = 0; i < phnum; i++) {
        const off = phoff + i * phentsize;
        const type = u32(b, off);
        const pOffset = Number(u64(b, off + 8));
        const pPaddr = Number(u64(b, off + 24));
        const filesz = Number(u64(b, off + 32));
        if (type === 1 && filesz > 0) segments.push({ address: pPaddr >>> 0, data: b.slice(pOffset, pOffset + filesz) });
    }
    return segmentsToImage(segments, 'elf');
}

function segmentsToImage(segments, format) {
    if (!segments.length) return { data: new Uint8Array(), baseAddress: 0, format, segments };
    const min = Math.min(...segments.map(s => s.address));
    const max = Math.max(...segments.map(s => s.address + s.data.length));
    const data = new Uint8Array(max - min);
    for (const s of segments) data.set(s.data, s.address - min);
    return { data, baseAddress: min, format, segments };
}

function hexBytes(s) {
    if (s.length % 2) throw new Error('Odd number of HEX digits');
    const out = [];
    for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
    if (out.some(Number.isNaN)) throw new Error('Invalid HEX digit');
    return out;
}

function u16(b, o) {
    return b[o] | (b[o + 1] << 8);
}

function u32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function u64(b, o) {
    return BigInt(u32(b, o)) | (BigInt(u32(b, o + 4)) << 32n);
}
