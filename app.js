'use strict';

// iOS Safari sometimes restores this page from the back-forward cache
// instead of doing a real reload after returning from the Google OAuth
// redirect (e.g. sign out then "Entrar com Google" again). Supabase only
// parses the ?code= param from the URL on the initial script load, so a
// bfcache restore silently misses it and gets stuck on the login screen.
// Force a real reload when that happens.
window.addEventListener('pageshow', function(event){
  if (event.persisted){
    window.location.reload();
  }
});

// Belt-and-braces for the same class of bug: capture, before anything else
// runs, whether this page load came back from Google with an auth code —
// the SDK strips it from the URL once it (successfully or not) tries to
// use it, so this has to be read synchronously up front. If we finish
// booting with no session despite that, the code/session exchange lost a
// race (e.g. localStorage not flushed yet on iOS Safari before the redirect
// away, not just bfcache) — retry once with a genuine reload rather than
// leaving the user stuck on the login screen.
var urlHadOAuthCode = /[?&](code|access_token)=/.test(window.location.search + window.location.hash);

var USERS = {
  'AM':  {label:'AM',  color:'#1F5F74'},
  'T&C': {label:'T&C', color:'#A15C3B'},
  'F&T': {label:'F&T', color:'#4C7A52'}
};
var SHORT_LABEL = { 'AM':'AM', 'T&C':'TC', 'F&T':'FT' };

var ADMIN_EMAIL = 'tiago.mota@gmail.com';

var MONTHS = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
var WEEKDAYS = ['seg','ter','qua','qui','sex','sáb','dom'];

var state = { bookings: [] };
var supabaseClient = null;
var realtimeChannel = null;
var viewDate = new Date(); viewDate.setDate(1);
var selectedDate = null;
var highlightRange = null;
var editingId = null;
var deleteArmed = false;
var pickerYear = null;
var currentUser = null;
var appBooted = false;

function pad2(n){ return n<10 ? '0'+n : ''+n; }
function toISO(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function parseISO(s){ var p=s.split('-'); return new Date(+p[0], +p[1]-1, +p[2]); }
function todayISO(){ return toISO(new Date()); }
function dateRangeOverlap(aS,aE,bS,bE){ return aS<=bE && bS<=aE; }

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

function boot(){
  supabaseClient = createSupabaseClient();
  if (!supabaseClient){
    document.getElementById('local-banner').hidden = false;
    showLogin();
    showLoginGoogleState();
    return;
  }
  wireLoginButtons();
  supabaseClient.auth.onAuthStateChange(function(_event, session){
    handleSession(session);
  });
  supabaseClient.auth.getSession().then(function(res){
    handleSession(res.data.session);
    retryOnStuckOAuthReturn(res.data.session);
  });
}

function retryOnStuckOAuthReturn(session){
  if (session || !urlHadOAuthCode) return;
  var flag = 'oauthRetryDone';
  if (sessionStorage.getItem(flag)) return;
  sessionStorage.setItem(flag, '1');
  window.location.reload();
}

function createSupabaseClient(){
  if (!window.supabase || !window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) return null;
  return window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
}

function wireLoginButtons(){
  document.getElementById('google-signin-btn').onclick = function(){
    sessionStorage.removeItem('oauthRetryDone');
    supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.href }
    });
  };
  document.getElementById('signout-btn').onclick = function(){
    supabaseClient.auth.signOut();
  };
  document.getElementById('request-access-btn').onclick = requestAccess;
}

function showLogin(){
  document.getElementById('login-screen').hidden = false;
  document.getElementById('app-screen').hidden = true;
}

function showLoginGoogleState(){
  document.getElementById('login-google').hidden = false;
  document.getElementById('login-unauthorized').hidden = true;
}

async function handleSession(session){
  if (!session){
    appBooted = false;
    currentUser = null;
    showLogin();
    showLoginGoogleState();
    return;
  }
  currentUser = { email: session.user.email, id: session.user.id };
  if (appBooted) return;
  var res = await supabaseClient.rpc('is_allowed_user');
  if (res.error){
    showLogin();
    showLoginGoogleState();
    return;
  }
  if (res.data){
    appBooted = true;
    await showApp();
  } else {
    showLogin();
    await showUnauthorizedState();
  }
}

