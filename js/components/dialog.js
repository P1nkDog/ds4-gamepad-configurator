/**
 * dialog.js - 对话框组件
 * 提供消息提示与确认对话框
 */

let overlay = null;
let titleEl = null;
let bodyEl = null;
let actionsEl = null;

function ensureElements() {
    overlay = document.getElementById('dialog-overlay');
    titleEl = document.getElementById('dialog-title');
    bodyEl = document.getElementById('dialog-body');
    actionsEl = document.getElementById('dialog-actions');
}

function show() {
    if (!overlay) ensureElements();
    overlay.hidden = false;
}

function hide() {
    if (!overlay) ensureElements();
    overlay.hidden = true;
    actionsEl.innerHTML = '';
}

/**
 * 确认对话框
 * @param {string} title
 * @param {string} body
 * @returns {Promise<boolean>} 用户确认返回 true，否则 false
 */
export function showConfirm(title, body) {
    return new Promise((resolve) => {
        ensureElements();
        titleEl.textContent = title;
        bodyEl.textContent = body;
        actionsEl.innerHTML = '';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-primary';
        cancelBtn.textContent = '取消';
        cancelBtn.addEventListener('click', () => {
            hide();
            resolve(false);
        });

        const okBtn = document.createElement('button');
        okBtn.className = 'btn-primary';
        okBtn.textContent = '确定';
        okBtn.addEventListener('click', () => {
            hide();
            resolve(true);
        });

        actionsEl.appendChild(cancelBtn);
        actionsEl.appendChild(okBtn);
        show();
    });
}

/**
 * 消息对话框
 * @param {string} title
 * @param {string} body
 * @returns {Promise<void>}
 */
export function showMessage(title, body) {
    return new Promise((resolve) => {
        ensureElements();
        titleEl.textContent = title;
        bodyEl.textContent = body;
        actionsEl.innerHTML = '';

        const okBtn = document.createElement('button');
        okBtn.className = 'btn-primary';
        okBtn.textContent = '确定';
        okBtn.addEventListener('click', () => {
            hide();
            resolve();
        });

        actionsEl.appendChild(okBtn);
        show();
    });
}
