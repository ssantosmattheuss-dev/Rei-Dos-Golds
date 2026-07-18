import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut, updatePassword, updateEmail,
  EmailAuthProvider, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, onSnapshot, query, where, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

/* =========================================================
   SO2 · REI DOS GOLDS — agora com backend real (Firebase)
   Dados persistem no Firestore e sincronizam em tempo real.
   ========================================================= */

const firebaseConfig = {
  apiKey: "AIzaSyA6RluAYVRZvAteikPUhE4nk-se42dQOsg",
  authDomain: "rei-dos-golds-cfbdd.firebaseapp.com",
  projectId: "rei-dos-golds-cfbdd",
  storageBucket: "rei-dos-golds-cfbdd.firebasestorage.app",
  messagingSenderId: "1073000132165",
  appId: "1:1073000132165:web:085d61c63c51064cfebd2c"
};
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

const ADMIN_WHATSAPP = "5511999999999"; // <-- troque pelo número real do administrador
const ADMIN_EMAIL = "admin@so2.com";    // a primeira conta cadastrada com este e-mail vira admin

// Custo real de cada pack (o que você paga para comprar o gold).
// Só o administrador enxerga esse valor. Ajuste aqui se o custo mudar.
const PACK_COSTS = {
  100:  7.99,
  300:  23.97,
  500:  33.99,
  3000: 129.99,
  6000: 259.98,
  9000: 389.97
};
const PACK_TYPES = Object.keys(PACK_COSTS).map(Number);

let state = {
  currentUser: null,   // {uid, id, name, whatsapp, email, role, blocked}
  packs: [],           // admin: campos públicos + privados mesclados. usuário: só públicos.
  purchases: [],
  usersList: [],        // só populado para admin
  pendingBuy: null,
  currentView: 'dashboard',
};
let publicPacksRaw = [];
let privatePacksMap = {};
let unsubscribers = [];
function clearListeners(){ unsubscribers.forEach(u=>{ try{u();}catch(e){} }); unsubscribers = []; }

