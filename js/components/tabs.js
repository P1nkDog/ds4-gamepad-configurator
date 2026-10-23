/**
 * tabs.js - Tab 栏组件
 * 渲染通用 Tab 栏（左侧 Tab 项 + 右侧可插入按钮）
 */

/**
 * 渲染 Tab 栏
 * @param {Array<{key:string, label:string}>} tabs
 * @param {string} activeKey
 * @param {Function} onSelect - (key) => void
 * @param {string} [rightHtml] - 右侧附加内容（如 [连接]/[断开] 按钮的 HTML）
 * @returns {HTMLElement}
 */
export function renderTabBar(tabs, activeKey, onSelect, rightHtml = '') {
    const bar = document.createElement('div');
    bar.className = 'tab-bar';

    for (const tab of tabs) {
        const btn = document.createElement('button');
        btn.className = `tab-item ${tab.key === activeKey ? 'active' : ''}`;
        btn.dataset.tab = tab.key;
        btn.textContent = tab.label;
        btn.addEventListener('click', () => {
            if (onSelect) onSelect(tab.key);
        });
        bar.appendChild(btn);
    }

    const spacer = document.createElement('div');
    spacer.className = 'tab-spacer';
    bar.appendChild(spacer);

    if (rightHtml) {
        const wrapper = document.createElement('div');
        wrapper.className = 'tab-right';
        wrapper.innerHTML = rightHtml;
        bar.appendChild(wrapper);
    }

    return bar;
}

/**
 * 更新 Tab 栏激活状态
 * @param {HTMLElement} bar
 * @param {string} activeKey
 */
export function setActiveTab(bar, activeKey) {
    bar.querySelectorAll('.tab-item').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === activeKey);
    });
}
