/**
 * serial.js - WebSerial 封装层
 * 参考 ds4_configurator/serial.js
 * 提供连接、断开、发送、接收功能（用于配置页面的 MSP 通信）
 */

export class SerialPort {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.connected = false;
        this.onData = null;  // 接收回调：onData(Uint8Array)
        this.onDisconnect = null;  // 物理断开回调
        this._onDisconnectEvent = null;
    }

    /**
     * 请求并打开串口
     * @param {number} baudRate
     * @returns {Promise<boolean>}
     */
    async open(baudRate = 115200) {
        try {
            if (!('serial' in navigator)) {
                throw new Error('此浏览器不支持 Web Serial API，请使用 Chrome 或 Edge 浏览器');
            }

            this.port = await navigator.serial.requestPort();
            await this.port.open({ baudRate });

            this.writer = this.port.writable.getWriter();
            this.connected = true;

            // 监听物理断开事件
            this._onDisconnectEvent = () => {
                console.log('USB 设备物理断开');
                this.connected = false;
                if (this.onDisconnect) this.onDisconnect();
            };
            navigator.serial.addEventListener('disconnect', this._onDisconnectEvent);

            this._startReading();
            return true;
        } catch (err) {
            console.error('串口打开失败:', err);
            this.port = null;
            this.writer = null;
            this.connected = false;
            throw err;
        }
    }

    /**
     * 关闭串口（带超时保护）
     */
    async close() {
        this.connected = false;

        // 取消读取器（带 500ms 超时）
        if (this.reader) {
            try {
                await Promise.race([
                    this.reader.cancel(),
                    new Promise(resolve => setTimeout(resolve, 500))
                ]);
            } catch (e) {}
            try {
                this.reader.releaseLock();
            } catch (e) {}
            this.reader = null;
        }

        // 释放写入器
        if (this.writer) {
            try {
                this.writer.releaseLock();
            } catch (e) {}
            this.writer = null;
        }

        // 关闭端口（带 500ms 超时）
        if (this.port) {
            try {
                await Promise.race([
                    this.port.close(),
                    new Promise(resolve => setTimeout(resolve, 500))
                ]);
            } catch (e) {}
            this.port = null;
        }

        // 移除断开事件监听
        if (this._onDisconnectEvent) {
            navigator.serial.removeEventListener('disconnect', this._onDisconnectEvent);
            this._onDisconnectEvent = null;
        }
    }

    /**
     * 发送数据
     * @param {Uint8Array} data
     * @returns {Promise<boolean>}
     */
    async write(data) {
        if (!this.connected || !this.writer) {
            console.error('串口未连接');
            return false;
        }
        try {
            await this.writer.write(data);
            return true;
        } catch (err) {
            console.error('发送失败:', err);
            return false;
        }
    }

    /**
     * 启动读取循环
     */
    async _startReading() {
        while (this.port && this.connected) {
            try {
                this.reader = this.port.readable.getReader();
                while (this.connected) {
                    const { value, done } = await this.reader.read();
                    if (done) break;
                    if (value && value.length > 0 && this.onData) {
                        this.onData(value);
                    }
                }
            } catch (err) {
                // USB 断开时会抛出 NetworkError，正常处理
                if (this.connected) {
                    console.warn('读取中断:', err.message);
                    this.connected = false;
                    if (this.onDisconnect) this.onDisconnect();
                }
            } finally {
                if (this.reader) {
                    try {
                        this.reader.releaseLock();
                    } catch (e) {}
                    this.reader = null;
                }
            }
        }
    }
}

// 导出单例
export const serial = new SerialPort();
