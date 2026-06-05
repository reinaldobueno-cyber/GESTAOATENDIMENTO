import { BONUS_HTML_BASE64 } from './bonus-html.js';

function setupRequired() {
  return new Response(
    'Proteção pendente: configure APP_USERS ou APP_USER e APP_PASSWORD nas variáveis do Worker na Cloudflare.',
    {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=UTF-8',
        'Cache-Control': 'no-store',
      },
    },
  );
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

function redirectTo(location, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'private, no-store',
      ...headers,
    },
  });
}

function wantsHtml(request) {
  const accept = request.headers.get('Accept') || '';
  return accept.includes('text/html') || accept.includes('*/*');
}

function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] || 0) ^ (right[i] || 0);
  }

  return diff === 0;
}

function bytesEqual(left, right) {
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] || 0) ^ (right[i] || 0);
  }

  return diff === 0;
}

function toBase64Utf8(value) {
  let binary = '';
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toBase64UrlBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function toBase64UrlUtf8(value) {
  return toBase64Utf8(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64UrlUtf8(value) {
  if (!value) return '';
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function fromBase64UrlJson(value) {
  if (!value) return null;
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function concatBytes(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function derivePrivateMapKeys(password, salt, iterations) {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-1', salt, iterations },
    material,
    512,
  );
  const bytes = new Uint8Array(bits);
  return {
    aes: bytes.slice(0, 32),
    mac: bytes.slice(32, 64),
  };
}

async function decryptPrivateMap(request, env) {
  try {
    const assetUrl = new URL('/private-client-map.enc.json', request.url);
    const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
    if (!asset.ok) {
      return 'window.CLIENTE_PRIVADO = {}; window.CLIENTE_PRIVADO_STATUS = "arquivo_privado_nao_encontrado";';
    }

    const pack = await asset.json();
    const salt = fromBase64(pack.salt);
    const iv = fromBase64(pack.iv);
    const data = fromBase64(pack.data);
    const mac = fromBase64(pack.mac);
    const iterations = Number(pack.iterations || 150000);
    const passwords = [
      env.PRIVATE_MAP_PASSWORD,
      env.AUTH_PASSWORD,
      env.APP_PASSWORD,
      ...parseAppUsers(env).map((item) => item.password),
    ].filter(Boolean);

    const availableSources = [
      env.PRIVATE_MAP_PASSWORD ? 'PRIVATE_MAP_PASSWORD' : '',
      env.AUTH_PASSWORD ? 'AUTH_PASSWORD' : '',
      env.APP_PASSWORD ? 'APP_PASSWORD' : '',
      parseAppUsers(env).length ? 'APP_USERS' : '',
    ].filter(Boolean);

    for (const password of [...new Set(passwords.map(String))]) {
      const keys = await derivePrivateMapKeys(password, salt, iterations);
      const macKey = await crypto.subtle.importKey(
        'raw',
        keys.mac,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const expectedMac = new Uint8Array(
        await crypto.subtle.sign('HMAC', macKey, concatBytes(salt, iv, data)),
      );

      if (bytesEqual(mac, expectedMac)) {
        const aesKey = await crypto.subtle.importKey('raw', keys.aes, 'AES-CBC', false, ['decrypt']);
        const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, data);
        return `${new TextDecoder().decode(plain)}\nwindow.CLIENTE_PRIVADO_STATUS = "ok"; window.CLIENTE_PRIVADO_STATUS_DETAIL = "mapa_aberto";`;
      }
    }

    return `window.CLIENTE_PRIVADO = {}; window.CLIENTE_PRIVADO_STATUS = "senha_incorreta_para_mapa_privado"; window.CLIENTE_PRIVADO_STATUS_DETAIL = ${JSON.stringify(`fontes_testadas:${availableSources.join(',') || 'nenhuma'}; senhas_testadas:${passwords.length}`)}; console.warn("Mapa privado de clientes não pôde ser aberto.", window.CLIENTE_PRIVADO_STATUS_DETAIL);`;
  } catch (error) {
    return `window.CLIENTE_PRIVADO = {}; window.CLIENTE_PRIVADO_STATUS = "erro_ao_abrir_mapa_privado"; window.CLIENTE_PRIVADO_STATUS_DETAIL = ${JSON.stringify(String(error?.message || error || 'erro desconhecido'))}; console.warn("Erro ao abrir mapa privado.", window.CLIENTE_PRIVADO_STATUS_DETAIL);`;
  }
}

function reportErrorPage(title, message, detail = '') {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${reportStyle()}</head><body><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(message)}${detail ? `\n\n${escapeHtml(detail)}` : ''}</pre></body></html>`,
    {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=UTF-8',
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    },
  );
}

function reportStyle() {
  return `<style>
    body{font-family:Arial,sans-serif;color:#102817;margin:32px;line-height:1.45}
    h1{font-family:Georgia,serif;font-size:28px;margin:0 0 6px}
    .muted{color:#2f6d45;font-size:13px;text-transform:uppercase;letter-spacing:.06em}
    .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:22px 0}
    .box{border:1px solid #bfd3c1;border-radius:8px;padding:12px;background:#f6faf5;min-width:0}
    .label{font-size:10px;color:#5e7b64;text-transform:uppercase;font-weight:bold}
    .value{font-size:20px;font-weight:bold;margin-top:4px;overflow-wrap:anywhere}
    .section{border-top:1px solid #d6e2d2;margin-top:20px;padding-top:16px}
    pre{white-space:pre-wrap;font-family:Arial,sans-serif;background:#f6faf5;border:1px solid #d6e2d2;border-radius:8px;padding:14px}
    button{border:1px solid #2f6d45;background:#2f6d45;color:white;border-radius:7px;padding:8px 12px;font-weight:bold;cursor:pointer}
    .msg{border:1px solid #d6e2d2;border-radius:8px;padding:12px;margin:10px 0;background:#fbfdfb;page-break-inside:avoid}
    .msg-head{font-size:11px;color:#5e7b64;font-weight:bold;text-transform:uppercase;margin-bottom:6px}
    .msg-body{white-space:pre-wrap}
    .msg-img{display:block;max-width:100%;max-height:520px;border:1px solid #d6e2d2;border-radius:8px;margin:.45rem 0}
    a{color:#2f6d45;font-weight:bold}
    @media print{button{display:none} body{margin:18mm}}
  </style>`;
}

function formatDuration(sec) {
  const total = Math.max(0, Math.round(Number(sec || 0)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatCsat(value) {
  return value == null ? 'SEM AVALIAÇÃO' : Number(value).toFixed(2).replace('.', ',');
}

function stripHtmlText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function findMessageList(value, depth = 0) {
  if (!value || depth > 5) return [];
  if (Array.isArray(value)) {
    const score = value.filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        ('message' in item ||
          'text' in item ||
          'content' in item ||
          'action' in item ||
          'createdAt' in item ||
          'sendBy' in item),
    ).length;
    if (score) return value;
    for (const item of value) {
      const found = findMessageList(item, depth + 1);
      if (found.length) return found;
    }
    return [];
  }
  if (typeof value === 'object') {
    for (const key of ['messages', 'data', 'content', 'results', 'history']) {
      const found = findMessageList(value[key], depth + 1);
      if (found.length) return found;
    }
    for (const item of Object.values(value)) {
      const found = findMessageList(item, depth + 1);
      if (found.length) return found;
    }
  }
  return [];
}

function messageSender(message) {
  const raw = message.sendBy || message.sentBy || message.sender || message.author || message.action || 'MENSAGEM';
  const upper = String(raw).toUpperCase();
  const name = message.fromUser || message.userName || message.agentName || message.senderName || '';
  let label = String(raw);
  if (upper.includes('USER')) label = 'CLIENTE';
  else if (upper.includes('AGENT')) label = 'ATENDENTE';
  else if (upper.includes('BOT')) label = 'BOT';
  else if (upper.includes('SYSTEM')) label = 'SISTEMA';
  else if (upper === 'NONE' || upper === 'TRANSFER' || upper === 'QUEUE') label = 'SISTEMA';
  return name ? `${label} - ${name}` : label;
}

function messageTime(message) {
  if (message.formattedCreatedAt) return message.formattedCreatedAt;
  const raw = message.createdAt || message.date || message.updatedAt || '';
  if (!raw) return '';
  if (typeof raw === 'number') {
    return new Date(raw).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  }
  return String(raw);
}

function firstUrl(value) {
  const text = String(value ?? '');
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  return match ? match[0] : '';
}

function isImageMessage(message, url) {
  const contentType = String(message.contentType || message.mimeType || message.type || '').toUpperCase();
  return (
    contentType.includes('IMAGE') ||
    /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i.test(url || '') ||
    String(message.message || '').startsWith('data:image/')
  );
}

function isAudioMessage(message, url) {
  const contentType = String(message.contentType || message.mimeType || message.type || '').toUpperCase();
  return contentType.includes('AUDIO') || /\.(mp3|m4a|aac|ogg|oga|opus|wav|webm)(\?|#|$)/i.test(url || '');
}

function messageBody(message) {
  return stripHtmlText(
    message.message ?? message.text ?? message.content ?? message.data ?? message.body ?? message.action ?? '',
  );
}

function messageMediaUrl(message) {
  const candidates = [
    message.fileUrl,
    message.mediaUrl,
    message.url,
    message.link,
    message.path,
    message.message,
    message.content,
    message.data,
    message.body,
  ];
  for (const candidate of candidates) {
    const url = firstUrl(candidate);
    if (url) return url;
    if (String(candidate || '').startsWith('data:image/')) return String(candidate);
  }
  return '';
}

function mediaProxyUrl(url) {
  return `/media?u=${toBase64UrlUtf8(url)}`;
}

function renderMessageBody(message) {
  const body = messageBody(message);
  const mediaUrl = messageMediaUrl(message);
  const contentType = String(message.contentType || message.mimeType || message.type || '').toUpperCase();
  if (mediaUrl && isImageMessage(message, mediaUrl)) {
    const visibleBody = body && body !== mediaUrl ? body : '';
    const proxiedUrl = mediaProxyUrl(mediaUrl);
    return `<div class="msg-body">${visibleBody ? `${escapeHtml(visibleBody)}<br>` : ''}<img class="msg-img" src="${escapeHtml(proxiedUrl)}" alt="Imagem do atendimento"><br><a href="${escapeHtml(mediaUrl)}" target="_blank" rel="noopener">Abrir imagem</a></div>`;
  }
  if (mediaUrl && isAudioMessage(message, mediaUrl)) {
    const visibleBody = body && body !== mediaUrl ? body : '';
    const proxiedUrl = mediaProxyUrl(mediaUrl);
    return `<div class="msg-body">${visibleBody ? `${escapeHtml(visibleBody)}<br>` : ''}<audio controls preload="none" src="${escapeHtml(proxiedUrl)}" style="width:100%;max-width:420px"></audio><br><a href="${escapeHtml(mediaUrl)}" target="_blank" rel="noopener">Abrir áudio original</a></div>`;
  }
  if (mediaUrl) {
    const label = contentType.includes('AUDIO')
      ? 'Áudio'
      : contentType.includes('VIDEO')
        ? 'Vídeo'
        : contentType.includes('APPLICATION') || contentType.includes('DOC')
          ? 'Anexo'
          : 'Mídia';
    return `<div class="msg-body">${body ? `${escapeHtml(body)}<br>` : ''}<a href="${escapeHtml(mediaUrl)}" target="_blank" rel="noopener">${escapeHtml(label)} do atendimento</a></div>`;
  }
  return `<div class="msg-body">${escapeHtml(body || '(mensagem sem texto ou anexo)')}</div>`;
}

function renderConversation(payload) {
  const list = findMessageList(payload);
  if (!list.length) return '<pre>Nenhuma mensagem retornada pelo NEPPO para este protocolo.</pre>';
  return `<div class="conversation">${list
    .map((message) => {
      const when = messageTime(message);
      return `<div class="msg"><div class="msg-head">${escapeHtml(messageSender(message))}${when ? ` · ${escapeHtml(when)}` : ''}</div>${renderMessageBody(message)}</div>`;
    })
    .join('')}</div>`;
}

function extractLinkedProtocols(payload, currentProtocol) {
  const text = JSON.stringify(payload || {});
  const current = String(currentProtocol || '').toUpperCase();
  return [...new Set(text.match(/WA\d{8,}/gi) || [])]
    .map((protocol) => protocol.toUpperCase())
    .filter((protocol) => protocol !== current)
    .slice(0, 5);
}

function cookieHeaderFrom(response) {
  const direct = response.headers.get('set-cookie');
  if (direct) {
    return direct
      .split(/,(?=[^;,]+=)/)
      .map((cookie) => cookie.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');
  }

  const getter = response.headers.getAll?.bind(response.headers);
  if (getter) {
    return getter('set-cookie')
      .map((cookie) => cookie.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');
  }

  return '';
}

async function getNeppoWebCookie(env) {
  if (env.NEPPO_WEB_COOKIE) return { ok: true, cookie: env.NEPPO_WEB_COOKIE, source: 'cookie' };

  const username = env.NEPPO_WEB_USERNAME || env.NEPPO_USERNAME;
  const password = env.NEPPO_WEB_PASSWORD || env.NEPPO_PASSWORD;
  if (!username || !password) {
    return {
      ok: false,
      reason: 'missing',
      message: 'O Worker publicado não recebeu NEPPO_WEB_USERNAME e NEPPO_WEB_PASSWORD.',
    };
  }

  const attempts = [
    { password: toBase64Utf8(password), verificationToken: '' },
    { password: toBase64Utf8(password), verificationToken: 'null' },
    { password, verificationToken: '' },
    { password, verificationToken: 'null' },
  ];

  let lastStatus = 0;
  let lastDetail = '';

  for (const attempt of attempts) {
    const body = new URLSearchParams();
    body.set('username', username);
    body.set('password', attempt.password);
    body.set('verificationToken', attempt.verificationToken);

    const response = await fetch('https://multsoft.neppo.com.br/chat/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://multsoft.neppo.com.br',
        Referer: 'https://multsoft.neppo.com.br/chat/',
      },
      body,
      redirect: 'manual',
    });

    const cookie = cookieHeaderFrom(response);
    if ((response.ok || response.status === 302) && cookie) {
      return { ok: true, cookie, source: 'login' };
    }

    lastStatus = response.status;
    lastDetail = (await response.text().catch(() => '')).slice(0, 300);
  }

  return {
    ok: false,
    reason: 'login_failed',
    status: lastStatus,
    detail: lastDetail,
    message:
      lastStatus === 401
        ? 'O Worker recebeu NEPPO_WEB_USERNAME e NEPPO_WEB_PASSWORD, mas o NEPPO recusou esse login. Confira se é a senha do login web do NEPPO e redeploye o Worker.'
        : `O Worker recebeu as variáveis do NEPPO, mas não conseguiu criar sessão web. Status ${lastStatus || 'desconhecido'}.`,
  };
}

function neppoCookieErrorResult(auth) {
  return {
    status: auth.reason === 'missing' ? 424 : 502,
    body: {
      ok: false,
      status: auth.status || null,
      message: auth.message || 'Não consegui autenticar no NEPPO.',
      detail: auth.detail || '',
    },
  };
}

async function fetchNeppoIssueHistory(sessionId, cookie) {
  const messages = [];
  const seen = new Set();
  let last = '';

  for (let page = 0; page < 12; page += 1) {
    const params = new URLSearchParams({ id: String(sessionId), size: '500' });
    if (last) params.set('last', last);

    const response = await fetch(
      `https://multsoft.neppo.com.br/chat/api/sessions/issue/history?${params.toString()}`,
      {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Cookie: cookie,
          Referer: 'https://multsoft.neppo.com.br/chat/',
        },
      },
    );

    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        detail: text.slice(0, 500),
      };
    }

    let batch = [];
    try {
      batch = JSON.parse(text);
    } catch {
      return { ok: true, messages, text };
    }

    if (!Array.isArray(batch) || !batch.length) break;

    let added = 0;
    for (const message of batch) {
      const key = [
        message.id || '',
        message.sessionId || '',
        message.createdAt || '',
        message.action || '',
        message.message || '',
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push(message);
      added += 1;
    }

    const nextLast = batch[batch.length - 1]?.createdAt;
    const hasMore = batch.some((message) => message?.lastChatMessage === true);
    if (!hasMore || !nextLast || String(nextLast) === String(last) || added === 0) break;
    last = String(nextLast);
  }

  return { ok: true, messages };
}

async function fetchAttendanceHistory(protocol, env) {
  const result = await getAttendanceHistoryData(protocol, env);
  return jsonResponse(result.body, result.status);
}

async function getAttendanceHistoryData(protocol, env) {
  const match = String(protocol || '').match(/^(?:WA|VC)0*(\d+)$/i);
  if (!match) {
    return { status: 400, body: { ok: false, message: 'Protocolo inválido.' } };
  }

  const auth = await getNeppoWebCookie(env);
  if (!auth.ok) return neppoCookieErrorResult(auth);

  const sessionId = match[1];
  const history = await fetchNeppoIssueHistory(sessionId, auth.cookie);
  if (!history.ok) {
    return {
      status: 502,
      body: {
        ok: false,
        status: history.status,
        message: `NEPPO retornou ${history.status} ao buscar a conversa.`,
        detail: history.detail || '',
      },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      protocol,
      sessionId,
      messages: history.messages || [],
      text: history.text || '',
    },
  };
}

async function getAttendanceHistoryBundle(protocol, env) {
  const primary = await getAttendanceHistoryData(protocol, env);
  const histories = [{ protocol, history: primary }];
  if (!primary.body?.ok) return histories;

  const linkedProtocols = extractLinkedProtocols(primary.body, protocol);
  for (const linkedProtocol of linkedProtocols) {
    const linkedHistory = await getAttendanceHistoryData(linkedProtocol, env);
    histories.push({ protocol: linkedProtocol, history: linkedHistory });
  }

  return histories;
}

function renderConversationBundle(histories) {
  return histories
    .map(({ protocol, history }, index) => {
      const heading =
        histories.length > 1
          ? `<h3>${index === 0 ? 'Protocolo inicial' : 'Protocolo transferido'}: ${escapeHtml(protocol)}</h3>`
          : '';
      if (!history.body?.ok) {
        return `${heading}<pre>${escapeHtml(history.body?.message || 'Não consegui buscar esta parte da conversa no NEPPO.')}${history.body?.detail ? `\n\n${escapeHtml(history.body.detail)}` : ''}</pre>`;
      }
      return `${heading}${renderConversation(history.body)}`;
    })
    .join('');
}

async function getCurrentDashboardRow(request, env, protocol) {
  const indexUrl = new URL('/index.html', request.url);
  const response = await env.ASSETS.fetch(indexUrl);
  if (!response.ok) return null;
  const html = await response.text();
  const match = html.match(/const D = (\{[\s\S]*?\n\});\r?\n\r?\nconst MANUAL_ADJUSTMENTS_STORAGE_KEY/);
  if (!match) return null;
  const data = JSON.parse(match[1]);
  return (Array.isArray(data.rows) ? data.rows : []).find(
    (row) => Array.isArray(row) && String(row[7] || '').toUpperCase() === String(protocol || '').toUpperCase(),
  ) || null;
}

async function getPrivateClientName(request, env, code) {
  if (!code) return '';
  const script = await decryptPrivateMap(request, env);
  const match = script.match(/\(\s*(\[[\s\S]*?\])\s*\)\.forEach/);
  if (!match) return '';
  const clients = JSON.parse(match[1]);
  const client = clients.find((item) => item?.codigo === code);
  return client?.nome || '';
}

async function renderPdfReport(request, env, protocol) {
  const url = new URL(request.url);
  let payload = null;
  try {
    payload = fromBase64UrlJson(url.searchParams.get('r'));
  } catch {
    return reportErrorPage('Atendimento', 'Não consegui abrir os dados deste atendimento.');
  }

  const payloadRow = Array.isArray(payload?.row) ? payload.row : [];
  const currentRow = await getCurrentDashboardRow(request, env, protocol).catch(() => null);
  const row = currentRow || payloadRow;
  const code = row[18] || payload?.code || '';
  const payloadCode = payload?.code || payloadRow[18] || '';
  const payloadNameStillMatches = !currentRow || String(payloadCode) === String(code);
  const privateClientName = await getPrivateClientName(request, env, code).catch(() => '');
  const clientName = privateClientName || (payloadNameStillMatches ? payload?.clientName : '') || row[19] || row[12] || code || 'Cliente não informado';
  const histories = await getAttendanceHistoryBundle(protocol, env);
  const conversationHtml = renderConversationBundle(histories);

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Atendimento ${escapeHtml(protocol)}</title>${reportStyle()}</head><body>
    <button onclick="window.print()">Salvar / imprimir PDF</button>
    <h1>Atendimento ${escapeHtml(protocol)}</h1>
    <div class="muted">Relatório gerado pelo painel Gestão de Atendimento</div>
    <div class="grid">
      <div class="box"><div class="label">Cliente</div><div class="value">${escapeHtml(clientName)}</div></div>
      <div class="box"><div class="label">Código</div><div class="value">${escapeHtml(code || '—')}</div></div>
      <div class="box"><div class="label">CSAT</div><div class="value">${escapeHtml(formatCsat(row[6]))}</div></div>
      <div class="box"><div class="label">Agente</div><div class="value">${escapeHtml(row[2] || '—')}</div></div>
      <div class="box"><div class="label">Grupo</div><div class="value">${escapeHtml(row[3] || '—')}</div></div>
      <div class="box"><div class="label">Operação</div><div class="value">${escapeHtml(row[17] || '—')}</div></div>
      <div class="box"><div class="label">Início</div><div class="value">${escapeHtml(row[10] || '—')}</div></div>
      <div class="box"><div class="label">Encerramento</div><div class="value">${escapeHtml(row[11] || '—')}</div></div>
      <div class="box"><div class="label">TMA / TME</div><div class="value">${formatDuration(row[4])} / ${formatDuration(row[5])}</div></div>
    </div>
    <div class="section"><b>Protocolo:</b> ${escapeHtml(row[7] || protocol)}<br><b>Session ID:</b> ${escapeHtml(row[16] || '—')}<br><b>Canal:</b> ${escapeHtml(row[14] || '—')}<br><b>Status:</b> ${escapeHtml(row[15] || '—')}</div>
    <div class="section"><h2>Conversa do atendimento</h2>${conversationHtml}</div>
  </body></html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

async function fetchMediaProxy(request, env) {
  const url = new URL(request.url);
  let target = '';
  try {
    target = fromBase64UrlUtf8(url.searchParams.get('u'));
  } catch {
    return new Response('Mídia inválida.', { status: 400 });
  }

  let mediaUrl = null;
  try {
    mediaUrl = new URL(target);
  } catch {
    return new Response('Mídia inválida.', { status: 400 });
  }

  if (mediaUrl.protocol !== 'https:' || !/(\.|^)neppo\.com\.br$/i.test(mediaUrl.hostname)) {
    return new Response('Mídia fora do NEPPO não permitida.', { status: 403 });
  }

  const headers = {
    Accept: 'audio/*,video/*,image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    Referer: 'https://multsoft.neppo.com.br/',
  };

  let response = await fetch(mediaUrl.toString(), { headers });
  if (!response.ok && (env.NEPPO_WEB_COOKIE || env.NEPPO_WEB_USERNAME || env.NEPPO_USERNAME)) {
    const auth = await getNeppoWebCookie(env);
    if (auth.ok) {
      response = await fetch(mediaUrl.toString(), {
        headers: {
          ...headers,
          Cookie: auth.cookie,
        },
      });
    }
  }

  if (!response.ok) {
    return new Response(`Não consegui carregar a mídia do atendimento. NEPPO retornou ${response.status}.`, {
      status: response.status,
      headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'Cache-Control': 'private, no-store' },
    });
  }

  const responseHeaders = new Headers(response.headers);
  responseHeaders.set('Cache-Control', 'private, no-store');
  responseHeaders.set('X-Robots-Tag', 'noindex, nofollow');
  if (!responseHeaders.get('Content-Type')) responseHeaders.set('Content-Type', 'application/octet-stream');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    cookies[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return cookies;
}

function appSessionSecret(env) {
  return env.APP_SESSION_SECRET || env.APP_PASSWORD || env.AUTH_PASSWORD || env.APP_USERS || env.AUTH_USERS || '';
}

function parseAppUsers(env) {
  const users = [];
  const source = env.APP_USERS || env.AUTH_USERS || '';

  if (source.trim()) {
    try {
      const parsed = JSON.parse(source);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item?.user && item?.password) {
            users.push({ user: String(item.user), password: String(item.password), role: normalizeUserRole(item.role || item.perfil || 'admin'), name: String(item.name || item.nome || item.user) });
          }
        }
      } else if (parsed && typeof parsed === 'object') {
        for (const [user, passwordOrConfig] of Object.entries(parsed)) {
          if (passwordOrConfig && typeof passwordOrConfig === 'object') {
            users.push({
              user: String(user),
              password: String(passwordOrConfig.password || passwordOrConfig.senha || ''),
              role: normalizeUserRole(passwordOrConfig.role || passwordOrConfig.perfil || 'admin'),
              name: String(passwordOrConfig.name || passwordOrConfig.nome || user),
            });
          } else {
            users.push({ user: String(user), password: String(passwordOrConfig), role: 'admin', name: String(user) });
          }
        }
      }
    } catch {
      for (const line of source.split(/\r?\n|;/)) {
        const clean = line.trim();
        if (!clean || clean.startsWith('#')) continue;
        const separator = clean.includes('=') ? clean.indexOf('=') : clean.indexOf(':');
        if (separator < 0) continue;
        users.push({
          user: clean.slice(0, separator).trim(),
          password: clean.slice(separator + 1).trim(),
          role: 'admin',
          name: clean.slice(0, separator).trim(),
        });
      }
    }
  }

  if ((env.APP_USER || env.AUTH_USER) && (env.APP_PASSWORD || env.AUTH_PASSWORD)) {
    users.push({
      user: String(env.APP_USER || env.AUTH_USER),
      password: String(env.APP_PASSWORD || env.AUTH_PASSWORD),
      role: 'admin',
      name: String(env.APP_USER || env.AUTH_USER),
    });
  }

  if (env.EVELYN_PASSWORD) {
    users.push({
      user: 'evelyn',
      password: String(env.EVELYN_PASSWORD),
      role: 'agente',
      name: 'Evelyn',
    });
  }

  return users.filter((item) => item.user && item.password);
}

function normalizeUserRole(role) {
  const clean = String(role || '').trim().toLowerCase();
  return clean === 'admin' || clean === 'administrador' || clean === 'gestor' ? 'admin' : 'agente';
}

function normalizeLogin(user) {
  return String(user || '').trim().toLowerCase();
}

async function hashManagedPassword(env, user, password) {
  return signText(`${normalizeLogin(user)}:${String(password || '')}`, appSessionSecret(env));
}

async function loadManagedUsers(env) {
  if (!env.ADJUSTMENTS) return [];
  const stored = (await env.ADJUSTMENTS.get(MANAGED_USERS_KEY, 'json')) || [];
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((item) => item?.user && item?.passwordHash)
    .map((item) => ({
      user: String(item.user),
      name: String(item.name || item.user),
      role: normalizeUserRole(item.role),
      active: item.active !== false,
      passwordHash: String(item.passwordHash),
      createdAt: item.createdAt || '',
      updatedAt: item.updatedAt || '',
      createdBy: item.createdBy || '',
      updatedBy: item.updatedBy || '',
      source: 'kv',
    }));
}

async function saveManagedUsers(env, users) {
  if (!env.ADJUSTMENTS) throw new Error('KV ADJUSTMENTS indisponível.');
  await env.ADJUSTMENTS.put(MANAGED_USERS_KEY, JSON.stringify(users.slice(0, 500)));
}

async function findAppUser(env, user, password = null) {
  const wantedUser = String(user || '').trim();
  for (const item of parseAppUsers(env)) {
    if (!timingSafeEqual(wantedUser, String(item.user).trim())) continue;
    if (password === null || timingSafeEqual(String(password), String(item.password))) return { ...item, source: 'env', active: true };
  }

  for (const item of await loadManagedUsers(env)) {
    if (!item.active) continue;
    if (!timingSafeEqual(normalizeLogin(wantedUser), normalizeLogin(item.user))) continue;
    if (password === null) return item;
    const expectedHash = await hashManagedPassword(env, item.user, password);
    if (timingSafeEqual(expectedHash, item.passwordHash)) return item;
  }
  return null;
}

async function signText(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return toBase64UrlBytes(new Uint8Array(signature));
}

async function createSessionCookie(user, env) {
  const expires = Date.now() + 12 * 60 * 60 * 1000;
  const payload = toBase64UrlUtf8(JSON.stringify({ user, expires }));
  const signature = await signText(payload, appSessionSecret(env));
  return `gestao_session=${payload}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`;
}

async function hasValidSession(request, env) {
  const token = parseCookies(request).gestao_session || '';
  const separator = token.indexOf('.');
  if (separator < 0) return false;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = await signText(payload, appSessionSecret(env));
  if (!timingSafeEqual(signature, expected)) return false;

  try {
    const session = JSON.parse(fromBase64UrlUtf8(payload));
    return (
      Boolean(await findAppUser(env, session.user)) &&
      Number(session.expires || 0) > Date.now()
    );
  } catch {
    return false;
  }
}

async function currentAppUser(request, env) {
  const token = parseCookies(request).gestao_session || '';
  const separator = token.indexOf('.');
  if (separator >= 0) {
    const payload = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    const expected = await signText(payload, appSessionSecret(env));
    if (timingSafeEqual(signature, expected)) {
      try {
        const session = JSON.parse(fromBase64UrlUtf8(payload));
        if (Number(session.expires || 0) > Date.now() && await findAppUser(env, session.user)) {
          return String(session.user);
        }
      } catch {}
    }
  }

  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return '';
  try {
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(':');
    if (sep < 0) return '';
    const user = decoded.slice(0, sep);
    const password = decoded.slice(sep + 1);
    return (await findAppUser(env, user, password)) ? user : '';
  } catch {
    return '';
  }
}

function loginPage(error = '', next = '/') {
  const safeNext = String(next || '/').startsWith('/') ? String(next || '/') : '/';
  return new Response(
    `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Entrar no painel</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#edf5ef;font-family:Arial,sans-serif;color:#102817}
    .card{width:min(472px,calc(100vw - 32px));background:#fff;border:1px solid #d6e2d2;border-radius:12px;padding:32px 28px;box-shadow:0 28px 80px rgba(31,61,42,.18)}
    h1{font-size:26px;line-height:1.1;margin:0 0 10px;font-weight:800}
    p{margin:0 0 24px;color:#5b6e62;line-height:1.45}
    label{display:block;margin:16px 0 7px;color:#809183;font-size:12px;letter-spacing:.04em;text-transform:uppercase;font-weight:800}
    input{width:100%;height:46px;border:1px solid #c7d6c9;border-radius:8px;background:#edf3ff;padding:0 14px;font-size:15px;color:#102817}
    input:focus{outline:2px solid #2f6d45;outline-offset:1px}
    button{width:100%;height:46px;margin-top:28px;border:0;border-radius:8px;background:#6f8874;color:#fff;font-size:15px;font-weight:800;cursor:pointer}
    button:hover{background:#2f6d45}
    .error{margin:0 0 16px;padding:10px 12px;border:1px solid #e4b9b9;border-radius:8px;background:#fff4f4;color:#8a1f1f;font-weight:700}
  </style>
</head>
<body>
  <main class="card">
    <h1>Entrar no painel</h1>
    <p>Use seu usuário para acessar os dados protegidos do atendimento.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${escapeHtml(safeNext)}">
      <label for="user">Usuário</label>
      <input id="user" name="user" autocomplete="username" autofocus>
      <label for="password">Senha</label>
      <input id="password" name="password" type="password" autocomplete="current-password">
      <button type="submit">Entrar</button>
    </form>
  </main>
</body>
</html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=UTF-8',
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    },
  );
}

async function handleLogin(request, env) {
  let form = null;
  try {
    form = await request.formData();
  } catch {
    return loginPage('Não consegui ler o login enviado.');
  }

  const user = String(form.get('user') || '');
  const password = String(form.get('password') || '');
  const next = String(form.get('next') || '/');
  const matched = await findAppUser(env, user, password);

  if (!matched) {
    return loginPage('Usuário ou senha inválidos.', next);
  }

  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  return redirectTo(safeNext, {
    'Set-Cookie': await createSessionCookie(matched.user, env),
  });
}

async function isAuthorized(request, env) {
  if (await hasValidSession(request, env)) return true;

  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;

  let decoded = '';
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }

  const separator = decoded.indexOf(':');
  if (separator < 0) return false;

  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  return Boolean(await findAppUser(env, user, password));
}

const MANAGED_USERS_KEY = 'app-users-v1';
const MANUAL_ADJUSTMENTS_KEY = 'manual-adjustments-v1';
const BONUS_CLOSURES_KEY = 'bonus-closures-v1';

function parseBonusUsers(env) {
  const source = String(env.BONUS_USERS || env.BONUS_PRIVATE_USERS || '').trim();
  if (!source) return [];
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
  } catch {}
  return source.split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean);
}

async function appUserProfile(env, user) {
  const found = await findAppUser(env, user);
  if (!found) return { user: String(user || ''), name: String(user || ''), role: 'agente', source: 'desconhecido', active: false };
  return {
    user: String(found.user),
    name: String(found.name || found.user),
    role: normalizeUserRole(found.role),
    source: found.source || 'env',
    active: found.active !== false,
  };
}

async function isAdminUser(user, env) {
  const profile = await appUserProfile(env, user);
  return profile.role === 'admin';
}

async function canUseBonus(user, env) {
  if (await isAdminUser(user, env)) return true;
  const allowed = parseBonusUsers(env);
  if (!allowed.length) return false;
  return allowed.some((item) => timingSafeEqual(String(item).toLowerCase(), String(user || '').toLowerCase()));
}

let bonusHtmlCache = '';

function bonusHtml() {
  if (bonusHtmlCache) return bonusHtmlCache;
  const binary = atob(BONUS_HTML_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  bonusHtmlCache = new TextDecoder().decode(bytes);
  return bonusHtmlCache;
}

function serveBonusPage() {
  const headers = new Headers();
  headers.set('Content-Type', 'text/html; charset=UTF-8');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(bonusHtml(), { status: 200, headers });
}

function isBonusPagePath(pathname) {
  return pathname === '/bonificacao'
    || pathname === '/bonificacao-app'
    || pathname === '/fechamento-bonificacao'
    || pathname === '/bonificacao-novo'
    || pathname.endsWith('/bonificacao.html');
}

function cleanAdjustment(input, user = '') {
  const item = input && typeof input === 'object' ? input : {};
  const protocolo = String(item.protocolo || '').trim().toUpperCase();
  if (!protocolo) return null;

  const out = {
    id: String(item.id || `${protocolo}-${Date.now()}`),
    protocolo,
    tipo: String(item.tipo || 'ajuste_manual').slice(0, 80),
    motivo: String(item.motivo || '').slice(0, 1200),
    impacto: String(item.impacto || '').slice(0, 1200),
    acao: String(item.acao || '').slice(0, 1200),
    diario: String(item.diario || '').slice(0, 2000),
    responsavel: String(item.responsavel || 'Painel').slice(0, 120),
    data: String(item.data || new Date().toLocaleDateString('pt-BR')).slice(0, 30),
    updatedAt: String(item.updatedAt || new Date().toISOString()).slice(0, 40),
    updatedBy: String(user || item.updatedBy || item.responsavel || 'painel').slice(0, 120),
  };

  if (item.desconsiderarCsat === true) out.desconsiderarCsat = true;
  if (item.desconsiderarTme === true) out.desconsiderarTme = true;
  if (item.ignorarAtendimento === true || item.ignorar === true) out.ignorarAtendimento = true;
  if (item.csat !== undefined && item.csat !== null && item.csat !== '') out.csat = Number(item.csat);
  if (item.tmaSec !== undefined && item.tmaSec !== null && item.tmaSec !== '') out.tmaSec = Number(item.tmaSec);
  if (item.tmeSec !== undefined && item.tmeSec !== null && item.tmeSec !== '') out.tmeSec = Number(item.tmeSec);
  if (item.agente) out.agente = String(item.agente).slice(0, 160);
  if (item.grupo) out.grupo = String(item.grupo).slice(0, 160);
  if (item.periodo) out.periodo = String(item.periodo).slice(0, 160);

  return out;
}

function normalizeAdjustmentText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function adjustmentSignature(item) {
  if (!item || !item.protocolo) return '';
  return [
    String(item.protocolo || '').trim().toUpperCase(),
    normalizeAdjustmentText(item.tipo || 'ajuste_manual'),
    normalizeAdjustmentText(item.motivo),
    normalizeAdjustmentText(item.impacto),
    normalizeAdjustmentText(item.acao),
    normalizeAdjustmentText(item.diario),
    item.desconsiderarCsat === true ? 'csat1' : 'csat0',
    item.desconsiderarTme === true ? 'tme1' : 'tme0',
    item.ignorarAtendimento === true || item.ignorar === true ? 'ign1' : 'ign0',
    item.csat !== undefined && item.csat !== null && item.csat !== '' ? `csat:${item.csat}` : '',
    item.tmaSec !== undefined && item.tmaSec !== null && item.tmaSec !== '' ? `tma:${item.tmaSec}` : '',
    item.tmeSec !== undefined && item.tmeSec !== null && item.tmeSec !== '' ? `tme:${item.tmeSec}` : '',
  ].join('|');
}

async function handleManualAdjustments(request, env, user = '') {
  if (!env.ADJUSTMENTS) {
    return jsonResponse({ adjustments: [], storage: false, message: 'ADJUSTMENTS_KV nao configurado' }, request.method === 'GET' ? 200 : 501);
  }

  if (request.method === 'GET') {
    const list = (await env.ADJUSTMENTS.get(MANUAL_ADJUSTMENTS_KEY, 'json')) || [];
    return jsonResponse({ adjustments: Array.isArray(list) ? list : [], storage: true });
  }

  if (request.method === 'DELETE') {
    const body = await request.json().catch(() => null);
    const id = String(body?.id || '').trim();
    const signature = String(body?.signature || '').trim();
    const protocolo = String(body?.protocolo || '').trim().toUpperCase();
    if (!id && !signature && !protocolo) return jsonResponse({ error: 'ID ou assinatura obrigatoria' }, 400);
    const current = (await env.ADJUSTMENTS.get(MANUAL_ADJUSTMENTS_KEY, 'json')) || [];
    const before = Array.isArray(current) ? current : [];
    const list = before.filter((a) => {
      if (id && String(a?.id || '') === id) return false;
      if (signature && adjustmentSignature(a) === signature) return false;
      return true;
    });
    await env.ADJUSTMENTS.put(MANUAL_ADJUSTMENTS_KEY, JSON.stringify(list.slice(-2000)));
    return jsonResponse({ ok: true, deleted: before.length - list.length, total: list.length });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Metodo nao permitido' }, 405);
  }

  const body = await request.json().catch(() => null);
  const item = cleanAdjustment(body, user);
  if (!item) return jsonResponse({ error: 'Protocolo obrigatorio' }, 400);

  const current = (await env.ADJUSTMENTS.get(MANUAL_ADJUSTMENTS_KEY, 'json')) || [];
  const itemSig = adjustmentSignature(item);
  const list = Array.isArray(current) ? current.filter((a) => String(a.id) !== String(item.id) && adjustmentSignature(a) !== itemSig) : [];
  list.push(item);
  await env.ADJUSTMENTS.put(MANUAL_ADJUSTMENTS_KEY, JSON.stringify(list.slice(-2000)));
  return jsonResponse({ ok: true, adjustment: item, total: list.length });
}

function cleanBonusClosure(input, user) {
  const item = input && typeof input === 'object' ? input : {};
  const ym = String(item.ym || '').slice(0, 7);
  const agent = String(item.agent || '').trim().slice(0, 160);
  if (!/^\d{4}-\d{2}$/.test(ym) || !agent) return null;
  return {
    id: String(item.id || `${ym}|${agent}`).slice(0, 240),
    ym,
    month: String(item.month || '').slice(0, 80),
    agent,
    team: String(item.team || '').slice(0, 20),
    nucleus: String(item.nucleus || '').slice(0, 80),
    metrics: item.metrics && typeof item.metrics === 'object' ? item.metrics : {},
    manual: item.manual && typeof item.manual === 'object' ? item.manual : {},
    breakdown: Array.isArray(item.breakdown) ? item.breakdown.slice(0, 30) : [],
    total: Number(item.total || 0),
    updatedAt: String(item.updatedAt || new Date().toISOString()).slice(0, 40),
    updatedBy: String(user || 'painel').slice(0, 120),
  };
}

async function handleBonusClosures(request, env, user) {
  if (!(await canUseBonus(user, env))) return jsonResponse({ error: 'Acesso negado' }, 403);
  if (!env.ADJUSTMENTS) {
    return jsonResponse({ closures: [], storage: false, message: 'ADJUSTMENTS_KV nao configurado' }, request.method === 'GET' ? 200 : 501);
  }
  if (request.method === 'GET') {
    const list = (await env.ADJUSTMENTS.get(BONUS_CLOSURES_KEY, 'json')) || [];
    return jsonResponse({ closures: Array.isArray(list) ? list : [], storage: true });
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'Metodo nao permitido' }, 405);
  const body = await request.json().catch(() => null);
  const item = cleanBonusClosure(body, user);
  if (!item) return jsonResponse({ error: 'Fechamento invalido' }, 400);
  const current = (await env.ADJUSTMENTS.get(BONUS_CLOSURES_KEY, 'json')) || [];
  const list = Array.isArray(current) ? current.filter((x) => String(x.id) !== String(item.id)) : [];
  list.push(item);
  await env.ADJUSTMENTS.put(BONUS_CLOSURES_KEY, JSON.stringify(list.slice(-3000)));
  return jsonResponse({ ok: true, closure: item, total: list.length });
}

function publicManagedUser(item) {
  return {
    user: String(item.user || ''),
    name: String(item.name || item.user || ''),
    role: normalizeUserRole(item.role),
    active: item.active !== false,
    source: item.source || 'kv',
    createdAt: item.createdAt || '',
    updatedAt: item.updatedAt || '',
    createdBy: item.createdBy || '',
    updatedBy: item.updatedBy || '',
  };
}

function mergeVisibleUsers(envUsers, managedUsers) {
  const map = new Map();
  for (const item of envUsers) {
    map.set(normalizeLogin(item.user), item);
  }
  for (const item of managedUsers.map(publicManagedUser)) {
    map.set(normalizeLogin(item.user), item);
  }
  return [...map.values()].sort((a, b) => String(a.name || a.user).localeCompare(String(b.name || b.user), 'pt-BR'));
}

async function handleUsersApi(request, env, currentUser) {
  if (!(await isAdminUser(currentUser, env))) return jsonResponse({ error: 'Acesso negado' }, 403);
  const envUsers = parseAppUsers(env).map((item) => publicManagedUser({ ...item, active: true, source: 'ambiente' }));
  const managedUsers = await loadManagedUsers(env);

  if (request.method === 'GET') {
    return jsonResponse({ users: mergeVisibleUsers(envUsers, managedUsers) });
  }

  if (request.method !== 'POST' && request.method !== 'DELETE') {
    return jsonResponse({ error: 'Método não permitido' }, 405);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'JSON inválido.' }, 400);
  }

  const targetUser = String(body.user || '').trim();
  const login = normalizeLogin(targetUser);
  if (!login) return jsonResponse({ error: 'Informe o usuário.' }, 400);
  if (!/^[a-z0-9._@-]{2,60}$/i.test(targetUser)) {
    return jsonResponse({ error: 'Use usuário com 2 a 60 caracteres: letras, números, ponto, hífen, underline ou @.' }, 400);
  }
  if (envUsers.some((item) => normalizeLogin(item.user) === login)) {
    return jsonResponse({ error: 'Usuário de ambiente não pode ser editado por esta tela.' }, 409);
  }

  const now = new Date().toISOString();
  const list = managedUsers.filter((item) => normalizeLogin(item.user) !== login);
  const existing = managedUsers.find((item) => normalizeLogin(item.user) === login);

  if (request.method === 'DELETE' || body.action === 'delete') {
    await saveManagedUsers(env, list);
    return jsonResponse({ ok: true, users: mergeVisibleUsers(envUsers, list) });
  }

  const role = normalizeUserRole(body.role || existing?.role || 'agente');
  const name = String(body.name || existing?.name || targetUser).trim() || targetUser;
  const active = body.active !== false;
  let passwordHash = existing?.passwordHash || '';
  if (body.password) passwordHash = await hashManagedPassword(env, targetUser, String(body.password));
  if (!passwordHash) return jsonResponse({ error: 'Informe uma senha para novo usuário.' }, 400);

  const item = {
    user: targetUser,
    name,
    role,
    active,
    passwordHash,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    createdBy: existing?.createdBy || currentUser,
    updatedBy: currentUser,
  };
  list.push(item);
  list.sort((a, b) => normalizeLogin(a.user).localeCompare(normalizeLogin(b.user), 'pt-BR'));
  await saveManagedUsers(env, list);
  return jsonResponse({ ok: true, user: publicManagedUser(item), users: mergeVisibleUsers(envUsers, list) });
}

export default {
  async fetch(request, env) {
    if (!parseAppUsers(env).length && !(await loadManagedUsers(env)).length) {
      return setupRequired();
    }

    const url = new URL(request.url);

    if (url.pathname === '/login') {
      if (request.method === 'POST') return handleLogin(request, env);
      return loginPage();
    }

    if (url.pathname === '/logout') {
      return new Response(
        `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sessão encerrada</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#edf5ef;font-family:Arial,sans-serif;color:#102817}.card{width:min(460px,calc(100vw - 32px));background:#fff;border:1px solid #d6e2d2;border-radius:12px;padding:28px;box-shadow:0 22px 70px rgba(31,61,42,.16)}a{display:inline-block;margin-top:18px;background:#2f6d45;color:#fff;text-decoration:none;border-radius:8px;padding:12px 16px;font-weight:800}</style></head><body><main class="card"><h1>Sessão encerrada</h1><p>Agora abra a Bonificação novamente. Seus dados locais não foram apagados.</p><a href="/bonificacao.html?fresh=1">Abrir Bonificação</a></main></body></html>`,
        {
          headers: {
            'Content-Type': 'text/html; charset=UTF-8',
            'Cache-Control': 'private, no-store',
            'Set-Cookie': 'gestao_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
          },
        },
      );
    }

    if (!(await isAuthorized(request, env))) {
      if (wantsHtml(request)) return loginPage('', `${url.pathname}${url.search}`);
      return redirectTo('/login');
    }
    const appUser = await currentAppUser(request, env);
    const appProfile = await appUserProfile(env, appUser);

    if (
      url.pathname === '/cliente-map-privado.csv' ||
      url.pathname.startsWith('/exports/cmax-')
    ) {
      if (appProfile.role !== 'admin') {
        return new Response('Acesso negado.', {
          status: 403,
          headers: {
            'Content-Type': 'text/plain; charset=UTF-8',
            'Cache-Control': 'private, no-store',
            'X-Robots-Tag': 'noindex, nofollow',
          },
        });
      }
    }

    if (url.pathname === '/api/session') {
      return jsonResponse({
        user: appUser,
        name: appProfile.name,
        role: appProfile.role,
        admin: appProfile.role === 'admin',
        bonusPrivate: await canUseBonus(appUser, env),
      });
    }

    if (url.pathname === '/api/users') {
      return handleUsersApi(request, env, appUser);
    }

    if (url.pathname === '/media') {
      return fetchMediaProxy(request, env);
    }

    if (url.pathname === '/api/manual-adjustments') {
      return handleManualAdjustments(request, env, appUser);
    }

    if (url.pathname === '/api/bonus-closures') {
      return handleBonusClosures(request, env, appUser);
    }

    if (isBonusPagePath(url.pathname)) {
      if (!(await canUseBonus(appUser, env))) {
        return new Response('Acesso negado.', {
          status: 403,
          headers: {
            'Content-Type': 'text/plain; charset=UTF-8',
            'Cache-Control': 'private, no-store',
            'X-Robots-Tag': 'noindex, nofollow',
          },
        });
      }
      return serveBonusPage();
    }

    const reportMatch = url.pathname.match(/^\/pdf-report\/([^/]+)$/);
    if (reportMatch) {
      return renderPdfReport(request, env, decodeURIComponent(reportMatch[1]));
    }

    const attendanceMatch = url.pathname.match(/^\/api\/attendance\/([^/]+)$/);
    if (attendanceMatch) {
      return fetchAttendanceHistory(decodeURIComponent(attendanceMatch[1]), env);
    }

    if (url.pathname.endsWith('/cliente-map-privado.js')) {
      const script = await decryptPrivateMap(request, env);
      return new Response(script, {
        headers: {
          'Content-Type': 'application/javascript; charset=UTF-8',
          'Cache-Control': 'private, no-store',
          'X-Robots-Tag': 'noindex, nofollow',
        },
      });
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'private, no-store');
    headers.set('X-Robots-Tag', 'noindex, nofollow');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