async function showUnauthorizedState(){
  document.getElementById('login-google').hidden = true;
  document.getElementById('login-unauthorized').hidden = false;
  document.getElementById('unauthorized-email').textContent = currentUser.email;
  var statusEl = document.getElementById('access-status-msg');
  var reqBtn = document.getElementById('request-access-btn');
  var res = await supabaseClient.rpc('my_access_status');
  var status = res.error ? 'none' : res.data;
  if (status === 'pending'){
    statusEl.textContent = 'Pedido enviado — aguarda aprovação.';
    reqBtn.hidden = true;
  } else if (status === 'denied'){
    statusEl.textContent = 'O teu pedido foi recusado.';
    reqBtn.hidden = false;
    reqBtn.textContent = 'Pedir acesso outra vez';
  } else {
    statusEl.textContent = '';
    reqBtn.hidden = false;
    reqBtn.textContent = 'Pedir acesso';
  }
}

async function requestAccess(){
  var res = await supabaseClient.rpc('request_access');
  if (!res.error) await showUnauthorizedState();
}

async function showApp(){
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app-screen').hidden = false;
  document.getElementById('lock-btn').onclick = function(){
    supabaseClient.auth.signOut();
  };
  var adminRes = await supabaseClient.rpc('is_admin_user');
  var isAdmin = !!adminRes.data;
  document.getElementById('history-btn').hidden = !isAdmin;
  await loadBookings();
  renderCalendar();
  wireCalendarNav();
  wireModal();
  if (isAdmin) await handleUrlAdminAction();
}

async function handleUrlAdminAction(){
  var params = new URLSearchParams(window.location.search);
  var approveId = params.get('approve');
  var denyId = params.get('deny');
  if (!approveId && !denyId) return;
  history.replaceState(null, '', window.location.pathname);
  document.getElementById('history-panel').hidden = false;
  switchAdminTab('access');

  var reqId = approveId || denyId;
  var isApprove = !!approveId;
  // Don't act on the link just because the page loaded (a mail client's link
  // scanner/prefetch could "click" it) — require an explicit confirmation.
  var listRes = await supabaseClient.rpc('list_access_requests');
  var req = (listRes.data || []).filter(function(r){ return r.id === reqId; })[0];
  if (!req || req.status !== 'pending') return;
  var confirmed = window.confirm((isApprove ? 'Aprovar' : 'Rejeitar') + ' o acesso de ' + req.email + '?');
  if (!confirmed) return;
  await supabaseClient.rpc(isApprove ? 'approve_access_request' : 'deny_access_request', { req_id: reqId });
  loadAccessTab();
}

function rowToBooking(row){
  return {
    id: row.id,
    start: row.start_date,
    end: row.end_date,
    users: row.users || [],
    exclusive: !!row.exclusive,
    desc: row.description || '',
    by: row.by_name || '',
    createdAt: row.created_at
  };
}

function bookingToRow(b){
  return {
    id: b.id,
    start_date: b.start,
    end_date: b.end,
    users: b.users,
    exclusive: !!b.exclusive,
    description: b.desc || '',
    by_name: b.by || '',
    created_at: b.createdAt
  };
}

async function loadBookings(){
  try {
    var res = await supabaseClient.from('bookings').select('*');
    if (res.error) throw res.error;
    state.bookings = (res.data || []).map(rowToBooking);
  } catch(e){
    document.getElementById('local-banner').hidden = false;
    return;
  }
  try {
    realtimeChannel = supabaseClient
      .channel('bookings-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, function(){
        refreshFromServer();
      })
      .subscribe();
  } catch(e){ /* realtime is a nice-to-have; ignore failures */ }
}

async function refreshFromServer(){
  if (!supabaseClient) return;
  var res = await supabaseClient.from('bookings').select('*');
  if (res.error) return;
  state.bookings = (res.data || []).map(rowToBooking);
  renderCalendar();
  var panel = document.getElementById('day-panel');
  if (panel && !panel.hidden && selectedDate) openDayPanel(selectedDate);
}

function bookingsForDate(iso){
  return state.bookings.filter(function(b){ return b.start <= iso && iso <= b.end; })
    .sort(function(a,b){ return a.start.localeCompare(b.start); });
}

