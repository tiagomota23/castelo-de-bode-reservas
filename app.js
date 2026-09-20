'use strict';

var USERS = {
  'AM':  {label:'AM',  color:'#1F5F74'},
  'T&C': {label:'T&C', color:'#A15C3B'},
  'F&T': {label:'F&T', color:'#4C7A52'}
};
var SHORT_LABEL = { 'AM':'AM', 'T&C':'TC', 'F&T':'FT' };

var PIN_SALT = 'cdb-2026-familia-salt-v1';
var PIN_HASHES = {
  JL:'bc63e22f9523efe4baf4fcdb756d06977ef4f82c0fce5c32f4c77410e1697d94',
  AM:'686cb928bece00b4270c5878e6b71b54f263f96bab3586e5e5c18787b1ec13be',
  RM:'6d31a4c50f60dc57589fd7a975ac2f4fb819d1303d630ae614063000400e525e',
  MG:'d94c9755650af89c198d76aeb92066dd0096c3441d84c8d5214b91a1a48c8455',
  LM:'e7c20f7c498d2a39306d03acca72ec3da84573a74232d5f1eda7b9f52513878f'
};
var PIN_KEYS = Object.keys(PIN_HASHES);

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
var loginChallenge = [];

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

async function sha256hex(msg){
  var enc = new TextEncoder().encode(msg);
  var buf = await crypto.subtle.digest('SHA-256', enc);
  var arr = Array.from(new Uint8Array(buf));
  return arr.map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
}

function pickThree(){
  var keys = PIN_KEYS.slice();
  for (var i = keys.length-1; i>0; i--){
    var j = Math.floor(Math.random()*(i+1));
    var t = keys[i]; keys[i]=keys[j]; keys[j]=t;
  }
  return keys.slice(0,3);
}

function getLockState(){
  var raw = null;
  try { raw = localStorage.getItem('cdb_lock'); } catch(e){}
  if (!raw) return {fails:0, until:0};
  try { var s = JSON.parse(raw); return {fails:s.fails||0, until:s.until||0}; } catch(e){ return {fails:0, until:0}; }
}
function setLockState(s){
  try { localStorage.setItem('cdb_lock', JSON.stringify(s)); } catch(e){}
}
function renderLocked(until){
  var wrap = document.getElementById('login-fields');
  wrap.innerHTML = '';
  var errEl = document.getElementById('login-error');
  var submit = document.getElementById('login-submit');
  submit.disabled = true;
  var timer = null;
  function tick(){
    var now = Date.now();
    var remaining = Math.max(0, Math.ceil((until-now)/1000));
    if (remaining <= 0){
      if (timer) clearInterval(timer);
      submit.disabled = false;
      wireLogin();
      return;
    }
    errEl.hidden = false;
    errEl.textContent = 'Demasiadas tentativas incorretas. Tenta novamente em ' + remaining + 's.';
  }
  tick();
  timer = setInterval(tick, 1000);
}

function boot(){
  wireLogin();
  var unlocked = false;
  try { unlocked = localStorage.getItem('cdb_unlocked') === '1'; } catch(e){}
  if (unlocked) { showApp(); } else { showLogin(); }
}

function showLogin(){
  document.getElementById('login-screen').hidden = false;
  document.getElementById('app-screen').hidden = true;
}

function wireLogin(){
  var lock = getLockState();
  var now = Date.now();
  if (lock.until && now < lock.until){
    renderLocked(lock.until);
    return;
  }
  document.getElementById('login-error').hidden = true;
  document.getElementById('login-submit').disabled = false;
  loginChallenge = pickThree();
  var wrap = document.getElementById('login-fields');
  wrap.innerHTML = '';
  loginChallenge.forEach(function(key, i){
    var field = document.createElement('label');
    field.className = 'pin-field';
    var span = document.createElement('span');
    span.textContent = key;
    var input = document.createElement('input');
    input.type = 'tel';
    input.inputMode = 'numeric';
    input.maxLength = 1;
    input.className = 'pin-input';
    input.id = 'pin-' + i;
    input.autocomplete = 'off';
    field.appendChild(span);
    field.appendChild(input);
    wrap.appendChild(field);
    input.addEventListener('input', function(){
      input.value = input.value.replace(/[^0-9]/g,'').slice(0,1);
      if (input.value && i < loginChallenge.length-1){
        var next = document.getElementById('pin-'+(i+1));
        if (next) next.focus();
      }
      var allFilled = true;
      for (var k=0;k<loginChallenge.length;k++){
        var el = document.getElementById('pin-'+k);
        if (!el || !el.value){ allFilled = false; break; }
      }
      if (allFilled) attemptLogin();
    });
    input.addEventListener('keydown', function(e){
      if (e.key === 'Enter') attemptLogin();
    });
  });
  document.getElementById('login-submit').onclick = attemptLogin;
  var first = document.getElementById('pin-0');
  if (first) setTimeout(function(){ first.focus(); }, 30);
}