/* ---------- helpers ---------- */
function fmtBRL(v){ return (v||0).toLocaleString('pt-BR', {style:'currency', currency:'BRL'}); }
function pricePerNumber(pack){ return pack.pricePerNumber || 0; }
function packRevenueTotal(pack){ return pack.cost!=null ? pack.cost*2 : (pack.pricePerNumber*pack.totalNumbers); }
function packProfit(pack){ return pack.cost; }
function soldCount(pack){ return (pack.sold||[]).length; }
function availableCount(pack){ return pack.totalNumbers - soldCount(pack); }
function fmtDateTime(iso){
  if(!iso) return null;
  const d = new Date(iso);
  if(isNaN(d.getTime())) return null;
  return d.toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function toDatetimeLocalValue(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function packSchedule(pack){
  const now = new Date();
  const start = pack.startsAt ? new Date(pack.startsAt) : null;
  const end = pack.endsAt ? new Date(pack.endsAt) : null;
  return {
    start, end,
    notStarted: !!(start && now < start),
    ended: !!(end && now > end)
  };
}
function isPackPurchasable(pack){
  const sch = packSchedule(pack);
  return pack.status==='open' && availableCount(pack)>0 && !sch.notStarted && !sch.ended;
}
function packScheduleBadge(pack){
  const sch = packSchedule(pack);
  if(sch.notStarted) return {cls:'status-closed', label:'Agendado'};
  if(sch.ended) return {cls:'status-closed', label:'Prazo encerrado'};
  return null;
}

function toast(msg){
  const t = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2600);
}
function friendlyAuthError(e){
  const code = (e && e.code) || '';
  const map = {
    'auth/invalid-credential':'E-mail ou senha inválidos.',
    'auth/wrong-password':'E-mail ou senha inválidos.',
    'auth/user-not-found':'E-mail ou senha inválidos.',
    'auth/email-already-in-use':'Este e-mail já está cadastrado.',
    'auth/weak-password':'A senha precisa ter pelo menos 6 caracteres.',
    'auth/invalid-email':'E-mail inválido.',
    'auth/too-many-requests':'Muitas tentativas. Aguarde um momento e tente novamente.',
    'auth/requires-recent-login':'Por segurança, informe sua senha atual para confirmar essa alteração.'
  };
  return map[code] || (e && e.message ? e.message : 'Ocorreu um erro. Tente novamente.');
}

/* ---------- auth screens ---------- */
function showRegister(){
  document.getElementById('login-form').style.display='none';
  document.getElementById('register-form').style.display='block';
}
function showLogin(){
  document.getElementById('register-form').style.display='none';
  document.getElementById('login-form').style.display='block';
}
async function doLogin(){
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const pass = document.getElementById('login-pass').value;
  const err = document.getElementById('login-err');
  err.style.display='none';
  try{
    await signInWithEmailAndPassword(auth, email, pass);
  }catch(e){
    err.textContent = friendlyAuthError(e);
    err.style.display='block';
  }
}
async function doRegister(){
  const name = document.getElementById('reg-name').value.trim();
  const wpp = document.getElementById('reg-wpp').value.trim();
  const email = document.getElementById('reg-email').value.trim().toLowerCase();
  const pass = document.getElementById('reg-pass').value;
  const err = document.getElementById('reg-err');
  err.style.display='none';
  if(!name||!wpp||!email||!pass){ err.textContent="Preencha todos os campos."; err.style.display='block'; return; }
  try{
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    const role = email===ADMIN_EMAIL ? 'admin' : 'user';
    await setDoc(doc(db,'users',cred.user.uid), {
      name, whatsapp:wpp, email, role, blocked:false, createdAt: serverTimestamp()
    });
    toast('Conta criada com sucesso!');
  }catch(e){
    err.textContent = friendlyAuthError(e);
    err.style.display='block';
  }
}
async function doLogout(){
  clearListeners();
  await signOut(auth);
}

/* ---------- auth state wiring ---------- */
onAuthStateChanged(auth, async (user) => {
  clearListeners();
  if(user){
    try{
      const snap = await getDoc(doc(db,'users',user.uid));
      if(!snap.exists()){
        await signOut(auth);
        document.getElementById('loading').classList.add('hide');
        document.getElementById('auth-wrap').style.display='flex';
        return;
      }
      const profile = snap.data();
      if(profile.blocked){
        toast('Sua conta está bloqueada. Fale com o administrador.');
        await signOut(auth);
        return;
      }
      state.currentUser = { uid:user.uid, id:user.uid, ...profile };
      document.getElementById('loading').classList.add('hide');
      enterApp();
    }catch(e){
      console.error(e);
      document.getElementById('loading').classList.add('hide');
      document.getElementById('auth-wrap').style.display='flex';
      toast('Erro ao carregar sua conta. Verifique as regras do Firestore.');
    }
  } else {
    state.currentUser = null;
    document.getElementById('loading').classList.add('hide');
    document.getElementById('app').style.display='none';
    document.getElementById('auth-wrap').style.display='flex';
    showLogin();
  }
});

function enterApp(){
  document.getElementById('auth-wrap').style.display='none';
  document.getElementById('app').style.display='block';
  const u = state.currentUser;
  document.getElementById('avatar').textContent = (u.name||'U').charAt(0).toUpperCase();
  document.getElementById('side-role').textContent = u.role==='admin' ? 'Administrador' : 'Jogador';
  document.getElementById('admin-pill').style.display = u.role==='admin' ? 'inline-block' : 'none';
  document.getElementById('admin-nav').style.display = u.role==='admin' ? 'flex' : 'none';
  document.getElementById('fab-wa').style.display = 'flex';
  subscribeAll();
  nav(u.role==='admin' ? 'admin-dashboard' : 'dashboard');
}

function mergePacks(){
  state.packs = publicPacksRaw.map(p => ({...p, ...(privatePacksMap[p.id]||{})}));
  renderView(state.currentView);
}

function subscribeAll(){
  publicPacksRaw = []; privatePacksMap = {};
  const unsubPacks = onSnapshot(collection(db,'packs'), (snap)=>{
    publicPacksRaw = snap.docs.map(d=>({id:d.id, ...d.data()}));
    mergePacks();
  }, (e)=>{ console.error('packs listener', e); toast('Erro ao carregar packs. Verifique as regras do Firestore.'); });
  unsubscribers.push(unsubPacks);

  if(state.currentUser.role==='admin'){
    const unsubPriv = onSnapshot(collection(db,'packsPrivate'), (snap)=>{
      privatePacksMap = {};
      snap.docs.forEach(d=>{ privatePacksMap[d.id] = d.data(); });
      mergePacks();
    }, (e)=>console.error('packsPrivate listener', e));
    unsubscribers.push(unsubPriv);

    const unsubPurchases = onSnapshot(collection(db,'purchases'), (snap)=>{
      state.purchases = snap.docs.map(d=>({id:d.id, ...d.data()}));
      renderView(state.currentView);
    }, (e)=>console.error('purchases listener', e));
    unsubscribers.push(unsubPurchases);

    const unsubUsers = onSnapshot(query(collection(db,'users'), where('role','==','user')), (snap)=>{
      state.usersList = snap.docs.map(d=>({id:d.id, ...d.data()}));
      renderView(state.currentView);
    }, (e)=>console.error('users listener', e));
    unsubscribers.push(unsubUsers);
  } else {
    const unsubMine = onSnapshot(query(collection(db,'purchases'), where('userId','==',state.currentUser.uid)), (snap)=>{
      state.purchases = snap.docs.map(d=>({id:d.id, ...d.data()}));
      renderView(state.currentView);
    }, (e)=>console.error('my purchases listener', e));
    unsubscribers.push(unsubMine);
  }
}

/* ---------- nav / sidebar ---------- */
function toggleSidebar(){
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar').classList.toggle('collapsed');
  document.getElementById('sidebar-overlay').classList.toggle('show');
}
const TITLES = {
  dashboard:"Dashboard", mynumbers:"Meus Números", history:"Histórico", account:"Minha Conta",
  'admin-dashboard':"Dashboard Administrativo", 'admin-create':"Criar Pack", 'admin-packs':"Gerenciar Packs",
  'admin-users':"Usuários", 'admin-confirm':"Confirmar Pagamento", 'admin-history':"Histórico Administrativo"
};
const RENDERERS = {
  dashboard:renderDashboard, mynumbers:renderMyNumbers, history:renderHistory, account:renderAccount,
  'admin-dashboard':renderAdminDashboard, 'admin-create':renderAdminCreate, 'admin-packs':renderAdminPacks,
  'admin-users':renderAdminUsers, 'admin-confirm':renderAdminConfirm, 'admin-history':renderAdminHistory
};
function renderView(view){
  (RENDERERS[view]||renderDashboard)();
}
function nav(view){
  state.currentView = view;
  document.querySelectorAll('.nav-item[data-view]').forEach(el=>{
    el.classList.toggle('active', el.dataset.view===view);
  });
  document.getElementById('page-title').textContent = TITLES[view] || '';
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('show');
  renderView(view);
}
function openWhats(){
  const u = state.currentUser;
  const msg = `Olá! Sou ${u.name} e gostaria de falar com o administrador do SO2 Rei dos Golds.`;
  window.open(`https://wa.me/${ADMIN_WHATSAPP}?text=${encodeURIComponent(msg)}`, '_blank');
}
function openWhatsChannel(){
  window.open('https://whatsapp.com/channel/0029VbDdiMD2UPBDp8xSUy3w', '_blank');
}

/* ---------- icon helper ---------- */
const ICON_GOLD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9"/></svg>`;

/* ---------- USER: Dashboard ---------- */
function renderDashboard(){
  const el = document.getElementById('content');
  const packs = state.packs;
  if(packs.length===0){ el.innerHTML = emptyState("Nenhum pack disponível no momento", "Volte em breve para novos sorteios."); return; }
  el.innerHTML = `
    <div class="section-head">
      <h3>Packs disponíveis</h3>
      <div class="sub">Escolha um pack e garanta seus números da sorte</div>
    </div>
    <div class="grid pack-grid">
      ${packs.map(p=>packCardHTML(p)).join('')}
    </div>
  `;
}
function packCardHTML(p){
  const isOpen = isPackPurchasable(p);
  const schBadge = packScheduleBadge(p);
  const badge = schBadge || {cls: isOpen?'status-open':'status-closed', label: isOpen?'Disponível':'Esgotado'};
  const sch = packSchedule(p);
  return `
    <div class="pack-card">
      <span class="status-badge ${badge.cls}">${badge.label}</span>
      <div class="pack-icon">${ICON_GOLD}</div>
      <div class="pack-num">PACK #${p.code}</div>
      <div class="pack-name">${p.type.toLocaleString('pt-BR')} Gold Package</div>
      <div class="pack-price">Valor por número<br><b>${fmtBRL(pricePerNumber(p))}</b></div>
      ${(sch.start || sch.end) ? `
      <div style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6;">
        ${sch.start ? `Início: <b style="color:var(--gold);">${fmtDateTime(p.startsAt)}</b><br>` : ''}
        ${sch.end ? `Término: <b style="color:var(--gold);">${fmtDateTime(p.endsAt)}</b>` : ''}
      </div>` : ''}
      <button class="pack-btn" ${isOpen?'':'disabled'} onclick="openBuyModal('${p.id}')">Comprar Números</button>
    </div>
  `;
}

function openBuyModal(packId){
  const p = state.packs.find(x=>x.id===packId);
  if(!p) return;
  state.pendingBuy = p;
  document.getElementById('buy-title').textContent = `Pack #${p.code} · ${p.type.toLocaleString('pt-BR')} Gold`;
  document.getElementById('buy-sub').textContent = `Disponível: ${availableCount(p)} números · ${fmtBRL(pricePerNumber(p))} cada`;
  document.getElementById('buy-qty').value = 1;
  document.getElementById('buy-qty').max = availableCount(p);
  updateTotal();
  document.getElementById('modal-buy').style.display='flex';
}
function changeQty(d){
  const input = document.getElementById('buy-qty');
  let v = parseInt(input.value||1) + d;
  const p = state.pendingBuy;
  const max = p ? availableCount(p) : 999;
  if(v<1) v=1;
  if(v>max) v=max;
  input.value = v;
  updateTotal();
}
function updateTotal(){
  const p = state.pendingBuy;
  if(!p) return;
  let qty = parseInt(document.getElementById('buy-qty').value||1);
  const max = availableCount(p);
  if(qty>max) { qty=max; document.getElementById('buy-qty').value=max; }
  if(qty<1) { qty=1; document.getElementById('buy-qty').value=1; }
  const total = qty * pricePerNumber(p);
  document.getElementById('buy-total').textContent = fmtBRL(total);
}
function closeModal(id){ document.getElementById(id).style.display='none'; }

function confirmBuy(){
  const p = state.pendingBuy;
  const u = state.currentUser;
  const qty = parseInt(document.getElementById('buy-qty').value||1);
  const total = qty * pricePerNumber(p);
  const msg =
`Olá! Quero comprar números no SO2 Rei dos Golds.

Nome: ${u.name}
WhatsApp: ${u.whatsapp}
E-mail: ${u.email}
Pack: #${p.code} - ${p.type.toLocaleString('pt-BR')} Gold Package
Quantidade de números: ${qty}
Valor total: ${fmtBRL(total)}

Aguardo os dados para pagamento via PIX.`;
  window.open(`https://wa.me/${ADMIN_WHATSAPP}?text=${encodeURIComponent(msg)}`, '_blank');
  closeModal('modal-buy');
  toast('Pedido enviado via WhatsApp! Aguarde a confirmação do administrador.');
}

/* ---------- USER: My numbers ---------- */
function renderMyNumbers(){
  const el = document.getElementById('content');
  const mine = state.purchases;
  if(mine.length===0){
    el.innerHTML = emptyState("Você ainda não tem números", "Compre números em um pack para vê-los aqui.");
    return;
  }
  el.innerHTML = `<div class="grid" style="gap:16px;">` + mine.map(pu=>{
    const pack = state.packs.find(p=>p.id===pu.packId) || {code:'——', type:0};
    return `
      <div class="card">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
          <div>
            <div class="pack-num">PACK #${pack.code}</div>
            <div class="pack-name" style="font-size:15px;">${pack.type.toLocaleString('pt-BR')} Gold Package</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:11px;color:var(--muted);">Números adquiridos</div>
            <div style="font-family:'Poppins';font-weight:800;color:var(--gold);">${pu.numbers.length}</div>
          </div>
        </div>
        <div>${pu.numbers.map(n=>`<span class="num-chip">${n}</span>`).join('')}</div>
      </div>`;
  }).join('') + `</div>`;
}

/* ---------- USER: History ---------- */
function renderHistory(){
  const el = document.getElementById('content');
  const mine = state.purchases;
  if(mine.length===0){
    el.innerHTML = emptyState("Nenhum histórico ainda", "Seus packs concluídos aparecerão aqui.");
    return;
  }
  el.innerHTML = `
    <div class="card" style="padding:0;overflow-x:auto;">
      <table>
        <thead><tr><th>Pack</th><th>Nome</th><th>Valor</th><th>Data</th><th>Status</th></tr></thead>
        <tbody>
        ${mine.map(pu=>{
          const pack = state.packs.find(p=>p.id===pu.packId) || {code:'——', type:0, status:'closed'};
          return `<tr>
            <td>#${pack.code}</td>
            <td>${pack.type.toLocaleString('pt-BR')} Gold Package</td>
            <td>${fmtBRL(pu.amount)}</td>
            <td>${pu.date}</td>
            <td><span class="badge-role ${pack.status==='open'?'badge-active':'badge-blocked'}">${pack.status==='open'?'Em andamento':'Encerrado'}</span></td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ---------- USER: Account ---------- */
function renderAccount(){
  const el = document.getElementById('content');
  const u = state.currentUser;
  el.innerHTML = `
    <div class="card" style="max-width:460px;">
      <div class="field"><label>Nome</label><input id="acc-name" value="${u.name}"></div>
      <div class="field"><label>WhatsApp</label><input id="acc-wpp" value="${u.whatsapp}"></div>
      <div class="field"><label>E-mail</label><input id="acc-email" value="${u.email}"></div>
      <div class="field"><label>Nova senha (deixe em branco para manter)</label><input id="acc-pass" type="password" placeholder="••••••••"></div>
      <div class="field"><label>Senha atual (só é preciso se mudar e-mail ou senha)</label><input id="acc-currentpass" type="password" placeholder="••••••••"></div>
      <button class="btn-gold" onclick="saveAccount()">Salvar alterações</button>
    </div>`;
}
async function saveAccount(){
  const u = state.currentUser;
  const name = document.getElementById('acc-name').value.trim() || u.name;
  const wpp = document.getElementById('acc-wpp').value.trim() || u.whatsapp;
  const newEmail = document.getElementById('acc-email').value.trim().toLowerCase();
  const newPass = document.getElementById('acc-pass').value;
  const currentPass = document.getElementById('acc-currentpass').value;

  try{
    await updateDoc(doc(db,'users',u.uid), { name, whatsapp: wpp });
    const emailChanged = newEmail && newEmail !== (u.email||'').toLowerCase();

    if(emailChanged || newPass){
      if(!currentPass){ toast('Informe sua senha atual para alterar e-mail ou senha.'); return; }
      const cred = EmailAuthProvider.credential(u.email, currentPass);
      await reauthenticateWithCredential(auth.currentUser, cred);
      if(emailChanged){
        await updateEmail(auth.currentUser, newEmail);
        await updateDoc(doc(db,'users',u.uid), { email:newEmail });
      }
      if(newPass){ await updatePassword(auth.currentUser, newPass); }
    }
    state.currentUser = { ...u, name, whatsapp:wpp, email: emailChanged?newEmail:u.email };
    document.getElementById('avatar').textContent = name.charAt(0).toUpperCase();
    toast('Dados atualizados com sucesso!');
    renderAccount();
  }catch(e){
    toast(friendlyAuthError(e));
  }
}

/* ---------- shared: empty state ---------- */
function emptyState(title, sub){
  return `<div class="card empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12h8M12 8v8"/></svg>
    <div class="e-title">${title}</div>
    <div>${sub}</div>
  </div>`;
}

/* ================= ADMIN ================= */
function renderAdminDashboard(){
  const el = document.getElementById('content');
  const totalUsers = state.usersList.length;
  const active = state.packs.filter(p=>p.status==='open').length;
  const closed = state.packs.filter(p=>p.status==='closed').length;
  const confirmedPayments = state.purchases.length;
  const arrecadado = state.purchases.reduce((s,pu)=>s+pu.amount,0);
  const custoTotal = state.packs.reduce((s,p)=>s+(p.cost||0),0);
  const lucroAlvo = custoTotal;
  el.innerHTML = `
    <div class="grid stat-grid">
      <div class="stat-card"><div class="lbl">Total de usuários</div><div class="val">${totalUsers}</div></div>
      <div class="stat-card"><div class="lbl">Packs ativos</div><div class="val gold">${active}</div></div>
      <div class="stat-card"><div class="lbl">Packs encerrados</div><div class="val">${closed}</div></div>
      <div class="stat-card"><div class="lbl">Pagamentos confirmados</div><div class="val gold">${confirmedPayments}</div></div>
    </div>
    <div class="grid stat-grid">
      <div class="stat-card"><div class="lbl">Arrecadado até agora</div><div class="val gold">${fmtBRL(arrecadado)}</div></div>
      <div class="stat-card"><div class="lbl">Custo total dos packs</div><div class="val">${fmtBRL(custoTotal)}</div></div>
      <div class="stat-card"><div class="lbl">Lucro alvo (100% do custo)</div><div class="val" style="color:var(--green);">${fmtBRL(lucroAlvo)}</div></div>
    </div>
    <div class="section-head"><h3>Histórico recente</h3></div>
    ${state.purchases.length===0 ? emptyState("Nenhuma operação ainda", "As confirmações de pagamento aparecerão aqui.") : `
    <div class="card" style="padding:0;overflow-x:auto;">
      <table>
        <thead><tr><th>Pack</th><th>Usuário</th><th>Qtd</th><th>Valor</th><th>Data</th></tr></thead>
        <tbody>
        ${state.purchases.slice().reverse().slice(0,6).map(pu=>{
          const pack = state.packs.find(p=>p.id===pu.packId) || {code:'——'};
          const user = state.usersList.find(u=>u.id===pu.userId) || {name:'Usuário removido'};
          return `<tr><td>#${pack.code}</td><td>${user.name}</td><td>${pu.numbers.length}</td><td>${fmtBRL(pu.amount)}</td><td>${pu.date}</td></tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>`}
  `;
}

function renderAdminCreate(){
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="card" style="max-width:480px;">
      <div class="field">
        <label>Tipo do Pack</label>
        <select id="np-type" style="width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--border);background:#0e0c0a;color:#fff;font-size:16px;">
          ${PACK_TYPES.map(t=>`<option value="${t}">${t.toLocaleString('pt-BR')} Gold Package · custo ${fmtBRL(PACK_COSTS[t])}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Quantidade total de números</label><input id="np-qty" type="number" min="1" value="100"></div>
      <div class="field">
        <label>Programar início (opcional)</label>
        <input id="np-start" type="datetime-local">
      </div>
      <div class="field">
        <label>Programar término (opcional)</label>
        <input id="np-end" type="datetime-local">
        <div style="font-size:11px;color:var(--muted);margin-top:5px;">Deixe em branco para o pack ficar disponível imediatamente e sem prazo para encerrar. Fora do período programado, a compra fica bloqueada automaticamente para os usuários.</div>
      </div>
      <div class="field">
        <label>Código de resgate (opcional)</label>
        <input id="np-code" type="text" placeholder="Pode deixar em branco e adicionar depois">
        <div style="font-size:11px;color:var(--muted);margin-top:5px;">Não é obrigatório agora — você pode adicionar assim que recuperar 100% do custo do pack. Esse código nunca aparece para os usuários; ele só é enviado ao vencedor, junto com o número sorteado, após o sorteio.</div>
      </div>
      <div class="card" style="background:#0e0c0a;padding:14px;margin:6px 0 16px;">
        <div style="font-size:10px;color:#655c4b;text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:10px;">Visível apenas para você (Admin)</div>
        <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--muted);margin-bottom:6px;"><span>Custo do pack</span><b id="np-cost" style="color:#fff;">—</b></div>
        <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--muted);margin-bottom:6px;"><span>Lucro (100% sobre o custo)</span><b id="np-profit" style="color:var(--green);">—</b></div>
        <div style="height:1px;background:var(--border);margin:8px 0;"></div>
        <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--muted);margin-bottom:6px;"><span>Valor total a arrecadar</span><b id="np-total" style="color:var(--gold);">—</b></div>
        <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--muted);"><span>Valor por número (visível ao usuário)</span><b id="np-unit" style="color:var(--gold);">—</b></div>
      </div>
      <button class="btn-gold" onclick="createPack()">Criar Pack</button>
    </div>
  `;
  const recompute = ()=>{
    const type = parseInt(document.getElementById('np-type').value);
    const cost = PACK_COSTS[type];
    const qty = Math.max(1, parseInt(document.getElementById('np-qty').value||1));
    document.getElementById('np-cost').textContent = fmtBRL(cost);
    document.getElementById('np-profit').textContent = fmtBRL(cost);
    document.getElementById('np-total').textContent = fmtBRL(cost*2);
    document.getElementById('np-unit').textContent = fmtBRL((cost*2)/qty);
  };
  document.getElementById('np-type').addEventListener('change', recompute);
  document.getElementById('np-qty').addEventListener('input', recompute);
  recompute();
}

async function nextPackCode(){
  const counterRef = doc(db,'counters','packs');
  const n = await runTransaction(db, async (tx)=>{
    const snap = await tx.get(counterRef);
    const next = snap.exists() ? (snap.data().value||0)+1 : 1;
    tx.set(counterRef, { value: next }, { merge:true });
    return next;
  });
  return String(n).padStart(6,'0');
}
async function createPack(){
  const type = parseInt(document.getElementById('np-type').value);
  const cost = PACK_COSTS[type];
  const qty = Math.max(1, parseInt(document.getElementById('np-qty').value||1));
  const redeemCode = document.getElementById('np-code').value.trim() || null;
  const startVal = document.getElementById('np-start').value;
  const endVal = document.getElementById('np-end').value;
  const startsAt = startVal ? new Date(startVal).toISOString() : null;
  const endsAt = endVal ? new Date(endVal).toISOString() : null;
  if(startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)){
    toast('O término precisa ser depois do início.');
    return;
  }
  const pricePerNumber = (cost*2)/qty;
  try{
    const code = await nextPackCode();
    await setDoc(doc(db,'packs',code), {
      code, type, totalNumbers:qty, sold:[], status:'open', pricePerNumber, startsAt, endsAt, createdAt: serverTimestamp()
    });
    await setDoc(doc(db,'packsPrivate',code), { cost, redeemCode, winner:null });
    toast(`Pack #${code} criado com sucesso!`);
    nav('admin-packs');
  }catch(e){
    console.error(e);
    toast('Erro ao criar pack. Verifique as regras do Firestore.');
  }
}

