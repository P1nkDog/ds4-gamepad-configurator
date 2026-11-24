/**
 * button_icons.js - 按键图标映射与 DOM 渲染辅助
 *
 * 18 枚透明底粉色 PNG（images/buttons/*.png，255×255 RGBA，主色 #ff6b9d）
 * 两套位序都要用到：
 *   - 物理键位（固件 INPUT_MASK_*，bit0~25）→ 见 PHYSICAL_BIT_ICON
 *   - DS4 逻辑位（固件 Ds4LogicalButton，bit1~18）→ 见 LOGICAL_BIT_ICON
 * 注意位序陷阱：物理 bit4~7 是 X/A/B/Y，逻辑 bit5~8 是 A/B/Y/X，两者不同序，
 * 因此两张表分别手写，不做偏移推导（与 button_map.js 的说明保持一致）。
 *
 * 着色规则（CSS 侧 .ds-btn-icon 实现，本模块只负责加类）：
 *   常态 = 原图粉色；选中态 = 浅色主题纯黑 / 深色主题纯白。
 */

/** 图标文件名（不含扩展名），顺序即 18 枚图标的规范次序 */
export const BUTTON_ICON_KEYS = [
    'up', 'right', 'down', 'left',
    'triangle', 'circle', 'cross', 'square',
    'l1', 'r1', 'l2', 'r2', 'l3', 'r3',
    'ps', 'share', 'options', 'touchpad',
];

/** 图标所在目录（相对站点根，与 index.html 同级） */
export const BUTTON_ICON_DIR = 'images/buttons';

/**
 * 说明：这 18 枚图标的图形本身就把按键名画在圆环里（L1 圆环内是「L1」，SHARE 圆环内是「SHARE」），
 * 因此标签**不再叠加文字**——叠一层就成了「Ⓛ1 L1」，属于重复表达。
 * 完整名称统一走元素的 title 提示；BTN1~BTN8 这类没有图标的键才回退成纯文字。
 */

/** 物理键 bit0~25 → 图标 key（18~25 是 BTN1~BTN8 扩展键，无对应图标，留 null） */
export const PHYSICAL_BIT_ICON = [
    'up', 'right', 'down', 'left',
    'square', 'cross', 'circle', 'triangle',
    'l1', 'r1', 'l2', 'r2', 'l3', 'r3',
    'ps', 'share', 'options', 'touchpad',
    null, null, null, null, null, null, null, null,
];

/** DS4 逻辑位 bit1~18 → 图标 key（下标即 bit 号，bit0 为「无」占位 null） */
export const LOGICAL_BIT_ICON = [
    null,
    'up', 'right', 'down', 'left',
    'cross', 'circle', 'triangle', 'square',
    'l1', 'r1', 'l2', 'r2', 'l3', 'r3',
    'ps', 'share', 'options', 'touchpad',
];

/** 取图标 URL；key 非法时返回 null */
export function buttonIconUrl(key) {
    if (!key || BUTTON_ICON_KEYS.indexOf(key) < 0) return null;
    return `${BUTTON_ICON_DIR}/${key}.png`;
}

/** 该图标是否需要搭配文字标签（图标自带按键名，恒为 false；保留导出以兼容调用方） */
export function iconText() {
    return '';
}

/**
 * 创建一个图标 <img>。
 * @param {string} key - 图标 key
 * @param {{size?:number, className?:string, selected?:boolean}} [opt]
 * @returns {HTMLImageElement|null}
 */
export function iconImg(key, opt) {
    const url = buttonIconUrl(key);
    if (!url) return null;
    const o = opt || {};
    const img = document.createElement('img');
    img.className = 'ds-btn-icon' + (o.className ? ' ' + o.className : '');
    img.src = url;
    img.alt = '';
    img.width = o.size || 18;
    img.height = o.size || 18;
    img.decoding = 'async';
    img.draggable = false;
    if (o.selected) img.classList.add('is-selected');
    return img;
}

/**
 * 创建「图标」或（无图标时）「文字」的标签块。
 * 26 路物理键里的 BTN1~BTN8 没有对应图标，靠 fallbackText 兜底，保证不漏显示。
 * @param {string|null} key
 * @param {string} [fallbackText] - 无图标时显示的文字
 * @param {{size?:number}} [opt]
 * @returns {HTMLSpanElement}
 */
export function iconTag(key, fallbackText, opt) {
    const o = opt || {};
    const tag = document.createElement('span');
    tag.className = 'ds-btn-tag';

    const img = iconImg(key, { size: o.size || 18 });
    if (img) {
        tag.appendChild(img);
        tag.classList.add('has-icon');
        // 图标是装饰性的，可读名称由外层元素的 title / 文本承担，避免读屏重复播报
        if (fallbackText) tag.title = fallbackText;
    } else {
        const span = document.createElement('span');
        span.className = 'ds-btn-tag-text';
        span.textContent = fallbackText || '';
        tag.appendChild(span);
    }
    return tag;
}

/**
 * 把位掩码渲染成一串图标标签，直接写进目标容器（替换原有文字摘要）。
 * @param {HTMLElement} el - 目标容器
 * @param {'physical'|'logical'} kind - 位序种类
 * @param {number} mask - 32 位掩码
 * @param {string} emptyText - 掩码为 0 时的文字（如「无（禁用）」/「未绑定」）
 * @param {(bit:number)=>string} [labelOf] - 无图标时的回退文字
 * @param {{max?:number}} [opt] - max 限制最多渲染几枚，超出折叠成「+N」
 */
export function fillMaskTags(el, kind, mask, emptyText, labelOf, opt) {
    if (!el) return;
    el.textContent = '';
    const table = kind === 'physical' ? PHYSICAL_BIT_ICON : LOGICAL_BIT_ICON;
    const m = Number(mask) >>> 0;
    const max = (opt && Number(opt.max) > 0) ? Number(opt.max) : 0;

    let count = 0;
    let total = 0;
    for (let bit = 0; bit < table.length; bit++) {
        if (!((m >>> bit) & 1)) continue;
        total++;
        if (max && count >= max) continue;      // 超出的只计数，不渲染
        const key = table[bit];
        const fallback = labelOf ? labelOf(bit) : `bit${bit}`;
        el.appendChild(iconTag(key, fallback));
        count++;
    }

    if (total === 0) {
        const span = document.createElement('span');
        span.className = 'ds-btn-tag is-empty';
        span.textContent = emptyText || '无';
        el.appendChild(span);
    } else if (total > count) {
        const more = document.createElement('span');
        more.className = 'ds-btn-tag ds-btn-more';
        more.textContent = `+${total - count}`;
        el.appendChild(more);
    }
}

/** 取物理键图标 key（越界返回 null） */
export function physicalIconKey(bit) {
    return PHYSICAL_BIT_ICON[bit] || null;
}

/** 取逻辑位图标 key（越界返回 null） */
export function logicalIconKey(bit) {
    return LOGICAL_BIT_ICON[bit] || null;
}
