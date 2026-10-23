/**
 * app.js - 主入口：页面路由、初始化
 *
 * SPA 模式：侧边栏菜单切换页面，无刷新。
 * 页面切换断开连接逻辑（需求文档）：
 * - 进入配置页面 → 自动断开 → 需要重新连接（按配置模式连接）
 * - 进入固件烧录页面 → 自动断开 → 需要重新连接（按烧录模式连接）
 * - 进入欢迎/文档页面 → 不影响连接
 */

import { initTheme, renderSidebarNav, updateSidebarNav } from './components/sidebar.js';
import { renderHomePage } from './pages/home.js';
import { renderConfigPage, disconnectConfig } from './pages/config.js';
import { renderFlashPage, disconnectFlash } from './pages/flash.js';
import { renderDocsPage } from './pages/docs.js';

const PAGES = [
    { id: 'home', label: '欢迎', render: renderHomePage },
    { id: 'config', label: '配置', render: renderConfigPage },
    { id: 'flash', label: '固件烧录', render: renderFlashPage },
    { id: 'docs', label: '文档&支持', render: renderDocsPage },
];

let currentPage = 'home';

/**
 * 页面导航
 * @param {string} pageId
 */
async function navigateTo(pageId) {
    // 进入配置/烧录页面时自动断开所有连接（需按对应模式重新连接）
    if (pageId === 'config' || pageId === 'flash') {
        await Promise.all([disconnectConfig(), disconnectFlash()]);
    }

    currentPage = pageId;
    updateSidebarNav(pageId);

    const page = PAGES.find(p => p.id === pageId);
    const container = document.getElementById('main-content');
    container.innerHTML = '';
    if (page) page.render(container);
}

/**
 * 处理启动提示
 * - 安全上下文（http://localhost 或 HTTPS）：正常启动，移除提示
 * - 非安全上下文（如 file://）：保留提示，说明需通过本地服务器访问
 */
function handleBootError() {
    const bootError = document.getElementById('boot-error');
    if (!bootError) return;

    if (window.isSecureContext) {
        bootError.remove();
        return;
    }

    // 非安全上下文：模块虽已加载，但 Web Serial/WebUSB 不可用
    const closeBtn = document.getElementById('boot-error-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            bootError.style.display = 'none';
        });
    }
}

/**
 * 初始化应用
 */
function initApp() {
    handleBootError();
    initTheme();
    renderSidebarNav(PAGES, currentPage, navigateTo);
    navigateTo(currentPage);
}

document.addEventListener('DOMContentLoaded', initApp);
