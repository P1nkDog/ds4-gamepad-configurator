/**
 * flasher.js - WCH ISP 固件烧录器
 * 移植自 wchisp-web/src/flasher.ts
 *
 * 烧录流程：识别芯片 → (解除保护) → 擦除 → ISP密钥 → 写入 → 校验 → 重置
 */

import {
    CFG_MASK_ALL,
    CFG_MASK_RDPR_USER_DATA_WPR,
    CODE_CHUNK_SIZE,
    SECTOR_SIZE,
    CMD,
    commandErase,
    commandIdentify,
    commandIspEnd,
    commandIspKey,
    commandProgram,
    commandReadConfig,
    commandVerify,
    commandWriteConfig,
    hex,
    ispKeyChecksum,
    makeXorKey,
    padToSector,
    xorWithKey,
} from './protocol.js';
import { assertOk, transfer } from './transport.js';
import { ChipDatabase, chipDisplayName, minEraseSectorNumber } from './device.js';
import { readFirmwareFile, parseFirmware } from './format.js';

export class WchIspFlasher {
    /**
     * @param {Object} transport - WebUsbTransport 或 WebSerialTransport
     */
    constructor(transport, chipDb = new ChipDatabase()) {
        this.transport = transport;
        this.chipDb = chipDb;
        this.info = null;
        this.onProgress = null;   // 进度回调：onProgress({phase, done, total, address, message})
        this.onLog = null;        // 日志回调：onLog(message, isError)
    }

    /**
     * 连接并识别芯片
     * @returns {Promise<object>} 芯片信息
     */
    async connect() {
        this.log('识别芯片...');
        const ident = await transfer(this.transport, commandIdentify());
        assertOk(ident, 'identify');
        if (ident.payload.length < 2) {
            throw new Error(`identify response too short: ${hex(ident.payload)}`);
        }

        const chipId = ident.payload[0];
        const deviceType = ident.payload[1];
        const chip = this.chipDb.find(chipId, deviceType);
        this.log(`芯片 ID: 0x${chipId.toString(16).padStart(2, '0')}, 设备类型: 0x${deviceType.toString(16).padStart(2, '0')}`);

        const config = await this.readConfig(CFG_MASK_ALL);
        const codeFlashProtected = Boolean(config.length >= 3 && config[2] !== 0xa5);
        const bootloader = config.slice(14, 18);
        const uid = config.slice(18);

        this.info = {
            chipId,
            deviceType,
            chip,
            name: chipDisplayName(chip, chipId, deviceType),
            uid,
            bootloader,
            configRaw: config,
            codeFlashProtected,
        };

        this.log(`连接成功: ${this.info.name}`);
        this.log(`UID: ${hex(uid)}`);
        this.log(`代码 Flash 保护: ${codeFlashProtected ? '是' : '否'}`);
        return this.info;
    }

    /**
     * 读取配置
     */
    async readConfig(mask = CFG_MASK_ALL) {
        const resp = await transfer(this.transport, commandReadConfig(mask));
        assertOk(resp, 'read_config');
        return resp.payload;
    }

    /**
     * 写入配置
     */
    async writeConfig(mask, data) {
        const resp = await transfer(this.transport, commandWriteConfig(mask, data));
        assertOk(resp, 'write_config');
    }

    /**
     * 解除代码保护
     */
    async unprotect(force = false) {
        const info = await this.ensureConnected();
        if (!force && !info.codeFlashProtected) return;
        this.log('解除代码保护...');

        const resp = await transfer(this.transport, commandReadConfig(CFG_MASK_RDPR_USER_DATA_WPR));
        assertOk(resp, 'read_config');
        if (resp.payload.length < 14) throw new Error('read_config response too short for protection registers');

        const config = resp.payload.slice(2, 14);
        config[0] = 0xa5;
        config[1] = 0x5a;
        config.set([0xff, 0xff, 0xff, 0xff], 8);
        await this.writeConfig(CFG_MASK_RDPR_USER_DATA_WPR, config);
        await this.reset(1);
    }

    /**
     * 重置芯片
     * 注意：设备收到 ISP_END 后会立即重启，USB 随之断开，导致读响应报
     * "transfer error"——这是预期行为（设备正在重启），不算失败。
     */
    async reset(reason = 1) {
        this.log('重置设备...');
        try {
            const resp = await transfer(this.transport, commandIspEnd(reason), 1000);
            assertOk(resp, 'isp_end');
        } catch (err) {
            // 设备已重启、USB 断开，读不到响应属正常现象
            this.log('设备已重启（USB 断开，读不到 ISP_END 响应，属正常）');
        }
    }

    /**
     * 擦除代码 Flash
     * @returns {Promise<number>} 擦除的扇区数
     */
    async eraseCode(bytesOrSectors, unit = 'bytes') {
        const info = await this.ensureConnected();
        let sectors = unit === 'sectors'
            ? bytesOrSectors
            : Math.ceil(bytesOrSectors / SECTOR_SIZE);
        sectors = Math.max(minEraseSectorNumber(info.chip, info.deviceType), sectors);

        this.log(`擦除 ${sectors} 个扇区...`);
        this.emitProgress({ phase: 'erase', done: 0, total: sectors * SECTOR_SIZE, message: 'Erasing' });
        const resp = await transfer(this.transport, commandErase(sectors), 5000);
        assertOk(resp, 'erase');
        this.emitProgress({ phase: 'erase', done: sectors * SECTOR_SIZE, total: sectors * SECTOR_SIZE });
        return sectors;
    }

