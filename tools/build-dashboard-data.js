const fs = require('fs');

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const idx = arg.indexOf('=');
  return idx >= 0 ? [arg.slice(0, idx), arg.slice(idx + 1)] : [arg, ''];
}));

const htmlPath = args['--html'];
const exportDir = args['--exports'] || 'exports';
const year = Number(args['--year'] || 2026);

if (!htmlPath) {
  throw new Error('Informe --html=<caminho do index.html>');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        value += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(value);
      value = '';
    } else if (ch === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (ch !== '\r') {
      value += ch;
    }
  }
  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows.shift().map((h) => h.replace(/^\uFEFF/, ''));
  return rows.filter((r) => r.some((v) => String(v || '').trim() !== '')).map((r) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = r[i] == null ? '' : r[i];
    });
    return obj;
  });
}

function readCsv(path) {
  if (!fs.existsSync(path)) return [];
  return parseCsv(fs.readFileSync(path, 'utf8'));
}

function toNumber(value, fallback = 0) {
  if (value == null || value === '' || value === '—') return fallback;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

function parseBrazilDate(value, month, day) {
  const m = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]), 0);
  return new Date(year, Number(month) - 1, Number(day), 0, 0, 0);
}

function getPeriodName(hour) {
  if (hour < 10) return '1 Periodo';
  if (hour < 12) return '2 Periodo';
  if (hour < 14) return '3 Periodo';
  if (hour < 16) return '4 Periodo';
  return '5 Periodo';
}

