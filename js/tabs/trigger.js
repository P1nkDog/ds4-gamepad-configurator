/**
 * trigger.js - 扳机 Tab（待完善）
 *
 * 当前固件（ds4_driver.c）将 L2/R2 硬编码为数字触发（按下=0xFF，松开=0x00），
 * 不支持模拟扳机与扳机死区配置，故暂以占位展示。
 */

/**
 * 渲染扳机 Tab
 * @param {HTMLElement} container
 */
export function renderTriggerTab(container) {
    container.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'section-card';

    const h = document.createElement('h3');
    h.textContent = '扳机配置';
    card.appendChild(h);

    const placeholder = document.createElement('p');
    placeholder.className = 'placeholder-text';
    placeholder.textContent = '待完善（当前固件暂不支持扳机模拟/死区配置）';
    card.appendChild(placeholder);

    container.appendChild(card);
}
