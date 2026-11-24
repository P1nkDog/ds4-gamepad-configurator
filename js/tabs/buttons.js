/**
 * buttons.js - 按键 Tab（26 键组合键重映射 + 按键消抖时间）
 *
 * 两块可写配置：
 *   - 按键映射（组 4 button_map，104 字节 = 26 × uint32 位掩码）：
 *     表格每行只显示一行「当前映射摘要」，点击摘要按钮弹出居中多选面板，
 *     可勾选 0 个（禁用）、1 个、或多个 DS4 逻辑功能（单键触发组合键）；
 *   - 按键消抖（组 2 gamepad_settings 的第 6 字节 debounce_ms，0~50ms）。
 * 两块分别 markDirty(4) / markDirty(2)，互不覆盖。
 */

import {
    PHYSICAL_BUTTONS,
    DS4_LOGICAL_BUTTONS,
    DEFAULT_BUTTON_MASKS,
    DS4_LOGICAL_MASK_ALL,
    ds4BtnBit,
    formatButtonMask,
} from './button_map.js';
import {
    physicalIconKey,
    logicalIconKey,
    iconImg,
    iconTag,
    fillMaskTags,
} from '../utils/button_icons.js';

// 配置组与消抖边界（与固件 Config/config.h 严格一致）
const GROUP_GAMEPAD_SETTINGS = 2;
const GROUP_BUTTON_MAP = 4;
const DEBOUNCE_MAX_MS = 50;
const DEBOUNCE_DEFAULT_MS = 4;

// 标签芯片样式改由全局 CSS 的 .ds-pick / .ds-pick.is-selected 承担，
// 选中态需要联动图标着色（浅色变黑 / 深色变白），内联样式做不到，故不在 JS 里写死。

// 弹窗内按逻辑分组展示 18 个功能位（bit 序号与固件 Ds4LogicalButton 一致）
const PICKER_GROUPS = [
    { title: '方向键', bits: [1, 2, 3, 4] },
    { title: '动作键', bits: [5, 6, 7, 8] },
    { title: '肩键与扳机', bits: [9, 10, 11, 12] },
    { title: '摇杆与系统键', bits: [13, 14, 15, 16, 17, 18] },
];

// 遮罩与弹窗卡片样式统一交给全局 CSS 的 .combo-picker-overlay / .combo-picker-card
// （磨砂遮罩、圆角、微阴影随主题走；层级 z-index:900 高于 .dialog-overlay(100) 与 .boot-error(300)）

/**
 * 渲染按键 Tab
 * @param {HTMLElement} container
 * @param {Object} model - 配置模型（共享 config.js 的 model 实例）
 * @param {Object} ctx - { markDirty(groupId) }
 */
export function renderButtonsTab(container, model, ctx) {
    container.innerHTML = '';

    // 顶部提示
    const banner = document.createElement('div');
    banner.className = 'notice-banner';
    banner.innerHTML = '支持 <b>26 路物理按键</b>（含 BTN1 ~ BTN8 扩展键）动态重映射：'
        + '点击表格里的<b>映射框</b>弹出多选面板，可勾选 <b>1 个或多个</b> DS4 逻辑功能——'
        + '勾多个即"按一下同时触发多个键"（组合键），全部取消即为<b>禁用</b>。'
        + '修改后请点击底边栏 <b>[保存]</b> 写入固件。'
        + '注意：上电按住 <b>Share</b> 进入配置模式走的是物理电平，<b>不受映射影响</b>。';
    container.appendChild(banner);

    // 按键消抖时间设置（组 2）
    container.appendChild(renderDebounceCard(model, ctx));

    // 26 键组合键映射表格（组 4）
    container.appendChild(renderMappingCard(model, ctx));
}