async function attemptLogin(){
  var lock = getLockState();
  var now = Date.now();
  if (lock.until && now < lock.until){ renderLocked(lock.until); return; }
  var errEl = document.getElementById('login-error');
  errEl.hidden = true;
  var ok = true;
  for (var i=0;i<loginChallenge.length;i++){
    var key = loginChallenge[i];
    var el = document.getElementById('pin-'+i);
    var val = el ? el.value : '';
    if (!val){ ok = false; continue; }
    var hash = await sha256hex(key + ':' + val + ':' + PIN_SALT);
    if (hash !== PIN_HASHES[key]) ok = false;
  }
  if (ok){
    setLockState({fails:0, until:0});
    try { localStorage.setItem('cdb_unlocked','1'); } catch(e){}
    showApp();
  } else {
    var fails = (lock.fails||0) + 1;
    var newLock = {fails: fails, until: 0};
    if (fails >= 2){
      var lockSeconds = Math.min(30 * Math.pow(2, fails-2), 3600);
      newLock.until = now + lockSeconds*1000;
    }
    setLockState(newLock);
    if (newLock.until){
      renderLocked(newLock.until);
    } else {
      errEl.hidden = false;
      wireLogin();
    }
  }
}

async function showApp(){
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app-screen').hidden = false;
  document.getElementById('lock-btn').onclick = function(){
    try { localStorage.removeItem('cdb_unlocked'); } catch(e){}
    showLogin();
    wireLogin();
  };
  await initSupabase();
  renderCalendar();
  wireCalendarNav();
  wireModal();
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

async function initSupabase(){
  try {
    if (!window.supabase || !window.SUPABASE_URL || !window.SUPABASE_ANON_KEY){
      throw new Error('supabase not configured');
    }
    supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    var res = await supabaseClient.from('bookings').select('*');
    if (res.error) throw res.error;
    state.bookings = (res.data || []).map(rowToBooking);
  } catch(e){
    supabaseClient = null;
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
  wireGridSwipeNav();
  wireMonthPicker();
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
  var wheelCooldown = false;
  grid.addEventListener('wheel', function(e){
    e.preventDefault();
    if (wheelCooldown) return;
    wheelAccum += e.deltaY;
    if (Math.abs(wheelAccum) > 40){
      viewDate.setMonth(viewDate.getMonth() + (wheelAccum > 0 ? 1 : -1));
      renderCalendar();
      wheelAccum = 0;
      wheelCooldown = true;
      setTimeout(function(){ wheelCooldown = false; }, 400);
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
    document.getElementById('f-by').value = b.by || '';
    var boxes = document.querySelectorAll('input[name="users"]');
    for (var i=0;i<boxes.length;i++) boxes[i].checked = b.users.indexOf(boxes[i].value) !== -1;
    delBtn.hidden = false;
  } else {
    document.getElementById('modal-title').textContent = 'Nova reserva';
    var d = prefillDate || todayISO();
    document.getElementById('f-start').value = d;
    document.getElementById('f-end').value = d;
    delBtn.hidden = true;
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

async function saveBooking(){
  var start = document.getElementById('f-start').value;
  var end = document.getElementById('f-end').value;
  var desc = document.getElementById('f-desc').value.trim();
  var exclusive = document.getElementById('f-exclusive').checked;
  var by = document.getElementById('f-by').value.trim();
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

  var savedOk = await commitBookings(next);
  if (!savedOk){
    errEl.hidden = false;
    errEl.textContent = supabaseClient ? 'Não foi possível guardar. Tenta novamente.' : 'Sincronização indisponível — recarrega a página e tenta outra vez. A reserva não foi partilhada.';
    return;
  }
  closeModal();
  renderCalendar();
  if (selectedDate) openDayPanel(selectedDate);
}

async function deleteBooking(){
  if (!editingId) return;
  var next = state.bookings.filter(function(b){ return b.id !== editingId; });
  var deletedOk = await commitBookings(next);
  if (!deletedOk){
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
    return false;
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
    return true;
  } catch(e){
    return false;
  }
}

boot();
