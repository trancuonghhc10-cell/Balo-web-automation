let ws = null;
let activeAccountId = null;
let currentPage = 1;
const pageSize = 50;
let searchTimeout = null;

// Initialize Lucide icons
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  connectWebSocket();
  loadAccounts();
  loadDataGroups();
  loadCampaigns();
  loadPhoneChecks();
});

// --- WEBSOCKET CONNECTION ---
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    document.getElementById('ws-status-dot').className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse';
    document.getElementById('ws-status-text').innerText = 'Đã kết nối Socket';
    appendLog('[System] Đã kết nối WebSocket thành công.');
  };

  ws.onclose = () => {
    document.getElementById('ws-status-dot').className = 'w-2.5 h-2.5 rounded-full bg-rose-500';
    document.getElementById('ws-status-text').innerText = 'Mất kết nối Socket';
    setTimeout(connectWebSocket, 3000);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleSocketMessage(data);
    } catch (e) {
      console.error('Socket message parse error:', e);
    }
  };
}

function handleSocketMessage(msg) {
  appendLog(`[${new Date().toLocaleTimeString()}] [${msg.type}] ${msg.message || ''}`);

  if (msg.type === 'task_log') {
    // Already appended
    return;
  } else if (msg.type === 'qr_generated') {
    document.getElementById('qr-loading-spinner').classList.add('hidden');
    const qrImg = document.getElementById('qr-image');
    qrImg.src = msg.qrImage;
    qrImg.classList.remove('hidden');
    document.getElementById('qr-modal-message').innerText = msg.message;
    document.getElementById('qr-scanned-user').classList.add('hidden');
  } else if (msg.type === 'qr_scanned') {
    document.getElementById('qr-scanned-user').classList.remove('hidden');
    document.getElementById('qr-scanned-avatar').src = msg.avatar || 'https://via.placeholder.com/40';
    document.getElementById('qr-scanned-name').innerText = msg.name || 'Người dùng Zalo';
    document.getElementById('qr-modal-message').innerText = msg.message;
  } else if (msg.type === 'login_success') {
    closeQRModal();
    alert(`🎉 ${msg.message}`);
    loadAccounts();
  } else if (msg.type === 'scan_progress') {
    const box = document.getElementById('scan-progress-box');
    box.className = 'bg-blue-50 border border-blue-200 p-4 rounded-xl flex items-center justify-between';
    box.classList.remove('hidden');
    document.getElementById('scan-progress-spinner').className = 'w-8 h-8 rounded-full border-2 border-blue-600 border-t-transparent animate-spin';
    document.getElementById('scan-progress-text').innerText = msg.message;
    if (msg.current && msg.total) {
      document.getElementById('scan-progress-count').innerText = `${msg.current} / ${msg.total}`;
    } else if (msg.total) {
      document.getElementById('scan-progress-count').innerText = `${msg.total} mục`;
    }
  } else if (msg.type === 'scan_complete') {
    resetScanButton();
    const box = document.getElementById('scan-progress-box');
    box.className = 'bg-emerald-50 border border-emerald-200 p-4 rounded-xl flex items-center justify-between';
    document.getElementById('scan-progress-spinner').className = 'w-8 h-8 rounded-full bg-emerald-500 text-white flex items-center justify-center font-bold text-xs';
    document.getElementById('scan-progress-spinner').innerText = '✓';
    document.getElementById('scan-progress-text').innerText = msg.message;
    setTimeout(() => {
      document.getElementById('scan-progress-box').classList.add('hidden');
    }, 4000);
    loadContacts();
    loadGroups();
    const sel = document.getElementById('group-select');
    const targetGid = currentViewingGroupId || (sel ? sel.value : null);
    if (targetGid) {
      currentViewingGroupId = targetGid;
      loadGroupMembers(targetGid);
    }
  } else if (msg.type === 'scan_error') {
    resetScanButton();
    const box = document.getElementById('scan-progress-box');
    box.className = 'bg-rose-50 border border-rose-200 p-4 rounded-xl flex items-center justify-between';
    document.getElementById('scan-progress-spinner').className = 'w-8 h-8 rounded-full bg-rose-500 text-white flex items-center justify-center font-bold text-xs';
    document.getElementById('scan-progress-spinner').innerText = '✕';
    document.getElementById('scan-progress-text').innerText = `⚠️ Lỗi quét: ${msg.error || msg.message}`;
    setTimeout(() => {
      document.getElementById('scan-progress-box').classList.add('hidden');
    }, 5000);
  } else if (msg.type === 'phone_check_progress') {
    loadPhoneChecks();
  } else if (msg.type === 'phone_check_complete') {
    alert(msg.message);
    loadPhoneChecks();
  } else if (msg.type === 'campaign_progress' || msg.type === 'campaign_complete') {
    loadCampaigns();
  }
}