function avg(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function fTime(seconds) {
  seconds = Math.max(0, Math.round(Number(seconds) || 0));
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = String(keyFn(item));
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function dayOfWeekIndex(month, day) {
  const dow = new Date(year, Number(month) - 1, Number(day)).getDay();
  return dow >= 1 && dow <= 5 ? dow - 1 : null;
}

function getConstDataBlock(html) {
  const marker = 'const D =';
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error('Bloco const D nao encontrado.');
  const start = html.indexOf('{', markerIndex);
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  throw new Error('Fim do bloco const D nao encontrado.');
}

function ensureLiveRefreshHtml(html) {
  let next = html.replace(
    'const DASHBOARD_REFRESH_INTERVAL_MS=5*60*1000;',
    'const DASHBOARD_REFRESH_INTERVAL_MS=30*1000;',
  );

  if (!next.includes('/api/neppo-live/dashboard')) {
    const liveFunction = `async function readDashboardLivePayload(force=false){
  const controller=new AbortController();
  const timeoutId=setTimeout(()=>controller.abort(),25000);
  try{
    const url=new URL('/api/neppo-live/dashboard',location.origin);
    url.searchParams.set('year','2026');
    url.searchParams.set('month',String(D.focusMonth||new Date().getMonth()+1));
    url.searchParams.set('_',Date.now());
    if(force)url.searchParams.set('force','1');
    const res=await fetch(url.toString(),{cache:'no-store',credentials:'same-origin',signal:controller.signal});
    const payload=await res.json().catch(()=>null);
    if(!res.ok||!payload?.ok||!payload?.data)return null;
    return {data:payload.data,signature:payload.signature||dashboardNumbersSignature(payload.data),meta:payload.meta||{},source:'neppo-live'};
  }catch{return null;}
  finally{clearTimeout(timeoutId);}
}
`;
    next = next.replace(
      /function dashboardNumbersSignature\(data\)\{[\s\S]*?\n\}\nasync function readDashboardAssetPayload\(\)\{/,
      (match) => match.replace('\nasync function readDashboardAssetPayload(){', `\n${liveFunction}async function readDashboardAssetPayload(force=false){`),
    );
    next = next.replace(
      "  try{\n    const url=new URL(location.href);",
      "  try{\n    const live=await readDashboardLivePayload(force);\n    if(live)return live;\n    const url=new URL(location.href);",
    );
  }

  if (!next.includes('function liveTmaSec(row)')) {
    const liveTimerFunctions = `function isOpenAttendanceRow(row){
  const status=String(row?.[15]||'').toUpperCase().trim();
  return !!row?.[10]&&!row?.[11]&&status&&status!=='CLOSED'&&status!=='CLOSE'&&status!=='ENCERRADO';
}
function liveTmaSec(row){
  if(isOpenAttendanceRow(row)){
    const start=parseBrDateTime(row?.[10]);
    if(start){
      const elapsed=Math.max(0,Math.round((Date.now()-start.getTime())/1000));
      return Math.max(Number(row?.[4]||0),elapsed);
    }
  }
  return validatedTmaSec(row);
}
function liveTmaAttrs(row){
  if(!isOpenAttendanceRow(row))return '';
  return \` data-live-tma="\${esc(row?.[10]||'')}" data-live-base="\${Number(row?.[4]||0)}"\`;
}
function updateLiveTmaTimers(){
  document.querySelectorAll('[data-live-tma]').forEach(el=>{
    const start=parseBrDateTime(el.getAttribute('data-live-tma')||'');
    if(!start)return;
    const base=Number(el.getAttribute('data-live-base')||0);
    const elapsed=Math.max(base,Math.max(0,Math.round((Date.now()-start.getTime())/1000)));
    el.textContent=fmtDur(elapsed);
  });
}
`;
    next = next.replace(
      'function validatedTmeSec(row){',
      `${liveTimerFunctions}function validatedTmeSec(row){`,
    );
  }

  next = next
    .replace(
      'const rated=rows.filter(isRatedRow), avgTma=avgArr(rows.map(r=>r[4]||0)), avgTme=avgArr(rows.map(r=>r[5]||0));',
      'const rated=rows.filter(isRatedRow), avgTma=avgArr(rows.map(liveTmaSec)), avgTme=avgArr(rows.map(r=>r[5]||0));',
    )
    .replace(
      '<td class="op-mono">${fmtDur(r[4]||0)}</td>',
      '<td class="op-mono"${liveTmaAttrs(r)}>${fmtDur(liveTmaSec(r))}</td>',
    )
    .replace(
      '<div class="attendance-detail-k"><b>TMA</b><span>${fmtDur(r[4]||0)}</span></div>',
      '<div class="attendance-detail-k"><b>TMA</b><span${liveTmaAttrs(r)}>${fmtDur(liveTmaSec(r))}</span></div>',
    );

  if (!next.includes('setInterval(updateLiveTmaTimers,1000);')) {
    next = next.replace(
      'startDashboardAutoRefresh();',
      'startDashboardAutoRefresh();\nsetInterval(updateLiveTmaTimers,1000);',
    );
  }

  if (!next.includes('function neppoBusinessOpen()')) {
    const businessHoursFunctions = `function saoPauloNowParts(){
  const br=new Date(Date.now()-3*60*60*1000);
  return {year:br.getUTCFullYear(),month:br.getUTCMonth(),day:br.getUTCDate(),dow:br.getUTCDay(),hour:br.getUTCHours(),minute:br.getUTCMinutes()};
}
function nextNeppoBusinessStartMs(){
  const p=saoPauloNowParts();
  let brStart=Date.UTC(p.year,p.month,p.day,8,0,0);
  const brNow=Date.UTC(p.year,p.month,p.day,p.hour,p.minute,0);
  let dow=p.dow;
  if(dow>=1&&dow<=5&&p.hour<8)return brStart+3*60*60*1000;
  do{brStart+=24*60*60*1000;dow=(dow+1)%7;}while(dow===0||dow===6||brStart<=brNow);
  return brStart+3*60*60*1000;
}
function neppoBusinessOpen(){
  const p=saoPauloNowParts();
  return p.dow>=1&&p.dow<=5&&p.hour>=8&&p.hour<18;
}
`;
    next = next.replace('const DASHBOARD_REFRESH_INTERVAL_MS=30*1000;', `${businessHoursFunctions}const DASHBOARD_REFRESH_INTERVAL_MS=30*1000;`);
  }

  const signatureFunction = `function dashboardNumbersSignature(data){
  if(!data)return '';
  const rows=Array.isArray(data.rows)?data.rows:[];
  const focusMonth=Number(data.focusMonth||0);
  const statusRows=rows
    .filter(r=>Array.isArray(r)&&(!focusMonth||Number(r[0])===focusMonth))
    .map(r=>[r[7]||'',r[10]||'',r[11]||'',r[15]||'',r[4]||0,r[5]||0,r[6]??null])
    .sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify({atend:data.atend||[],open:data.open||[],closed:data.closed||[],aval:data.aval||[],focusMonth,rowCount:rows.length,statusRows});
}`;
  next = next.replace(
    /function dashboardNumbersSignature\(data\)\{[\s\S]*?\n\}(?=\nasync function readDashboard(?:Live|Asset)Payload)/,
    signatureFunction,
  );

  next = next
    .replace('async function readDashboardLivePayload(){', 'async function readDashboardLivePayload(force=false){')
    .replace("    url.searchParams.set('_',Date.now());\n    const res=await fetch(url.toString(),{cache:'no-store',credentials:'same-origin',signal:controller.signal});", "    url.searchParams.set('_',Date.now());\n    if(force)url.searchParams.set('force','1');\n    const res=await fetch(url.toString(),{cache:'no-store',credentials:'same-origin',signal:controller.signal});")
    .replace('async function readDashboardAssetPayload(){', 'async function readDashboardAssetPayload(force=false){')
    .replace('const live=await readDashboardLivePayload();', 'const live=await readDashboardLivePayload(force);')
    .replace('payload=await readDashboardAssetPayload();', 'payload=await readDashboardAssetPayload(force);')
    .replace('Falha ao consultar a publicação. Nova tentativa em 1 minuto.', 'Falha ao consultar a base NEPPO. Nova tentativa em 1 minuto.')
    .replace('Base conferida. Nenhuma nova publicação ainda.', 'Base conferida. Nenhuma mudança ainda.')
    .replace('Base conferida. Sem nova publicação ainda.', 'Base conferida. Sem mudança ainda.')
    .replace('Sem nova publicação no NEPPO nesta verificação.', 'Sem mudança na base NEPPO nesta verificação.')
    .replace('Sem nova publicação no NEPPO por enquanto.', 'Sem mudança na base NEPPO por enquanto.')
    .replace('Consultando publicação automaticamente...', 'Consultando base NEPPO automaticamente...')
    .replace('Última publicação', 'Última base')
    .replace('setTimeout(()=>{if(!document.hidden)checkDashboardAssetUpdate({force:true});},15000);', 'setTimeout(()=>{if(!document.hidden&&neppoBusinessOpen())checkDashboardAssetUpdate({force:true});},15000);')
    .replace('let neppoLiveHealthLoading=false;', 'let neppoLiveHealthLoading=false;\nlet neppoLiveHealthLastCheckMs=0;')
    .replace('  if(neppoLiveHealthLoading)return null;\n  neppoLiveHealthLoading=true;', '  if(neppoLiveHealthLoading)return null;\n  neppoLiveHealthLastCheckMs=Date.now();\n  neppoLiveHealthLoading=true;')
    .replace('dashboardStatusTimer=setInterval(()=>{renderNeppoRefreshStatus();loadNeppoLiveHealth();},60000);', "dashboardStatusTimer=setInterval(()=>{renderNeppoRefreshStatus();if(Date.now()-neppoLiveHealthLastCheckMs>60000)loadNeppoLiveHealth();},10000);");

  if (!next.includes("Fora do expediente NEPPO. Próxima tentativa na próxima janela útil.")) {
    next = next.replace(
      "  if(dashboardAssetRefreshBusy){if(manual)toast('Verificação NEPPO já está em andamento.');return false;}\n",
      "  if(dashboardAssetRefreshBusy){if(manual)toast('Verificação NEPPO já está em andamento.');return false;}\n  if(!manual&&!neppoBusinessOpen()){\n    const nextStart=nextNeppoBusinessStartMs();\n    dashboardLastCheckMessage='Fora do expediente NEPPO. Próxima tentativa na próxima janela útil.';\n    scheduleDashboardNextCheck(Math.max(60000,nextStart-Date.now()));\n    if(typeof loadNeppoLiveHealth==='function')loadNeppoLiveHealth();\n    return false;\n  }\n",
    );
  }

  next = next
    .replace(
      /\.logo-gem\{[^}]*\}/,
      ".logo-gem{width:28px;height:28px;background:var(--moss);border-radius:7px;display:grid;place-items:center;color:#fff;font-family:'Fraunces',serif;font-size:1rem;font-weight:900;line-height:1;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);}",
    )
    .replace(
      /<div class="logo-gem"(?:\s+aria-label="Multsoft")?>[\s\S]*?<\/div>/,
      '<div class="logo-gem" aria-label="Multsoft">M</div>',
    )
    .replace(
      /\.wg-group-summary\{[^}]*\}/,
      '.wg-group-summary{display:grid;gap:.45rem;max-height:none;overflow:visible;padding-right:0;}',
    )
    .replace(
      /\.wg-group-row\{([^}]*)grid-template-columns:minmax\(0,1fr\) auto;([^}]*)\}/,
      '.wg-group-row{$1grid-template-columns:minmax(0,1fr);$2}',
    )
    .replace(
      /\.wg-group-row\{[^}]*\}/,
      '.wg-group-row{width:100%;border:1px solid var(--border);border-radius:7px;background:#fff;padding:.5rem .62rem;display:grid;grid-template-columns:minmax(0,1fr);gap:.45rem;text-align:left;cursor:pointer;transition:border-color .12s,background .12s,box-shadow .12s;}',
    )
    .replace(
      /\.wg-group-metrics\{[^}]*\}/,
      ".wg-group-metrics{display:flex;gap:.35rem;flex-wrap:wrap;align-items:center;margin-top:.38rem;}",
    );

  if (!next.includes('.wg-summary-pill{')) {
    next = next.replace(
      /\.wg-group-metrics\{[^}]*\}/,
      (match) => `${match}
.wg-summary-pill{display:inline-flex;align-items:center;gap:.32rem;border:1px solid var(--mist);border-radius:999px;background:var(--foam);color:var(--moss);font-family:'Geist Mono',monospace;font-size:.58rem;font-weight:800;line-height:1;padding:4px 8px;}
.wg-summary-pill b{font-size:.64rem;color:var(--ink);}
.wg-summary-pill.warn{border-color:rgba(154,107,26,.35);background:rgba(154,107,26,.08);color:var(--amber);}
.wg-summary-pill.progress{border-color:rgba(42,107,138,.28);background:rgba(42,107,138,.07);color:var(--sky);}`,
    );
  }

  next = next.replace(
    /<div class="wg-group-metrics">\$\{fN\(g\.protocolTotal\)\} protocolo\(s\) · \$\{fN\(g\.messageTotal\)\} mensagem\(ns\)\$\{g\.open\?` · \$\{fN\(g\.open\)\} sem resposta`:''\}\$\{g\.progress\?` · \$\{fN\(g\.progress\)\} em tratativa`:''\}\$\{g\.closed\?` · \$\{fN\(g\.closed\)\} encerrado\(s\)`:''\}<\/div>\s*<\/div>\s*<div class="wg-group-count">\$\{fN\(g\.messageTotal\)\}<\/div>/,
    () => `<div class="wg-group-metrics"><span class="wg-summary-pill">Protocolos <b>\${fN(g.protocolTotal)}</b></span><span class="wg-summary-pill">Mensagens <b>\${fN(g.messageTotal)}</b></span>\${g.open?'<span class="wg-summary-pill warn">Sem resposta <b>'+fN(g.open)+'</b></span>':''}\${g.progress?'<span class="wg-summary-pill progress">Em tratativa <b>'+fN(g.progress)+'</b></span>':''}\${g.closed?'<span class="wg-summary-pill">Encerrados <b>'+fN(g.closed)+'</b></span>':''}</div>
      </div>`,
  );

  return next;
}