function renderAdminPacks(){
  const el = document.getElementById('content');
  if(state.packs.length===0){ el.innerHTML = emptyState("Nenhum pack criado ainda", "Crie o primeiro pack na aba \"Criar Pack\"."); return; }
  el.innerHTML = `
    <div class="grid pack-grid">
      ${state.packs.map(p=>{
        const full = availableCount(p) <= 0 && p.totalNumbers > 0;
        const schBadge = packScheduleBadge(p);
        const badge = p.winner ? {cls:'status-closed', label:'Sorteado'} : full ? {cls:'status-open', label:'Esgotado'} : schBadge ? schBadge : {cls: p.status==='open'?'status-open':'status-closed', label: p.status==='open'?'Ativo':'Encerrado'};
        const sch = packSchedule(p);
        return `
        <div class="pack-card">
          <span class="status-badge ${badge.cls}">${badge.label}</span>
          <div class="pack-icon">${ICON_GOLD}</div>
          <div class="pack-num">PACK #${p.code}</div>
          <div class="pack-name">${p.type.toLocaleString('pt-BR')} Gold Package</div>
          <div class="pack-price">
            Vendidos: <b>${soldCount(p)}/${p.totalNumbers}</b><br>
            Preço/número: <b>${fmtBRL(pricePerNumber(p))}</b><br>
            <span style="color:#655c4b;">Custo: ${fmtBRL(p.cost)} · Lucro alvo: <span style="color:var(--green);">${fmtBRL(packProfit(p))}</span></span><br>
            <span style="color:#655c4b;">Código de resgate: ${p.redeemCode ? `<span style="color:var(--gold);font-weight:700;">${p.redeemCode}</span>` : '<span style="color:var(--red);">não definido</span>'}</span>
          </div>
          ${(sch.start || sch.end) ? `
          <div style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6;">
            ${sch.start ? `Início: <b style="color:var(--gold);">${fmtDateTime(p.startsAt)}</b><br>` : ''}
            ${sch.end ? `Término: <b style="color:var(--gold);">${fmtDateTime(p.endsAt)}</b>` : ''}
          </div>` : ''}
          ${p.winner ? `
          <div style="margin-top:12px;padding:10px 12px;border-radius:12px;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.35);font-size:12.5px;">
            🏆 Vencedor: <b style="color:#fff;">${p.winner.userName}</b><br>
            Número sorteado: <b style="color:var(--gold);">${p.winner.number}</b>
          </div>` : ''}
          <div class="btn-row" style="margin-top:14px;flex-wrap:wrap;">
            <button class="btn-small" onclick="editPackQty('${p.id}')">Editar</button>
            <button class="btn-small ${p.status==='open'?'danger':''}" onclick="togglePackStatus('${p.id}')">${p.status==='open'?'Encerrar':'Reativar'}</button>
            <button class="btn-small danger" onclick="deletePack('${p.id}')">Excluir</button>
            ${full && !p.winner ? `<button class="btn-small" style="background:var(--gold);color:#000;border-color:var(--gold);" onclick="drawWinner('${p.id}')">🎲 Sortear Número</button>` : ''}
            ${p.winner ? `<button class="btn-wa" onclick="contactWinner('${p.id}')">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.84.5 3.55 1.36 5.03L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2z"/></svg>
              Falar com o vencedor
            </button>` : ''}
          </div>
        </div>
      `;}).join('')}
    </div>
  `;
}
async function togglePackStatus(id){
  const p = state.packs.find(x=>x.id===id);
  if(!p) return;
  const newStatus = p.status==='open' ? 'closed' : 'open';
  try{
    await updateDoc(doc(db,'packs',id), { status:newStatus });
    toast(`Pack #${p.code} ${newStatus==='open'?'reativado':'encerrado'}.`);
  }catch(e){ toast('Erro ao atualizar pack.'); }
}
function deletePack(id){
  const p = state.packs.find(x=>x.id===id);
  if(!p) return;
  openGenericModal(`
    <h3>Excluir Pack #${p.code}?</h3>
    <div class="m-sub">Essa ação não pode ser desfeita. ${soldCount(p)>0?`<b style="color:var(--red);">Atenção: este pack já tem ${soldCount(p)} número(s) vendido(s). O histórico de compras é mantido para auditoria mesmo após a exclusão do pack.</b>`:''}</div>
    <div class="btn-row">
      <button class="btn-secondary" onclick="closeModal('modal-generic')">Cancelar</button>
      <button class="btn-small danger" style="flex:1;" onclick="doDeletePack('${p.id}')">Sim, excluir</button>
    </div>
  `);
}
async function doDeletePack(id){
  try{
    await deleteDoc(doc(db,'packs',id));
    await deleteDoc(doc(db,'packsPrivate',id));
    closeModal('modal-generic');
    toast('Pack excluído.');
  }catch(e){ toast('Erro ao excluir pack.'); }
}
function editPackQty(id){
  const p = state.packs.find(x=>x.id===id);
  if(!p) return;
  openGenericModal(`
    <h3>Editar Pack #${p.code}</h3>
    <div class="m-sub">${p.type.toLocaleString('pt-BR')} Gold Package</div>
    <div class="field"><label>Quantidade total de números</label><input id="edit-qty" type="number" min="${soldCount(p)}" value="${p.totalNumbers}"></div>
    <div class="field">
      <label>Programar início (opcional)</label>
      <input id="edit-start" type="datetime-local" value="${toDatetimeLocalValue(p.startsAt)}">
    </div>
    <div class="field">
      <label>Programar término (opcional)</label>
      <input id="edit-end" type="datetime-local" value="${toDatetimeLocalValue(p.endsAt)}">
      <div style="font-size:11px;color:var(--muted);margin-top:5px;">Deixe em branco para não ter agendamento. Fora do período, a compra fica bloqueada automaticamente.</div>
    </div>
    <div class="field">
      <label>Código de resgate (opcional)</label>
      <input id="edit-code" type="text" value="${p.redeemCode || ''}" placeholder="Adicione quando recuperar 100% do custo">
      <div style="font-size:11px;color:var(--muted);margin-top:5px;">Visível só para você. É enviado ao vencedor junto com o número sorteado.</div>
    </div>
    <div class="btn-row">
      <button class="btn-secondary" onclick="closeModal('modal-generic')">Cancelar</button>
      <button class="btn-gold" style="flex:1;" onclick="saveEditPack('${p.id}')">Salvar</button>
    </div>
  `);
}
async function saveEditPack(id){
  const p = state.packs.find(x=>x.id===id);
  if(!p) return;
  const v = parseInt(document.getElementById('edit-qty').value||p.totalNumbers);
  if(v < soldCount(p)){ toast('Quantidade não pode ser menor que os números já vendidos.'); return; }
  const redeemCode = document.getElementById('edit-code').value.trim() || null;
  const startVal = document.getElementById('edit-start').value;
  const endVal = document.getElementById('edit-end').value;
  const startsAt = startVal ? new Date(startVal).toISOString() : null;
  const endsAt = endVal ? new Date(endVal).toISOString() : null;
  if(startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)){
    toast('O término precisa ser depois do início.');
    return;
  }
  const pricePerNumber = (p.cost*2)/v;
  try{
    await updateDoc(doc(db,'packs',id), { totalNumbers:v, pricePerNumber, startsAt, endsAt });
    await updateDoc(doc(db,'packsPrivate',id), { redeemCode });
    closeModal('modal-generic');
    toast('Pack atualizado.');
  }catch(e){ toast('Erro ao atualizar pack.'); }
}