function appendLog(text) {
  const terminal = document.getElementById('log-terminal');
  if (!terminal) return;
  const line = document.createElement('div');
  line.innerText = text;
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

function clearLogs() {
  const terminal = document.getElementById('log-terminal');
  if (terminal) terminal.innerHTML = '<div>[System] Log cleared.</div>';
}

// --- TABS SWITCHING ---
function switchTab(tabId) {
  const sections = ['data', 'zalo-tools', 'facebook', 'tiktok', 'ai', 'data-groups', 'phone-check', 'campaigns', 'accounts', 'logs'];
  sections.forEach((s) => {
    const el = document.getElementById(`section-${s}`);
    const btn = document.getElementById(`tab-${s}-btn`);
    if (el) el.classList.add('hidden');
    if (btn) {
      btn.className = 'nav-btn w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition text-slate-400 hover:text-white hover:bg-slate-800';
    }
  });

  const activeEl = document.getElementById(`section-${tabId}`);
  const activeBtn = document.getElementById(`tab-${tabId}-btn`);
  if (activeEl) activeEl.classList.remove('hidden');
  if (activeBtn) {
    activeBtn.className = 'nav-btn w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition text-white bg-blue-600 shadow-md shadow-blue-600/30';
  }

  const titles = {
    'data': 'Quét Dữ Liệu Zalo (/data)',
    'zalo-tools': 'Zalo Auto Tool (56 Hàm Tự Động Hóa)',
    'facebook': 'Facebook Auto Tool (Chrome Native Automation)',
    'tiktok': 'TikTok Auto Tool (41 Hàm Tự Động Hóa)',
    'ai': 'AI Intelligent Content Engine (14 Hàm AI)',
    'data-groups': 'Quản Lý Nhóm Data (/data-groups)',
    'phone-check': 'Kiểm Tra SĐT Có Zalo',
    'campaigns': 'Chiến Dịch Tự Động Gửi Tin (/campaigns)',
    'accounts': 'Quản Lý Tài Khoản Đa Nền Tảng',
    'logs': 'Nhật Ký Realtime (Logs)'
  };
  document.getElementById('page-title').innerText = titles[tabId] || 'akaAgent Ubuntu';
  lucide.createIcons();
}

// --- MODAL TABS: QR vs COOKIE ---
function switchModalTab(tab) {
  const qrView = document.getElementById('modal-view-qr');
  const cookieView = document.getElementById('modal-view-cookie');
  const qrBtn = document.getElementById('modal-tab-qr-btn');
  const cookieBtn = document.getElementById('modal-tab-cookie-btn');

  if (tab === 'qr') {
    qrView.classList.remove('hidden');
    cookieView.classList.add('hidden');
    qrBtn.className = 'flex-1 py-1.5 rounded-lg text-xs font-bold transition bg-white text-blue-600 shadow-sm';
    cookieBtn.className = 'flex-1 py-1.5 rounded-lg text-xs font-bold transition text-slate-500 hover:text-slate-800';
    // Trigger fresh QR
    fetch('/api/auth/qr', { method: 'POST' });
  } else {
    qrView.classList.add('hidden');
    cookieView.classList.remove('hidden');
    cookieBtn.className = 'flex-1 py-1.5 rounded-lg text-xs font-bold transition bg-white text-blue-600 shadow-sm';
    qrBtn.className = 'flex-1 py-1.5 rounded-lg text-xs font-bold transition text-slate-500 hover:text-slate-800';
  }
  lucide.createIcons();
}

async function submitCookieLogin() {
  const cookieText = document.getElementById('cookie-input').value.trim();
  if (!cookieText) return alert('Vui lòng nhập chuỗi Cookie từ chat.zalo.me!');

  const btn = document.getElementById('cookie-login-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div> <span>Đang xác thực...</span>';

  try {
    const res = await fetch('/api/auth/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: cookieText })
    });
    const json = await res.json();
    if (json.ok) {
      closeQRModal();
      alert(`🎉 Đăng nhập thành công tài khoản: ${json.data.displayName || 'Zalo'}!`);
      loadAccounts();
    } else {
      alert(`⚠️ Lỗi đăng nhập: ${json.error || 'Cookie không hợp lệ hoặc đã hết hạn.'}`);
    }
  } catch (err) {
    alert(`Lỗi kết nối máy chủ: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="log-in" class="w-4 h-4"></i> <span>Xác Nhận Đăng Nhập Cookie</span>';
    lucide.createIcons();
  }
}

// --- ACCOUNTS MANAGEMENT ---
async function loadAccounts() {
  try {
    const res = await fetch('/api/accounts');
    const json = await res.json();
    const select = document.getElementById('active-account-select');
    const grid = document.getElementById('accounts-grid');
    
    select.innerHTML = '';
    grid.innerHTML = '';

    if (json.data && json.data.length > 0) {
      json.data.forEach((acc, i) => {
        const opt = document.createElement('option');
        opt.value = acc.id;
        opt.innerText = `${acc.name} (${acc.isConnected ? '🟢 Online' : '⚪ Offline'})`;
        select.appendChild(opt);

        const card = document.createElement('div');
        card.className = 'bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between';
        card.innerHTML = `
          <div class="flex items-center gap-3 mb-4">
            <img src="${acc.avatar || 'https://via.placeholder.com/48'}" class="w-12 h-12 rounded-full border border-slate-200 object-cover" />
            <div>
              <h4 class="font-bold text-sm text-slate-800">${acc.name}</h4>
              <p class="text-xs text-slate-400 font-mono">UID: ${acc.zalo_id || acc.id}</p>
              <span class="inline-block mt-1 text-[11px] px-2 py-0.5 rounded-full font-medium ${acc.isConnected ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}">
                ${acc.isConnected ? '● Đang kết nối' : '○ Đã lưu phiên'}
              </span>
            </div>
          </div>
          <div class="flex items-center justify-between pt-3 border-t border-slate-100 text-xs">
            <button onclick="selectAndScan(${acc.id})" class="text-blue-600 hover:underline font-semibold">Quét dữ liệu</button>
            <button onclick="deleteAccount(${acc.id})" class="text-rose-600 hover:underline">Xóa tài khoản</button>
          </div>
        `;
        grid.appendChild(card);
      });

      if (!activeAccountId || !json.data.some(a => a.id == activeAccountId)) {
        activeAccountId = json.data[0].id;
        select.value = activeAccountId;
      } else {
        select.value = activeAccountId;
      }
      loadContacts();
      loadGroups();
    } else {
      select.innerHTML = '<option value="">Chưa có tài khoản</option>';
      grid.innerHTML = '<div class="col-span-3 text-center p-8 text-slate-400 bg-white rounded-xl border border-dashed border-slate-300">Chưa có tài khoản Zalo nào. Vui lòng bấm "Thêm Tài Khoản" để kết nối.</div>';
    }
  } catch (err) {
    console.error('Error loading accounts:', err);
  }
}

function onAccountChange() {
  activeAccountId = document.getElementById('active-account-select').value;
  loadContacts();
  loadGroups();
}

function selectAndScan(accId) {
  activeAccountId = accId;
  document.getElementById('active-account-select').value = accId;
  switchTab('data');
  loadContacts();
}

async function deleteAccount(accId) {
  if (!confirm('Bạn có chắc chắn muốn xóa tài khoản này?')) return;
  await fetch(`/api/accounts/${accId}`, { method: 'DELETE' });
  loadAccounts();
}

// --- QR MODAL ---
function openQRModal() {
  document.getElementById('qr-modal').classList.remove('hidden');
  switchModalTab('qr');
}

function closeQRModal() {
  document.getElementById('qr-modal').classList.add('hidden');
}

// --- CONTACTS / DATA SCANNING & MULTI-VIEW ---
let currentDataView = 'friends';
let currentViewingGroupId = null;
let currentViewingGroupName = '';

function switchDataView(view) {
  currentDataView = view;
  const btnFriends = document.getElementById('view-tab-friends');
  const btnGroups = document.getElementById('view-tab-groups');
  const btnMembers = document.getElementById('view-tab-members');

  const containerFriends = document.getElementById('table-container-friends');
  const containerGroups = document.getElementById('table-container-groups');
  const containerMembers = document.getElementById('table-container-members');

  const groupSelectWrapper = document.getElementById('group-select-wrapper');
  const searchWrapper = document.getElementById('search-filter-wrapper');
  const genderWrapper = document.getElementById('gender-filter-wrapper');
  const exportBtn = document.getElementById('export-excel-btn');
  const actionSelect = document.getElementById('data-action-select');
  const scanBtnText = document.getElementById('trigger-scan-text');

  // Reset tab button styles
  const activeClass = 'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold bg-blue-600 text-white shadow-sm transition';
  const inactiveClass = 'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-200 transition';

  btnFriends.className = view === 'friends' ? activeClass : inactiveClass;
  btnGroups.className = view === 'groups' ? activeClass : inactiveClass;
  btnMembers.className = view === 'members' ? activeClass : inactiveClass;

  containerFriends.classList.add('hidden');
  containerGroups.classList.add('hidden');
  containerMembers.classList.add('hidden');

  if (view === 'friends') {
    containerFriends.classList.remove('hidden');
    groupSelectWrapper.classList.add('hidden');
    searchWrapper.classList.remove('hidden');
    genderWrapper.classList.remove('hidden');
    exportBtn.href = '/api/export/contacts';
    exportBtn.innerHTML = '<i data-lucide="file-spreadsheet" class="w-4 h-4 text-emerald-600"></i><span>Xuất Excel Bạn Bè</span>';
    actionSelect.value = 'friends';
    scanBtnText.innerText = 'Bắt Đầu Quét Bạn Bè';
    loadContacts();
  } else if (view === 'groups') {
    containerGroups.classList.remove('hidden');
    groupSelectWrapper.classList.add('hidden');
    searchWrapper.classList.add('hidden');
    genderWrapper.classList.add('hidden');
    exportBtn.href = '/api/export/groups';
    exportBtn.innerHTML = '<i data-lucide="file-spreadsheet" class="w-4 h-4 text-emerald-600"></i><span>Xuất Excel Nhóm</span>';
    actionSelect.value = 'groups';
    scanBtnText.innerText = 'Bắt Đầu Quét 110 Nhóm';
    loadGroups();
  } else if (view === 'members') {
    containerMembers.classList.remove('hidden');
    groupSelectWrapper.classList.remove('hidden');
    searchWrapper.classList.add('hidden');
    genderWrapper.classList.add('hidden');
    actionSelect.value = 'group_members';
    scanBtnText.innerText = 'Bắt Đầu Quét Thành Viên';
    if (currentViewingGroupId) {
      loadGroupMembers(currentViewingGroupId, currentViewingGroupName);
    }
  }
  lucide.createIcons();
}

function refreshCurrentView() {
  if (currentDataView === 'friends') loadContacts();
  else if (currentDataView === 'groups') loadGroups();
  else if (currentDataView === 'members' && currentViewingGroupId) loadGroupMembers(currentViewingGroupId, currentViewingGroupName);
}

function onDataActionChange() {
  const action = document.getElementById('data-action-select').value;
  if (action === 'friends' || action === 'recommends') switchDataView('friends');
  else if (action === 'groups') switchDataView('groups');
  else if (action === 'group_members' || action === 'group_members_deep') switchDataView('members');
}

function onGroupSelectChange() {
  const sel = document.getElementById('group-select');
  const gid = sel.value;
  const name = sel.options[sel.selectedIndex]?.text || '';
  if (gid) {
    viewGroupMembers(gid, name);
  }
}

function resetScanButton() {
  const btn = document.getElementById('trigger-scan-btn');
  btn.disabled = false;
  btn.className = 'flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-bold shadow-md shadow-emerald-600/20 transition cursor-pointer';
  const scanBtnText = document.getElementById('trigger-scan-text');
  if (currentDataView === 'friends') scanBtnText.innerText = 'Bắt Đầu Quét Bạn Bè';
  else if (currentDataView === 'groups') scanBtnText.innerText = 'Bắt Đầu Quét 110 Nhóm';
  else scanBtnText.innerText = 'Bắt Đầu Quét Thành Viên';
  lucide.createIcons();
}

async function triggerScan() {
  if (!activeAccountId) return alert('Vui lòng chọn hoặc thêm tài khoản Zalo trước!');
  const action = document.getElementById('data-action-select').value;

  const btn = document.getElementById('trigger-scan-btn');
  btn.disabled = true;
  btn.className = 'flex items-center gap-2 px-5 py-2.5 bg-slate-400 text-white rounded-lg text-sm font-bold shadow-none transition cursor-not-allowed';
  document.getElementById('trigger-scan-text').innerText = 'Đang gửi yêu cầu...';

  try {
    if (action === 'friends') {
      const res = await fetch('/api/scan/friends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: activeAccountId })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
    } else if (action === 'recommends') {
      const res = await fetch('/api/scan/recommends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: activeAccountId })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
    } else if (action === 'groups') {
      const res = await fetch('/api/scan/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: activeAccountId })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
    } else if (action === 'group_members' || action === 'group_members_deep') {
      const groupId = document.getElementById('group-select').value;
      if (!groupId) {
        resetScanButton();
        return alert('Vui lòng chọn nhóm cần quét thành viên!');
      }
      const isDeep = (action === 'group_members_deep');
      const endpoint = isDeep ? '/api/scan/group-members-deep' : '/api/scan/group-members';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: activeAccountId, group_id: groupId, mode: isDeep ? 'deep' : 'fast' })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
    }
  } catch (err) {
    resetScanButton();
    alert('Lỗi kích hoạt quét: ' + err.message);
  }
}

async function loadContacts() {
  if (!activeAccountId) return;
  const search = document.getElementById('contact-search').value;
  const gender = document.getElementById('contact-gender').value;
  const offset = (currentPage - 1) * pageSize;

  let url = `/api/contacts?account_id=${activeAccountId}&limit=${pageSize}&offset=${offset}`;
  if (search) url += `&search=${encodeURIComponent(search)}`;
  if (gender) url += `&gender=${encodeURIComponent(gender)}`;

  try {
    const res = await fetch(url);
    const json = await res.json();
    const tbody = document.getElementById('contacts-table-body');
    tbody.innerHTML = '';

    if (json.items && json.items.length > 0) {
      json.items.forEach((c, idx) => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-50 transition border-b border-slate-100';
        tr.innerHTML = `
          <td class="p-3.5 text-center text-xs font-mono text-slate-400">${offset + idx + 1}</td>
          <td class="p-3.5 text-center">
            <img src="${c.avatar_url || 'https://via.placeholder.com/32'}" class="w-8 h-8 rounded-full border border-slate-200 mx-auto object-cover" />
          </td>
          <td class="p-3.5 font-semibold text-slate-800">${c.name || '—'}</td>
          <td class="p-3.5 text-slate-500">${c.zalo_name || '—'}</td>
          <td class="p-3.5 font-mono text-xs text-blue-600 font-medium">${c.phone || 'Chưa có'}</td>
          <td class="p-3.5 text-xs">${c.gender || '—'}</td>
          <td class="p-3.5 font-mono text-xs text-slate-500">${c.uid}</td>
          <td class="p-3.5 text-center">
            <span class="text-[11px] px-2 py-0.5 rounded-full ${c.is_friend ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}">
              ${c.is_friend ? 'Bạn bè' : 'Người lạ'}
            </span>
          </td>
          <td class="p-3.5 text-right">
            <button onclick="promptSendMessage('${c.uid}', '${c.name || ''}')" class="text-xs text-blue-600 hover:text-blue-800 font-medium">Nhắn tin</button>
          </td>
        `;
        tbody.appendChild(tr);
      });
      document.getElementById('contacts-count-text').innerText = `Hiển thị ${json.items.length} / tổng ${json.total} bạn bè`;
      document.getElementById('badge-friends-count').innerText = json.total;
    } else {
      tbody.innerHTML = '<tr><td colspan="9" class="p-8 text-center text-slate-400">Không có dữ liệu phù hợp bộ lọc.</td></tr>';
      document.getElementById('contacts-count-text').innerText = '0 dữ liệu';
    }
  } catch (err) {
    console.error('Error loading contacts:', err);
  }
}

function debounceSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    currentPage = 1;
    document.getElementById('page-num').innerText = '1';
    loadContacts();
  }, 350);
}

function prevPage() {
  if (currentPage > 1) {
    currentPage--;
    document.getElementById('page-num').innerText = currentPage;
    loadContacts();
  }
}

function nextPage() {
  currentPage++;
  document.getElementById('page-num').innerText = currentPage;
  loadContacts();
}

async function loadGroups() {
  if (!activeAccountId) return;
  try {
    const res = await fetch(`/api/groups?account_id=${activeAccountId}`);
    const json = await res.json();
    const select = document.getElementById('group-select');
    select.innerHTML = '<option value="">-- Chọn nhóm Zalo --</option>';

    const tbody = document.getElementById('groups-table-body');
    tbody.innerHTML = '';

    if (json.items && json.items.length > 0) {
      document.getElementById('badge-groups-count').innerText = json.items.length;
      document.getElementById('groups-count-text').innerText = `Hiển thị tổng số ${json.items.length} nhóm Zalo`;

      json.items.forEach((g, idx) => {
        // Option in select
        const opt = document.createElement('option');
        opt.value = g.group_id;
        opt.innerText = `${g.name} (${g.member_count} tv)`;
        select.appendChild(opt);

        // Row in table
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-50 transition border-b border-slate-100';
        tr.innerHTML = `
          <td class="p-3.5 text-center text-xs font-mono text-slate-400">${idx + 1}</td>
          <td class="p-3.5 text-center">
            <img src="${g.avatar_url || 'https://via.placeholder.com/32'}" class="w-8 h-8 rounded-full border border-slate-200 mx-auto object-cover" />
          </td>
          <td class="p-3.5 font-semibold text-slate-800">${g.name || 'Nhóm không tên'}</td>
          <td class="p-3.5 font-mono text-xs text-slate-500">${g.group_id}</td>
          <td class="p-3.5 text-center font-bold text-blue-600">${g.member_count}</td>
          <td class="p-3.5 text-center">
            <span class="text-[11px] px-2 py-0.5 rounded-full ${g.is_joined ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}">
              ${g.is_joined ? 'Đã tham gia' : 'Rời nhóm'}
            </span>
          </td>
          <td class="p-3.5 text-right space-x-2">
            <button onclick="scanSingleGroup('${g.group_id}')" class="px-2.5 py-1 text-xs bg-emerald-50 text-emerald-700 border border-emerald-300 rounded hover:bg-emerald-100 font-semibold">Quét Thành Viên</button>
            <button onclick="viewGroupMembers('${g.group_id}', '${g.name.replace(/'/g, "\\'")}')" class="px-2.5 py-1 text-xs bg-blue-50 text-blue-700 border border-blue-300 rounded hover:bg-blue-100 font-semibold">Xem TV</button>
          </td>
        `;
        tbody.appendChild(tr);
      });
    } else {
      tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400">Chưa có nhóm nào. Vui lòng bấm "Bắt Đầu Quét 110 Nhóm".</td></tr>';
      document.getElementById('groups-count-text').innerText = '0 nhóm';
    }
  } catch (e) {
    console.error('Failed to load groups:', e);
  }
}

async function scanSingleGroup(groupId) {
  if (!activeAccountId) return alert('Vui lòng chọn tài khoản Zalo trước!');
  document.getElementById('group-select').value = groupId;
  switchDataView('members');
  await triggerScan();
}

async function viewGroupMembers(groupId, groupName) {
  currentViewingGroupId = groupId;
  currentViewingGroupName = groupName || groupId;
  document.getElementById('group-select').value = groupId;
  switchDataView('members');
  await loadGroupMembers(groupId, groupName);
}

async function loadGroupMembers(groupId, groupName) {
  if (!groupId) return;
  try {
    const res = await fetch(`/api/group-members/${groupId}`);
    const json = await res.json();
    const tbody = document.getElementById('members-table-body');
    tbody.innerHTML = '';

    document.getElementById('current-group-viewing-title').innerText = `Thành viên nhóm: ${groupName || groupId}`;

    if (json.items && json.items.length > 0) {
      document.getElementById('badge-members-count').innerText = json.items.length;
      document.getElementById('members-count-text').innerText = `Tổng số ${json.items.length} thành viên đã quét`;

      json.items.forEach((m, idx) => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-50 transition border-b border-slate-100';
        tr.innerHTML = `
          <td class="p-3.5 text-center text-xs font-mono text-slate-400">${idx + 1}</td>
          <td class="p-3.5 text-center">
            <img src="${m.avatar_url || 'https://via.placeholder.com/32'}" class="w-8 h-8 rounded-full border border-slate-200 mx-auto object-cover" />
          </td>
          <td class="p-3.5 font-semibold text-slate-800">${m.name || 'Thành viên Zalo'}</td>
          <td class="p-3.5 font-mono text-xs text-slate-500">${m.uid}</td>
          <td class="p-3.5 text-center">
            <span class="text-[11px] px-2 py-0.5 rounded-full ${
              m.role === 'creator' ? 'bg-amber-100 text-amber-800 font-bold' :
              m.role === 'admin' ? 'bg-blue-100 text-blue-800 font-semibold' :
              'bg-slate-100 text-slate-600'
            }">
              ${m.role === 'creator' ? 'Trưởng nhóm' : m.role === 'admin' ? 'Phó nhóm' : 'Thành viên'}
            </span>
          </td>
          <td class="p-3.5 text-center">
            <span class="text-[11px] px-2 py-0.5 rounded-full ${m.is_friend ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}">
              ${m.is_friend ? '● Bạn bè' : '○ Người lạ'}
            </span>
          </td>
          <td class="p-3.5 text-center">
            <span class="text-[11px] px-2 py-0.5 rounded-full ${m.is_hidden ? 'bg-purple-100 text-purple-700 font-semibold' : 'bg-blue-100 text-blue-700'}">
              ${m.is_hidden ? 'Thành viên ẩn' : 'Công khai'}
            </span>
          </td>
          <td class="p-3.5 text-right space-x-2">
            <button onclick="openShareMsgModal('${m.uid}', '${(m.name || '').replace(/'/g, "\\'")}')" class="px-2.5 py-1 text-xs bg-blue-50 text-blue-700 border border-blue-300 rounded hover:bg-blue-100 font-semibold">Nhắn tin (Share)</button>
          </td>
        `;
        tbody.appendChild(tr);
      });
    } else {
      document.getElementById('badge-members-count').innerText = '0';
      document.getElementById('members-count-text').innerText = '0 thành viên';
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="p-8 text-center text-slate-400">
            Nhóm này chưa được quét thành viên. Bấm nút <b>"Quét Chuyên Sâu (Thành Viên Ẩn)"</b> ở trên để tải danh sách thành viên Zalo.
          </td>
        </tr>
      `;
    }
  } catch (e) {
    console.error('Failed to load group members:', e);
  }
}