const attendancePath = `${exportDir.replace(/[\\/]$/, '')}/atendimentos-neppo.csv`;
const diaryPath = `${exportDir.replace(/[\\/]$/, '')}/diario-tratamentos.csv`;
const csvRows = readCsv(attendancePath);
const records = csvRows.map((row) => {
  const mes = Math.trunc(toNumber(row.Mes));
  const dia = Math.trunc(toNumber(row.Dia));
  const created = parseBrazilDate(row.DataInicial, mes, dia);
  const avaliacao = row.Avaliacao === '' || row.Avaliacao === '—' ? null : toNumber(row.Avaliacao, null);
  return {
    mes,
    dia,
    semana: `Sem.${Math.ceil(dia / 7)}`,
    periodo: getPeriodName(created.getHours()),
    atendSec: toNumber(row.TempoAtendimentoSeg),
    protocolo: row.Protocolo || '',
    agente: row.Agente || 'Sem agente',
    hora: created.getHours(),
    esperaSec: toNumber(row.TempoEsperaSeg),
    grupo: row.Grupo || 'Sem grupo',
    avaliacao,
    criadoEm: row.DataInicial || '',
    encerradoEm: row.DataEncerramento || '',
    cliente: row.ClienteOriginal || '',
    clienteUsuario: row.UsuarioInformado || '',
    clienteContrato: row.ContratoExtraido || '',
    clienteChave: row.ChaveCliente || '',
    cpfCnpj: row.CpfCnpjNeppo || '',
    codigoExterno: row.CodigoExternoNeppo || '',
    usuarioNeppo: row.UsuarioNeppo || '',
    usuarioId: Math.trunc(toNumber(row.UsuarioIdNeppo)),
    telefone: row.Telefone || '',
    chamada: row.Canal || '',
    operacao: row.Operacao || 'MODELO',
    status: row.Status || '',
    sessionId: Math.trunc(toNumber(row.SessionId)),
  };
});

