/**
 * msp.js - MSP v1 协议编解码
 * 参考 ds4_configurator/msp.js，命令码与固件 Driver/msp/msp_protocol.h 一致
 *
 * 帧格式：$ M < [size] [cmd] [data...] [crc]
 * 响应：  $ M > [size] [cmd] [data...] [crc]
 * 错误：  $ M ! [size] [cmd] [status] [crc]
 */

// 命令码（与固件 msp_protocol.h 保持一致）
export const MSP_CMD = {
    API_VERSION:    0x01,
    FC_VARIANT:     0x02,
    FC_VERSION:     0x03,
    REBOOT:         0x04,
    CONFIG_GET:     0x10,
    CONFIG_SET:     0x11,
    CONFIG_SAVE:    0x12,
    CONFIG_RESET:   0x13,
    CONFIG_STATUS:  0x14,
    JOYSTICK_RAW:   0x15,
    CALIB_START:    0x16,
    CALIB_SAMPLE:   0x17,
    CALIB_TRACK:    0x18,
    CALIB_END:      0x19,
    CALIB_CANCEL:   0x1A,
    // 配置模式下的实时输入快照（宏在线录制用）
    //   请求：空载荷 []；响应：固定 16 字节小端，不带状态码
    //   [0..3]u32 buttons  消抖后 26 路物理键位图（bit0~25）
    //   [4..5]u16 lx / [6..7]u16 ly / [8..9]u16 rx / [10..11]u16 ry（12-bit 映射输出）
    //   [12..15]u32 设备微秒时间戳（主机按无符号差值算间隔，回绕安全）
    INPUT_SNAPSHOT: 0x1B,
    // 多配置（全局硬件层 + 4 套独立配置）
    //   0x1C PROFILE_GET：空载荷；响应 131 字节
    //        [0]active_profile [1]profile_count [2]shortcut_enable [3..130]4 × 32B 名称
    //        注意：首字节是"当前激活配置号"，**不是状态码**（不要放进 MSP_STATUS_INDEX）
    //   0x1D PROFILE_SWITCH：请求 [idx]（0~3）；响应 [active_profile, status]
    PROFILE_GET:    0x1C,
    PROFILE_SWITCH: 0x1D,
};

// 状态码
export const MSP_STATUS = {
    OK:             0,
    ERROR:          1,
    INVALID_ID:     2,
    INVALID_DATA:   3,
    FLASH_ERROR:    4,
};

// 状态码名称
export const MSP_STATUS_NAME = {
    0: 'OK',
    1: 'ERROR',
    2: 'INVALID_ID',
    3: 'INVALID_DATA',
    4: 'FLASH_ERROR',
};

export class MspProtocol {
    constructor() {
        this.state = 'IDLE';
        this.rxSize = 0;
        this.rxCmd = 0;
        this.rxPayload = [];
        this.rxOffset = 0;
        this.rxCrc = 0;
        this.isError = false;

        // 待处理请求队列：{ cmd, resolve, timer }
        this.pending = [];
    }

    /**
     * 构建 MSP v1 请求帧
     * @param {number} cmd - 命令码
     * @param {number[]} data - 载荷数据
     * @returns {Uint8Array} 帧字节
     */
    buildFrame(cmd, data = []) {
        const size = data.length;
        let crc = 0;
        crc ^= size;
        crc ^= cmd;
        for (const byte of data) {
            crc ^= byte;
        }

        const frame = new Uint8Array(3 + 1 + 1 + data.length + 1);
        frame[0] = 0x24; // $
        frame[1] = 0x4D; // M
        frame[2] = 0x3C; // <
        frame[3] = size;
        frame[4] = cmd;
        for (let i = 0; i < data.length; i++) {
            frame[5 + i] = data[i];
        }
        frame[5 + data.length] = crc;
        return frame;
    }

    /**
     * 逐字节喂入接收状态机
     * @param {number} byte - 接收到的字节
     */
    processByte(byte) {
        switch (this.state) {
            case 'IDLE':
                if (byte === 0x24) { // $
                    this.state = 'HEADER_M';
                }
                break;

            case 'HEADER_M':
                if (byte === 0x4D) { // M
                    this.state = 'HEADER_DIR';
                } else {
                    this.state = 'IDLE';
                }
                break;

            case 'HEADER_DIR':
                if (byte === 0x3E || byte === 0x21) { // > or !
                    this.isError = (byte === 0x21);
                    this.state = 'SIZE';
                    this.rxCrc = 0;
                } else {
                    this.state = 'IDLE';
                }
                break;

            case 'SIZE':
                this.rxSize = byte;
                this.rxCrc ^= byte;
                this.rxOffset = 0;
                this.rxPayload = [];
                this.state = 'CMD';
                break;

            case 'CMD':
                this.rxCmd = byte;
                this.rxCrc ^= byte;
                if (this.rxSize > 0) {
                    this.state = 'PAYLOAD';
                } else {
                    this.state = 'CRC';
                }
                break;

            case 'PAYLOAD':
                this.rxPayload.push(byte);
                this.rxCrc ^= byte;
                this.rxOffset++;
                if (this.rxOffset >= this.rxSize) {
                    this.state = 'CRC';
                }
                break;

            case 'CRC':
                if (byte === this.rxCrc) {
                    this._handleResponse(this.rxCmd, this.rxPayload, this.isError);
                } else {
                    console.warn('MSP CRC 错误');
                }
                this.state = 'IDLE';
                break;

            default:
                this.state = 'IDLE';
                break;
        }
    }

    /**
     * 处理接收到的数据块
     * @param {Uint8Array} data
     */
    processData(data) {
        for (const byte of data) {
            this.processByte(byte);
        }
    }

    /**
     * 发送请求并等待响应（带命令匹配的请求队列）
     * @param {Object} serial - 串口对象（serial.js 中的 SerialPort）
     * @param {number} cmd - 命令码
     * @param {number[]} data - 载荷
     * @param {number} timeoutMs - 超时毫秒
     * @returns {Promise<{cmd, payload, isError}|null>} 超时返回 null
     */
    request(serial, cmd, data = [], timeoutMs = 2000) {
        return new Promise((resolve) => {
            const entry = { cmd, resolve, timer: null };
            this.pending.push(entry);

            // 超时清理
            entry.timer = setTimeout(() => {
                const idx = this.pending.indexOf(entry);
                if (idx >= 0) this.pending.splice(idx, 1);
                resolve(null);
            }, timeoutMs);

            const frame = this.buildFrame(cmd, data);
            serial.write(frame).then((ok) => {
                // 写入失败（例如串口已断开）时立即超时
                if (!ok && this.pending.includes(entry)) {
                    clearTimeout(entry.timer);
                    this.pending.splice(this.pending.indexOf(entry), 1);
                    resolve(null);
                }
            });
        });
    }

    /**
     * 收到完整响应帧：匹配并唤醒最早的同命令请求
     */
    _handleResponse(cmd, payload, isError) {
        const idx = this.pending.findIndex(e => e.cmd === cmd);
        if (idx >= 0) {
            const [entry] = this.pending.splice(idx, 1);
            clearTimeout(entry.timer);
            entry.resolve({ cmd, payload, isError });
        }
    }
}

// 导出单例
export const msp = new MspProtocol();