function makeDayCell(dateObj, isCurrentMonth){
  var iso = toISO(dateObj);
  var today = todayISO();
  var cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'day-cell';
  if (!isCurrentMonth) cell.classList.add('day-outside');
  if (iso === today) cell.classList.add('is-today');
  if (highlightRange && iso >= highlightRange.start && iso <= highlightRange.end) cell.classList.add('day-highlight');
  var num = document.createElement('span');
  num.className = 'day-num';
  num.textContent = dateObj.getDate();
  cell.appendChild(num);
  var dayBookings = bookingsForDate(iso);
  if (dayBookings.length){
    var marks = document.createElement('span');
    marks.className = 'day-marks';
    var seenUsers = {};
    var anyExclusive = false;
    dayBookings.forEach(function(b){
      if (b.exclusive) anyExclusive = true;
      b.users.forEach(function(u){
        if (seenUsers[u]) return;
        seenUsers[u] = true;
        var meta = USERS[u] || {label:u, color:'#999'};
        var tag = document.createElement('i');
        tag.className = 'day-tag';
        tag.textContent = SHORT_LABEL[u] || meta.label;
        tag.style.color = meta.color;
        tag.style.borderColor = meta.color;
        tag.style.background = meta.color + '1a';
        marks.appendChild(tag);
      });
    });
    if (anyExclusive){
      var star = document.createElement('i');
      star.className = 'mini-star';
      star.textContent = '★';
      marks.appendChild(star);
    }
    cell.appendChild(marks);
  }
  cell.addEventListener('click', function(){
    if (!isCurrentMonth){
      viewDate = new Date(dateObj.getFullYear(), dateObj.getMonth(), 1);
      renderCalendar();
    }
    if (dayBookings.length){
      openDayPanel(iso);
    } else {
      document.getElementById('day-panel').hidden = true;
      if (highlightRange){ highlightRange = null; renderCalendar(); }
      selectedDate = iso;
      openModal(null, iso);
    }
  });
  cell.addEventListener('dblclick', function(){
    if (dayBookings.length){
      if (!isCurrentMonth){
        viewDate = new Date(dateObj.getFullYear(), dateObj.getMonth(), 1);
        renderCalendar();
      }
      selectedDate = iso;
      openModal(dayBookings[0].id, iso);
    }
  });
  return cell;
}

function renderCalendar(){
  document.getElementById('month-name').textContent = MONTHS[viewDate.getMonth()];
  document.getElementById('year-name').textContent = viewDate.getFullYear();
  document.getElementById('weekday-row').innerHTML = WEEKDAYS.map(function(w){ return '<div class="wd">'+w+'</div>'; }).join('');

  var grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';
  var year = viewDate.getFullYear(), month = viewDate.getMonth();
  var firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
  var daysInMonth = new Date(year, month+1, 0).getDate();
  var lastDow = (new Date(year, month, daysInMonth).getDay() + 6) % 7;
  var leadDays = firstDow + 7;
  var trailDays = (6 - lastDow) + 7;

  for (var i = leadDays; i >= 1; i--){
    grid.appendChild(makeDayCell(new Date(year, month, 1 - i), false));
  }
  for (var d = 1; d <= daysInMonth; d++){
    grid.appendChild(makeDayCell(new Date(year, month, d), true));
  }
  for (var j = 1; j <= trailDays; j++){
    grid.appendChild(makeDayCell(new Date(year, month, daysInMonth + j), false));
  }
}

function wireCalendarNav(){
  document.getElementById('prev-month').onclick = function(){ viewDate.setMonth(viewDate.getMonth()-1); renderCalendar(); };
  document.getElementById('next-month').onclick = function(){ viewDate.setMonth(viewDate.getMonth()+1); renderCalendar(); };
  document.getElementById('today-btn').onclick = function(){
    var t = new Date();
    viewDate = new Date(t.getFullYear(), t.getMonth(), 1);
    renderCalendar();
  };
  document.getElementById('fab-add').onclick = function(){
    var d = selectedDate || todayISO();
    if (bookingsForDate(d).length){ openDayPanel(d); } else { openModal(null, d); }
  };
  document.getElementById('day-panel-close').onclick = closeDayPanel;
  document.getElementById('history-btn').onclick = openAdminPanel;
  document.getElementById('history-panel-close').onclick = closeHistoryPanel;
  document.getElementById('admin-tab-history').onclick = function(){ switchAdminTab('history'); };
  document.getElementById('admin-tab-access').onclick = function(){ switchAdminTab('access'); };
  wireGridSwipeNav();
  wireMonthPicker();
}

function summarizeBooking(b){
  if (!b) return '(vazio)';
  var users = b.users.map(function(u){ return (USERS[u] && USERS[u].label) || u; }).join('+');
  var s = users + ' · ' + formatRange(b.start, b.end);
  if (b.desc) s += ' (' + b.desc + ')';
  if (b.exclusive) s += ' ★';
  return s;
}