const monthShortNames = ['', 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const monthFullNames = ['', 'Janeiro 2026', 'Fevereiro 2026', 'Março 2026', 'Abril 2026', 'Maio 2026', 'Junho 2026', 'Julho 2026', 'Agosto 2026', 'Setembro 2026', 'Outubro 2026', 'Novembro 2026', 'Dezembro 2026'];
const months = [...new Set(records.map((r) => r.mes))].sort((a, b) => a - b);
const focusMonth = months[months.length - 1] || new Date().getMonth() + 1;
const byMonthRecords = new Map(months.map((m) => [m, records.filter((r) => r.mes === m)]));
const D = {
  meses: months.map((m) => monthShortNames[m]),
  mesNomes: months.map((m) => monthFullNames[m]),
  focusMonth,
  focusIndex: months.indexOf(focusMonth),
  focusLabel: monthFullNames[focusMonth],
  atend: [],
  aval: [],
  closed: [],
  open: [],
  cobert: [],
  sat: [],
  tma: [],
  tme: [],
  sla: [],
};

for (const m of months) {
  const rs = byMonthRecords.get(m) || [];
  const closed = rs.filter((r) => r.status === 'CLOSED');
  const open = rs.filter((r) => r.status !== 'CLOSED');
  const ev = closed.filter((r) => r.avaliacao != null);
  D.atend.push(rs.length);
  D.closed.push(closed.length);
  D.open.push(open.length);
  D.aval.push(ev.length);
  D.cobert.push(round(ev.length / Math.max(1, closed.length), 4));
  D.sat.push(round(avg(ev.map((r) => r.avaliacao)), 3));
  D.tma.push(fTime(avg(closed.map((r) => r.atendSec))));
  D.tme.push(fTime(avg(closed.map((r) => r.esperaSec))));
  D.sla.push(round(closed.filter((r) => r.esperaSec <= 120).length / Math.max(1, closed.length), 4));
}

D.daily = {};
for (const m of months) {
  const rs = byMonthRecords.get(m) || [];
  const byDay = groupBy(rs, (r) => r.dia);
  D.daily[String(m)] = {};
  for (const [day, items] of [...byDay.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const ev = items.filter((r) => r.avaliacao != null);
    D.daily[String(m)][day] = { v: items.length, c: ev.length ? round(avg(ev.map((r) => r.avaliacao)), 3) : D.sat[months.indexOf(m)] };
  }
}

D.dow = {};
D.semanas = {};
D.semDow = {};
for (const m of months) {
  const rs = byMonthRecords.get(m) || [];
  const arr = [0, 0, 0, 0, 0];
  for (const rec of rs) {
    const idx = dayOfWeekIndex(m, rec.dia);
    if (idx != null) arr[idx]++;
  }
  D.dow[String(m)] = arr;
  const weeks = [...new Set(rs.map((r) => r.semana))].sort();
  D.semanas[String(m)] = weeks.map((wk) => rs.filter((r) => r.semana === wk).length);
  if (m === focusMonth) {
    for (const wk of weeks) {
      const row = [0, 0, 0, 0, 0];
      for (const rec of rs.filter((r) => r.semana === wk)) {
        const idx = dayOfWeekIndex(m, rec.dia);
        if (idx != null) row[idx]++;
      }
      D.semDow[wk] = row;
    }
  }
}

const groupNames = [...groupBy(records, (r) => r.grupo).entries()].sort((a, b) => b[1].length - a[1].length).map(([name]) => name);
D.grupos = { nomes: groupNames };
for (const m of months) {
  const rs = byMonthRecords.get(m) || [];
  D.grupos[monthShortNames[m].toLowerCase()] = groupNames.map((gn) => rs.filter((r) => r.grupo === gn).length);
}

const agents = [...groupBy(records, (r) => r.agente).keys()].sort();
D.agentes = {};
for (const agent of agents) {
  D.agentes[agent] = months.map((m) => {
    const rs = (byMonthRecords.get(m) || []).filter((r) => r.agente === agent);
    const closed = rs.filter((r) => r.status === 'CLOSED');
    const ev = closed.filter((r) => r.avaliacao != null);
    return [rs.length, ev.length, round(avg(ev.map((r) => r.avaliacao)), 2), closed.length ? fTime(avg(closed.map((r) => r.atendSec))) : '—'];
  });
}
D.agentList = agents;
D.groupList = groupNames;

D.rows = records.map((r) => [
  r.mes, r.dia, r.agente, r.grupo, round(r.atendSec), round(r.esperaSec), r.avaliacao,
  r.protocolo, r.periodo, r.hora, r.criadoEm, r.encerradoEm, r.cliente, r.telefone,
  r.chamada, r.status, r.sessionId, r.operacao, r.clienteUsuario, r.clienteContrato,
  r.clienteChave, r.cpfCnpj, r.codigoExterno, r.usuarioNeppo, r.usuarioId,
]);

const focus = byMonthRecords.get(focusMonth) || [];
const hours = Array.from({ length: 10 }, (_, i) => i + 8);
D.hours = hours;
D.tmaAg = {};
for (const [agent, items] of groupBy(focus, (r) => r.agente)) {
  const mins = items.map((r) => r.atendSec / 60);
  D.tmaAg[agent] = [round(avg(mins), 1), round(median(mins), 1), round(Math.max(0, ...mins), 1), items.length];
}
D.tmaDist = [0, 0, 0, 0, 0, 0];
for (const rec of focus) {
  const min = rec.atendSec / 60;
  if (min < 10) D.tmaDist[0]++;
  else if (min < 20) D.tmaDist[1]++;
  else if (min < 30) D.tmaDist[2]++;
  else if (min < 45) D.tmaDist[3]++;
  else if (min < 60) D.tmaDist[4]++;
  else D.tmaDist[5]++;
}
D.avDist = {};
for (const [rating, items] of [...groupBy(focus.filter((r) => r.avaliacao != null), (r) => Math.trunc(r.avaliacao)).entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  D.avDist[rating] = items.length;
}
D.avBaixa = {};
for (const [agent, items] of [...groupBy(focus.filter((r) => r.avaliacao != null && r.avaliacao < 9), (r) => r.agente).entries()].sort((a, b) => b[1].length - a[1].length)) {
  D.avBaixa[agent] = items.length;
}
D.hourDow = hours.map((hour) => {
  const row = [0, 0, 0, 0, 0];
  for (const rec of focus.filter((r) => r.hora === hour)) {
    const idx = dayOfWeekIndex(focusMonth, rec.dia);
    if (idx != null) row[idx]++;
  }
  return row;
});
D.tmeHora = hours.map((hour) => round(avg(focus.filter((r) => r.hora === hour).map((r) => r.esperaSec)), 1));
const topGroups = [...groupBy(focus, (r) => r.grupo).entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5).map(([name]) => name);
D.grpHora = {};
for (const gn of topGroups) {
  D.grpHora[gn] = hours.map((hour) => focus.filter((r) => r.grupo === gn && r.hora === hour).length);
}
D.agGrp = {};
for (const [agent, items] of [...groupBy(focus, (r) => r.agente).entries()].sort((a, b) => b[1].length - a[1].length)) {
  D.agGrp[agent] = {};
  for (const [groupName, groupItems] of [...groupBy(items, (r) => r.grupo).entries()].sort((a, b) => b[1].length - a[1].length)) {
    D.agGrp[agent][groupName] = groupItems.length;
  }
}
D.agDay = {};
for (const m of months) {
  const rs = byMonthRecords.get(m) || [];
  D.agDay[String(m)] = {};
  for (const [agent, items] of [...groupBy(rs, (r) => r.agente).entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    D.agDay[String(m)][agent] = {};
    for (const [day, dayItems] of [...groupBy(items, (r) => r.dia).entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      D.agDay[String(m)][agent][day] = dayItems.length;
    }
  }
}
D.agDayMar = D.agDay['3'];
const periodOrder = ['1º Periodo da manhã', '2º Periodo da manhã', '3º Periodo da manhã', '4º Periodo da manhã', 'Almoço 1', 'Almoço 2', '1º Periodo da tarde', '2º Periodo da tarde', '3º Periodo da tarde', '4º Periodo da tarde'];
const periodHours = {
  '1º Periodo da manhã': '07-09h', '2º Periodo da manhã': '09-10h', '3º Periodo da manhã': '10-11h', '4º Periodo da manhã': '11-12h',
  'Almoço 1': '12-13h', 'Almoço 2': '13-14h', '1º Periodo da tarde': '14-15h', '2º Periodo da tarde': '15-16h',
  '3º Periodo da tarde': '16-17h', '4º Periodo da tarde': '17-18:30h',
};
D.periodos = periodOrder.map((period) => {
  const rs = focus.filter((r) => r.periodo === period);
  const ev = rs.filter((r) => r.avaliacao != null);
  return { n: period.replace(' Periodo', ' Período'), h: periodHours[period], at: rs.length, pct: round(rs.length / Math.max(1, focus.length), 3), av: ev.length, cob: round(ev.length / Math.max(1, rs.length), 3), sat: round(avg(ev.map((r) => r.avaliacao)), 3), tma: fTime(avg(rs.map((r) => r.atendSec))), tme: fTime(avg(rs.map((r) => r.esperaSec))) };
});
D.perMes = {};
for (const m of months) {
  const rs = byMonthRecords.get(m) || [];
  D.perMes[monthShortNames[m].toLowerCase()] = periodOrder.map((period) => rs.filter((r) => r.periodo === period).length);
}
D.csatDow = [0, 1, 2, 3, 4].map((idx) => round(avg(focus.filter((r) => dayOfWeekIndex(focusMonth, r.dia) === idx && r.avaliacao != null).map((r) => r.avaliacao)), 3));
D.csatWeek = { labels: [], data: [] };
for (const week of [...new Set(focus.map((r) => r.semana))].sort()) {
  D.csatWeek.labels.push(week);
  D.csatWeek.data.push(round(avg(focus.filter((r) => r.semana === week && r.avaliacao != null).map((r) => r.avaliacao)), 3));
}
D.byMonth = {};
for (const m of months) {
  const mk = monthShortNames[m].toLowerCase();
  const focusM = byMonthRecords.get(m) || [];
  D.byMonth[mk] = {
    tmaAg: {}, tmaDist: [0, 0, 0, 0, 0, 0], avDist: {}, avBaixa: {},
    hourDow: hours.map((hour) => {
      const row = [0, 0, 0, 0, 0];
      for (const rec of focusM.filter((r) => r.hora === hour)) {
        const idx = dayOfWeekIndex(m, rec.dia);
        if (idx != null) row[idx]++;
      }
      return row;
    }),
    tmeHora: hours.map((hour) => round(avg(focusM.filter((r) => r.hora === hour).map((r) => r.esperaSec)), 1)),
    grpHora: {}, agGrp: {}, periodos: [], csatDow: [], csatWeek: { labels: [], data: [] }, semDow: {},
  };
  for (const [agent, items] of groupBy(focusM, (r) => r.agente)) {
    const mins = items.map((r) => r.atendSec / 60);
    D.byMonth[mk].tmaAg[agent] = [round(avg(mins), 1), round(median(mins), 1), round(Math.max(0, ...mins), 1), items.length];
  }
  for (const rec of focusM) {
    const min = rec.atendSec / 60;
    if (min < 10) D.byMonth[mk].tmaDist[0]++;
    else if (min < 20) D.byMonth[mk].tmaDist[1]++;
    else if (min < 30) D.byMonth[mk].tmaDist[2]++;
    else if (min < 45) D.byMonth[mk].tmaDist[3]++;
    else if (min < 60) D.byMonth[mk].tmaDist[4]++;
    else D.byMonth[mk].tmaDist[5]++;
  }
  for (const gn of [...groupBy(focusM, (r) => r.grupo).entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5).map(([name]) => name)) {
    D.byMonth[mk].grpHora[gn] = hours.map((hour) => focusM.filter((r) => r.grupo === gn && r.hora === hour).length);
  }
  D.byMonth[mk].periodos = periodOrder.map((period) => {
    const rs = focusM.filter((r) => r.periodo === period);
    const ev = rs.filter((r) => r.avaliacao != null);
    return { n: period.replace(' Periodo', ' Período'), h: periodHours[period], at: rs.length, pct: round(rs.length / Math.max(1, focusM.length), 3), av: ev.length, cob: round(ev.length / Math.max(1, rs.length), 3), sat: round(avg(ev.map((r) => r.avaliacao)), 3), tma: fTime(avg(rs.map((r) => r.atendSec))), tme: fTime(avg(rs.map((r) => r.esperaSec))) };
  });
  for (const week of [...new Set(focusM.map((r) => r.semana))].sort()) {
    D.byMonth[mk].csatWeek.labels.push(week);
    D.byMonth[mk].csatWeek.data.push(round(avg(focusM.filter((r) => r.semana === week && r.avaliacao != null).map((r) => r.avaliacao)), 3));
    const row = [0, 0, 0, 0, 0];
    for (const rec of focusM.filter((r) => r.semana === week)) {
      const idx = dayOfWeekIndex(m, rec.dia);
      if (idx != null) row[idx]++;
    }
    D.byMonth[mk].semDow[week] = row;
  }
}
D.diary = readCsv(diaryPath);

const html = fs.readFileSync(htmlPath, 'utf8');
const block = getConstDataBlock(html);
fs.writeFileSync(htmlPath, ensureLiveRefreshHtml(html.slice(0, block.start) + JSON.stringify(D) + html.slice(block.end)), 'utf8');
console.log(`Updated D block. records=${records.length} diary=${D.diary.length}`);