// --- PHONE CHECK LOGIC ---
async function startPhoneCheck() {
  if (!activeAccountId) return alert('Vui lòng chọn tài khoản Zalo trước!');
  const raw = document.getElementById('phone-input').value;
  const phones = raw.split('\n').map(p => p.trim()).filter(Boolean);
  if (phones.length === 0) return alert('Vui lòng nhập ít nhất 1 số điện thoại!');

  document.getElementById('phone-count-badge').innerText = `Đang gửi ${phones.length} SĐT...`;

  try {
    const res = await fetch('/api/phone-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: activeAccountId, phones })
    });
    const json = await res.json();
    if (json.ok) {
      alert(`Đã kích hoạt kiểm tra ${phones.length} SĐT! Tiến trình hiển thị realtime.`);
    }
  } catch (e) {
    alert('Lỗi: ' + e.message);
  }
}

async function loadPhoneChecks() {
  try {
    const res = await fetch('/api/phone-checks');
    const json = await res.json();
    const tbody = document.getElementById('phone-results-body');
    tbody.innerHTML = '';
    if (json.items && json.items.length > 0) {
      json.items.forEach(item => {
        const tr = document.createElement('tr');
        tr.className = 'border-b border-slate-100 hover:bg-slate-50';
        tr.innerHTML = `
          <td class="p-2.5 font-mono font-medium">${item.phone}</td>
          <td class="p-2.5">
            <span class="px-2 py-0.5 rounded text-[10px] font-semibold ${item.has_zalo ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">
              ${item.has_zalo ? 'Có Zalo' : 'Không có Zalo'}
            </span>
          </td>
          <td class="p-2.5 font-semibold text-slate-800">${item.zalo_name || '—'}</td>
          <td class="p-2.5 font-mono text-slate-400">${item.zalo_id || '—'}</td>
          <td class="p-2.5 text-slate-400 text-[11px]">${new Date(item.checked_at).toLocaleTimeString()}</td>
        `;
        tbody.appendChild(tr);
      });
    } else {
      tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-400">Chưa có lượt kiểm tra nào.</td></tr>';
    }
  } catch (e) {
    console.error('Error loading phone checks:', e);
  }
}

