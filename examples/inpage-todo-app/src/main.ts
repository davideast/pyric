import { TaskApplicationService, type TaskItem, type ActivityEvent } from './services/firebase-service';
import { SandboxSimulationDriver } from './sandbox/sandbox-driver';

// Initialize deep domain and simulation modules
const sandboxDriver = new SandboxSimulationDriver('inpage-task-workspace');
sandboxDriver.initializeDefaultSecurityRules();
await sandboxDriver.seedDemoAccounts();

const appService = new TaskApplicationService(sandboxDriver.sandbox);

// ── Application State & DOM Utilities ──
let currentTasks: TaskItem[] = [];
let activeFilter: 'all' | 'active' | 'completed' = 'all';
let searchQuery = '';
let editingTaskId: string | null = null;
let activeAttachmentUrl: string | null = null;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ── Universal Iframe Clipboard Helper (Circumvents NotAllowedError in sandboxed iframes) ──
function universalCopyText(text: string, onSuccess?: () => void): void {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onSuccess).catch(() => executeFallbackCopy(text, onSuccess));
      return;
    }
  } catch {
    // Proceed immediately to fallback copy inside restricted about:srcdoc preview frames
  }
  executeFallbackCopy(text, onSuccess);
}

function executeFallbackCopy(text: string, onSuccess?: () => void): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    if (onSuccess) onSuccess();
  } catch (err) {
    console.warn("Universal fallback copy failed:", err);
  } finally {
    document.body.removeChild(textarea);
  }
}

// ── UI Error & Security Rules Denial Banner Seam ──
function showErrorBanner(errorTitle: string, errorDetails: any): void {
  const banner = $('error-banner');
  const content = $('error-banner-content');
  if (!banner || !content) return;

  const titleText = String(errorTitle || 'Operation Denied');
  let bodyHtml = '';

  if (errorDetails && errorDetails.code === 'permission-denied' && errorDetails.denialContext) {
    const d = errorDetails.denialContext;
    const ruleExpr = d.rule && d.rule.expression ? d.rule.expression : 'N/A';
    const ruleLine = d.rule && d.rule.line ? `Line ${d.rule.line}` : 'Unknown Line';
    const reasons = Array.isArray(d.reasons) ? d.reasons.join('\n') : String(errorDetails.message || '');

    bodyHtml = `
      <div class="flex flex-col gap-2 w-full text-xs">
        <div class="flex items-center justify-between flex-wrap gap-1">
          <span class="font-semibold text-red-500 text-sm">🔒 ${titleText}</span>
          <span class="font-mono text-[10px] px-2 py-0.5 rounded bg-red-500/15 text-red-400 font-semibold">${d.method || 'WRITE'} ${d.path || 'doc'}</span>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-[10px] font-semibold text-red-300">Failed Rule (${ruleLine}):</span>
          <div class="font-mono text-[11px] p-2 rounded bg-zinc-900 border border-red-500/30 text-red-400 font-medium overflow-x-auto">${ruleExpr}</div>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-[10px] font-semibold text-red-300">Rules Evaluator Reasoning:</span>
          <pre class="font-mono text-[11px] p-2 rounded bg-zinc-900 border border-red-500/30 text-zinc-300 overflow-x-auto whitespace-pre-wrap">${reasons}</pre>
        </div>
        <div class="flex justify-between items-center pt-2 border-t border-red-500/20 text-[11px] text-zinc-400">
          <span>Tip: Authoritative Rules Debug Context guides AI agents in diagnosing access denials.</span>
          <button type="button" onclick="window.openInspector()" class="underline font-semibold hover:text-white text-red-400">Inspect Sandbox Rules &rarr;</button>
        </div>
      </div>
    `;
  } else {
    const msg = typeof errorDetails === 'string' ? errorDetails : (errorDetails?.message || String(errorDetails));
    bodyHtml = `
      <div class="flex flex-col gap-1.5 w-full text-xs">
        <span class="font-semibold text-red-500 text-sm">⚠️ ${titleText}</span>
        <pre class="font-mono text-[11px] p-2 rounded bg-zinc-900 border border-red-500/30 text-zinc-300 overflow-x-auto whitespace-pre-wrap">${msg}</pre>
      </div>
    `;
  }

  content.innerHTML = bodyHtml;
  banner.classList.remove('hidden');
  banner.classList.add('flex');
}

function hideErrorBanner(): void {
  const banner = $('error-banner');
  if (banner) {
    banner.classList.add('hidden');
    banner.classList.remove('flex');
  }
}

