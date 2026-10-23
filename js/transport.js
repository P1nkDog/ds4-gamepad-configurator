/**
 * transport.js - 传输层通用方法
 * 移植自 wchisp-web/src/transport.ts
 */

import { parseResponse } from './protocol.js';

/**
 * 发送请求并接收响应
 * @param {Object} transport - 传输层（WebUsbTransport 或 WebSerialTransport）
 * @param {Uint8Array} request - 请求原始数据
 * @param {number} timeoutMs - 超时毫秒
 * @returns {Promise<{ok, command, status, payload, raw}>}
 */
export async function transfer(transport, request, timeoutMs = 1000) {
    await transport.sendRaw(request);
    await delay(0);
    const raw = await transport.recvRaw(timeoutMs);
    if (raw[0] !== request[0]) {
        throw new Error(`Response command type mismatch: requested 0x${request[0].toString(16)}, got 0x${raw[0]?.toString(16)}`);
    }
    return parseResponse(raw);
}

/**
 * 断言响应成功
 * @param {Object} response
 * @param {string} label
 */
export function assertOk(response, label) {
    if (!response.ok) {
        throw new Error(`${label} failed with status 0x${response.code.toString(16)}`);
    }
}

function delay(ms) {
    if (ms <= 0) return;
    return new Promise(resolve => setTimeout(resolve, ms));
}