// --- DATA GROUPS LOGIC ---
async function loadDataGroups() {
  try {
    const res = await fetch('/api/data-groups');
    const json = await res.json();
    const grid = document.getElementById('data-groups-grid');
    grid.innerHTML = '';

    if (json.items && json.items.length > 0) {
      json.items.forEach(dg => {
        const card = document.createElement('div');
        card.className = 'bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between';
        card.innerHTML = `
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs uppercase font-mono px-2 py-0.5 rounded bg-blue-50 text-blue-600 font-bold">${dg.contact_type}</span>
              <span class="text-xs text-slate-400">${new Date(dg.created_at).toLocaleDateString()}</span>
            </div>
            <h4 class="font-bold text-base text-slate-800 mb-1">${dg.name}</h4>
            <p class="text-xs text-slate-500 mb-3">${dg.description || 'Chưa có mô tả'}</p>
          </div>
          <div class="pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
            <span class="font-semibold text-slate-700">${dg.member_count || 0} liên hệ</span>
            <span class="text-blue-600 font-medium">Nguồn: ${dg.source}</span>
          </div>
        `;
        grid.appendChild(card);
      });
    } else {
      grid.innerHTML = '<div class="col-span-3 text-center p-8 text-slate-400 bg-white rounded-xl border border-dashed border-slate-300">Chưa có nhóm data nào. Hãy bấm "Tạo Nhóm Data Mới".</div>';
    }
  } catch (e) {
    console.error('Error loading data groups:', e);
  }
}

