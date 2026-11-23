/**
 * buttons.js - 按键 Tab（固定映射表 + 按键消抖时间设置）
 *
 * 当前固件（gamepad.c）的物理按键 → DS4 按键映射是写死的，不支持自定义，
 * 因此映射部分以只读表格展示；本 Tab 同时承载「按键消抖时间」设置
 * （属于 gamepad_settings 配置组，第 6 字节 debounce_ms，0~50ms）。
 */

import { PHYSICAL_BUTTONS } from './button_map.js';

// 配置组与消抖边界（与固件 Config/config.h 严格一致）
const GROUP_GAMEPAD_SETTINGS = 2;
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
    banner.innerHTML = '当前固件为<b>固定映射</b>，暂不支持自定义按键映射。以下为固件当前的映射关系（只读）。';
    container.appendChild(banner);

    // 按键消抖时间设置（可写）
    container.appendChild(renderDebounceCard(model, ctx));

    // 映射表格
    const table = document.createElement('table');
    table.className = 'mapping-table';

    const thead = document.createElement('thead');
    thead.innerHTML = `
        <tr>
            <th>物理按键</th>
            <th>映射功能</th>
            <th>宏设置</th>
        </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const item of PHYSICAL_BUTTONS) {
        const tr = document.createElement('tr');

        const tdName = document.createElement('td');
        tdName.textContent = item.name;

        const tdTarget = document.createElement('td');
        if (item.target) {
            tdTarget.innerHTML = `<span class="map-target">${item.target}</span>`;
        } else {
            tdTarget.innerHTML = '<span class="map-none">无（固件未定义）</span>';
        }

        const tdMacro = document.createElement('td');
        const macroBtn = document.createElement('button');
        macroBtn.className = 'btn-macro';
        macroBtn.textContent = '无';
        tdMacro.appendChild(macroBtn);

        tr.appendChild(tdName);
        tr.appendChild(tdTarget);
        tr.appendChild(tdMacro);
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.appendChild(table);
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