function renderHistoryList(entries){
  var list = document.getElementById('history-list');
  list.innerHTML = '';
  if (!entries.length){
    list.innerHTML = '<p class="empty-note">Sem alterações registadas.</p>';
    return;
  }
  var actionLabels = {insert:'Criada', update:'Editada', delete:'Eliminada'};
  entries.forEach(function(entry){
    var row = document.createElement('div');
    row.className = 'history-row';
    var when = new Date(entry.changed_at);
    var whenTxt = pad2(when.getDate())+'/'+pad2(when.getMonth()+1)+' '+pad2(when.getHours())+':'+pad2(when.getMinutes());

    var body = '';
    if (entry.action === 'update'){
      body = '<div class="history-before">'+escapeHtml(summarizeBooking(rowToBooking(entry.old_data)))+'</div>' +
             '<div class="history-arrow">↓</div>' +
             '<div class="history-after">'+escapeHtml(summarizeBooking(rowToBooking(entry.new_data)))+'</div>';
    } else if (entry.action === 'insert'){
      body = '<div class="history-after">'+escapeHtml(summarizeBooking(rowToBooking(entry.new_data)))+'</div>';
    } else {
      body = '<div class="history-before">'+escapeHtml(summarizeBooking(rowToBooking(entry.old_data)))+'</div>';
    }

    var whoTxt = entry.changed_by ? ' · '+escapeHtml(entry.changed_by) : '';
    row.innerHTML =
      '<div class="history-row-top">' +
        '<span class="history-badge history-badge-'+entry.action+'">'+(actionLabels[entry.action]||entry.action)+'</span>' +
        '<span class="history-time">'+whenTxt+whoTxt+'</span>' +
      '</div>' +
      '<div class="history-body">'+body+'</div>';

    var revertBtn = document.createElement('button');
    revertBtn.type = 'button';
    revertBtn.className = 'btn btn-secondary history-revert-btn';
    revertBtn.textContent = entry.action === 'insert' ? 'Desfazer (eliminar)' : 'Reverter';
    revertBtn.addEventListener('click', function(){ revertHistoryEntry(entry); });
    row.appendChild(revertBtn);

    list.appendChild(row);
  });
}

function openAdminPanel(){
  document.getElementById('history-panel').hidden = false;
  document.getElementById('history-error').hidden = true;
  switchAdminTab('history');
}

function closeHistoryPanel(){
  document.getElementById('history-panel').hidden = true;
}

function switchAdminTab(tab){
  document.getElementById('admin-tab-history').classList.toggle('is-active', tab === 'history');
  document.getElementById('admin-tab-access').classList.toggle('is-active', tab === 'access');
  document.getElementById('history-list').hidden = tab !== 'history';
  document.getElementById('access-list').hidden = tab !== 'access';
  document.getElementById('history-error').hidden = true;
  if (tab === 'history') loadHistoryTab(); else loadAccessTab();
}

async function loadHistoryTab(){
  var list = document.getElementById('history-list');
  list.innerHTML = '<p class="empty-note">A carregar…</p>';
  if (!supabaseClient){
    list.innerHTML = '<p class="empty-note">Sincronização indisponível.</p>';
    return;
  }
  var res = await supabaseClient.from('booking_history').select('*').order('changed_at', {ascending:false}).limit(100);
  if (res.error){
    list.innerHTML = '<p class="empty-note">Não foi possível carregar o histórico.</p>';
    return;
  }
  renderHistoryList(res.data || []);
}

async function loadAccessTab(){
  var list = document.getElementById('access-list');
  list.innerHTML = '<p class="empty-note">A carregar…</p>';
  var reqRes = await supabaseClient.rpc('list_access_requests');
  var usersRes = await supabaseClient.rpc('list_allowed_users');
  var adminsRes = await supabaseClient.rpc('list_admin_users');
  if (reqRes.error || usersRes.error || adminsRes.error){
    list.innerHTML = '<p class="empty-note">Não foi possível carregar.</p>';
    return;
  }
  renderAccessTab(reqRes.data || [], usersRes.data || [], adminsRes.data || []);
}