function openCreateGroupModal() {
  const name = prompt('Nhập tên Nhóm Data mới:');
  if (!name) return;
  const desc = prompt('Mô tả nhóm data (tùy chọn):') || '';
  fetch('/api/data-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description: desc, source: 'scan', contact_type: 'person' })
  }).then(() => loadDataGroups());
}

// --- CAMPAIGNS LOGIC ---
async function loadCampaigns() {
  try {
    const res = await fetch('/api/campaigns');
    const json = await res.json();
    const tbody = document.getElementById('campaigns-table-body');
    tbody.innerHTML = '';

    if (json.items && json.items.length > 0) {
      json.items.forEach(c => {
        const tr = document.createElement('tr');
        tr.className = 'border-b border-slate-100 hover:bg-slate-50';
        tr.innerHTML = `
          <td class="p-3.5">
            <p class="font-bold text-slate-800">${c.name}</p>
            <p class="text-xs text-slate-400 font-mono truncate max-w-xs">${c.template}</p>
          </td>
          <td class="p-3.5 text-xs text-slate-600">${c.type}</td>
          <td class="p-3.5">
            <span class="px-2 py-0.5 rounded text-xs font-semibold ${
              c.status === 'running' ? 'bg-amber-100 text-amber-800 animate-pulse' :
              c.status === 'completed' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'
            }">
              ${c.status}
            </span>
          </td>
          <td class="p-3.5 text-xs font-semibold">
            ${c.sent_count} / ${c.total_count} (Lỗi: ${c.failed_count})
          </td>
          <td class="p-3.5 text-xs font-mono">${c.delay_min}s - ${c.delay_max}s</td>
          <td class="p-3.5 text-right space-x-2">
            ${c.status === 'running' ? 
              `<button onclick="stopCampaign(${c.id})" class="px-2.5 py-1 bg-amber-600 text-white rounded text-xs font-medium">Dừng</button>` :
              `<button onclick="startCampaign(${c.id})" class="px-2.5 py-1 bg-emerald-600 text-white rounded text-xs font-medium">Bắt đầu</button>`
            }
          </td>
        `;
        tbody.appendChild(tr);
      });
    } else {
      tbody.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-slate-400">Chưa có chiến dịch nào được tạo.</td></tr>';
    }
  } catch (e) {
    console.error('Error loading campaigns:', e);
  }
}

