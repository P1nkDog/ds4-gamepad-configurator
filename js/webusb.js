/**
 * webusb.js - WebUSB 传输层
 * 移植自 wchisp-web/src/webusb.ts
 * 默认 VID: 0x4348 / 0x1a86，PID: 0x55e0（WCH ISP 设备）
 */

export class WebUsbTransport {
    static DEFAULT_VENDOR_IDS = [0x4348, 0x1a86];
    static DEFAULT_PRODUCT_ID = 0x55e0;
    static DEFAULT_ENDPOINT_OUT = 0x02;
    static DEFAULT_ENDPOINT_IN = 0x82;
    static DEFAULT_INTERFACE = 0;

    constructor(device, options = {}) {
        this.device = device;
        this.vendorIds = options.vendorIds || WebUsbTransport.DEFAULT_VENDOR_IDS;
        this.productId = options.productId || WebUsbTransport.DEFAULT_PRODUCT_ID;
        this.interfaceNumber = options.interfaceNumber ?? WebUsbTransport.DEFAULT_INTERFACE;
        this.configurationValue = options.configurationValue ?? 1;
        this.endpointOut = options.endpointOut ?? WebUsbTransport.DEFAULT_ENDPOINT_OUT;
        this.endpointIn = options.endpointIn ?? WebUsbTransport.DEFAULT_ENDPOINT_IN;
    }

    /**
     * 请求并打开 USB 设备
     */
    static async request(options = {}) {
        const usb = navigator.usb;
        if (!usb) throw new Error('此浏览器不支持 WebUSB API');

        const vendorIds = options.vendorIds || WebUsbTransport.DEFAULT_VENDOR_IDS;
        const productId = options.productId || WebUsbTransport.DEFAULT_PRODUCT_ID;

        const device = await usb.requestDevice({
            filters: vendorIds.map(vendorId => ({ vendorId, productId }))
        });

        return WebUsbTransport.openDevice(device, options);
    }

    /**
     * 打开已获取的设备
     */
    static async openDevice(device, options = {}) {
        const transport = new WebUsbTransport(device, options);
        await transport.open();
        return transport;
    }

    /**
     * 打开设备：选择配置、声明接口、检测端点
     */
    async open() {
        if (!this.device.opened) {
            await this.device.open();
        }
        if (!this.device.configuration || this.device.configuration.configurationValue !== this.configurationValue) {
            await this.device.selectConfiguration(this.configurationValue);
        }
        this._detectEndpoints();
        await this.device.claimInterface(this.interfaceNumber);
    }

    /**
     * 发送原始数据
     * 注意：WebUSB 的 transferOut 需要端点号（1-15），而非带方向位的地址（0x02/0x82）
     */
    async sendRaw(raw) {
        const result = await this.device.transferOut(this.endpointOut & 0x0f, raw);
        if (result.status !== 'ok') {
            throw new Error(`USB transferOut failed: ${result.status}`);
        }
    }

    /**
     * 接收原始数据（与原版 wchisp-web 一致：不带超时，一直等待设备响应）
     * 注意：WebUSB 的 transferIn 需要端点号（1-15），而非带方向位的地址
     */
    async recvRaw(_timeoutMs = 5000) {
        const result = await this.device.transferIn(this.endpointIn & 0x0f, 64);
        if (result.status !== 'ok') {
            throw new Error(`USB transferIn failed: ${result.status}`);
        }
        if (!result.data) {
            throw new Error('USB transferIn returned no data');
        }
        return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice();
    }

    /**
     * 关闭设备
     */
    async close() {
        try { await this.device.releaseInterface(this.interfaceNumber); } catch (e) {}
        try { await this.device.close(); } catch (e) {}
    }

    /**
     * 自动检测 endpoint（需求文档 v1.7：WebUSB endpoint 自动检测）。
     * 遍历当前配置接口的端点，优先用配置的默认值，否则取找到的第一个 OUT/IN 端点。
     */
    _detectEndpoints() {
        const iface = this.device.configuration?.interfaces?.find(
            i => i.interfaceNumber === this.interfaceNumber
        );
        if (!iface) return;

        let foundOut = null;
        let foundIn = null;
        for (const alt of iface.alternates || []) {
            for (const ep of alt.endpoints || []) {
                if (ep.direction === 'out' && foundOut === null) foundOut = ep.endpointNumber;
                if (ep.direction === 'in' && foundIn === null) foundIn = ep.endpointNumber;
            }
        }

        // 仅当配置的默认端点不存在时，才使用自动检测到的端点
        if (foundOut !== null && !this._hasEndpoint(iface, 'out', this.endpointOut)) {
            this.endpointOut = foundOut;
        }
        if (foundIn !== null && !this._hasEndpoint(iface, 'in', this.endpointIn)) {
            this.endpointIn = foundIn;
        }
    }

    _hasEndpoint(iface, direction, endpointNumber) {
        for (const alt of iface.alternates || []) {
            for (const ep of alt.endpoints || []) {
                if (ep.direction === direction && (ep.endpointNumber & 0x0f) === (endpointNumber & 0x0f)) {
                    return true;
                }
            }
        }
        return false;
    }
}