    /**
     * 完整烧录流程
     * @param {File|Uint8Array} input - 固件文件或数据
     * @param {{erase?:boolean, verify?:boolean, reset?:boolean, unprotect?:boolean, pad?:boolean}} options
     */
    async flash(input, options = {}) {
        const info = await this.ensureConnected();
        if (options.unprotect) await this.unprotect(false);

        const image = await this.normalizeFirmware(input);
        const baseAddress = image.baseAddress ?? 0;
        if (baseAddress !== 0) {
            throw new Error(`仅支持从地址 0 开始的固件，当前固件基地址为 0x${baseAddress.toString(16)}`);
        }

        const data = options.pad === false ? image.data : padToSector(image.data);

        if (options.erase !== false) {
            await this.eraseCode(data.length, 'bytes');
        }

        await this.beginIspKey();
        this.log('写入固件...');
        await this.writeCode(data);
        this.log(`写入完成: ${data.length} 字节`);

        if (options.verify !== false) {
            await this.beginIspKey();
            this.log('校验数据...');
            await this.verifyCode(data);
        }

        if (options.reset !== false) {
            await this.reset(1);
        }

        this.log(`烧录完成: ${info.name}`);
        return info;
    }

    /**
     * 分块写入代码
     */
    async writeCode(data) {
        const key = this.xorKey();
        let address = 0;

        for (let off = 0; off < data.length; off += CODE_CHUNK_SIZE) {
            const chunk = data.slice(off, off + CODE_CHUNK_SIZE);
            const xored = xorWithKey(chunk, key);
            try {
                const resp = await transfer(this.transport, commandProgram(address, xored), 300);
                assertOk(resp, `program 0x${address.toString(16)}`);
            } catch (err) {
                throw new Error(`写入失败 @0x${address.toString(16)}: ${err.message}`);
            }
            address += chunk.length;
            this.emitProgress({ phase: 'write', done: address, total: data.length, address });
        }

        const finalResp = await transfer(this.transport, commandProgram(address, new Uint8Array()), 300);
        assertOk(finalResp, `program final 0x${address.toString(16)}`);
    }

    /**
     * 分块校验代码
     */
    async verifyCode(data) {
        const key = this.xorKey();
        let address = 0;

        for (let off = 0; off < data.length; off += CODE_CHUNK_SIZE) {
            const chunk = data.slice(off, off + CODE_CHUNK_SIZE);
            const xored = xorWithKey(chunk, key);
            try {
                const resp = await transfer(this.transport, commandVerify(address, xored));
                assertOk(resp, 'verify response');
                if (resp.payload[0] !== 0x00) {
                    throw new Error(`Verify failed at 0x${address.toString(16)}`);
                }
            } catch (err) {
                throw new Error(`校验失败 @0x${address.toString(16)}: ${err.message}`);
            }
            address += chunk.length;
            this.emitProgress({ phase: 'verify', done: address, total: data.length, address });
        }
    }

    /**
     * 关闭传输层
     */
    async close() {
        await this.transport.close?.();
        this.info = null;
    }

    /**
     * 开始 ISP 密钥（建立加密通道）
     */
    async beginIspKey(checkChecksum = true) {
        const info = await this.ensureConnected();
        const resp = await transfer(this.transport, commandIspKey(new Uint8Array(0x1e)));
        assertOk(resp, 'isp_key');
        if (checkChecksum) {
            const expected = ispKeyChecksum(info.uid, info.chipId);
            if (resp.payload[0] !== expected) {
                throw new Error(`isp_key checksum failed: expected 0x${expected.toString(16)}, got 0x${(resp.payload[0] ?? 0).toString(16)}`);
            }
        }
    }

    /**
     * 生成 XOR 密钥
     */
    xorKey() {
        const info = this.ensureConnectedSync();
        return makeXorKey(info.uid, info.chipId);
    }

    ensureConnectedSync() {
        if (!this.info) throw new Error('未连接设备');
        return this.info;
    }

    async ensureConnected() {
        return this.info ?? this.connect();
    }

    async normalizeFirmware(input) {
        if (typeof File !== 'undefined' && input instanceof File) {
            return readFirmwareFile(input);
        }
        if (typeof input === 'object' && input !== null && 'data' in input && 'segments' in input) {
            return input;
        }
        // 裸字节（Uint8Array）或字符串按二进制固件处理
        return parseFirmware(input);
    }

    /**
     * 输出日志
     */
    log(message, isError = false) {
        if (this.onLog) this.onLog(message, isError);
        if (isError) {
            console.error(`[Flasher] ${message}`);
        } else {
            console.log(`[Flasher] ${message}`);
        }
    }

    /**
     * 输出进度
     */
    emitProgress(event) {
        if (this.onProgress) this.onProgress(event);
    }
}

export { CMD };