function openCreateCampaignModal() {
  document.getElementById('campaign-modal').classList.remove('hidden');
}

function closeCampaignModal() {
  document.getElementById('campaign-modal').classList.add('hidden');
}

async function saveCampaign() {
  if (!activeAccountId) return alert('Vui lòng chọn tài khoản Zalo trước!');
  const name = document.getElementById('campaign-name').value;
  const type = document.getElementById('campaign-type').value;
  const template = document.getElementById('campaign-template').value;
  const delay_min = Number(document.getElementById('campaign-delay-min').value) || 5;
  const delay_max = Number(document.getElementById('campaign-delay-max').value) || 15;

  if (!name || !template) return alert('Vui lòng điền đủ tên và nội dung tin nhắn!');

  await fetch('/api/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      account_id: activeAccountId,
      type,
      template,
      delay_min,
      delay_max
    })
  });

  closeCampaignModal();
  loadCampaigns();
}

async function startCampaign(id) {
  await fetch(`/api/campaigns/${id}/start`, { method: 'POST' });
  loadCampaigns();
}

async function stopCampaign(id) {
  await fetch(`/api/campaigns/${id}/stop`, { method: 'POST' });
  loadCampaigns();
}

function promptSendMessage(uid, name) {
  const msg = prompt(`Nhập tin nhắn gửi tới ${name} (${uid}):`);
  if (!msg) return;
  fetch('/api/zalo/send-friend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: activeAccountId, uid, message: msg })
  }).then(res => res.json()).then(r => {
    if (r.ok) alert(`✅ Đã gửi tin nhắn thành công tới ${name}!`);
    else alert(`⚠️ Lỗi: ${r.error}`);
  });
}

// ================= ZALO AUTO TOOL HANDLERS =================
async function executeZaloSendPhone() {
  const phone = document.getElementById('zalo-send-phone-num').value.trim();
  const message = document.getElementById('zalo-send-phone-msg').value.trim();
  if (!phone || !message) return alert('Vui lòng nhập đầy đủ SĐT và nội dung tin nhắn!');

  appendLog(`[BOT] Bắt đầu gửi tin nhắn tới SĐT ${phone}...`);
  const res = await fetch('/api/zalo/send-phone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: activeAccountId, phone, message })
  });
  const data = await res.json();
  if (data.ok) alert(`✅ Đã gửi tin nhắn tới ${phone}!`);
  else alert(`⚠️ Lỗi gửi tin: ${data.error}`);
}

async function executeZaloHpbd() {
  const template = document.getElementById('zalo-hpbd-template').value.trim();
  appendLog('[BOT] Bắt đầu tiến trình quét và chúc mừng sinh nhật bạn bè Zalo...');
  const res = await fetch('/api/zalo/send-hpbd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: activeAccountId, template })
  });
  const data = await res.json();
  alert(data.message || 'Tiến trình gửi lời chúc sinh nhật đang chạy ngầm.');
}

async function executeZaloAddPhone() {
  const phone = document.getElementById('zalo-add-phone-num').value.trim();
  const greeting = document.getElementById('zalo-add-phone-greeting').value.trim();
  if (!phone) return alert('Vui lòng nhập SĐT cần kết bạn!');

  appendLog(`[BOT] Gửi lời mời kết bạn tới ${phone}...`);
  const res = await fetch('/api/zalo/add-friend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: activeAccountId, phone, greeting })
  });
  const data = await res.json();
  if (data.ok) alert(`✅ Đã gửi lời mời kết bạn tới SĐT ${phone}!`);
  else alert(`⚠️ Kết quả: ${data.reason || data.error}`);
}

async function executeZaloAddRecommend() {
  const limit = document.getElementById('zalo-recommend-limit').value || 10;
  appendLog(`[BOT] Bắt đầu kết bạn gợi ý (tối đa ${limit} người)...`);
  const res = await fetch('/api/zalo/add-recommend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: activeAccountId, limit })
  });
  const data = await res.json();
  alert(data.message || 'Đang thực thi kết bạn gợi ý.');
}

async function executeZaloAcceptFriends() {
  const limit = document.getElementById('zalo-accept-limit').value || 20;
  appendLog(`[BOT] Tự động đồng ý tối đa ${limit} lời mời kết bạn...`);
  const res = await fetch('/api/zalo/accept-friends', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: activeAccountId, limit })
  });
  const data = await res.json();
  alert(data.message || 'Đang thực thi đồng ý kết bạn.');
}

async function executeZaloJoinGroupLink() {
  const link = document.getElementById('zalo-group-link').value.trim();
  if (!link) return alert('Vui lòng nhập link nhóm Zalo!');

  appendLog(`[BOT] Đang mở link tham gia nhóm: ${link}...`);
  const res = await fetch('/api/zalo/join-group-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: activeAccountId, link })
  });
  const data = await res.json();
  if (data.ok) alert('✅ Đã bấm tham gia nhóm thành công!');
  else alert(`⚠️ Không thể tham gia nhóm: ${data.reason || data.error}`);
}

// ================= FACEBOOK AUTO TOOL HANDLERS =================
async function openFacebookChromeLogin() {
  appendLog('[BOT] Mở Chrome đăng nhập Facebook...');
  const res = await fetch('/api/facebook/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: 1 })
  });
  const data = await res.json();
  alert(data.message || 'Đã mở cửa sổ Chrome Facebook.');
}

async function executeFbNewsfeed() {
  const minutes = document.getElementById('fb-surf-minutes').value || 5;
  const like_rate = document.getElementById('fb-like-rate').value || 0.4;
  appendLog(`[BOT] Bắt đầu nuôi nick lướt Newsfeed Facebook trong ${minutes} phút (like rate: ${like_rate})...`);

  const res = await fetch('/api/facebook/newsfeed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: 1, minutes, like_rate })
  });
  const data = await res.json();
  alert(data.message || 'Đã khởi động nuôi nick Facebook!');
}

async function executeFbPostProfile() {
  const content = document.getElementById('fb-post-content').value.trim();
  if (!content) return alert('Vui lòng nhập nội dung bài viết!');

  appendLog('[BOT] Bắt đầu đăng bài lên trang cá nhân Facebook...');
  const res = await fetch('/api/facebook/post-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: 1, content })
  });
  const data = await res.json();
  if (data.ok) alert('✅ Đã đăng bài lên trang cá nhân Facebook thành công!');
  else alert(`⚠️ Lỗi: ${data.error}`);
}