function renderAccessTab(requests, users, admins){
  var list = document.getElementById('access-list');
  list.innerHTML = '';
  var pending = requests.filter(function(r){ return r.status === 'pending'; });
  var adminEmails = admins.map(function(a){ return a.email; });

  var h1 = document.createElement('h3');
  h1.className = 'access-section-title';
  h1.textContent = 'Pedidos pendentes';
  list.appendChild(h1);

  if (!pending.length){
    var p = document.createElement('p');
    p.className = 'empty-note';
    p.textContent = 'Sem pedidos pendentes.';
    list.appendChild(p);
  } else {
    pending.forEach(function(r){
      var row = document.createElement('div');
      row.className = 'history-row';
      row.innerHTML = '<div class="history-row-top"><span>'+escapeHtml(r.email)+'</span></div>';
      var actions = document.createElement('div');
      actions.className = 'history-row-actions';
      var approveBtn = document.createElement('button');
      approveBtn.type = 'button';
      approveBtn.className = 'btn btn-primary';
      approveBtn.textContent = 'Aprovar';
      approveBtn.addEventListener('click', function(){ decideAccessRequest(r.id, true); });
      var denyBtn = document.createElement('button');
      denyBtn.type = 'button';
      denyBtn.className = 'btn btn-secondary';
      denyBtn.textContent = 'Rejeitar';
      denyBtn.addEventListener('click', function(){ decideAccessRequest(r.id, false); });
      actions.appendChild(approveBtn);
      actions.appendChild(denyBtn);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  var h2 = document.createElement('h3');
  h2.className = 'access-section-title';
  h2.textContent = 'Utilizadores autorizados';
  list.appendChild(h2);
  users.forEach(function(u){
    var isAdmin = adminEmails.indexOf(u.email) !== -1;
    var row = document.createElement('div');
    row.className = 'history-row';
    row.innerHTML = '<div class="history-row-top"><span>'+escapeHtml(u.email)+(isAdmin ? ' <span class="history-badge history-badge-update">Admin</span>' : '')+'</span></div>';
    var actions = document.createElement('div');
    actions.className = 'history-row-actions';
    if (u.email !== ADMIN_EMAIL){
      var revokeBtn = document.createElement('button');
      revokeBtn.type = 'button';
      revokeBtn.className = 'btn btn-secondary';
      revokeBtn.textContent = 'Remover acesso';
      revokeBtn.addEventListener('click', function(){ revokeAccess(u.email); });
      actions.appendChild(revokeBtn);
    }
    if (isAdmin){
      if (u.email !== ADMIN_EMAIL){
        var revokeAdminBtn = document.createElement('button');
        revokeAdminBtn.type = 'button';
        revokeAdminBtn.className = 'btn btn-secondary';
        revokeAdminBtn.textContent = 'Remover admin';
        revokeAdminBtn.addEventListener('click', function(){ revokeAdmin(u.email); });
        actions.appendChild(revokeAdminBtn);
      }
    } else {
      var makeAdminBtn = document.createElement('button');
      makeAdminBtn.type = 'button';
      makeAdminBtn.className = 'btn btn-primary';
      makeAdminBtn.textContent = 'Tornar Admin';
      makeAdminBtn.addEventListener('click', function(){ makeAdmin(u.email); });
      actions.appendChild(makeAdminBtn);
    }
    row.appendChild(actions);
    list.appendChild(row);
  });
}

async function decideAccessRequest(id, approve){
  await supabaseClient.rpc(approve ? 'approve_access_request' : 'deny_access_request', { req_id: id });
  loadAccessTab();
}

async function revokeAccess(email){
  await supabaseClient.rpc('revoke_access', { target_email: email });
  loadAccessTab();
}

async function makeAdmin(email){
  await supabaseClient.rpc('make_admin', { target_email: email });
  loadAccessTab();
}

async function revokeAdmin(email){
  await supabaseClient.rpc('revoke_admin', { target_email: email });
  loadAccessTab();
}

async function revertHistoryEntry(entry){
  var errEl = document.getElementById('history-error');
  errEl.hidden = true;
  var target = entry.action === 'insert' ? null : rowToBooking(entry.old_data);
  var next = state.bookings.filter(function(b){ return b.id !== entry.booking_id; });
  if (target){
    var conflict = findConflict(target.start, target.end, target.id);
    if (conflict){
      errEl.hidden = false;
      errEl.textContent = 'Não é possível reverter: conflita com "'+(conflict.desc || conflict.users.join('+'))+'" ('+formatRange(conflict.start, conflict.end)+').';
      return;
    }
    next.push(target);
  }
  next.sort(function(a,b){ return a.start.localeCompare(b.start); });
  var result = await commitBookings(next);
  if (!result.ok){
    errEl.hidden = false;
    errEl.textContent = !supabaseClient
      ? 'Sincronização indisponível.'
      : (result.conflict
        ? 'Outra pessoa reservou essas datas entretanto. Recarrega e tenta outra vez.'
        : 'Não foi possível reverter. Tenta novamente.');
    return;
  }
  renderCalendar();
  if (selectedDate) openDayPanel(selectedDate);
  loadHistoryTab();
}

function renderMonthPicker(){
  document.getElementById('month-picker-title').textContent = pickerYear;
  var grid = document.getElementById('month-picker-grid');
  grid.innerHTML = '';
  var today = new Date();
  MONTHS.forEach(function(name, i){
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'month-picker-btn';
    if (pickerYear === today.getFullYear() && i === today.getMonth()) btn.classList.add('is-today');
    if (pickerYear === viewDate.getFullYear() && i === viewDate.getMonth()) btn.classList.add('is-selected');
    btn.textContent = name.slice(0,3);
    btn.addEventListener('click', function(){
      viewDate = new Date(pickerYear, i, 1);
      renderCalendar();
      closeMonthPicker();
    });
    grid.appendChild(btn);
  });
}

function openMonthPicker(){
  pickerYear = viewDate.getFullYear();
  renderMonthPicker();
  document.getElementById('month-picker-backdrop').hidden = false;
}

function closeMonthPicker(){
  document.getElementById('month-picker-backdrop').hidden = true;
}

function wireMonthPicker(){
  document.getElementById('month-label-btn').onclick = openMonthPicker;
  document.getElementById('mp-prev-year').onclick = function(){ pickerYear--; renderMonthPicker(); };
  document.getElementById('mp-next-year').onclick = function(){ pickerYear++; renderMonthPicker(); };
  document.getElementById('month-picker-backdrop').addEventListener('click', function(e){
    if (e.target.id === 'month-picker-backdrop') closeMonthPicker();
  });
}

function wireGridSwipeNav(){
  var grid = document.getElementById('calendar-grid');
  var wheelAccum = 0;
  var wheelLocked = false;
  var wheelEndTimer = null;
  grid.addEventListener('wheel', function(e){
    e.preventDefault();
    // A single trackpad swipe fires a long burst of wheel events (momentum/
    // inertia can run well past a fixed cooldown), so lock for the whole
    // gesture instead of a flat timeout — only unlock once events stop.
    clearTimeout(wheelEndTimer);
    wheelEndTimer = setTimeout(function(){ wheelLocked = false; wheelAccum = 0; }, 150);
    if (wheelLocked) return;
    wheelAccum += e.deltaY;
    if (Math.abs(wheelAccum) > 40){
      viewDate.setMonth(viewDate.getMonth() + (wheelAccum > 0 ? 1 : -1));
      renderCalendar();
      wheelLocked = true;
    }
  }, { passive: false });

  var touchStartY = null;
  grid.addEventListener('touchstart', function(e){
    touchStartY = e.touches.length === 1 ? e.touches[0].clientY : null;
  }, { passive: true });
  grid.addEventListener('touchend', function(e){
    if (touchStartY === null) return;
    var endY = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientY : touchStartY;
    var dy = endY - touchStartY;
    touchStartY = null;
    if (Math.abs(dy) > 50){
      viewDate.setMonth(viewDate.getMonth() + (dy < 0 ? 1 : -1));
      renderCalendar();
    }
  }, { passive: true });
}

function formatRange(start,end){
  var s = parseISO(start), e = parseISO(end);
  if (start === end) return s.getDate()+' '+MONTHS[s.getMonth()].slice(0,3)+' '+s.getFullYear();
  return s.getDate()+' '+MONTHS[s.getMonth()].slice(0,3)+' – '+e.getDate()+' '+MONTHS[e.getMonth()].slice(0,3)+' '+e.getFullYear();
}

function openDayPanel(iso){
  selectedDate = iso;
  document.getElementById('day-panel').hidden = false;
  var d = parseISO(iso);
  document.getElementById('day-panel-title').textContent = d.getDate()+' de '+MONTHS[d.getMonth()]+' '+d.getFullYear();
  var list = document.getElementById('day-panel-list');
  var items = bookingsForDate(iso);
  if (items.length){
    var minStart = items[0].start, maxEnd = items[0].end;
    items.forEach(function(b){
      if (b.start < minStart) minStart = b.start;
      if (b.end > maxEnd) maxEnd = b.end;
    });
    highlightRange = { start: minStart, end: maxEnd };
  } else {
    highlightRange = null;
  }
  renderCalendar();
  if (!items.length){
    list.innerHTML = '<p class="empty-note">Sem reservas neste dia.</p>';
    return;
  }
  list.innerHTML = '';
  items.forEach(function(b){
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'booking-row';
    var chips = b.users.map(function(u){
      var meta = USERS[u] || {label:u,color:'#999'};
      return '<span class="chip" style="background:'+meta.color+'22;color:'+meta.color+';border-color:'+meta.color+'">'+escapeHtml(meta.label)+'</span>';
    }).join('');
    row.innerHTML =
      '<div class="booking-row-top">'+chips+(b.exclusive?'<span class="excl-badge">★ exclusivo</span>':'')+'</div>'+
      (b.desc ? '<div class="booking-row-desc">'+escapeHtml(b.desc)+'</div>' : '')+
      '<div class="booking-row-range">'+formatRange(b.start,b.end)+(b.by ? ' · '+escapeHtml(b.by) : '')+'</div>';
    row.addEventListener('click', function(){ openModal(b.id, iso); });
    list.appendChild(row);
  });
}
function closeDayPanel(){
  document.getElementById('day-panel').hidden = true;
  highlightRange = null;
  renderCalendar();
}

function wireModal(){
  document.getElementById('f-cancel').onclick = closeModal;
  document.getElementById('modal-backdrop').addEventListener('click', function(e){
    if (e.target.id === 'modal-backdrop') closeModal();
  });
  document.getElementById('booking-form').addEventListener('submit', function(e){
    e.preventDefault();
    saveBooking();
  });
  document.getElementById('f-delete').onclick = function(){
    var btn = document.getElementById('f-delete');
    if (!deleteArmed){
      deleteArmed = true;
      btn.textContent = 'Confirmar eliminação';
      btn.classList.add('btn-danger-armed');
      return;
    }
    deleteBooking();
  };
  document.getElementById('f-start').addEventListener('change', validateDatesLive);
  document.getElementById('f-end').addEventListener('change', validateDatesLive);
}

function validateDatesLive(){
  var start = document.getElementById('f-start').value;
  var end = document.getElementById('f-end').value;
  var errEl = document.getElementById('form-error');
  var saveBtn = document.getElementById('f-save');
  if (!start || !end || end < start){
    errEl.hidden = true;
    saveBtn.disabled = false;
    return;
  }
  var conflict = findConflict(start, end, editingId);
  if (conflict){
    errEl.hidden = false;
    errEl.textContent = 'Já existe uma reserva nessas datas: "'+(conflict.desc || conflict.users.join('+'))+'" ('+formatRange(conflict.start,conflict.end)+'). Só é permitida uma reserva por dia — escolhe outras datas.';
    saveBtn.disabled = true;
  } else {
    errEl.hidden = true;
    saveBtn.disabled = false;
  }
}

function openModal(id, prefillDate){
  editingId = id;
  var form = document.getElementById('booking-form');
  form.reset();
  document.getElementById('form-error').hidden = true;
  var delBtn = document.getElementById('f-delete');
  deleteArmed = false;
  delBtn.textContent = 'Eliminar';
  delBtn.classList.remove('btn-danger-armed');
  if (id){
    var b = state.bookings.filter(function(x){ return x.id === id; })[0];
    document.getElementById('modal-title').textContent = 'Editar reserva';
    document.getElementById('f-start').value = b.start;
    document.getElementById('f-end').value = b.end;
    document.getElementById('f-desc').value = b.desc || '';
    document.getElementById('f-exclusive').checked = !!b.exclusive;
    var boxes = document.querySelectorAll('input[name="users"]');
    for (var i=0;i<boxes.length;i++) boxes[i].checked = b.users.indexOf(boxes[i].value) !== -1;
    delBtn.hidden = false;
    // Shows who it's currently attributed to; only changes to the viewer's
    // own email if they actually save an edit (see saveBooking).
    document.getElementById('f-by').value = b.by || '';
  } else {
    document.getElementById('modal-title').textContent = 'Nova reserva';
    var d = prefillDate || todayISO();
    document.getElementById('f-start').value = d;
    document.getElementById('f-end').value = d;
    delBtn.hidden = true;
    document.getElementById('f-by').value = (currentUser && currentUser.email) || '';
  }
  validateDatesLive();
  document.getElementById('modal-backdrop').hidden = false;
}

function closeModal(){
  document.getElementById('modal-backdrop').hidden = true;
  editingId = null;
}

function findConflict(start, end, excludeId){
  for (var i=0;i<state.bookings.length;i++){
    var b = state.bookings[i];
    if (b.id === excludeId) continue;
    if (dateRangeOverlap(start,end,b.start,b.end)) return b;
  }
  return null;
}

var commitInFlight = false;

async function saveBooking(){
  if (commitInFlight) return;
  var start = document.getElementById('f-start').value;
  var end = document.getElementById('f-end').value;
  var desc = document.getElementById('f-desc').value.trim();
  var exclusive = document.getElementById('f-exclusive').checked;
  var by = (currentUser && currentUser.email) || '';
  var boxes = document.querySelectorAll('input[name="users"]:checked');
  var users = Array.prototype.map.call(boxes, function(cb){ return cb.value; });
  var errEl = document.getElementById('form-error');

  if (!start || !end || end < start){
    errEl.hidden = false; errEl.textContent = 'Verifica as datas: o fim tem de ser igual ou depois do início.'; return;
  }
  if (!users.length){
    errEl.hidden = false; errEl.textContent = 'Escolhe pelo menos um: AM, T&C ou F&T.'; return;
  }
  var conflict = findConflict(start, end, editingId);
  if (conflict){
    errEl.hidden = false;
    errEl.textContent = 'Já existe uma reserva nessas datas: "'+(conflict.desc || conflict.users.join('+'))+'" ('+formatRange(conflict.start,conflict.end)+'). Só é permitida uma reserva por dia — escolhe outras datas.';
    return;
  }

  var prevCreatedAt = null;
  if (editingId){
    var existing = state.bookings.filter(function(b){ return b.id === editingId; })[0];
    prevCreatedAt = existing ? existing.createdAt : null;
  }
  var booking = {
    id: editingId || ('bk_'+Date.now().toString(36)+Math.random().toString(36).slice(2,7)),
    start: start, end: end, users: users, exclusive: exclusive, desc: desc, by: by,
    createdAt: prevCreatedAt || new Date().toISOString()
  };

  var next = state.bookings.filter(function(b){ return b.id !== booking.id; });
  next.push(booking);
  next.sort(function(a,b){ return a.start.localeCompare(b.start); });

  commitInFlight = true;
  document.getElementById('f-save').disabled = true;
  var result;
  try {
    result = await commitBookings(next);
  } finally {
    commitInFlight = false;
    document.getElementById('f-save').disabled = false;
  }
  if (!result.ok){
    errEl.hidden = false;
    errEl.textContent = !supabaseClient
      ? 'Sincronização indisponível — recarrega a página e tenta outra vez. A reserva não foi partilhada.'
      : (result.conflict
        ? 'Outra pessoa reservou essas datas entretanto. Recarrega e escolhe outras datas.'
        : 'Não foi possível guardar. Tenta novamente.');
    return;
  }
  closeModal();
  renderCalendar();
  if (selectedDate) openDayPanel(selectedDate);
}

async function deleteBooking(){
  if (!editingId || commitInFlight) return;
  var next = state.bookings.filter(function(b){ return b.id !== editingId; });
  commitInFlight = true;
  document.getElementById('f-delete').disabled = true;
  var result;
  try {
    result = await commitBookings(next);
  } finally {
    commitInFlight = false;
    document.getElementById('f-delete').disabled = false;
  }
  if (!result.ok){
    var fe = document.getElementById('form-error');
    fe.hidden = false;
    fe.textContent = supabaseClient ? 'Não foi possível eliminar. Tenta novamente.' : 'Sincronização indisponível — recarrega a página e tenta outra vez. A eliminação não foi partilhada.';
    return;
  }
  closeModal();
  renderCalendar();
  if (selectedDate) openDayPanel(selectedDate);
}

function addDaysISO(iso, delta){
  var d = parseISO(iso);
  d.setDate(d.getDate() + delta);
  return toISO(d);
}

function bookingKey(b){
  return b.users.slice().sort().join('+') + '|' + (b.exclusive?1:0) + '|' + (b.desc||'') + '|' + (b.by||'');
}

function coalesceBookings(bookings){
  var sorted = bookings.slice().sort(function(a,b){ return a.start.localeCompare(b.start); });
  var out = [];
  for (var i=0;i<sorted.length;i++){
    var cur = sorted[i];
    if (out.length){
      var last = out[out.length-1];
      if (addDaysISO(last.end,1) === cur.start && bookingKey(last) === bookingKey(cur)){
        last.end = cur.end;
        continue;
      }
    }
    out.push({ id:cur.id, start:cur.start, end:cur.end, users:cur.users.slice(), exclusive:cur.exclusive, desc:cur.desc, by:cur.by, createdAt:cur.createdAt });
  }
  return out;
}

async function commitBookings(rawNext){
  if (!supabaseClient){
    document.getElementById('local-banner').hidden = false;
    return { ok: false };
  }
  var prevBookings = state.bookings;
  var coalesced = coalesceBookings(rawNext);
  var prevById = {};
  prevBookings.forEach(function(b){ prevById[b.id] = b; });
  var coalescedIds = {};
  var toUpsert = [];
  coalesced.forEach(function(b){
    coalescedIds[b.id] = true;
    var orig = prevById[b.id];
    if (!orig || orig.start !== b.start || orig.end !== b.end || bookingKey(orig) !== bookingKey(b)){
      toUpsert.push(b);
    }
  });
  var toDelete = prevBookings.filter(function(b){ return !coalescedIds[b.id]; }).map(function(b){ return b.id; });

  try {
    if (toDelete.length){
      var delRes = await supabaseClient.from('bookings').delete().in('id', toDelete);
      if (delRes.error) throw delRes.error;
    }
    if (toUpsert.length){
      var upRes = await supabaseClient.from('bookings').upsert(toUpsert.map(bookingToRow));
      if (upRes.error) throw upRes.error;
    }
    state.bookings = coalesced;
    return { ok: true };
  } catch(e){
    return { ok: false, conflict: e && e.code === '23P01' };
  }
}

boot();
