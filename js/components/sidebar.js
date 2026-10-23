/**
 * sidebar.js - 侧边栏组件
 * 渲染主导航（垂直发光 Radio）与主题切换
 */

const THEME_STORAGE_KEY = 'ds4-theme';

/**
 * 渲染侧边栏导航
 * @param {Array<{id:string, label:string}>} pages
 * @param {string} currentPage
 * @param {Function} onNavigate - (pageId) => void
 */
export function renderSidebarNav(pages, currentPage, onNavigate) {
    const nav = document.getElementById('sidebar-nav');
    nav.innerHTML = '';

    const container = document.createElement('div');
    container.className = 'radio-container';
    container.style.setProperty('--total-radio', String(pages.length));

    pages.forEach((page, index) => {
        const input = document.createElement('input');
        input.type = 'radio';
        input.id = `nav-${page.id}`;
        input.name = 'sidebar-nav';
        input.checked = page.id === currentPage;

        const label = document.createElement('label');
        label.htmlFor = `nav-${page.id}`;
        label.textContent = page.label;

        container.appendChild(input);
        container.appendChild(label);
    });

    const gliderWrap = document.createElement('div');
    gliderWrap.className = 'glider-container';
    const glider = document.createElement('div');
    glider.className = 'glider';
    gliderWrap.appendChild(glider);
    container.appendChild(gliderWrap);

    nav.appendChild(container);

    // 点击切换页面
    container.addEventListener('click', (event) => {
        const target = event.target.closest('label');
        if (!target) return;
        const input = document.getElementById(target.htmlFor);
        if (!input) return;
        input.checked = true;
        onNavigate(input.id.replace('nav-', ''));
    });
}

/**
 * 更新导航选中状态
 * @param {string} currentPage
 */
export function updateSidebarNav(currentPage) {
    const nav = document.getElementById('sidebar-nav');
    const input = nav?.querySelector(`input#nav-${currentPage}`);
    if (input) input.checked = true;
}

/**
 * 获取当前主题（优先读取 localStorage，否则跟随系统）
 * @returns {'light'|'dark'}
 */
export function getCurrentTheme() {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * 应用主题到文档
 * @param {'light'|'dark'} theme
 */
export function applyTheme(theme) {
    const input = document.getElementById('input');
    if (input) input.checked = theme === 'dark';
    if (theme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
}

/**
 * 初始化主题
 */
export function initTheme() {
    applyTheme(getCurrentTheme());

    const input = document.getElementById('input');
    if (input) {
        input.addEventListener('change', () => {
            const theme = input.checked ? 'dark' : 'light';
            localStorage.setItem(THEME_STORAGE_KEY, theme);
            applyTheme(theme);
        });
    }
}