async function executeFbPostGroup() {
  const group_id = document.getElementById('fb-post-group-url').value.trim();
  const content = document.getElementById('fb-post-group-content').value.trim();
  if (!group_id || !content) return alert('Vui lòng nhập link nhóm và nội dung!');

  appendLog(`[BOT] Đăng bài vào nhóm: ${group_id}...`);
  const res = await fetch('/api/facebook/post-group', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: 1, group_id, content })
  });
  const data = await res.json();
  if (data.ok) alert('✅ Đã đăng bài vào nhóm Facebook thành công!');
  else alert(`⚠️ Lỗi: ${data.error}`);
}

async function executeFbAddRecommend() {
  const limit = document.getElementById('fb-recommend-limit').value || 10;
  appendLog(`[BOT] Kết bạn theo gợi ý Facebook (${limit} người)...`);
  const res = await fetch('/api/facebook/add-recommend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: 1, limit })
  });
  const data = await res.json();
  alert(data.message || 'Đã bắt đầu kết bạn gợi ý Facebook!');
}

async function executeFbScanComments() {
  const post_url = document.getElementById('fb-scan-post-url').value.trim();
  if (!post_url) return alert('Vui lòng nhập link bài viết Facebook!');

  appendLog(`[BOT] Quét bình luận bài viết: ${post_url}...`);
  const res = await fetch('/api/facebook/scan-comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: 1, post_url })
  });
  const data = await res.json();
  const resultDiv = document.getElementById('fb-scan-results');
  resultDiv.classList.remove('hidden');

  if (data.ok && data.comments && data.comments.length > 0) {
    resultDiv.innerHTML = `<p class="font-bold text-slate-800 mb-2">Đã tìm thấy ${data.comments.length} bình luận:</p>` +
      data.comments.map(c => `<div class="py-1 border-b border-slate-200"><b>${c.author}:</b> ${c.text}</div>`).join('');
  } else {
    resultDiv.innerHTML = '<p class="text-slate-400">Không tìm thấy bình luận nào hoặc bài viết yêu cầu đăng nhập.</p>';
  }
}

// ================= TIKTOK AUTO TOOL HANDLERS =================
async function openTikTokChromeLogin() {
  appendLog('[BOT] Mở Chrome đăng nhập TikTok...');
  const res = await fetch('/api/tiktok/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: 1 })
  });
  const data = await res.json();
  alert(data.message || 'Đã mở cửa sổ Chrome TikTok.');
}

async function executeTikTokSurf() {
  const minutes = document.getElementById('tiktok-surf-minutes').value || 5;
  const interact_rate = document.getElementById('tiktok-like-rate').value || 0.5;
  appendLog(`[BOT] Bắt đầu lướt For You feed TikTok trong ${minutes} phút (like rate: ${interact_rate})...`);

  const res = await fetch('/api/tiktok/surf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: 1, minutes, interact_rate })
  });
  const data = await res.json();
  alert(data.message || 'Đã khởi động lướt TikTok!');
}

async function executeTikTokDownload() {
  const url = document.getElementById('tiktok-dl-url').value.trim();
  if (!url) return alert('Vui lòng nhập link video TikTok!');

  appendLog(`[BOT] Trích xuất link video không logo từ: ${url}...`);
  const res = await fetch('/api/tiktok/download-no-watermark', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  const data = await res.json();
  const box = document.getElementById('tiktok-dl-result');
  box.classList.remove('hidden');

  if (data.ok) {
    box.innerHTML = `
      <p class="font-bold text-emerald-800">✅ Trích xuất thành công:</p>
      <p class="text-slate-700"><b>Tiêu đề:</b> ${data.title || 'Video TikTok'}</p>
      <p class="text-slate-500"><b>Tác giả:</b> @${data.author || 'tiktok'}</p>
      <div class="pt-2">
        <a href="${data.videoNoWatermark}" target="_blank" download class="inline-block px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold text-xs">
          📥 Tải Video MP4 Sạch (Không Logo)
        </a>
      </div>
    `;
  } else {
    box.innerHTML = `<p class="text-rose-600">⚠️ Lỗi: ${data.error}</p>`;
  }
}

// ================= AI CONTENT ENGINE HANDLERS =================
async function executeAiWriteCmt() {
  const content = document.getElementById('ai-write-cmt-input').value.trim();
  const tone = document.getElementById('ai-write-cmt-tone').value;
  if (!content) return alert('Vui lòng dán nội dung bài viết!');

  const res = await fetch('/api/ai/write-comment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, tone })
  });
  const data = await res.json();
  const box = document.getElementById('ai-write-cmt-result');
  box.classList.remove('hidden');
  box.innerHTML = `<p class="font-bold mb-1">Gợi ý bình luận (${tone}):</p><p class="italic">"${data.comment}"</p>`;
}

async function executeAiReplyCmt() {
  const comment = document.getElementById('ai-reply-cmt-input').value.trim();
  if (!comment) return alert('Vui lòng nhập bình luận khách hàng!');

  const res = await fetch('/api/ai/write-reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment })
  });
  const data = await res.json();
  const box = document.getElementById('ai-reply-cmt-result');
  box.classList.remove('hidden');
  box.innerHTML = `<p class="font-bold mb-1">Câu trả lời tự động gợi ý:</p><p class="italic">"${data.reply}"</p>`;
}

async function executeAiSpintaxMessage() {
  const topic = document.getElementById('ai-spintax-topic').value.trim();
  if (!topic) return alert('Vui lòng nhập chủ đề tin nhắn!');

  const res = await fetch('/api/ai/write-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic })
  });
  const data = await res.json();
  const box = document.getElementById('ai-spintax-result');
  box.classList.remove('hidden');
  box.innerHTML = `<p class="font-bold text-slate-800 mb-1">Kịch bản Spintax tạo bởi AI:</p><p>${data.spintaxTemplate}</p>`;
}

// ================= ZALO PROTOCOL CHATBOT & GROUP HANDLERS =================
async function startZaloChatbot() {
  const tone = document.getElementById('zalo-chatbot-tone').value;
  const delay_sec = Number(document.getElementById('zalo-chatbot-delay').value) || 2;
  const custom_spintax = document.getElementById('zalo-chatbot-spintax').value.trim();

  appendLog('[BOT] Khởi động Zalo AI Chatbot CSKH 24/7 (kết nối Zalo WebSocket listener)...');
  const res = await fetch('/api/zalo/chatbot/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: activeAccountId, tone, delay_sec, custom_spintax })
  });
  const data = await res.json();
  if (data.ok) {
    const badge = document.getElementById('zalo-chatbot-badge');
    badge.className = 'text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-mono animate-pulse';
    badge.innerText = '● Đang Chạy 24/7';
    alert('🎉 ' + data.message);
  } else {
    alert('⚠️ Lỗi: ' + data.error);
  }
}