function renderAdminUsers(){
  const el = document.getElementById('content');
  const users = state.usersList;
  el.innerHTML = `
    <div class="search-bar" style="margin-bottom:16px;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
      <input id="users-search" placeholder="Buscar por nome ou e-mail..." oninput="filterUsers(this.value)">
    </div>
    <div class="hist-list" id="users-list">${users.map((u,idx)=>userCard(u,idx)).join('')}</div>
    ${users.length===0 ? emptyState("Nenhum usuário cadastrado", "Contas criadas pelos jogadores aparecerão aqui.") : ''}
  `;
}
function userCard(u, idx){
  const purchases = state.purchases.filter(pu=>pu.userId===u.id);
  const totalNumbers = purchases.reduce((s,pu)=>s+pu.numbers.length,0);
  const totalSpent = purchases.reduce((s,pu)=>s+pu.amount,0);
  return `
  <div class="hist-item" id="user-${idx}" data-name="${u.name.toLowerCase()}" data-email="${u.email.toLowerCase()}">
    <div class="hist-head" onclick="toggleUser(${idx})">
      <div class="hist-main">
        <div class="hist-pack">${u.blocked ? '<span style="color:var(--red);">BLOQUEADO</span>' : '<span style="color:var(--green);">ATIVO</span>'}</div>
        <div class="hist-user">${u.name}</div>
      </div>
      <div class="hist-meta">
        <span>${u.email}</span>
        <span><b>${totalNumbers}</b> número${totalNumbers!==1?'s':''}</span>
      </div>
      <div class="hist-chevron">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </div>
    </div>
    <div class="hist-details">
      <div class="hist-details-in">
        <div class="hist-row"><span class="k">Nome completo</span><span class="v">${u.name}</span></div>
        <div class="hist-row"><span class="k">WhatsApp</span><span class="v">${u.whatsapp}</span></div>
        <div class="hist-row"><span class="k">E-mail</span><span class="v">${u.email}</span></div>
        <div class="hist-row"><span class="k">Status</span><span class="v"><span class="badge-role ${u.blocked?'badge-blocked':'badge-active'}">${u.blocked?'Bloqueado':'Ativo'}</span></span></div>
        <div class="hist-row"><span class="k">Packs participados</span><span class="v">${purchases.length}</span></div>
        <div class="hist-row"><span class="k">Total gasto</span><span class="v">${fmtBRL(totalSpent)}</span></div>
        <div class="btn-row" style="margin-top:14px;">
          <button class="btn-small" onclick="toggleBlock('${u.id}')">${u.blocked?'Desbloquear':'Bloquear'}</button>
          <button class="btn-small danger" onclick="deleteUser('${u.id}')">Excluir conta</button>
        </div>
      </div>
    </div>
  </div>`;
}
function toggleUser(idx){
  document.getElementById('user-'+idx).classList.toggle('open');
}
function filterUsers(q){
  q=q.toLowerCase();
  document.querySelectorAll('#users-list .hist-item').forEach(item=>{
    const match = item.dataset.name.includes(q) || item.dataset.email.includes(q);
    item.style.display = match?'':'none';
  });
}
async function toggleBlock(id){
  const u = state.usersList.find(x=>x.id===id);
  if(!u) return;
  const next = !u.blocked;
  try{
    await updateDoc(doc(db,'users',id), { blocked: next });
    toast(`${u.name} ${next?'bloqueado':'desbloqueado'}.`);
  }catch(e){ toast('Erro ao atualizar usuário.'); }
}
function deleteUser(id){
  const u = state.usersList.find(x=>x.id===id);
  if(!u) return;
  openGenericModal(`
    <h3>Excluir conta de ${u.name}?</h3>
    <div class="m-sub">Isso remove o perfil do usuário do sistema. Por segurança, a conta de login (e-mail/senha) no Firebase Authentication não é removida automaticamente pelo app — se quiser bloquear o acesso por completo, use "Bloquear" ou remova a conta manualmente pelo Console do Firebase.</div>
    <div class="btn-row">
      <button class="btn-secondary" onclick="closeModal('modal-generic')">Cancelar</button>
      <button class="btn-small danger" style="flex:1;" onclick="doDeleteUser('${u.id}')">Sim, excluir perfil</button>
    </div>
  `);
}
async function doDeleteUser(id){
  try{
    await deleteDoc(doc(db,'users',id));
    closeModal('modal-generic');
    toast('Perfil do usuário excluído.');
  }catch(e){ toast('Erro ao excluir usuário.'); }
}