// ── Reactive Task List Rendering Seam ──
function renderTasks(): void {
  const listEl = $('todo-list');
  const emptyEl = $('empty-state');
  const countEl = $('items-left-count');
  const progressPercent = $('progress-percent');
  const progressFill = $('progress-bar-fill');
  const clearBtn = $('clear-completed-btn');

  if (!listEl || !emptyEl) return;

  const filtered = currentTasks.filter((task) => {
    const matchesFilter = 
      activeFilter === 'all' || 
      (activeFilter === 'active' && !task.completed) || 
      (activeFilter === 'completed' && task.completed);
    const matchesSearch = !searchQuery || task.title.toLowerCase().includes(searchQuery.toLowerCase()) || task.category.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const activeCount = currentTasks.filter((t) => !t.completed).length;
  const totalCount = currentTasks.length;
  const percent = totalCount > 0 ? Math.round(((totalCount - activeCount) / totalCount) * 100) : 0;

  if (countEl) countEl.textContent = `${activeCount} item${activeCount === 1 ? '' : 's'} remaining`;
  if (progressPercent) progressPercent.textContent = `${percent}%`;
  if (progressFill) progressFill.style.width = `${percent}%`;
  if (clearBtn) clearBtn.classList.toggle('hidden', currentTasks.every((t) => !t.completed));

  if (filtered.length === 0) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    emptyEl.classList.add('flex');
  } else {
    emptyEl.classList.add('hidden');
    emptyEl.classList.remove('flex');

    listEl.innerHTML = filtered.map((task) => {
      const isEditing = editingTaskId === task.id;
      return `
        <div class="group flex items-center justify-between p-3.5 sm:px-4 sm:py-3 gap-3 border-b border-zinc-800 hover:bg-zinc-900/40 transition-colors ${task.completed ? 'opacity-70' : ''}">
          <div class="flex items-center gap-3 flex-1 min-w-0">
            <button 
              type="button" 
              onclick="window.toggleTodoStatus('${task.id}', ${!task.completed})" 
              class="w-5 h-5 rounded border border-zinc-700 flex items-center justify-center transition-colors shrink-0 ${task.completed ? 'bg-white border-white text-zinc-950 font-bold' : 'bg-transparent text-transparent hover:border-zinc-500'}"
            >
              ✓
            </button>
            <div class="flex-1 min-w-0 flex flex-col gap-1">
              ${isEditing ? `
                <div class="flex items-center gap-2 w-full">
                  <input 
                    id="edit-input-${task.id}" 
                    type="text" 
                    value="${task.title.replace(/"/g, '&quot;')}"
                    onkeydown="if(event.key==='Enter') window.commitEdit('${task.id}', this.value); if(event.key==='Escape') window.cancelEdit();"
                    onblur="window.commitEdit('${task.id}', this.value)"
                    class="h-8 w-full rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-white font-medium focus:outline-none focus:ring-1 focus:ring-zinc-400"
                  />
                </div>
              ` : `
                <div class="flex items-center flex-wrap gap-2">
                  <span ondblclick="window.beginEdit('${task.id}')" class="text-sm font-medium truncate cursor-pointer ${task.completed ? 'line-through text-zinc-500' : 'text-zinc-100'}">${task.title}</span>
                  <span class="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 font-mono text-[10px] text-zinc-300 font-semibold">${task.category}</span>
                  <span class="px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold border ${task.priority === 'High' ? 'bg-red-500/15 border-red-500/30 text-red-400' : task.priority === 'Medium' ? 'bg-amber-500/15 border-amber-500/30 text-amber-400' : 'bg-zinc-800 border-zinc-700 text-zinc-400'}">${task.priority}</span>
                  <span class="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 font-mono text-[10px] text-zinc-400">owner: ${task.owner}</span>
                </div>
              `}
              ${task.attachmentUrl ? `
                <div class="inline-flex items-center gap-2 mt-1">
                  <a href="${task.attachmentUrl}" target="_blank" class="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 underline font-medium">
                    <span>📎 View Attached Image Asset</span>
                  </a>
                </div>
              ` : ''}
            </div>
          </div>
          <div class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <button type="button" onclick="window.beginEdit('${task.id}')" class="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-semibold">Edit</button>
            <button type="button" onclick="window.deleteTodoItem('${task.id}')" class="text-xs px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-400 font-semibold">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  }
}

// ── Real-time Subscriptions ──
appService.onAuthChange((user) => {
  const authLabel = $('auth-status-text');
  const signinBtn = $('signin-btn');
  const signoutBtn = $('signout-btn');
  const switchUserBtn = $('switch-user-btn');

  if (user) {
    const display = user.displayName || user.email || 'Authenticated User';
    if (authLabel) authLabel.innerHTML = `<span class="inline-flex items-center gap-1.5 flex-wrap"><span>Signed in as</span> <span class="font-bold text-white">${display}</span> <code class="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 font-mono text-[11px] text-zinc-300">${user.uid}</code></span>`;
    if (signinBtn) signinBtn.classList.add('hidden');
    if (signoutBtn) signoutBtn.classList.remove('hidden');
    if (switchUserBtn) switchUserBtn.classList.remove('hidden');

    appService.subscribeToTasks(
      (tasks) => {
        currentTasks = tasks;
        renderTasks();
      },
      (err) => showErrorBanner('Firestore Read Denied by Security Rules', err)
    );
  } else {
    if (authLabel) authLabel.textContent = 'Signed out — database modifications will be rejected by Security Rules';
    if (signinBtn) signinBtn.classList.remove('hidden');
    if (signoutBtn) signoutBtn.classList.add('hidden');
    if (switchUserBtn) switchUserBtn.classList.add('hidden');
    currentTasks = [];
    renderTasks();
  }
});

appService.subscribeToPresence((activeUids) => {
  const container = $('rtdb-presence-list');
  if (!container) return;
  if (activeUids.length === 0) {
    container.innerHTML = '<p class="text-xs text-zinc-500 italic">No users currently active in presence tree.</p>';
  } else {
    container.innerHTML = activeUids.map((uid) => `<div class="p-2 rounded bg-zinc-900 border border-zinc-800 text-xs text-emerald-400 font-mono font-semibold flex items-center gap-2"><span>🟢</span><span>${uid}</span></div>`).join('');
  }
});

appService.subscribeToActivityStream((events) => {
  const container = $('rtdb-activity-list');
  if (!container) return;
  if (events.length === 0) {
    container.innerHTML = '<p class="text-xs text-zinc-500 italic">Awaiting activity stream events...</p>';
  } else {
    container.innerHTML = events.map((evt) => {
      const timeStr = new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `<div class="p-1.5 rounded bg-zinc-900 border border-zinc-800 text-[11px] font-mono flex items-center gap-2"><span class="text-zinc-500 shrink-0">[${timeStr}]</span><strong class="text-zinc-200">${evt.user}:</strong> <span class="text-zinc-300">${evt.action}</span></div>`;
    }).join('');
  }
});

// ── Global Window Handlers for Declarative HTML Markup ──
declare global {
  interface Window {
    openInspector: () => void;
    closeInspector: () => void;
    openSignInModal: () => void;
    closeSignInModal: () => void;
    switchAuthTab: (tab: 'signin' | 'signup') => void;
    switchConsoleTab: (tab: 'db' | 'rtdb' | 'ai' | 'fcm') => void;
    handleAddTaskSubmit: (e: Event) => boolean;
    toggleTodoStatus: (id: string, status: boolean) => Promise<void>;
    deleteTodoItem: (id: string) => Promise<void>;
    beginEdit: (id: string) => void;
    commitEdit: (id: string, value: string) => Promise<void>;
    cancelEdit: () => void;
    filterTasks: (filter: 'all' | 'active' | 'completed') => void;
    handleSearchInput: (e: Event) => void;
    clearCompletedItems: () => Promise<void>;
    handleEmailAuthSignIn: (e: Event) => boolean;
    handleEmailAuthSignUp: (e: Event) => boolean;
    handleGoogleOAuthSignIn: () => Promise<void>;
    handleGuestAuthSignIn: () => Promise<void>;
    fillDemoLogin: (email: string, pass: string) => void;
    handleUserSignOut: () => Promise<void>;
    hideErrorBanner: () => void;
    copyErrorDetails: (e: Event) => void;
    triggerAttachmentUpload: () => void;
    handleFileSelected: (e: Event) => Promise<void>;
    removeSelectedAttachment: () => void;
    // Simulation driver actions
    toggleRtdbPresence: () => Promise<void>;
    triggerRtdbFanoutWrite: () => Promise<void>;
    testRtdbRuleDenial: () => Promise<void>;
    handleGenerateTasks: () => Promise<void>;
    applyAiScenario: (val: any) => void;
    acceptAiTask: (title: string, cat: string, prio: 'Low'|'Medium'|'High') => Promise<void>;
    handleEnablePushNotifications: () => Promise<void>;
    handleRevokePushNotifications: () => Promise<void>;
    simulatePushAlert: (type: 'overdue' | 'update' | 'silent') => Promise<void>;
    copyFcmToken: (e: Event) => void;
    dismissFcmToast: (id: string) => void;
  }
}

window.openInspector = () => {
  const modal = $('inspector-modal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    window.switchConsoleTab('db');
  }
};

window.closeInspector = () => {
  const modal = $('inspector-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
};

window.openSignInModal = () => {
  const modal = $('signin-modal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
};

window.closeSignInModal = () => {
  const modal = $('signin-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
};

window.switchAuthTab = (tab: 'signin' | 'signup') => {
  const signinPanel = $('auth-panel-signin');
  const signupPanel = $('auth-panel-signup');
  const signinBtn = $('auth-tab-btn-signin');
  const signupBtn = $('auth-tab-btn-signup');

  if (tab === 'signin') {
    if (signinPanel) signinPanel.classList.remove('hidden'), signinPanel.classList.add('flex');
    if (signupPanel) signupPanel.classList.add('hidden'), signupPanel.classList.remove('flex');
    if (signinBtn) signinBtn.className = "py-1.5 rounded-md transition-all bg-zinc-800 text-white shadow-sm font-bold";
    if (signupBtn) signupBtn.className = "py-1.5 rounded-md transition-all text-zinc-400 hover:text-white";
  } else {
    if (signupPanel) signupPanel.classList.remove('hidden'), signupPanel.classList.add('flex');
    if (signinPanel) signinPanel.classList.add('hidden'), signinPanel.classList.remove('flex');
    if (signupBtn) signupBtn.className = "py-1.5 rounded-md transition-all bg-zinc-800 text-white shadow-sm font-bold";
    if (signinBtn) signinBtn.className = "py-1.5 rounded-md transition-all text-zinc-400 hover:text-white";
  }
};

window.switchConsoleTab = (tab: 'db' | 'rtdb' | 'ai' | 'fcm') => {
  const tabs = ['db', 'rtdb', 'ai', 'fcm'] as const;
  for (const t of tabs) {
    const btn = $(`console-btn-${t}`);
    const panel = $(`console-panel-${t}`);
    if (t === tab) {
      if (btn) btn.className = "px-4 py-2 rounded-md transition-all bg-white text-zinc-950 font-bold shadow-sm shrink-0";
      if (panel) panel.classList.remove('hidden'), panel.classList.add('flex');
    } else {
      if (btn) btn.className = "px-4 py-2 rounded-md transition-all text-zinc-400 hover:bg-zinc-800 font-semibold shrink-0";
      if (panel) panel.classList.add('hidden'), panel.classList.remove('flex');
    }
  }

  if (tab === 'db') {
    const summary = sandboxDriver.getInspectorSummary();
    const content = $('inspector-content');
    const denialsHtml = summary.recentDenials.length === 0
      ? `<div class="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-medium text-xs">✓ Zero security rule denials recorded in this session.</div>`
      : `<div class="flex flex-col gap-2 pt-2 border-t border-zinc-800">
           <span class="font-bold text-red-400 text-xs">Recent Rule Denials (${summary.recentDenials.length}):</span>
           <div class="flex flex-col gap-2 max-h-48 overflow-y-auto">
             ${summary.recentDenials.map(d => `<div class="p-2 rounded bg-red-500/10 border border-red-500/30 font-mono text-[11px] text-red-300 flex flex-col gap-1"><span>${d.method} ${d.path} (uid: ${d.auth ? d.auth.uid : 'null'})</span><span>Line ${d.rule?.line || '?'}: ${d.rule?.expression || ''}</span><pre class="text-[10px] whitespace-pre-wrap">${(d.reasons||[]).join('\n')}</pre></div>`).join('')}
           </div>
         </div>`;

    if (content) {
      content.innerHTML = `
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 text-xs">
          <div class="flex flex-col gap-1">
            <span class="text-zinc-400">Active Identity:</span>
            <strong class="text-white font-mono text-[11px] truncate">${summary.currentUid}</strong>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-zinc-400">Total Documents:</span>
            <strong class="text-white font-mono text-sm">${summary.totalDocuments} items</strong>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-zinc-400">Collections:</span>
            <strong class="text-white text-sm capitalize">${summary.collections.join(', ') || 'todos'}</strong>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-zinc-400">Event Operations:</span>
            <strong class="text-white font-mono text-sm">${summary.totalEvents} ops</strong>
          </div>
        </div>
        ${denialsHtml}
        <div class="flex-1 flex flex-col gap-2 pt-2 border-t border-zinc-800 min-h-[200px]">
          <span class="font-bold text-xs text-white">Active Firestore Security Rules:</span>
          <pre class="flex-1 p-4 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-300 font-mono text-xs overflow-auto select-text">${summary.activeFirestoreRules}</pre>
        </div>
      `;
    }
  } else if (tab === 'rtdb') {
    const dump = $('rtdb-rules-dump');
    if (dump) dump.textContent = JSON.stringify(sandboxDriver.getInspectorSummary().activeRtdbRulesJson, null, 2);
  } else if (tab === 'fcm') {
    const fcmStatus = $('console-fcm-status');
    const token = appService.getActiveToken();
    if (fcmStatus) {
      fcmStatus.innerHTML = token
        ? `<span class="inline-flex items-center gap-2 flex-wrap"><span class="text-emerald-400 font-bold">Active</span> <code class="px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 font-mono text-[11px] max-w-[220px] truncate inline-block align-bottom">${token}</code> <button type="button" onclick="window.copyFcmToken(event)" class="underline text-white font-semibold">Copy</button></span>`
        : `<span class="text-zinc-500 italic">Token not requested yet (Enable via top header bar)</span>`;
    }
  }
};

window.handleAddTaskSubmit = (e: Event) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('new-task-input');
  const catSelect = $<HTMLSelectElement>('task-category');
  const prioSelect = $<HTMLSelectElement>('task-priority');

  if (!input || !input.value.trim()) return false;
  const title = input.value;
  const cat = catSelect ? catSelect.value : 'Work';
  const prio = (prioSelect ? prioSelect.value : 'Medium') as 'Low' | 'Medium' | 'High';

  appService.addTask(title, cat, prio, activeAttachmentUrl || undefined).then(() => {
    input.value = '';
    window.removeSelectedAttachment();
  }).catch((err) => {
    showErrorBanner('Firestore Write Denied by Security Rules', err);
  });
  return false;
};

window.toggleTodoStatus = async (id: string, status: boolean) => {
  const user = appService.getCurrentUser();
  try {
    await appService.toggleTaskStatus(id, status, user ? user.uid : 'anonymous');
  } catch (err) {
    showErrorBanner('Firestore Update Denied by Security Rules', err);
  }
};

window.deleteTodoItem = async (id: string) => {
  try {
    await appService.removeTask(id);
  } catch (err) {
    showErrorBanner('Firestore Deletion Denied by Security Rules', err);
  }
};

window.beginEdit = (id: string) => {
  editingTaskId = id;
  renderTasks();
  const input = $<HTMLInputElement>(`edit-input-${id}`);
  if (input) input.focus(), input.select();
};

window.commitEdit = async (id: string, newTitle: string) => {
  if (!newTitle.trim()) return window.cancelEdit();
  const user = appService.getCurrentUser();
  try {
    await appService.updateTaskTitle(id, newTitle, user ? user.uid : 'anonymous');
    editingTaskId = null;
    renderTasks();
  } catch (err) {
    showErrorBanner('Firestore Modification Denied by Security Rules', err);
    editingTaskId = null;
    renderTasks();
  }
};

window.cancelEdit = () => {
  editingTaskId = null;
  renderTasks();
};

window.filterTasks = (filter: 'all' | 'active' | 'completed') => {
  activeFilter = filter;
  const allBtn = $('tab-all');
  const actBtn = $('tab-active');
  const compBtn = $('tab-completed');
  if (allBtn) allBtn.className = filter === 'all' ? 'px-4 py-1.5 rounded-md bg-zinc-800 text-white font-bold shadow-sm cursor-pointer' : 'px-4 py-1.5 rounded-md text-zinc-400 hover:text-white cursor-pointer';
  if (actBtn) actBtn.className = filter === 'active' ? 'px-4 py-1.5 rounded-md bg-zinc-800 text-white font-bold shadow-sm cursor-pointer' : 'px-4 py-1.5 rounded-md text-zinc-400 hover:text-white cursor-pointer';
  if (compBtn) compBtn.className = filter === 'completed' ? 'px-4 py-1.5 rounded-md bg-zinc-800 text-white font-bold shadow-sm cursor-pointer' : 'px-4 py-1.5 rounded-md text-zinc-400 hover:text-white cursor-pointer';
  renderTasks();
};

window.handleSearchInput = (e: Event) => {
  const target = e.target as HTMLInputElement;
  searchQuery = target ? target.value : '';
  renderTasks();
};

window.clearCompletedItems = async () => {
  try {
    await appService.clearCompletedTasks(currentTasks);
  } catch (err) {
    showErrorBanner('Batch Deletion Denied by Security Rules', err);
  }
};

window.handleEmailAuthSignIn = (e: Event) => {
  e.preventDefault();
  const email = $<HTMLInputElement>('signin-email')?.value;
  const pass = $<HTMLInputElement>('signin-password')?.value;
  if (!email || !pass) return false;
  appService.signInEmail(email, pass).then(() => {
    window.closeSignInModal();
    hideErrorBanner();
  }).catch((err) => {
    const errBox = $('signin-error');
    if (errBox) errBox.textContent = `Sign in failed: ${err.message}`, errBox.classList.remove('hidden');
  });
  return false;
};

window.handleEmailAuthSignUp = (e: Event) => {
  e.preventDefault();
  const email = $<HTMLInputElement>('signup-email')?.value;
  const pass = $<HTMLInputElement>('signup-password')?.value;
  if (!email || !pass) return false;
  appService.signInEmail(email, pass).then(() => {
    window.closeSignInModal();
    hideErrorBanner();
  }).catch((err) => {
    const errBox = $('signup-error');
    if (errBox) errBox.textContent = `Registration failed: ${err.message}`, errBox.classList.remove('hidden');
  });
  return false;
};

window.handleGoogleOAuthSignIn = async () => {
  await appService.signInGoogle();
  window.closeSignInModal();
};

window.handleGuestAuthSignIn = async () => {
  await appService.signInGuest();
  window.closeSignInModal();
};

window.fillDemoLogin = (email: string, pass: string) => {
  const eInput = $<HTMLInputElement>('signin-email');
  const pInput = $<HTMLInputElement>('signin-password');
  if (eInput && pInput) eInput.value = email, pInput.value = pass;
};

window.handleUserSignOut = async () => {
  await appService.signOutUser();
};

window.hideErrorBanner = hideErrorBanner;

window.copyErrorDetails = (e: Event) => {
  const btn = e.target as HTMLButtonElement;
  const el = $('error-banner-content');
  if (el) {
    universalCopyText(el.innerText, () => {
      if (btn) btn.textContent = '✓ Copied';
      setTimeout(() => { if (btn) btn.textContent = 'Copy Debug Log'; }, 2000);
    });
  }
};

window.triggerAttachmentUpload = () => {
  const fileInput = $<HTMLInputElement>('attachment-file-input');
  if (fileInput) fileInput.click();
};

window.handleFileSelected = async (e: Event) => {
  const input = e.target as HTMLInputElement;
  if (!input || !input.files || input.files.length === 0) return;
  const file = input.files[0];
  const chip = $('attachment-chip');
  const filenameEl = $('attachment-filename');
  
  try {
    const url = await appService.uploadTaskAttachment(file);
    activeAttachmentUrl = url;
    if (filenameEl) filenameEl.textContent = file.name;
    if (chip) chip.classList.remove('hidden'), chip.classList.add('inline-flex');
  } catch (err: any) {
    showErrorBanner('Firebase Storage Upload Denied', err);
    input.value = '';
  }
};

window.removeSelectedAttachment = () => {
  activeAttachmentUrl = null;
  const chip = $('attachment-chip');
  const input = $<HTMLInputElement>('attachment-file-input');
  if (chip) chip.classList.add('hidden'), chip.classList.remove('inline-flex');
  if (input) input.value = '';
};

// ── Simulation Driver Handlers (Sandbox Controller Seam) ──
window.toggleRtdbPresence = async () => {
  try {
    await sandboxDriver.togglePresence();
  } catch (err) {
    showErrorBanner('RTDB Presence Modification Failed', err);
  }
};

window.triggerRtdbFanoutWrite = async () => {
  try {
    await sandboxDriver.triggerAtomicFanOut();
  } catch (err) {
    showErrorBanner('RTDB Atomic Fan-Out Failed', err);
  }
};

window.testRtdbRuleDenial = async () => {
  try {
    await sandboxDriver.testRtdbRuleDenial();
  } catch (err) {
    showErrorBanner('RTDB Declarative Rule Validation Failure (.validate Mismatch)', err);
  }
};

window.applyAiScenario = (val: any) => {
  sandboxDriver.setAiScenario(val);
};

window.handleGenerateTasks = async () => {
  const promptEl = $<HTMLInputElement>('ai-prompt-input');
  const btn = $<HTMLButtonElement>('ai-generate-btn');
  const outputContainer = $('ai-output-container');
  const suggestionsList = $('ai-suggestions-list');
  const statusBadge = $('ai-validation-status');
  const rawBox = $('ai-raw-text');

  if (!promptEl || !outputContainer || !suggestionsList || !statusBadge || !rawBox) return;
  const scenario = sandboxDriver.getAiScenario();
  
  if (btn) btn.disabled = true, btn.innerHTML = `<span>⏳ Synthesizing...</span>`;
  outputContainer.classList.remove('hidden'), outputContainer.classList.add('flex');

  try {
    if (scenario === 'quota_error') {
      throw { code: 'RESOURCE_EXHAUSTED', message: 'Simulated 429 Quota Exceeded error from generative AI broker.' };
    }
    
    const promptText = scenario === 'malformed' 
      ? 'Return unstructured plaintext markdown instead of valid JSON array' 
      : (promptEl.value || 'Generate 3 high-impact onboarding tasks');
      
    if (scenario === 'malformed') {
      rawBox.textContent = `Sure, here are some task recommendations:\n1. Audit security rules\n2. Configure IAM profiles\n3. Enable encryption`;
      statusBadge.className = "font-mono px-2 py-0.5 rounded text-[10px] bg-red-500/20 border border-red-500/30 text-red-400 font-bold uppercase";
      statusBadge.textContent = "SCHEMA_VALIDATION_REJECTED";
      suggestionsList.innerHTML = `
        <div class="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex flex-col gap-1.5">
          <p class="font-bold">⚠️ Pre-Write Schema Validation Failed (Zero Database Mutations Executed)</p>
          <p class="text-[11px] text-zinc-300">The model returned conversational markdown instead of a JSON task array. In accordance with safety principles, the output was rejected before reaching Firestore.</p>
        </div>
      `;
      return;
    }

    const res = await appService.generateTaskSuggestions(promptText);
    rawBox.textContent = res.raw;
    statusBadge.className = "font-mono px-2 py-0.5 rounded text-[10px] bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 font-bold uppercase";
    statusBadge.textContent = `VALID_SCHEMA (${res.items.length} items)`;

    suggestionsList.innerHTML = res.items.map(item => `
      <div class="p-3 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-between gap-3 hover:border-purple-500/50 transition-colors">
        <div class="flex flex-col gap-1 truncate">
          <strong class="text-white text-xs truncate">${item.title}</strong>
          <div class="flex items-center gap-2 text-[11px] text-zinc-400 font-mono">
            <span>Cat: ${item.category || 'Work'}</span> &bull; <span>Prio: ${item.priority || 'Medium'}</span>
          </div>
        </div>
        <button type="button" onclick="window.acceptAiTask('${item.title.replace(/'/g, "\\'")}', '${item.category || 'Work'}', '${item.priority || 'Medium'}')" class="px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs shrink-0 transition-colors">+ Add Task</button>
      </div>
    `).join('');

  } catch (err: any) {
    statusBadge.className = "font-mono px-2 py-0.5 rounded text-[10px] bg-red-500/20 border border-red-500/30 text-red-400 font-bold uppercase";
    statusBadge.textContent = "AI_SERVICE_ERROR";
    rawBox.textContent = JSON.stringify({ error: err.message, code: err.code || 'UNKNOWN' }, null, 2);
    suggestionsList.innerHTML = `
      <div class="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex flex-col gap-1.5">
        <p class="font-bold">🛑 AI Broker Request Denied (${err.code || 'ERROR'})</p>
        <p class="text-[11px] text-zinc-300">${err.message || 'Unknown exception during generation.'}</p>
      </div>
    `;
    showErrorBanner('Firebase AI Logic Service Error', err);
  } finally {
    if (btn) btn.disabled = false, btn.innerHTML = `<span>✨ Generate Tasks</span>`;
  }
};

window.acceptAiTask = async (title: string, cat: string, prio: 'Low'|'Medium'|'High') => {
  try {
    await appService.addTask(title, cat, prio);
    await window.simulatePushAlert('update');
  } catch (err) {
    showErrorBanner('Firestore Write Denied by Security Rules', err);
  }
};

window.handleEnablePushNotifications = async () => {
  try {
    const token = await appService.requestPushToken();
    const statusTextEl = $('fcm-status-text');
    const enableBtn = $('fcm-enable-btn');
    const disableBtn = $('fcm-disable-btn');

    if (statusTextEl) {
      statusTextEl.innerHTML = `<span class="inline-flex items-center gap-1.5 flex-wrap"><span>Active Token:</span> <code class="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 font-mono text-[10px] text-zinc-300 max-w-[140px] truncate inline-block align-bottom">${token}</code> <button type="button" onclick="window.copyFcmToken(event)" class="underline text-[11px] font-semibold text-white">Copy</button></span>`;
    }
    if (enableBtn) enableBtn.classList.add('hidden');
    if (disableBtn) disableBtn.classList.remove('hidden');

    // Route confirmation delivery through simulation seam
    await sandboxDriver.deliverSimulatedPush('silent', appService.messaging);
  } catch (err) {
    showErrorBanner('Cloud Messaging Token Enrollment Failed', err);
  }
};

window.handleRevokePushNotifications = async () => {
  appService.clearPushToken();
  const statusTextEl = $('fcm-status-text');
  const enableBtn = $('fcm-enable-btn');
  const disableBtn = $('fcm-disable-btn');

  if (statusTextEl) statusTextEl.textContent = 'Disabled (Token requested only via user gesture)';
  if (enableBtn) enableBtn.classList.remove('hidden');
  if (disableBtn) disableBtn.classList.add('hidden');
};

window.simulatePushAlert = async (type: 'overdue' | 'update' | 'silent') => {
  try {
    if (!appService.getActiveToken()) {
      showErrorBanner('FCM Simulation Denied', { message: 'Must enable push notification enrollment before delivering simulated payloads.' });
      return;
    }
    await sandboxDriver.deliverSimulatedPush(type, appService.messaging);
  } catch (err) {
    showErrorBanner('Simulated Push Delivery Failure', err);
  }
};

window.copyFcmToken = (e: Event) => {
  const token = appService.getActiveToken();
  const btn = e.target as HTMLElement;
  if (token && btn) {
    universalCopyText(token, () => {
      const orig = btn.textContent;
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.textContent = orig || 'Copy'; }, 2000);
    });
  }
};

window.dismissFcmToast = (id: string) => {
  const el = $(id);
  if (el) {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }
};

// Bind foreground notification reception to DOM toasts
appService.onPushMessage((payload: any) => {
  const container = $('fcm-toast-container');
  if (!container) return;

  const toastId = `toast_${Date.now()}_${Math.floor(Math.random()*1000)}`;
  const hasNotif = Boolean(payload.notification);
  const title = hasNotif ? (payload.notification.title || 'Notification') : '📦 Silent Data Sync Payload';
  const body = hasNotif ? payload.notification.body : 'Received payload without display notification block.';
  const dataJson = payload.data ? JSON.stringify(payload.data, null, 2) : '{}';

  const toastEl = document.createElement('div');
  toastEl.id = toastId;
  toastEl.className = "pointer-events-auto p-4 rounded-xl bg-zinc-900 border border-zinc-700 shadow-xl text-xs text-white transition-all transform duration-300 translate-y-2 opacity-0 flex flex-col gap-2.5 select-text cursor-text";
  toastEl.innerHTML = `
    <div class="flex items-start justify-between gap-2">
      <div class="flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-blue-500 animate-pulse shrink-0"></span>
        <strong class="text-sm font-bold text-white">${title}</strong>
      </div>
      <button type="button" onclick="window.dismissFcmToast('${toastId}')" class="text-zinc-400 hover:text-white font-bold px-1">&times;</button>
    </div>
    <p class="text-zinc-300 leading-normal">${body || ''}</p>
    <div class="flex flex-col gap-1 pt-1.5 border-t border-zinc-800 text-[11px]">
      <div class="flex justify-between font-mono font-semibold text-zinc-400">
        <span>payload.data:</span>
        <span class="text-blue-400">route: foreground</span>
      </div>
      <pre class="p-2 rounded bg-zinc-950 border border-zinc-800 font-mono text-[10px] overflow-x-auto text-zinc-200">${dataJson}</pre>
    </div>
  `;
  container.prepend(toastEl);
  setTimeout(() => { toastEl.style.opacity = '1'; toastEl.style.transform = 'translateY(0)'; }, 20);
  setTimeout(() => window.dismissFcmToast(toastId), 8000);
});