async function stopZaloChatbot() {
  appendLog('[BOT] Dừng Zalo AI Chatbot...');
  const res = await fetch('/api/zalo/chatbot/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: activeAccountId })
  });
  const data = await res.json();
  const badge = document.getElementById('zalo-chatbot-badge');
  badge.className = 'text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 font-mono';
  badge.innerText = 'Đang tắt';
  alert(data.message);
}

async function executeZaloAddUsersToGroup() {
  const group_id = document.getElementById('zalo-add-group-id').value.trim();
  const rawUids = document.getElementById('zalo-add-group-uids').value.trim();
  if (!group_id || !rawUids) return alert('Vui lòng nhập Group ID và danh sách UID thành viên!');

  const uids = rawUids.split(/[\n,]+/).map(u => u.trim()).filter(Boolean);
  appendLog(`[BOT] Đang mời ${uids.length} thành viên vào nhóm ${group_id} qua Protocol API...`);

  const res = await fetch('/api/zalo/add-users-group', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: activeAccountId, group_id, member_uids: uids })
  });
  const data = await res.json();
  if (data.ok) alert(`✅ Đã gửi lời mời tham gia nhóm cho ${data.addedCount} thành viên!`);
  else alert('⚠️ Lỗi: ' + data.error);
}

// ================= AKABIZ NATIVE GROUP & SHARE METHOD HANDLERS =================
async function triggerDeepScanCurrentGroup() {
  if (!activeAccountId) return alert('Vui lòng chọn tài khoản Zalo trước!');
  if (!currentViewingGroupId) return alert('Vui lòng chọn nhóm cần quét thành viên ẩn!');

  appendLog(`[BOT] Kích hoạt Zalo Protocol quét chuyên sâu nhóm ${currentViewingGroupId} (bóc tách thành viên bị ẩn)...`);
  try {
    const res = await fetch('/api/scan/group-members-deep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: activeAccountId, group_id: currentViewingGroupId })
    });
    const data = await res.json();
    if (data.ok) {
      appendLog(`[BOT] ${data.message}`);
    } else {
      alert('⚠️ Lỗi: ' + data.error);
    }
  } catch (err) {
    alert('Lỗi kết nối: ' + err.message);
  }
}

// Modal: Gửi tin nhắn Chia sẻ (Share Method)
function openShareMsgModal(uid, name) {
  document.getElementById('share-target-uid').value = uid;
  document.getElementById('share-target-name').value = `${name || 'Thành viên Zalo'} (${uid})`;
  document.getElementById('share-msg-modal').classList.remove('hidden');
  lucide.createIcons();
}

function closeShareMsgModal() {
  document.getElementById('share-msg-modal').classList.add('hidden');
}

async function confirmSendShareMsg() {
  const uid = document.getElementById('share-target-uid').value;
  const name = document.getElementById('share-target-name').value;
  const message = document.getElementById('share-msg-content').value.trim();
  const useShare = document.getElementById('share-method-mode').checked;

  if (!message) return alert('Vui lòng nhập nội dung tin nhắn cần gửi!');
  if (!activeAccountId) return alert('Vui lòng chọn tài khoản Zalo trước!');

  const btn = document.getElementById('btn-confirm-send-share');
  btn.disabled = true;
  btn.innerHTML = '<div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div> <span>Đang chuyển tiếp...</span>';

  appendLog(`[BOT] Đang gửi tin nhắn tới ${name} qua phương thức ${useShare ? 'Chia sẻ (Share Method)' : 'Trực tiếp'}...`);

  try {
    const endpoint = useShare ? '/api/zalo/send-share-method' : '/api/zalo/send-friend';
    const body = useShare ? { account_id: activeAccountId, target: uid, message } : { account_id: activeAccountId, uid, message };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.ok) {
      closeShareMsgModal();
      appendLog(`✅ Đã gửi tin nhắn thành công tới ${name}!`);
      alert(`🎉 Đã gửi tin nhắn thành công tới ${name}!`);
    } else {
      alert('⚠️ Không thể gửi tin: ' + data.error);
    }
  } catch (err) {
    alert('Lỗi gửi tin: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="send" class="w-4 h-4"></i> <span>Gửi Tin Nhắn</span>';
    lucide.createIcons();
  }
}

// Modal: Gửi tuần tự toàn bộ thành viên nhóm (SendEachOne Method)
async function openBroadcastModalForGroup() {
  if (!currentViewingGroupId) return alert('Vui lòng chọn một nhóm trước!');
  document.getElementById('broadcast-group-title').value = `${currentViewingGroupName || currentViewingGroupId} (ID: ${currentViewingGroupId})`;
  document.getElementById('broadcast-group-modal').classList.remove('hidden');
  lucide.createIcons();
}

function closeBroadcastGroupModal() {
  document.getElementById('broadcast-group-modal').classList.add('hidden');
}

async function confirmBroadcastGroup() {
  const message = document.getElementById('broadcast-group-content').value.trim();
  const delay_min = Number(document.getElementById('broadcast-delay-min').value) || 10;
  const delay_max = Number(document.getElementById('broadcast-delay-max').value) || 20;

  if (!message) return alert('Vui lòng nhập nội dung tin nhắn gửi nhóm!');
  if (!activeAccountId) return alert('Vui lòng chọn tài khoản Zalo!');

  // Lấy danh sách thành viên của nhóm hiện tại
  try {
    const res = await fetch(`/api/group-members/${currentViewingGroupId}`);
    const json = await res.json();
    const members = json.items || [];
    if (members.length === 0) {
      return alert('Nhóm chưa có thành viên nào được quét! Vui lòng bấm Quét chuyên sâu trước.');
    }

    const confirmRun = confirm(`Bạn có chắc chắn muốn gửi tin nhắn tuần tự (Share Method) tới ${members.length} thành viên của nhóm không?`);
    if (!confirmRun) return;

    const targets = members.map(m => ({ uid: m.uid, name: m.name }));
    appendLog(`[BOT] Khởi chạy gửi tin tuần tự tới ${targets.length} thành viên của nhóm ${currentViewingGroupName}...`);

    const sendRes = await fetch('/api/zalo/send-each-one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: activeAccountId,
        targets,
        message,
        delay_min,
        delay_max
      })
    });
    const sendData = await sendRes.json();
    if (sendData.ok) {
      closeBroadcastGroupModal();
      alert(`🚀 ${sendData.message}\nHệ thống đang tự động gửi ngầm trên Chrome, bạn có thể theo dõi tiến trình trong tab Nhật ký!`);
    } else {
      alert('⚠️ Lỗi: ' + sendData.error);
    }
  } catch (err) {
    alert('Lỗi: ' + err.message);
  }
}