function renderAdminConfirm(){
  const el = document.getElementById('content');
  const openPacks = state.packs.filter(p=>p.status==='open' && availableCount(p)>0);
  const users = state.usersList;
  el.innerHTML = `
    <div class="card" style="max-width:480px;">
      <div class="m-sub" style="margin-bottom:16px;">Confirme um pagamento recebido via PIX para gerar e vincular os números automaticamente.</div>
      ${openPacks.length===0 || users.length===0 ? `<div style="font-size:13px;color:var(--muted);">${openPacks.length===0?'Nenhum pack disponível no momento.':''} ${users.length===0?'Nenhum usuário cadastrado ainda.':''}</div>` : `
      <div class="field">
        <label>Pack</label>
        <select id="cf-pack" style="width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--border);background:#0e0c0a;color:#fff;font-size:16px;">
          ${openPacks.map(p=>`<option value="${p.id}">#${p.code} · ${p.type.toLocaleString('pt-BR')} Gold (${availableCount(p)} disp.)</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Usuário</label>
        <select id="cf-user" style="width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--border);background:#0e0c0a;color:#fff;font-size:16px;">
          ${users.map(u=>`<option value="${u.id}">${u.name} · ${u.email}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Quantidade de números comprados</label><input id="cf-qty" type="number" min="1" value="1"></div>
      <button class="btn-gold" onclick="confirmPayment()">Confirmar Pagamento</button>
      `}
    </div>
    <div id="cf-result" style="margin-top:20px;max-width:480px;"></div>
  `;
}
async function confirmPayment(){
  const packId = document.getElementById('cf-pack').value;
  const userId = document.getElementById('cf-user').value;
  const qty = Math.max(1, parseInt(document.getElementById('cf-qty').value||1));
  const packRef = doc(db,'packs',packId);
  try{
    const numbers = await runTransaction(db, async (tx)=>{
      const snap = await tx.get(packRef);
      if(!snap.exists()) throw new Error('Pack não encontrado.');
      const pack = snap.data();
      const sold = pack.sold || [];
      const available = pack.totalNumbers - sold.length;
      if(qty > available) throw new Error('Quantidade maior que os números disponíveis neste pack.');
      const existing = new Set(sold);
      const nums = [];
      while(nums.length < qty){
        const n = String(Math.floor(100000 + Math.random()*900000));
        if(!existing.has(n) && !nums.includes(n)) nums.push(n);
      }
      tx.update(packRef, { sold: sold.concat(nums) });
      const purchaseRef = doc(collection(db,'purchases'));
      tx.set(purchaseRef, {
        packId, userId, numbers: nums,
        amount: qty * pack.pricePerNumber,
        date: new Date().toLocaleDateString('pt-BR'),
        createdAt: serverTimestamp()
      });
      return nums;
    });
    toast('Pagamento confirmado e números gerados!');
    showConfirmResult(packId, userId, numbers);
  }catch(e){
    toast(e.message || 'Erro ao confirmar pagamento.');
  }
}
function showConfirmResult(packId, userId, numbers){
  const pack = state.packs.find(p=>p.id===packId) || {code:'——', type:0};
  const user = state.usersList.find(u=>u.id===userId) || {name:'Usuário', whatsapp:''};
  const msg =
`Olá ${user.name}! Seu pagamento foi confirmado. 🎉

Pack: #${pack.code} - ${pack.type.toLocaleString('pt-BR')} Gold Package
Quantidade: ${numbers.length} números
Seus números da sorte:
${numbers.join(', ')}

Boa sorte!`;
  document.getElementById('cf-result').innerHTML = `
    <div class="card">
      <div style="font-family:'Poppins';font-weight:700;margin-bottom:10px;">Números gerados para ${user.name}</div>
      <div>${numbers.map(n=>`<span class="num-chip">${n}</span>`).join('')}</div>
      <div class="btn-row">
        <button class="btn-secondary" onclick="navigator.clipboard.writeText('${numbers.join(', ')}');toast('Números copiados!');">Copiar</button>
        <button class="btn-wa" onclick="window.open('https://wa.me/${(user.whatsapp||'').replace(/\D/g,'')}?text=${encodeURIComponent(msg)}','_blank')">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.84.5 3.55 1.36 5.03L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91C21.96 6.45 17.5 2 12.04 2z"/></svg>
          Enviar pelo WhatsApp
        </button>
      </div>
    </div>
  `;
}

function renderAdminHistory(){
  const el = document.getElementById('content');
  if(state.purchases.length===0){
    el.innerHTML = emptyState("Nenhum registro ainda", "Todas as confirmações de pagamento aparecerão aqui, permanentemente.");
    return;
  }
  const items = state.purchases.slice().reverse();
  el.innerHTML = `
    <div class="hist-list">
      ${items.map((pu, idx)=>{
        const pack = state.packs.find(p=>p.id===pu.packId) || {code:'——', type:0};
        const user = state.usersList.find(u=>u.id===pu.userId);
        return `
        <div class="hist-item" id="hist-${idx}">
          <div class="hist-head" onclick="toggleHistory(${idx})">
            <div class="hist-main">
              <div class="hist-pack">PACK #${pack.code}</div>
              <div class="hist-user">${user ? user.name : 'Usuário removido'}</div>
            </div>
            <div class="hist-meta">
              <span><b>${pu.numbers.length}</b> número${pu.numbers.length>1?'s':''}</span>
              <span><b>${fmtBRL(pu.amount)}</b></span>
              <span>${pu.date}</span>
            </div>
            <div class="hist-chevron">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
            </div>
          </div>
          <div class="hist-details">
            <div class="hist-details-in">
              <div class="hist-row"><span class="k">Pack</span><span class="v">#${pack.code} · ${pack.type.toLocaleString('pt-BR')} Gold Package</span></div>
              <div class="hist-row"><span class="k">Usuário</span><span class="v">${user ? user.name : '—'}</span></div>
              <div class="hist-row"><span class="k">WhatsApp</span><span class="v">${user ? user.whatsapp : '—'}</span></div>
              <div class="hist-row"><span class="k">E-mail</span><span class="v">${user ? user.email : '—'}</span></div>
              <div class="hist-row"><span class="k">Valor pago</span><span class="v">${fmtBRL(pu.amount)}</span></div>
              <div class="hist-row"><span class="k">Data e hora</span><span class="v">${pu.date}</span></div>
              <div class="hist-numbers-label">Números gerados (${pu.numbers.length})</div>
              <div class="hist-numbers">${pu.numbers.map(n=>`<span class="num-chip">${n}</span>`).join('')}</div>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}
function toggleHistory(idx){
  document.getElementById('hist-'+idx).classList.toggle('open');
}

async function drawWinner(id){
  const p = state.packs.find(x=>x.id===id);
  if(!p) return;
  if(availableCount(p) > 0){ toast('Este pack ainda não está esgotado.'); return; }
  if(!(p.sold||[]).length){ toast('Este pack não tem números vendidos.'); return; }
  const number = p.sold[Math.floor(Math.random()*p.sold.length)];
  const purchase = state.purchases.find(pu=>pu.packId===id && pu.numbers.includes(number));
  const user = purchase ? state.usersList.find(u=>u.id===purchase.userId) : null;
  const winner = { number, userId: user? user.id : null, userName: user? user.name : 'Usuário não identificado', date: new Date().toLocaleDateString('pt-BR') };
  try{
    await updateDoc(doc(db,'packsPrivate',id), { winner });
    await updateDoc(doc(db,'packs',id), { status:'closed' });
    toast(`Número sorteado: ${number} 🎉`);
  }catch(e){ toast('Erro ao sortear. Verifique as regras do Firestore.'); }
}
function contactWinner(id){
  const p = state.packs.find(x=>x.id===id);
  if(!p || !p.winner) return;
  const user = state.usersList.find(u=>u.id===p.winner.userId);
  if(!user){ toast('Usuário do vencedor não encontrado.'); return; }
  if(!p.redeemCode){
    openGenericModal(`
      <h3>Código de resgate não definido</h3>
      <div class="m-sub">Este pack ainda não tem um código de resgate cadastrado. Você pode adicionar agora ou enviar a mensagem mesmo assim e incluir o código depois.</div>
      <div class="btn-row">
        <button class="btn-secondary" onclick="closeModal('modal-generic')">Cancelar</button>
        <button class="btn-small" style="flex:1;" onclick="closeModal('modal-generic');editPackQty('${p.id}');">Adicionar código</button>
        <button class="btn-gold" style="flex:1;" onclick="closeModal('modal-generic');sendWinnerMessage('${p.id}');">Enviar sem código</button>
      </div>
    `);
    return;
  }
  sendWinnerMessage(id);
}
function sendWinnerMessage(id){
  const p = state.packs.find(x=>x.id===id);
  const user = state.usersList.find(u=>u.id===p.winner.userId);
  if(!user){ toast('Usuário do vencedor não encontrado.'); return; }
  const instructions = p.redeemCode
    ? `Como resgatar:
1. Acesse https://store.standoff2.com/pt-BR
2. Faça login na sua conta do Standoff 2. Se o site solicitar, informe o Player ID, que pode ser encontrado no Perfil dentro do jogo.
3. Acesse a opção Código Promocional (Promo Code).
4. Digite o código acima e confirme o resgate.`
    : `Em breve enviaremos o código de resgate e as instruções por aqui. Fique de olho!`;
  const msg =
`Parabéns ${user.name}! 🏆🎉

O sorteio do Pack #${p.code} - ${p.type.toLocaleString('pt-BR')} Gold Package foi realizado!

Número sorteado: ${p.winner.number}
${p.redeemCode ? `Código de resgate: ${p.redeemCode}\n` : ''}
${instructions}`;
  window.open(`https://wa.me/${user.whatsapp.replace(/\D/g,'')}?text=${encodeURIComponent(msg)}`,'_blank');
}

/* ---------- generic modal ---------- */
function openGenericModal(html){
  document.getElementById('modal-generic-body').innerHTML = `<span class="modal-close" onclick="closeModal('modal-generic')">&times;</span>` + html;
  document.getElementById('modal-generic').style.display = 'flex';
}

/* ---------- expose functions used by inline HTML event handlers ---------- */
Object.assign(window, {
  changeQty, closeModal, confirmBuy, confirmPayment, contactWinner, createPack,
  deletePack, deleteUser, doDeletePack, doDeleteUser, doLogin, doLogout, doRegister,
  drawWinner, editPackQty, filterUsers, nav, openBuyModal, openWhats, openWhatsChannel, saveAccount,
  saveEditPack, sendWinnerMessage, showLogin, showRegister, toast, toggleBlock,
  toggleHistory, togglePackStatus, toggleSidebar, toggleUser, updateTotal
});
