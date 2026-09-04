const overlay = () => document.getElementById('dialog-overlay');
const titleEl = () => document.getElementById('dialog-title');
const messageEl = () => document.getElementById('dialog-message');
const inputEl = () => document.getElementById('dialog-input');
const confirmBtn = () => document.getElementById('dialog-confirm');
const cancelBtn = () => document.getElementById('dialog-cancel');

let resolveDialog = null;
let dialogMode = 'confirm';

function escapeText(text) {
  return String(text ?? '');
}

function setConfirmStyle(danger) {
  const btn = confirmBtn();
  btn.className = 'dialog-btn ' + (danger ? 'dialog-btn-danger' : 'dialog-btn-primary');
}

function closeDialog(result) {
  const el = overlay();
  if (!el || el.classList.contains('hidden')) return;
  el.classList.add('hidden');
  inputEl().classList.add('hidden');
  document.body.classList.remove('dialog-open');
  const resolve = resolveDialog;
  resolveDialog = null;
  if (resolve) resolve(result);
}

function openDialog() {
  overlay().classList.remove('hidden');
  document.body.classList.add('dialog-open');
}

function bindDialogEvents() {
  cancelBtn().addEventListener('click', () => {
    closeDialog(dialogMode === 'prompt' ? null : false);
  });

  confirmBtn().addEventListener('click', () => {
    if (dialogMode === 'prompt') {
      closeDialog(inputEl().value);
      return;
    }
    closeDialog(true);
  });

  overlay().addEventListener('click', (e) => {
    if (e.target === overlay()) {
      closeDialog(dialogMode === 'prompt' ? null : false);
    }
  });

  document.addEventListener('keydown', (e) => {
    const el = overlay();
    if (!el || el.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDialog(dialogMode === 'prompt' ? null : false);
    }
    if (e.key === 'Enter' && dialogMode === 'prompt' && document.activeElement === inputEl()) {
      e.preventDefault();
      confirmBtn().click();
    }
  });
}

/**
 * @returns {Promise<boolean>}
 */
export function showConfirm({
  title = '确认',
  message = '',
  confirmText = '确定',
  cancelText = '取消',
  danger = false
} = {}) {
  return new Promise((resolve) => {
    resolveDialog = resolve;
    dialogMode = 'confirm';
    titleEl().textContent = escapeText(title);
    messageEl().textContent = escapeText(message);
    messageEl().classList.toggle('hidden', !message);
    inputEl().classList.add('hidden');
    confirmBtn().textContent = confirmText;
    cancelBtn().textContent = cancelText;
    cancelBtn().classList.remove('hidden');
    setConfirmStyle(danger);
    openDialog();
    confirmBtn().focus();
  });
}

/**
 * @returns {Promise<string|null>}
 */
export function showPrompt({
  title = '输入',
  message = '',
  placeholder = '',
  defaultValue = '',
  confirmText = '确定',
  cancelText = '取消'
} = {}) {
  return new Promise((resolve) => {
    resolveDialog = resolve;
    dialogMode = 'prompt';
    titleEl().textContent = escapeText(title);
    messageEl().textContent = escapeText(message);
    messageEl().classList.toggle('hidden', !message);
    const input = inputEl();
    input.classList.remove('hidden');
    input.placeholder = placeholder;
    input.value = defaultValue;
    confirmBtn().textContent = confirmText;
    cancelBtn().textContent = cancelText;
    cancelBtn().classList.remove('hidden');
    setConfirmStyle(false);
    openDialog();
    input.focus();
    input.select();
  });
}

bindDialogEvents();
