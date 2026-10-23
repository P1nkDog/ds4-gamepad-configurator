/**
 * buttons.js - 按键 Tab（只读显示固件固定映射）
 *
 * 当前固件（gamepad.c）的物理按键 → DS4 按键映射是写死的，不支持自定义。
 * 因此本 Tab 以只读表格展示固件当前的固定映射。
 */

import { PHYSICAL_BUTTONS } from './button_map.js';

/**
 * 渲染按键 Tab
 * @param {HTMLElement} container
 */
export function renderButtonsTab(container) {
    container.innerHTML = '';

    // 顶部提示
    const banner = document.createElement('div');
    banner.className = 'notice-banner';
    banner.innerHTML = '当前固件为<b>固定映射</b>，暂不支持自定义按键映射。以下为固件当前的映射关系（只读）。';
    container.appendChild(banner);

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
