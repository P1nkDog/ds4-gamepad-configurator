/**
 * webserial.js - WCH ISP Web Serial 传输层
 * 移植自 wchisp-web/src/webserial.ts
 * 在原始 ISP 命令上添加串口帧格式：
 *   请求帧：[0x57] [0xAB] [命令...] [校验和]
 *   响应帧：[0x55] [0xAA] [命令] [状态] [数据...] [校验和]
 */

import { frameSerialRequest, parseSerialResponse, readLe16 } from './protocol.js';

export class WebSerialTransport {
    constructor(port, options = {}) {
        this.port = port;
        this.baudRate = options.baudRate ?? 115200;
        this.dataBits = options.dataBits ?? 8;
        this.stopBits = options.stopBits ?? 1;
        this.parity = options.parity ?? 'none';
        this.bufferSize = options.bufferSize ?? 255;
        this.flowControl = options.flowControl ?? 'none';

        this.reader = null;
        this.writer = null;
        this.pending = new Uint8Array(0);
    }

    /**
     * 请求并打开串口
     */
    static async request(options = {}) {
        const serial = navigator.serial;
        if (!serial) throw new Error('此浏览器不支持 Web Serial API');
        const port = await serial.requestPort();
        return WebSerialTransport.openPort(port, options);
    }

    /**
     * 打开串口
     */
    static async openPort(port, options = {}) {
        const transport = new WebSerialTransport(port, options);
        await transport.open();
        return transport;
    }

    /**
     * 打开串口
     */
    async open() {
        await this.port.open({
            baudRate: this.baudRate,
            dataBits: this.dataBits,
            stopBits: this.stopBits,
            parity: this.parity,
            bufferSize: this.bufferSize,
            flowControl: this.flowControl,
        });
        if (!this.port.readable || !this.port.writable) {
            throw new Error('Serial port is not readable/writable');
        }
        this.reader = this.port.readable.getReader();
        this.writer = this.port.writable.getWriter();
    }

    /**
     * 发送原始数据（添加串口帧格式）
     */
    async sendRaw(raw) {
        if (!this.writer) throw new Error('Serial writer is not open');
        await this.writer.write(frameSerialRequest(raw));
    }

    /**
     * 接收原始数据（解析串口帧格式）
     */
    async recvRaw(timeoutMs = 1000) {
        await this.readUntil(6, timeoutMs);
        const start = this.findHeader();
        if (start < 0) throw new Error('Serial response header not found');
        if (start > 0) this.pending = this.pending.slice(start);

        await this.readUntil(6, timeoutMs);
        const len = readLe16(this.pending, 4);
        const frameLen = 2 + 4 + len + 1;
        await this.readUntil(frameLen, timeoutMs);

        const frame = this.pending.slice(0, frameLen);
        this.pending = this.pending.slice(frameLen);

        return parseSerialResponse(frame);
    }

    /**
     * 关闭串口
     */
    async close() {
        try { await this.reader?.cancel(); } catch (e) {}
        try { this.reader?.releaseLock(); } catch (e) {}
        try { this.writer?.releaseLock(); } catch (e) {}
        try { await this.port.close(); } catch (e) {}
    }

    /**
     * 读取直到缓冲区达到指定长度（带超时）
     */
    async readUntil(n, timeoutMs) {
        if (!this.reader) throw new Error('Serial reader is not open');
        const deadline = Date.now() + timeoutMs;

        while (this.pending.length < n) {
            const left = deadline - Date.now();
            if (left <= 0) {
                throw new Error(`Timed out waiting for serial response (${this.pending.length}/${n} bytes)`);
            }

            const result = await Promise.race([
                this.reader.read(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), left))
            ]);

            if (result.done) throw new Error('Serial stream closed');
            if (result.value?.length) {
                this.pending = concat(this.pending, result.value);
            }
        }
    }

    /**
     * 查找帧头 0x55 0xAA
     */
    findHeader() {
        for (let i = 0; i + 1 < this.pending.length; i++) {
            if (this.pending[i] === 0x55 && this.pending[i + 1] === 0xaa) {
                return i;
            }
        }
        return -1;
    }
}

function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}
