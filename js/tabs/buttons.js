/**
 * buttons.js - 按键 Tab（26 键动态重映射 + 按键消抖时间）
 *
 * 两块可写配置：
 *   - 按键映射（组 4 button_map，26 字节）：每个物理键下拉选择 DS4 逻辑功能，
 *     支持多对一、支持「无（禁用）」、支持一键恢复出厂映射；
 *   - 按键消抖（组 2 gamepad_settings 的第 6 字节 debounce_ms，0~50ms）。
 * 两块分别 markDirty(4) / markDirty(2)，互不覆盖。
 */

import {
    PHYSICAL_BUTTONS,
    DS4_LOGICAL_BUTTONS,
    DEFAULT_BUTTON_MAP,
    logicalButtonLabel,
} from './button_map.js';

// 配置组与消抖边界（与固件 Config/config.h 严格一致）
const GROUP_GAMEPAD_SETTINGS = 2;
const GROUP_BUTTON_MAP = 4;
const DEBOUNCE_MAX_MS = 50;
const DEBOUNCE_DEFAULT_MS = 4;

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
        + '每个物理键可单独指定 DS4 逻辑功能，允许多个物理键映射到同一功能、也可设为「无（禁用）」。'
        + '修改后请点击底边栏 <b>[保存]</b> 写入固件。'
        + '注意：上电按住 <b>Share</b> 进入配置模式走的是物理电平，<b>不受映射影响</b>。';
    container.appendChild(banner);

    // 按键消抖时间设置（组 2）
    container.appendChild(renderDebounceCard(model, ctx));

    // 26 键重映射表格（组 4）
    container.appendChild(renderMappingCard(model, ctx));
}

//--------------------------------------------------------------------+
// 26 键重映射卡片（组 4 button_map）
//--------------------------------------------------------------------+
function renderMappingCard(model, ctx) {
    // 初始化容错：字段缺失/长度不对时回落到出厂映射
    if (!Array.isArray(model.buttonMap) || model.buttonMap.length !== PHYSICAL_BUTTONS.length) {
        model.buttonMap = [...DEFAULT_BUTTON_MAP];
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
    title.textContent = '按键映射（26 路）';
    title.style.cssText = 'margin:0;';
    head.appendChild(title);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn';
    resetBtn.textContent = '恢复默认映射';
    head.appendChild(resetBtn);
    card.appendChild(head);

    const hint = document.createElement('p');
    hint.className = 'placeholder-text';
    hint.textContent = '下拉框修改后请点击底边栏 [保存] 写入固件。多项选择同一功能时会叠加输出（多对一）；选「无（禁用）」表示该物理键不产生任何输出。';
    card.appendChild(hint);

    const table = document.createElement('table');
    table.className = 'mapping-table';

    const thead = document.createElement('thead');
    thead.innerHTML = `
        <tr>
            <th>物理按键 / 引脚</th>
            <th>映射功能（写入固件）</th>
            <th>出厂默认</th>
        </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const selectEls = [];

    PHYSICAL_BUTTONS.forEach((item, index) => {
        const tr = document.createElement('tr');

        // 物理按键列：名称 + 位号 + 引脚
        const tdName = document.createElement('td');
        const nameEl = document.createElement('span');
        nameEl.textContent = item.name;
        const pinEl = document.createElement('span');
        pinEl.textContent = ` bit${item.bit} · ${item.pin}`;
        pinEl.style.cssText = 'font-size:12px;color:var(--text-secondary);';
        tdName.appendChild(nameEl);
        tdName.appendChild(pinEl);
        tr.appendChild(tdName);

        // 映射功能列：19 项下拉
        const tdSelect = document.createElement('td');
        const select = document.createElement('select');
        select.style.cssText = 'padding:6px 10px;border:1px solid var(--border);border-radius:8px;'
            + 'background:var(--input-bg);color:var(--text-primary);font-family:inherit;font-size:14px;min-width:180px;cursor:pointer;';
        for (const opt of DS4_LOGICAL_BUTTONS) {
            const o = document.createElement('option');
            o.value = String(opt.value);
            o.textContent = opt.label;
            select.appendChild(o);
        }
        select.value = String(model.buttonMap[index]);
        select.addEventListener('change', () => {
            model.buttonMap[index] = Number(select.value);
            markDirty(GROUP_BUTTON_MAP);
        });
        selectEls.push(select);
        tdSelect.appendChild(select);
        tr.appendChild(tdSelect);

        // 默认映射列：方便恢复前对照
        const tdDefault = document.createElement('td');
        tdDefault.textContent = logicalButtonLabel(DEFAULT_BUTTON_MAP[index]);
        tdDefault.style.cssText = 'font-size:13px;color:var(--text-secondary);';
        tr.appendChild(tdDefault);

        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    card.appendChild(table);

    // 恢复默认映射：复位 model 与全部下拉框（只标记脏，不直接写 Flash）
    resetBtn.addEventListener('click', () => {
        model.buttonMap = [...DEFAULT_BUTTON_MAP];
        selectEls.forEach((sel, i) => { sel.value = String(DEFAULT_BUTTON_MAP[i]); });
        markDirty(GROUP_BUTTON_MAP);
    });

    return card;
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