//--------------------------------------------------------------------+
// 26 键组合键映射卡片（组 4 button_map，104 字节位掩码）
//   每行单行展示：物理键名 + 「当前映射」按钮（点击弹窗编辑）；界面不再平铺 18 枚芯片。
//--------------------------------------------------------------------+
function renderMappingCard(model, ctx) {
    // 初始化容错：字段缺失/长度不对时回落到出厂映射
    if (!Array.isArray(model.buttonMap) || model.buttonMap.length !== PHYSICAL_BUTTONS.length) {
        model.buttonMap = [...DEFAULT_BUTTON_MASKS];
    }

    const markDirty = (ctx && typeof ctx.markDirty === 'function')
        ? ctx.markDirty
        : () => {};

    const card = document.createElement('div');
    card.className = 'section-card';

    // 标题行：左标题 + 右 [恢复默认映射]
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;';

    const title = document.createElement('h3');
    title.textContent = '按键映射（26 路 · 点击编辑）';
    title.style.cssText = 'margin:0;';
    head.appendChild(title);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn';
    resetBtn.textContent = '恢复默认映射';
    head.appendChild(resetBtn);
    card.appendChild(head);

    const hint = document.createElement('p');
    hint.className = 'placeholder-text';
    hint.textContent = '点击映射框可弹出多选面板，支持单键触发单个或多个 DS4 按键同时按下（组合键），'
        + '全部取消即为「无（禁用）」。边框高亮表示该行已被自定义（与出厂默认不同）。'
        + '修改后请点击底边栏 [保存] 写入固件（写的是组 4 的 104 字节位掩码）。';
    card.appendChild(hint);

    const table = document.createElement('table');
    table.className = 'mapping-table';

    const thead = document.createElement('thead');
    thead.innerHTML = `
        <tr>
            <th>物理按键 / 引脚</th>
            <th>映射功能（点击编辑）</th>
            <th>出厂默认</th>
        </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const refreshers = [];

    PHYSICAL_BUTTONS.forEach((item, index) => {
        const tr = document.createElement('tr');

        // ---- 第 1 列：图标 + 名称 + bit/引脚（摘要移到第 2 列，这里不再重复） ----
        const tdName = document.createElement('td');
        const nameBox = document.createElement('span');
        nameBox.className = 'ds-row-name';

        const rowIcon = iconImg(physicalIconKey(item.bit), { size: 22 });
        if (rowIcon) {
            rowIcon.classList.add('ds-row-icon');
            rowIcon.title = item.name;
            nameBox.appendChild(rowIcon);
        }

        const textBox = document.createElement('span');
        textBox.className = 'ds-row-text';

        const nameEl = document.createElement('span');
        nameEl.className = 'ds-row-title';
        nameEl.textContent = item.name;

        const pinEl = document.createElement('span');
        pinEl.className = 'ds-row-meta';
        pinEl.textContent = `bit${item.bit} · ${item.pin}`;

        textBox.appendChild(nameEl);
        textBox.appendChild(pinEl);
        nameBox.appendChild(textBox);
        tdName.appendChild(nameBox);
        tr.appendChild(tdName);

        // ---- 第 2 列：单行紧凑触发按钮（左：当前映射图标组，右：▾ 指示符） ----
        const tdTrigger = document.createElement('td');
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'ds-map-trigger';
        trigger.dataset.index = String(index);

        const triggerLabel = document.createElement('span');
        triggerLabel.className = 'ds-btn-tags';

        const triggerArrow = document.createElement('span');
        triggerArrow.className = 'ds-map-arrow';
        triggerArrow.textContent = '▾';

        trigger.appendChild(triggerLabel);
        trigger.appendChild(triggerArrow);
        trigger.addEventListener('click', () => openComboPickerModal(index, model, markDirty, refresh));
        tdTrigger.appendChild(trigger);
        tr.appendChild(tdTrigger);

        // ---- 第 3 列：出厂默认摘要 ----
        const tdDefault = document.createElement('td');
        tdDefault.textContent = formatButtonMask(DEFAULT_BUTTON_MASKS[index]);
        tdDefault.style.cssText = 'font-size:13px;color:var(--text-secondary);white-space:nowrap;';
        tr.appendChild(tdDefault);

        // 刷新本行触发按钮：图标组 / 禁用配色 / 自定义边框高亮
        function refresh() {
            const m = (Number(model.buttonMap[index]) & DS4_LOGICAL_MASK_ALL) >>> 0;
            const def = (Number(DEFAULT_BUTTON_MASKS[index]) & DS4_LOGICAL_MASK_ALL) >>> 0;
            const disabled = (m === 0);
            const custom = (m !== def);

            fillMaskTags(triggerLabel, 'logical', m, '无（禁用）', (bit) => {
                const fb = DS4_LOGICAL_BUTTONS.find((x) => x.bit === bit);
                return fb ? fb.short : `bit${bit}`;
            });
            trigger.dataset.mask = String(m);
            trigger.title = `点击编辑：${formatButtonMask(m)}`;
            trigger.classList.toggle('is-custom', custom);
            trigger.classList.toggle('is-disabled', disabled);
        }
        refresh();
        refreshers.push(refresh);

        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    card.appendChild(table);

    // 恢复默认映射：复位 model 与全部 26 行（只标脏，不直接写 Flash）
    resetBtn.addEventListener('click', () => {
        model.buttonMap = [...DEFAULT_BUTTON_MASKS];
        for (const fn of refreshers) fn();
        markDirty(GROUP_BUTTON_MAP);
    });

    return card;
}

//--------------------------------------------------------------------+
// 居中多选组合弹窗
//   芯片点击即时翻转对应 bit → 刷新弹窗芯片/预览条 + 表格该行按钮 + markDirty(4)
//   关闭：完成 / × / 点遮罩空白 / Esc（关闭时移除 keydown 监听）
//--------------------------------------------------------------------+
function openComboPickerModal(index, model, markDirty, onApply) {
    const phys = PHYSICAL_BUTTONS[index];
    const notify = (typeof onApply === 'function') ? onApply : () => {};

    const overlay = document.createElement('div');
    overlay.className = 'combo-picker-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const card = document.createElement('div');
    card.className = 'combo-picker-card';

    // ---- 头部：图标 + 标题 + 副标（bit/引脚） + 关闭 ----
    const head = document.createElement('div');
    head.className = 'combo-picker-head';

    const titleBox = document.createElement('div');
    titleBox.className = 'combo-picker-title-box';

    const titleRow = document.createElement('div');
    titleRow.className = 'combo-picker-title-row';

    const headIcon = iconImg(physicalIconKey(phys.bit), { size: 30 });
    if (headIcon) {
        headIcon.classList.add('ds-picker-icon');
        titleRow.appendChild(headIcon);
    }

    const title = document.createElement('h3');
    title.className = 'combo-picker-title';
    title.textContent = `配置按键映射 · ${phys.name}`;
    titleRow.appendChild(title);

    const sub = document.createElement('span');
    sub.className = 'combo-picker-sub';
    sub.textContent = `bit${phys.bit} · ${phys.pin}`;

    titleBox.appendChild(titleRow);
    titleBox.appendChild(sub);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'combo-picker-close';
    closeBtn.textContent = '×';
    closeBtn.title = '关闭（Esc）';

    head.appendChild(titleBox);
    head.appendChild(closeBtn);
    card.appendChild(head);

    // ---- 当前组合实时预览条 ----
    const preview = document.createElement('div');
    preview.className = 'combo-picker-preview';

    const previewLabel = document.createElement('span');
    previewLabel.className = 'combo-picker-preview-label';
    previewLabel.textContent = '当前触发：';

    const previewValue = document.createElement('span');
    previewValue.className = 'ds-btn-tags combo-picker-preview-value';

    preview.appendChild(previewLabel);
    preview.appendChild(previewValue);
    card.appendChild(preview);

    // ---- 4 个分组 × 18 枚芯片 ----
    const chips = [];
    for (const group of PICKER_GROUPS) {
        const section = document.createElement('div');
        section.className = 'combo-picker-group';

        const groupLabel = document.createElement('div');
        groupLabel.className = 'combo-picker-group-title';
        groupLabel.textContent = group.title;

        const wrap = document.createElement('div');
        wrap.className = 'combo-picker-chips';

        for (const bitNo of group.bits) {
            const fb = DS4_LOGICAL_BUTTONS.find((x) => x.bit === bitNo);
            if (!fb) continue;

            const bit = ds4BtnBit(fb.bit);
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ds-pick ds-pick-circle';
            chip.dataset.bit = String(fb.bit);
            chip.title = fb.label;
            chip.setAttribute('aria-pressed', 'false');
            chip._bit = bit;
            // 18 个逻辑位全部有图标 → 一律渲染成 44px 正圆按钮；
            // 图标本身就把键名画在环内，不再叠文字。
            chip.appendChild(iconTag(logicalIconKey(fb.bit), fb.short, { size: 50 }));
            chip.addEventListener('click', () => toggle(bit));
            chips.push(chip);
            wrap.appendChild(chip);
        }

        section.appendChild(groupLabel);
        section.appendChild(wrap);
        card.appendChild(section);
    }

    // ---- 底部操作栏 ----
    const footer = document.createElement('div');
    footer.className = 'combo-picker-footer';

    const leftGroup = document.createElement('div');
    leftGroup.className = 'combo-picker-footer-left';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn';
    clearBtn.textContent = '清空（禁用）';
    clearBtn.addEventListener('click', () => {
        model.buttonMap[index] = 0;
        refresh();
        markDirty(GROUP_BUTTON_MAP);
    });

    const resetOneBtn = document.createElement('button');
    resetOneBtn.type = 'button';
    resetOneBtn.className = 'btn';
    resetOneBtn.textContent = '恢复此键默认';
    resetOneBtn.addEventListener('click', () => {
        model.buttonMap[index] = DEFAULT_BUTTON_MASKS[index] >>> 0;
        refresh();
        markDirty(GROUP_BUTTON_MAP);
    });

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'btn-primary';
    doneBtn.textContent = '完成';
    doneBtn.addEventListener('click', () => close());

    leftGroup.appendChild(clearBtn);
    leftGroup.appendChild(resetOneBtn);
    footer.appendChild(leftGroup);
    footer.appendChild(doneBtn);
    card.appendChild(footer);

    overlay.appendChild(card);

    //------------------------------------------------------------------
    // 状态刷新与关闭
    //------------------------------------------------------------------
    function currentMask() {
        return (Number(model.buttonMap[index]) & DS4_LOGICAL_MASK_ALL) >>> 0;
    }

    function toggle(bit) {
        model.buttonMap[index] = ((currentMask() ^ bit) & DS4_LOGICAL_MASK_ALL) >>> 0;
        refresh();
        markDirty(GROUP_BUTTON_MAP);
    }

    function refresh() {
        const m = currentMask();
        for (const chip of chips) {
            const on = (m & chip._bit) !== 0;
            chip.classList.toggle('is-selected', on);
            chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        fillMaskTags(previewValue, 'logical', m, '无（禁用）', (bit) => {
            const fb = DS4_LOGICAL_BUTTONS.find((x) => x.bit === bit);
            return fb ? fb.short : `bit${bit}`;
        });
        notify();   // 同步表格该行的触发按钮（图标组 / 配色 / 边框）
        return m;
    }

    let closed = false;
    function close() {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKeydown);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    function onKeydown(ev) {
        if (ev.key === 'Escape' || ev.key === 'Esc') close();
    }

    closeBtn.addEventListener('click', () => close());
    overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay) close();   // 点遮罩空白关闭；点卡片内部不关
    });

    refresh();
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeydown);

    return close;
}

//--------------------------------------------------------------------+
// 按键消抖时间卡片（0~50ms，写 gamepad_settings 的第 6 字节）
//--------------------------------------------------------------------+
function renderDebounceCard(model, ctx) {
    // 初始化容错：model 未连接过 / 字段被置空时回落到出厂默认
    if (!Number.isFinite(model.debounceMs)) model.debounceMs = DEBOUNCE_DEFAULT_MS;

    const markDirty = (ctx && typeof ctx.markDirty === 'function')
        ? ctx.markDirty
        : () => {};

    const card = document.createElement('div');
    card.className = 'section-card';

    const title = document.createElement('h3');
    title.textContent = '按键消抖';
    card.appendChild(title);

    const row = document.createElement('div');
    row.className = 'config-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'config-label';
    labelEl.textContent = '消抖时间';
    row.appendChild(labelEl);

    const input = document.createElement('div');
    input.className = 'config-input';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(DEBOUNCE_MAX_MS);
    slider.step = '1';
    slider.value = String(model.debounceMs);

    const stepper = document.createElement('div');
    stepper.className = 'number-stepper';
    const num = document.createElement('input');
    num.type = 'number';
    num.min = '0';
    num.max = String(DEBOUNCE_MAX_MS);
    num.step = '1';
    num.value = String(model.debounceMs);
    stepper.appendChild(num);

    const rangeEl = document.createElement('span');
    rangeEl.className = 'config-range';
    rangeEl.textContent = `0-${DEBOUNCE_MAX_MS} ms（0 = 关闭消抖直通）`;

    // 0~50 整数钳位：越界值固件会判 INVALID_DATA，这里先在 UI 侧收口
    const clamp = (v) => Math.min(DEBOUNCE_MAX_MS, Math.max(0, Math.round(v)));
    const apply = (v) => {
        const raw = Number.isFinite(v) ? v : model.debounceMs;
        model.debounceMs = clamp(raw);
        slider.value = String(model.debounceMs);
        num.value = String(model.debounceMs);
        markDirty(GROUP_GAMEPAD_SETTINGS);
    };

    slider.addEventListener('input', () => apply(parseInt(slider.value, 10)));
    num.addEventListener('change', () => {
        if (num.value === '') { num.value = String(model.debounceMs); return; }
        // 用 Number() 而非 parseInt()：手输 "4.6" 时按四舍五入取 5，
        // 与 buildGamepadSettingsBytes() 的 Math.round 口径保持一致。
        const v = Number(num.value);
        apply(Number.isFinite(v) ? v : model.debounceMs);
    });

    input.appendChild(slider);
    input.appendChild(stepper);
    input.appendChild(rangeEl);
    row.appendChild(input);
    card.appendChild(row);

    const hint = document.createElement('p');
    hint.className = 'placeholder-text';
    hint.textContent = '修改后请点击底边栏 [保存] 写入固件。消抖为恒定毫秒窗口（与 250Hz~8kHz 回报率无关）；0 ms 表示关闭消抖，抖动将原样上报。';
    card.appendChild(hint);

    return card;
}
