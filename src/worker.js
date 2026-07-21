import { BONUS_HTML_BASE64 } from './bonus-html.js';
import { PRIVATE_CLIENT_MAP } from './private-client-map.js';

const NEPPO_LIVE_CACHE = new Map();
const NEPPO_API_BASE = 'https://api.neppo.com.br';
const NEPPO_AUTH_BASE = 'https://api-auth.neppo.com.br';
const NEPPO_LIVE_KV_PREFIX = 'neppo-live-dashboard-v2';
const NEPPO_LIVE_HEALTH_KEY = 'neppo-live-health-v2';
const NEPPO_LIVE_FRESH_MS = 15 * 1000;
const NEPPO_LIVE_CRON_FRESH_MS = 90 * 1000;
const NEPPO_LIVE_RUNNING_LOCK_MS = 3 * 60 * 1000;
const NEPPO_LIVE_STALE_MS = 30 * 60 * 1000;
const NEPPO_LIVE_KV_EXPIRATION_TTL = 2 * 24 * 60 * 60;
const NEPPO_LIVE_HISTORY_ENRICH_LIMIT = 60;
const NEPPO_LIVE_HISTORY_ENRICH_CONCURRENCY = 4;
const NEPPO_CONTACT_CACHE_KEY = 'neppo-attendance-contact-cache-v1';
const NEPPO_CONTACT_CACHE_MAX_ITEMS = 8000;
const NEPPO_BUSINESS_START_HOUR = 8;
const NEPPO_BUSINESS_END_HOUR = 18;
const DASHBOARD_RELEASE_MARKER = 'gestaoatendimento-20260720-release-guard';

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
  const info = conversationInfoFromMessages(history.messages || []);
  if (info.caller || info.phone) {
    await mergeNeppoContactCache(env, [{
      protocol,
      sessionId,
      user: info.caller,
      phone: info.phone,
    }]).catch(() => null);
  }

  return {
    status: 200,
    body: {
      ok: true,
      protocol,
      sessionId,
      contactInfo: info,
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

function normalizeClientLookupName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function neppoApiConfig(env) {
  return {
    clientKey: String(env.NEPPO_CLIENT_KEY || '').trim(),
    clientSecret: String(env.NEPPO_CLIENT_SECRET || '').trim(),
    username: String(env.NEPPO_USERNAME || env.NEPPO_WEB_USERNAME || '').trim(),
    password: String(env.NEPPO_PASSWORD || env.NEPPO_WEB_PASSWORD || '').trim(),
  };
}

function missingNeppoApiConfig(env) {
  const cfg = neppoApiConfig(env);
  return Object.entries(cfg)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

async function getNeppoApiToken(env) {
  const cfg = neppoApiConfig(env);
  const missing = missingNeppoApiConfig(env);
  if (missing.length) {
    return {
      ok: false,
      status: 424,
      message: `Credenciais API NEPPO ausentes no Worker: ${missing.join(', ')}.`,
    };
  }
  const basic = toBase64Utf8(`${cfg.clientKey}:${cfg.clientSecret}`);
  const body = new URLSearchParams({
    grant_type: 'password',
    username: cfg.username,
    password: cfg.password,
  });
  let last = { status: 0, data: {}, message: '' };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${NEPPO_AUTH_BASE}/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.access_token) return { ok: true, token: String(data.access_token) };
      last = { status: response.status || 502, data, message: '' };
      if (response.status < 500 || attempt === 3) break;
    } catch (error) {
      last = { status: 0, data: {}, message: error.message || String(error) };
      if (attempt === 3) break;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
  }
  return {
    ok: false,
    status: last.status || 502,
    message: `NEPPO recusou autenticação API (${last.status || 'sem status'}).`,
    detail: last.message || JSON.stringify(last.data || {}).slice(0, 500),
  };
}

async function invokeNeppoApiList(token, endpoint, page, size, conditions = [], sortColumn = 'createdAt') {
  const response = await fetch(`${NEPPO_API_BASE}/chatapi/1.0/api/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      page,
      size,
      conditions,
      sort: true,
      sortColumn,
      direction: 'DESC',
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`NEPPO ${endpoint} retornou ${response.status}.`);
    error.status = response.status;
    error.detail = JSON.stringify(data).slice(0, 500);
    throw error;
  }
  return Array.isArray(data.results) ? data.results : [];
}

async function getNeppoRowsUntil(token, endpoint, start, end, dateField, sortColumn = 'createdAt', options = {}) {
  const rows = [];
  const maxPages = Math.max(1, Math.min(20, Number(options.maxPages || 8)));
  const pageSize = Math.max(20, Math.min(200, Number(options.pageSize || 100)));
  let pages = 0;
  for (let page = 0; page < maxPages; page += 1) {
    pages += 1;
    const batch = await invokeNeppoApiList(token, endpoint, page, pageSize, [], sortColumn);
    if (!batch.length) break;
    let stop = false;
    for (const item of batch) {
      const rawDate = item?.[dateField];
      if (!rawDate) continue;
      const dt = new Date(rawDate);
      if (Number.isNaN(dt.getTime())) continue;
      if (dt < start) {
        stop = true;
        continue;
      }
      if (dt >= end) continue;
      rows.push(item);
    }
    if (stop) break;
  }
  rows.pages = pages;
  return rows;
}

function normalizeNeppoAgent(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const repaired = repairPortugueseMojibake(raw);
  const canonicalKey = repaired
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\uFFFD+/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ')
    .trim();
  const map = {
    'Evelyn GonÃ§alves': 'Evelyn Gonçalves',
    'Evelyn Gon��alves': 'Evelyn Gonçalves',
    'JÃºlia Almeida': 'Julia Almeida',
    'J��lia Almeida': 'Julia Almeida',
    'Júlia Almeida': 'Julia Almeida',
    GABRIEL: 'Gabriel Freire',
    MARCUS: 'Marcus Silva',
  };
  if (map[raw]) return map[raw];
  if (map[repaired]) return map[repaired];
  if (/^evelyn gon.*alves$/.test(canonicalKey)) return 'Evelyn Gonçalves';
  if (canonicalKey === 'julia almeida') return 'Julia Almeida';
  if (canonicalKey === 'gabriel') return 'Gabriel Freire';
  if (canonicalKey === 'marcus') return 'Marcus Silva';
  return repaired
    .toLocaleLowerCase('pt-BR')
    .replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase('pt-BR'));
}

function repairPortugueseMojibake(value) {
  return String(value || '')
    .replace(/Ã¡/g, 'á')
    .replace(/Ã /g, 'à')
    .replace(/Ã¢/g, 'â')
    .replace(/Ã£/g, 'ã')
    .replace(/Ã©/g, 'é')
    .replace(/Ãª/g, 'ê')
    .replace(/Ã­/g, 'í')
    .replace(/Ã³/g, 'ó')
    .replace(/Ã´/g, 'ô')
    .replace(/Ãµ/g, 'õ')
    .replace(/Ãº/g, 'ú')
    .replace(/Ã§/g, 'ç')
    .replace(/Ã/g, 'Á')
    .replace(/Ã‰/g, 'É')
    .replace(/Ã‡/g, 'Ç');
}

function normalizeNeppoGroup(value) {
  const raw = String(value || '').trim();
  const map = {
    Agricola: 'Agrícola',
    'Config. Balança': 'Configuracao de balanca e bastao',
    'PMG e Comunic.': 'PMG e Comunicacao para Associacao',
    Reprodução: 'Reproducao',
    'Ret. Envio Ativo': 'Retorno envio ativo',
    'fila Suporte': 'Fila Suporte',
  };
  return map[raw] || raw || 'Sem grupo';
}

function neppoPeriodName(hour) {
  if (hour < 10) return '1 Periodo';
  if (hour < 12) return '2 Periodo';
  if (hour < 14) return '3 Periodo';
  if (hour < 16) return '4 Periodo';
  return '5 Periodo';
}

function normalizeDocument(value) {
  return String(value || '').replace(/\D+/g, '');
}

function splitNeppoClientName(value) {
  const raw = String(value || '').trim();
  const parts = raw.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { usuario: parts[0], contrato: parts.slice(1).join(' - ') };
  }
  return { usuario: raw, contrato: raw };
}

function isGenericNeppoCaller(value) {
  const raw = String(value || '').trim();
  const normalized = normalizeClientLookupName(raw);
  return (
    !normalized ||
    /^CLIENTE\s*#?\s*\d+$/i.test(raw) ||
    /^(CLIENTE|ATENDENTE|BOT|SISTEMA|MENSAGEM|MESSAGE|NONE|TRANSFER|QUEUE)$/.test(normalized) ||
    /^(WHATSAPP|VOICE)\s*\d+$/.test(normalized)
  );
}

function conversationCallerNameFromSender(value) {
  const cleaned = stripHtmlText(value)
    .replace(/^CLIENTE\s*-\s*/i, '')
    .replace(/\s+-\s+\d{2}\/\d{2}\/\d{4}.*$/i, '')
    .trim();
  const parts = cleaned.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  const candidate = parts.length > 1 ? parts[0] : cleaned;
  return isGenericNeppoCaller(candidate) ? '' : candidate;
}

function neppoPhoneFromValues(...values) {
  for (const value of values) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return digits;
  }
  return '';
}

function neppoPhoneFromHistoryValue(value, key = '') {
  if (value == null) return '';
  const keyText = String(key || '');
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value);
    const hinted = /(phone|fone|celular|mobile|whatsapp|voice|origin|jid|sender|author|from|contact|remote)/i.test(keyText)
      || /(WHATSAPP|VOICE)\s*\+?\d{10,15}/i.test(text)
      || /@s\.whatsapp\.net/i.test(text);
    return hinted ? neppoPhoneFromValues(text) : '';
  }
  if (typeof value !== 'object') return '';
  for (const [childKey, childValue] of Object.entries(value)) {
    const phone = neppoPhoneFromHistoryValue(childValue, childKey);
    if (phone) return phone;
  }
  return '';
}

function conversationInfoFromMessages(messages) {
  const info = { caller: '', phone: '' };
  for (const message of messages || []) {
    if (!info.phone) info.phone = neppoPhoneFromHistoryValue(message);
    if (!info.caller) {
      const sender = messageSender(message);
      if (/^CLIENTE\b/i.test(sender)) {
        info.caller = conversationCallerNameFromSender(sender);
      }
    }
    if (info.caller && info.phone) break;
  }
  return info;
}

function normalizeNeppoContactProtocol(value) {
  const protocol = String(value || '').trim().toUpperCase();
  return /^(WA|VC)\d{8,}$/.test(protocol) ? protocol : '';
}

function neppoContactUserFromRow(row) {
  if (!Array.isArray(row)) return '';
  const direct = String(row[18] || '').trim();
  if (direct && !isGenericNeppoCaller(direct)) return direct;
  const parts = splitNeppoClientName(row[12] || '');
  return parts.usuario && !isGenericNeppoCaller(parts.usuario) ? parts.usuario : '';
}

function neppoContactEntryFromRow(row) {
  if (!Array.isArray(row)) return null;
  const protocol = normalizeNeppoContactProtocol(row[7]);
  if (!protocol) return null;
  const phone = neppoPhoneFromValues(row[13], row[14], row[23]);
  const user = neppoContactUserFromRow(row);
  if (!phone && !user) return null;
  return {
    protocol,
    user,
    phone,
    sessionId: Number(row[16] || 0) || '',
    updatedAt: new Date().toISOString(),
  };
}

function normalizeNeppoContactEntry(entry = {}) {
  const protocol = normalizeNeppoContactProtocol(entry.protocol || entry.protocolo);
  if (!protocol) return null;
  const user = String(entry.user || entry.usuario || '').trim();
  const phone = neppoPhoneFromValues(entry.phone || entry.telefone);
  if (!user && !phone) return null;
  return {
    protocol,
    user: user && !isGenericNeppoCaller(user) ? user : '',
    phone,
    sessionId: Number(entry.sessionId || entry.session_id || 0) || '',
    updatedAt: String(entry.updatedAt || entry.updated_at || new Date().toISOString()),
  };
}

async function readNeppoContactCache(env) {
  if (!env.ADJUSTMENTS) return { items: {} };
  const stored = await env.ADJUSTMENTS.get(NEPPO_CONTACT_CACHE_KEY, 'json').catch(() => null);
  const items = stored && typeof stored.items === 'object' && stored.items ? stored.items : {};
  return { items };
}

async function writeNeppoContactCache(env, cache) {
  if (!env.ADJUSTMENTS) return false;
  const items = cache && typeof cache.items === 'object' && cache.items ? cache.items : {};
  const limited = Object.fromEntries(
    Object.entries(items)
      .sort((a, b) => String(b[1]?.updatedAt || '').localeCompare(String(a[1]?.updatedAt || '')))
      .slice(0, NEPPO_CONTACT_CACHE_MAX_ITEMS),
  );
  await env.ADJUSTMENTS.put(NEPPO_CONTACT_CACHE_KEY, JSON.stringify({ items: limited, updatedAt: new Date().toISOString() }));
  return true;
}

async function mergeNeppoContactCache(env, entries = []) {
  const normalized = entries.map(normalizeNeppoContactEntry).filter(Boolean);
  if (!normalized.length || !env.ADJUSTMENTS) return { ok: false, saved: 0, cache: await readNeppoContactCache(env) };
  const cache = await readNeppoContactCache(env);
  let saved = 0;
  for (const entry of normalized) {
    const current = cache.items[entry.protocol] || {};
    const next = {
      protocol: entry.protocol,
      user: entry.user || current.user || '',
      phone: entry.phone || current.phone || '',
      sessionId: entry.sessionId || current.sessionId || '',
      updatedAt: new Date().toISOString(),
    };
    if ((next.user && next.user !== current.user) || (next.phone && next.phone !== current.phone) || (!current.protocol && (next.user || next.phone))) {
      cache.items[entry.protocol] = next;
      saved += 1;
    }
  }
  if (saved) await writeNeppoContactCache(env, cache);
  return { ok: true, saved, total: Object.keys(cache.items).length, cache };
}

async function persistNeppoContactRows(env, rows = []) {
  return mergeNeppoContactCache(env, rows.map(neppoContactEntryFromRow).filter(Boolean));
}

function applyNeppoContactCacheToRows(data, cache) {
  if (!data || !Array.isArray(data.rows) || !cache?.items) return 0;
  let changed = 0;
  for (const row of data.rows) {
    if (!Array.isArray(row)) continue;
    const protocol = normalizeNeppoContactProtocol(row[7]);
    const item = protocol ? cache.items[protocol] : null;
    if (!item) continue;
    if (!row[13] && item.phone) {
      row[13] = item.phone;
      changed += 1;
    }
    if ((!row[18] || isGenericNeppoCaller(row[18])) && item.user) {
      row[18] = item.user;
      changed += 1;
    }
  }
  return changed;
}

async function withNeppoContactCache(env, body) {
  if (!body?.data || !env.ADJUSTMENTS) return body;
  const next = cloneDashboardDataForWorker(body);
  const cache = await readNeppoContactCache(env);
  const applied = applyNeppoContactCacheToRows(next.data, cache);
  if (applied) {
    recalculateDashboardMetricsFromRows(next.data);
    next.signature = dashboardLiveSignature(next.data, next.meta || {});
    next.contactCacheApplied = applied;
  }
  return next;
}

function neppoClientKey(clientName, cpfCnpj, externalCode, contract) {
  if (cpfCnpj) return `DOC:${cpfCnpj}`;
  if (externalCode) return `EXT:${externalCode}`;
  if (contract) return `NOME:${normalizeClientLookupName(contract)}`;
  return `NOME:${normalizeClientLookupName(clientName)}`;
}

function brDatePartsFromNeppo(value) {
  const date = new Date(value);
  const br = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date,
    br,
    month: br.getUTCMonth() + 1,
    day: br.getUTCDate(),
    hour: br.getUTCHours(),
    label: `${pad(br.getUTCDate())}/${pad(br.getUTCMonth() + 1)}/${br.getUTCFullYear()} ${pad(br.getUTCHours())}:${pad(br.getUTCMinutes())}`,
  };
}

function dashboardDataRangeFromHtmlForWorker(html) {
  const marker = 'const D =';
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = html.indexOf('{', markerIndex);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        let end = i + 1;
        while (html[end] === ' ' || html[end] === '\t') end += 1;
        if (html[end] === ';') end += 1;
        return {
          statementStart: markerIndex,
          statementEnd: end,
          jsonStart: start,
          jsonEnd: i + 1,
        };
      }
    }
  }
  return null;
}

function extractDashboardDataFromHtmlForWorker(html) {
  const range = dashboardDataRangeFromHtmlForWorker(html);
  return range ? JSON.parse(html.slice(range.jsonStart, range.jsonEnd)) : null;
}

function dashboardDataScriptLiteral(data) {
  return JSON.stringify(data)
    .replace(/<\//g, '<\\/')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function cloneDashboardDataForWorker(data) {
  return JSON.parse(JSON.stringify(data));
}

function replaceDashboardDataInHtml(html, data) {
  const range = dashboardDataRangeFromHtmlForWorker(html);
  if (!range || !data || !Array.isArray(data.rows)) return null;
  const normalizedData = recalculateDashboardMetricsFromRows(cloneDashboardDataForWorker(data));
  return `${html.slice(0, range.statementStart)}const D = ${dashboardDataScriptLiteral(normalizedData)};${html.slice(range.statementEnd)}`;
}

async function readPublishedDashboardData(request, env) {
  const indexUrl = new URL('/index.html', request.url);
  const response = await env.ASSETS.fetch(indexUrl);
  if (!response.ok) throw new Error('index.html publicado não encontrado.');
  const html = await response.text();
  const data = extractDashboardDataFromHtmlForWorker(html);
  if (!data || !Array.isArray(data.rows)) throw new Error('Bloco D do dashboard não foi lido.');
  return data;
}

function dashboardLiveSignature(data, meta = {}) {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const focusMonth = Number(data.focusMonth || meta.month || 0);
  const statusRows = rows
    .filter((row) => Array.isArray(row) && (!focusMonth || Number(row[0]) === focusMonth))
    .map((row) => [row[7] || '', row[10] || '', row[11] || '', row[15] || '', row[13] || '', row[18] || '', row[4] || 0, row[5] || 0, row[6] ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify({
    source: 'neppo-live',
    checkedAt: meta.checkedAt || '',
    atend: data.atend || [],
    open: data.open || [],
    closed: data.closed || [],
    aval: data.aval || [],
    focusMonth,
    rowCount: rows.length,
    statusRows,
  });
}

function workerCsatValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n <= 10 ? n : null;
}

function workerRowCsat(row) {
  return Array.isArray(row) ? workerCsatValue(row[6]) : null;
}

const EXCLUDED_NEPPO_OPERATIONAL_AGENT_KEYS = new Set(['gabriel simaes']);

function isExcludedOperationalAgent(agent) {
  const key = String(agent || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[_\s]+/g, ' ')
    .trim();
  return (
    EXCLUDED_NEPPO_OPERATIONAL_AGENT_KEYS.has(key) ||
    key.includes('gabriel sim') ||
    key.includes('pesquisa') ||
    key.includes('botserver') ||
    key.includes('fluxo')
  );
}

function recalculateDashboardMetricsFromRows(data) {
  if (!data || !Array.isArray(data.rows)) return data;
  const rows = data.rows.filter(Array.isArray).map((row) => row.slice());
  for (const row of rows) {
    row[2] = normalizeNeppoAgent(row[2]) || 'Sem agente';
    row[3] = normalizeNeppoGroup(row[3]);
  }
  const operationalRows = rows.filter((row) => !isExcludedOperationalAgent(row[2]));
  data.rows = operationalRows;
  data.agentList = [...new Set(operationalRows.map((row) => row[2] || 'Sem agente'))]
    .sort((a, b) => String(a).localeCompare(String(b), 'pt-BR'));
  const months = Array.isArray(data.meses) && data.meses.length ? data.meses.length : 12;
  const avg = (arr) => (arr.length ? arr.reduce((sum, value) => sum + value, 0) / arr.length : null);
  const med = (arr) => {
    const a = arr.slice().sort((x, y) => x - y);
    if (!a.length) return 0;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  };
  const weekOf = (day) => Math.max(1, Math.ceil(Number(day || 1) / 7));
  const fmt = (sec) => {
    const s = Math.round(sec || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  };
  const short = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const periodDefs = [
    ['1º Período da manhã', '07-09h', 7, 9],
    ['2º Período da manhã', '09-10h', 9, 10],
    ['3º Período da manhã', '10-11h', 10, 11],
    ['4º Período da manhã', '11-12h', 11, 12],
    ['Almoço 1', '12-13h', 12, 13],
    ['Almoço 2', '13-14h', 13, 14],
    ['1º Período da tarde', '14-15h', 14, 15],
    ['2º Período da tarde', '15-16h', 15, 16],
    ['3º Período da tarde', '16-17h', 16, 17],
    ['4º Período da tarde', '17-18:30h', 17, 19],
  ];
  const groupNames = [...new Set([...(data.grupos?.nomes || []), ...operationalRows.map((row) => row[3] || 'Sem grupo')])];
  data.grupos = { nomes: groupNames };
  data.atend = [];
  data.aval = [];
  data.cobert = [];
  data.sat = [];
  data.tma = [];
  data.tme = [];
  data.sla = [];
  data.daily = {};
  data.agentes = {};
  data.byMonth = {};
  for (let mi = 0; mi < months; mi += 1) {
    const monthNo = mi + 1;
    const mk = short[mi] || String(monthNo);
    const monthRows = operationalRows.filter((row) => Number(row[0]) === monthNo);
    const rated = monthRows.filter((row) => workerRowCsat(row) !== null);
    data.atend[mi] = monthRows.length;
    data.aval[mi] = rated.length;
    data.cobert[mi] = monthRows.length ? rated.length / monthRows.length : 0;
    data.sat[mi] = avg(rated.map(workerRowCsat)) || 0;
    data.tma[mi] = fmt(avg(monthRows.map((row) => row[4]).filter((value) => value != null)) || 0);
    data.tme[mi] = fmt(avg(monthRows.map((row) => row[5]).filter((value) => value != null)) || 0);
    data.sla[mi] = monthRows.length ? monthRows.filter((row) => (row[5] || 0) <= 120).length / monthRows.length : 0;

    const dayMap = {};
    for (const row of monthRows) {
      const day = String(row[1]);
      const csat = workerRowCsat(row);
      if (!dayMap[day]) dayMap[day] = { rows: [], ratings: [] };
      dayMap[day].rows.push(row);
      if (csat !== null) dayMap[day].ratings.push(csat);
    }
    data.daily[monthNo] = Object.fromEntries(Object.entries(dayMap).map(([day, item]) => [
      day,
      { v: item.rows.length, c: avg(item.ratings) || data.sat[mi] || 0 },
    ]));
    data.grupos[mk] = groupNames.map((group) => monthRows.filter((row) => (row[3] || 'Sem grupo') === group).length);

    const agents = [...new Set(monthRows.map((row) => row[2] || 'Sem agente'))];
    for (const agent of agents) {
      if (!data.agentes[agent]) data.agentes[agent] = Array.from({ length: months }, () => [0, 0, 0, '00:00:00']);
      const agentRows = monthRows.filter((row) => (row[2] || 'Sem agente') === agent);
      const agentRated = agentRows.filter((row) => workerRowCsat(row) !== null);
      data.agentes[agent][mi] = [
        agentRows.length,
        agentRated.length,
        avg(agentRated.map(workerRowCsat)) || 0,
        fmt(avg(agentRows.map((row) => row[4]).filter((value) => value != null)) || 0),
      ];
    }

    const avDist = {};
    for (const row of rated) {
      const key = String(Math.round(workerRowCsat(row)));
      avDist[key] = (avDist[key] || 0) + 1;
    }
    const tmaAg = {};
    for (const agent of agents) {
      const agentRows = monthRows.filter((row) => (row[2] || 'Sem agente') === agent);
      const tmas = agentRows.map((row) => row[4]).filter((value) => value != null);
      if (agentRows.length) {
        tmaAg[agent] = [
          (avg(tmas) || 0) / 60,
          med(tmas) / 60,
          avg(agentRows.map((row) => row[5]).filter((value) => value != null)) || 0,
          agentRows.length,
        ];
      }
    }
    const tmaDist = [0, 0, 0, 0, 0, 0];
    for (const row of monthRows) {
      const min = (row[4] || 0) / 60;
      const index = min < 10 ? 0 : min < 20 ? 1 : min < 30 ? 2 : min < 45 ? 3 : min < 60 ? 4 : 5;
      tmaDist[index] += 1;
    }
    const agGrp = {};
    for (const row of monthRows) {
      const agent = row[2] || 'Sem agente';
      const group = row[3] || 'Sem grupo';
      if (!agGrp[agent]) agGrp[agent] = {};
      agGrp[agent][group] = (agGrp[agent][group] || 0) + 1;
    }
    const csatWeek = { labels: [], data: [] };
    for (let week = 1; week <= 5; week += 1) {
      const weekRows = rated.filter((row) => weekOf(row[1]) === week);
      if (weekRows.length) {
        csatWeek.labels.push(`Sem.${week}`);
        csatWeek.data.push(Number((avg(weekRows.map(workerRowCsat)) || 0).toFixed(3)));
      }
    }
    const periodos = periodDefs.map(([n, h, startHour, endHour]) => {
      const periodRows = monthRows.filter((row) => Number(row[9]) >= startHour && Number(row[9]) < endHour);
      const periodRated = periodRows.filter((row) => workerRowCsat(row) !== null);
      return {
        n,
        h,
        at: periodRows.length,
        pct: monthRows.length ? periodRows.length / monthRows.length : 0,
        av: periodRated.length,
        cob: periodRows.length ? periodRated.length / periodRows.length : 0,
        sat: avg(periodRated.map(workerRowCsat)) || 0,
        tma: fmt(avg(periodRows.map((row) => row[4]).filter((value) => value != null)) || 0),
        tme: fmt(avg(periodRows.map((row) => row[5]).filter((value) => value != null)) || 0),
      };
    });
    data.byMonth[mk] = { tmaAg, avDist, tmaDist, agGrp, csatWeek, periodos };
    if (mi === Number(data.focusIndex || 0)) {
      data.tmaAg = tmaAg;
      data.avDist = avDist;
      data.csatWeek = csatWeek;
    }
  }
  return data;
}

function neppoLiveRangeForRequest(year, month) {
  const now = saoPauloDateParts();
  const isCurrentMonth = Number(year) === now.year && Number(month) === now.month;
  if (isCurrentMonth) {
    return {
      mode: 'today',
      day: now.day,
      start: new Date(Date.UTC(year, month - 1, now.day, 3, 0, 0)),
      end: new Date(Date.UTC(year, month - 1, now.day + 1, 3, 0, 0)),
    };
  }
  return {
    mode: 'month',
    day: 0,
    start: new Date(Date.UTC(year, month - 1, 1, 3, 0, 0)),
    end: new Date(Date.UTC(year, month, 1, 3, 0, 0)),
  };
}

function neppoLiveCacheKey(year, month) {
  return `${NEPPO_LIVE_KV_PREFIX}:${year}:${String(month).padStart(2, '0')}`;
}

function neppoLiveAgeMs(body) {
  const checkedAt = body?.meta?.checkedAt || body?.checkedAt || '';
  const time = new Date(checkedAt).getTime();
  return Number.isFinite(time) ? Date.now() - time : Infinity;
}

function neppoLiveIsFresh(body, maxAgeMs = NEPPO_LIVE_FRESH_MS) {
  return body?.ok === true && body?.data && neppoLiveAgeMs(body) <= maxAgeMs;
}

async function readNeppoLiveKv(env, year, month) {
  if (!env.ADJUSTMENTS) return null;
  const stored = await env.ADJUSTMENTS.get(neppoLiveCacheKey(year, month), 'json').catch(() => null);
  return stored && stored.ok === true && stored.data ? stored : null;
}

async function writeNeppoLiveKv(env, year, month, body) {
  if (!env.ADJUSTMENTS || !body?.ok || !body?.data) return false;
  await env.ADJUSTMENTS.put(
    neppoLiveCacheKey(year, month),
    JSON.stringify(body),
    { expirationTtl: NEPPO_LIVE_KV_EXPIRATION_TTL },
  );
  return true;
}

async function writeNeppoLiveHealth(env, status) {
  if (!env.ADJUSTMENTS) return false;
  const body = {
    checkedAt: new Date().toISOString(),
    ...status,
  };
  await env.ADJUSTMENTS.put(NEPPO_LIVE_HEALTH_KEY, JSON.stringify(body), { expirationTtl: NEPPO_LIVE_KV_EXPIRATION_TTL });
  return true;
}

async function readNeppoLiveHealth(env) {
  if (!env.ADJUSTMENTS) return null;
  return env.ADJUSTMENTS.get(NEPPO_LIVE_HEALTH_KEY, 'json').catch(() => null);
}

function neppoLiveHealthAgeMs(status) {
  const time = new Date(status?.checkedAt || '').getTime();
  return Number.isFinite(time) ? Date.now() - time : Infinity;
}

function neppoRefreshSecret(env) {
  return String(env.NEPPO_REFRESH_SECRET || env.WEBHOOK_SECRET || env.NEPPO_CLIENT_SECRET || '').trim();
}

function whatsappReconcileSecret(env) {
  return String(env.WHATSAPP_RECONCILE_SECRET || env.WEBHOOK_SECRET || env.NEPPO_CLIENT_SECRET || '').trim();
}

function requestSecret(request) {
  const bearer = String(request.headers.get('Authorization') || '').trim().match(/^Bearer\s+(.+)$/i);
  return String(
    request.headers.get('X-Neppo-Refresh-Secret') ||
    request.headers.get('X-Whatsapp-Reconcile-Secret') ||
    request.headers.get('X-Gestao-Automation-Secret') ||
    bearer?.[1] ||
    '',
  ).trim();
}

async function refreshNeppoLiveDashboard(request, env, year, month) {
  const result = await buildLiveNeppoDashboard(request, env, month, year);
  if (!result.ok) throw Object.assign(new Error(result.body?.message || 'Falha NEPPO live.'), { status: result.status, body: result.body });
  await writeNeppoLiveKv(env, year, month, result.body);
  return result.body;
}

async function refreshNeppoLiveDashboardForCron(env) {
  const { year, month } = currentSaoPauloYearMonth();
  const schedule = neppoBusinessSchedule();
  const missing = missingNeppoApiConfig(env);
  if (!env.ADJUSTMENTS) return;
  if (!schedule.open) {
    const status = {
      ok: true,
      stage: 'outside-hours',
      year,
      month,
      schedule,
      message: 'Fora do expediente NEPPO. Atualizacao automatica pausada ate a proxima janela.',
    };
    await writeNeppoLiveHealth(env, status);
    return status;
  }
  if (missing.length) {
    const status = {
      ok: false,
      stage: 'config',
      year,
      month,
      schedule,
      message: `Credenciais API NEPPO ausentes no Worker: ${missing.join(', ')}.`,
    };
    await writeNeppoLiveHealth(env, status);
    return status;
  }
  const [cached, currentHealth] = await Promise.all([
    readNeppoLiveKv(env, year, month),
    readNeppoLiveHealth(env),
  ]);
  if (neppoLiveIsFresh(cached, NEPPO_LIVE_CRON_FRESH_MS)) {
    const status = {
      ok: true,
      stage: 'success',
      year,
      month,
      schedule,
      liveRows: cached?.meta?.liveRows || 0,
      ratings: cached?.meta?.ratings || 0,
      ageMs: neppoLiveAgeMs(cached),
      message: 'Base NEPPO recente no KV; coleta pulada para evitar duplicidade.',
    };
    await writeNeppoLiveHealth(env, status);
    return status;
  }
  if (currentHealth?.stage === 'running' && neppoLiveHealthAgeMs(currentHealth) <= NEPPO_LIVE_RUNNING_LOCK_MS) {
    if (cached && neppoLiveAgeMs(cached) <= NEPPO_LIVE_STALE_MS) {
      const status = {
        ok: true,
        stage: 'success',
        year,
        month,
        schedule,
        liveRows: cached?.meta?.liveRows || 0,
        ratings: cached?.meta?.ratings || 0,
        ageMs: neppoLiveAgeMs(cached),
        message: 'Coleta NEPPO anterior ainda em andamento; painel mantido com KV valido.',
      };
      await writeNeppoLiveHealth(env, status);
      return status;
    }
    return currentHealth;
  }
  await writeNeppoLiveHealth(env, { ok: null, stage: 'running', year, month, schedule, message: 'Atualizacao NEPPO em andamento no Worker.' });
  const request = new Request('https://gestaoatendimento.reinaldo-bueno.workers.dev/');
  try {
    const body = await refreshNeppoLiveDashboard(request, env, year, month);
    const status = {
      ok: true,
      stage: 'success',
      year,
      month,
      schedule,
      liveRows: body?.meta?.liveRows || 0,
      ratings: body?.meta?.ratings || 0,
      message: 'Base NEPPO atualizada no Worker/KV.',
    };
    await writeNeppoLiveHealth(env, status);
    return status;
  } catch (error) {
    const status = {
      ok: false,
      stage: 'error',
      year,
      month,
      schedule,
      status: error.status || 0,
      message: error.body?.message || error.message || String(error),
      detail: error.body?.detail || '',
    };
    await writeNeppoLiveHealth(env, status);
    return status;
  }
}

function currentSaoPauloYearMonth() {
  const br = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return { year: br.getUTCFullYear(), month: br.getUTCMonth() + 1 };
}

function saoPauloDateParts(date = new Date()) {
  const br = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  return {
    year: br.getUTCFullYear(),
    month: br.getUTCMonth() + 1,
    day: br.getUTCDate(),
    dayOfWeek: br.getUTCDay(),
    hour: br.getUTCHours(),
    minute: br.getUTCMinutes(),
    br,
  };
}

function nextNeppoBusinessStart(date = new Date()) {
  const parts = saoPauloDateParts(date);
  let brStart = Date.UTC(parts.year, parts.month - 1, parts.day, NEPPO_BUSINESS_START_HOUR, 0, 0);
  const brNow = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  let dow = parts.dayOfWeek;
  if (dow >= 1 && dow <= 5 && parts.hour < NEPPO_BUSINESS_START_HOUR) {
    return new Date(brStart + 3 * 60 * 60 * 1000).toISOString();
  }
  do {
    brStart += 24 * 60 * 60 * 1000;
    dow = (dow + 1) % 7;
  } while (dow === 0 || dow === 6 || brStart <= brNow);
  return new Date(brStart + 3 * 60 * 60 * 1000).toISOString();
}

function neppoBusinessSchedule(date = new Date()) {
  const parts = saoPauloDateParts(date);
  const isWeekday = parts.dayOfWeek >= 1 && parts.dayOfWeek <= 5;
  const open = isWeekday && parts.hour >= NEPPO_BUSINESS_START_HOUR && parts.hour < NEPPO_BUSINESS_END_HOUR;
  return {
    open,
    isWeekday,
    timezone: 'America/Sao_Paulo',
    startHour: NEPPO_BUSINESS_START_HOUR,
    endHour: NEPPO_BUSINESS_END_HOUR,
    nextStartAt: open ? '' : nextNeppoBusinessStart(date),
  };
}

async function enrichLiveRowsFromNeppoHistory(liveRows, env) {
  const result = { checked: 0, users: 0, phones: 0, skipped: 0, ok: true };
  const candidates = (liveRows || [])
    .filter((row) => Array.isArray(row) && row[16] && (!row[13] || isGenericNeppoCaller(row[18])))
    .slice(0, NEPPO_LIVE_HISTORY_ENRICH_LIMIT);
  result.skipped = Math.max(0, (liveRows || []).length - candidates.length);
  if (!candidates.length) return result;

  const auth = await getNeppoWebCookie(env);
  if (!auth.ok) {
    return { ...result, ok: false, message: auth.message || 'Histórico NEPPO indisponível para enriquecer usuário/telefone.' };
  }

  for (let index = 0; index < candidates.length; index += NEPPO_LIVE_HISTORY_ENRICH_CONCURRENCY) {
    const batch = candidates.slice(index, index + NEPPO_LIVE_HISTORY_ENRICH_CONCURRENCY);
    await Promise.all(batch.map(async (row) => {
      const history = await fetchNeppoIssueHistory(row[16], auth.cookie).catch(() => null);
      result.checked += 1;
      if (!history?.ok) return;
      const { caller, phone } = conversationInfoFromMessages(history.messages || []);
      if (caller && (isGenericNeppoCaller(row[18]) || row[18] !== caller)) {
        row[18] = caller;
        result.users += 1;
      }
      if (!row[13] && phone) {
        row[13] = phone;
        result.phones += 1;
      }
    }));
  }

  return result;
}

async function buildLiveNeppoDashboard(request, env, month, year) {
  const baseData = await readPublishedDashboardData(request, env);
  const initialContactCache = await readNeppoContactCache(env).catch(() => ({ items: {} }));
  const initialContactApplied = applyNeppoContactCacheToRows(baseData, initialContactCache);
  const auth = await getNeppoApiToken(env);
  if (!auth.ok) return { ok: false, status: auth.status, body: auth };

  const range = neppoLiveRangeForRequest(year, month);
  const { start, end } = range;
  const token = auth.token;
  const agents = [];
  for (let page = 0; page < 3; page += 1) {
    const batch = await invokeNeppoApiList(token, 'agent', page, 200, [], 'createdAt');
    if (!batch.length) break;
    agents.push(...batch);
  }

  const agentByUserName = new Map();
  for (const row of agents) {
    const user = row?.user || {};
    if (String(user.typeUser || '') !== 'AGENT') continue;
    const display = normalizeNeppoAgent(user.displayName || user.name || row.loginAttendance);
    if (!display || /@Botserver|Pesquisa|Fluxo/i.test(display)) continue;
    for (const key of [user.userName, row.loginAttendance, user.name]) {
      if (key) agentByUserName.set(String(key), display);
    }
  }

  const sessions = await getNeppoRowsUntil(token, 'user-session', start, end, 'createdAt', 'createdAt', { maxPages: range.mode === 'today' ? 8 : 18, pageSize: 100 });
  const answers = await getNeppoRowsUntil(token, 'chat-answer', start, end, 'createdAt', 'createdAt', { maxPages: range.mode === 'today' ? 8 : 18, pageSize: 100 });
  const ratingBySession = new Map();
  for (const answer of answers) {
    if (Number(answer.questionId) !== 1) continue;
    const option = Number(answer.optionAnswerId);
    if (option < 20 || option > 30) continue;
    ratingBySession.set(Number(answer.sessionId), option - 20);
  }

  const excludedGroups = new Set(['Administrativo', 'Comercial', 'CSI']);
  const liveRows = [];
  const seenProtocols = new Set();
  for (const session of sessions) {
    if (session?.onlyBot) continue;
    const created = brDatePartsFromNeppo(session.createdAt);
    const closed = session.closedAt ? brDatePartsFromNeppo(session.closedAt) : null;
    const group = normalizeNeppoGroup(session?.groupConf?.name);
    if (excludedGroups.has(group)) continue;
    const lastAgent = String(session.lastAgent || '');
    const agent = agentByUserName.get(lastAgent)
      || normalizeNeppoAgent(session?.agent?.displayName || (lastAgent && lastAgent !== 'queue' ? lastAgent : ''))
      || 'Sem agente';
    const clientName = String(session?.user?.displayName || session?.user?.name || session?.user?.userName || '');
    const clientParts = splitNeppoClientName(clientName);
    const cpfCnpj = normalizeDocument(session?.user?.cpf);
    const externalCode = String(session?.user?.externalCode || '');
    const phone = neppoPhoneFromValues(
      session?.user?.phone,
      session.externalProtocol,
      session?.user?.originUser,
      session?.user?.userName,
      session?.user?.displayName,
      session?.user?.name,
    );
    const protocol = String(session.protocol || '');
    if (!protocol || seenProtocols.has(protocol)) continue;
    seenProtocols.add(protocol);
    liveRows.push([
      created.month,
      created.day,
      agent,
      group,
      Math.round(Number(session.tma || 0)),
      Math.round(Number(session.tme || 0)),
      ratingBySession.has(Number(session.id)) ? ratingBySession.get(Number(session.id)) : null,
      protocol,
      neppoPeriodName(created.hour),
      created.hour,
      created.label,
      closed ? closed.label : '',
      clientName,
      phone,
      String(session?.user?.originUser || ''),
      String(session.status || ''),
      Number(session.id || 0),
      String(session?.groupConf?.operation?.operationName || 'MODELO'),
      clientParts.usuario,
      clientParts.contrato,
      neppoClientKey(clientName, cpfCnpj, externalCode, clientParts.contrato),
      cpfCnpj,
      externalCode,
      String(session?.user?.userName || ''),
      Number(session?.user?.id || 0),
    ]);
  }

  const historyEnrichment = await enrichLiveRowsFromNeppoHistory(liveRows, env).catch((error) => ({
    ok: false,
    checked: 0,
    users: 0,
    phones: 0,
    message: error.message || String(error),
  }));
  const contactPersist = await persistNeppoContactRows(env, liveRows).catch((error) => ({
    ok: false,
    saved: 0,
    total: 0,
    message: error.message || String(error),
    cache: initialContactCache,
  }));

  const rows = [
    ...((baseData.rows || []).filter((row) => Array.isArray(row) && !(
      Number(row[0]) === month && (range.mode === 'month' || Number(row[1]) === range.day)
    ))),
    ...liveRows,
  ];
  baseData.rows = rows;
  const finalContactApplied = applyNeppoContactCacheToRows(baseData, contactPersist.cache || initialContactCache);
  baseData.focusMonth = month;
  baseData.focusIndex = Array.isArray(baseData.meses) ? Math.max(0, Math.min(baseData.meses.length - 1, month - 1)) : 0;
  recalculateDashboardMetricsFromRows(baseData);
  const meta = {
    source: 'neppo-live',
    checkedAt: new Date().toISOString(),
    year,
    month,
    range: {
      mode: range.mode,
      day: range.day,
      start: start.toISOString(),
      end: end.toISOString(),
    },
    liveRows: liveRows.length,
    historyEnrichment,
    contactCache: {
      saved: contactPersist.saved || 0,
      total: contactPersist.total || Object.keys((contactPersist.cache || initialContactCache).items || {}).length,
      applied: initialContactApplied + finalContactApplied,
    },
    ratings: ratingBySession.size,
    pages: {
      agents: Math.ceil(agents.length / 200) || 1,
      sessions: sessions.pages || 0,
      answers: answers.pages || 0,
    },
  };
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      data: baseData,
      signature: dashboardLiveSignature(baseData, meta),
      meta,
    },
  };
}

async function handleNeppoLiveDashboard(request, env, ctx) {
  const url = new URL(request.url);
  const now = currentSaoPauloYearMonth();
  const month = Math.max(1, Math.min(12, Number(url.searchParams.get('month') || now.month)));
  const year = Math.max(2020, Math.min(2100, Number(url.searchParams.get('year') || now.year)));
  const force = url.searchParams.get('force') === '1' || url.searchParams.get('refresh') === '1';
  const schedule = neppoBusinessSchedule();
  const cacheKey = `${year}-${month}`;
  const cached = NEPPO_LIVE_CACHE.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) {
    const body = await withNeppoContactCache(env, await cached.promise);
    return jsonResponse({ ...body, cached: true, cache: 'memory' });
  }

  const kvBody = await readNeppoLiveKv(env, year, month);
  if (!force && neppoLiveIsFresh(kvBody)) {
    const body = await withNeppoContactCache(env, kvBody);
    return jsonResponse({ ...body, cached: true, cache: 'kv', ageMs: neppoLiveAgeMs(kvBody), schedule });
  }

  if (!force && !schedule.open) {
    const age = neppoLiveAgeMs(kvBody);
    if (kvBody && age <= NEPPO_LIVE_KV_EXPIRATION_TTL * 1000) {
      const body = await withNeppoContactCache(env, kvBody);
      return jsonResponse({ ...body, cached: true, cache: 'kv-outside-hours', outsideHours: true, ageMs: age, schedule });
    }
    return jsonResponse({
      ok: false,
      outsideHours: true,
      schedule,
      message: 'Fora do expediente NEPPO. A coleta automatica fica pausada de segunda a sexta fora de 08:00-18:00.',
    });
  }

  const promise = refreshNeppoLiveDashboard(request, env, year, month);
  NEPPO_LIVE_CACHE.set(cacheKey, { expiresAt: Date.now() + NEPPO_LIVE_FRESH_MS, promise });
  try {
    return jsonResponse(await promise);
  } catch (error) {
    NEPPO_LIVE_CACHE.delete(cacheKey);
    if (kvBody && neppoLiveAgeMs(kvBody) <= NEPPO_LIVE_STALE_MS) {
      const body = await withNeppoContactCache(env, kvBody);
      const staleBody = {
        ...body,
        cached: true,
        cache: 'kv-stale',
        stale: true,
        ageMs: neppoLiveAgeMs(kvBody),
        refreshError: error.body || { message: error.message || String(error) },
      };
      if (ctx) ctx.waitUntil(refreshNeppoLiveDashboard(request, env, year, month).catch(() => null));
      return jsonResponse(staleBody);
    }
    return jsonResponse(error.body || { ok: false, message: error.message || String(error) }, error.status || 502);
  }
}

async function handleNeppoLiveHealth(env) {
  const { year, month } = currentSaoPauloYearMonth();
  const schedule = neppoBusinessSchedule();
  const cached = await readNeppoLiveKv(env, year, month);
  const health = await readNeppoLiveHealth(env);
  const cache = cached ? {
    key: neppoLiveCacheKey(year, month),
    year,
    month,
    ageMs: neppoLiveAgeMs(cached),
    checkedAt: cached?.meta?.checkedAt || '',
    liveRows: cached?.meta?.liveRows || 0,
    ratings: cached?.meta?.ratings || 0,
  } : {
    key: neppoLiveCacheKey(year, month),
    year,
    month,
    missing: true,
  };
  let healthView = health || null;
  const cacheCheckedAt = cached?.meta?.checkedAt || '';
  const cacheTime = Date.parse(cacheCheckedAt);
  const healthTime = Date.parse(health?.checkedAt || '');
  if (
    cached &&
    Number.isFinite(cacheTime) &&
    (
      !healthView ||
      healthView.stage === 'running' ||
      !Number.isFinite(healthTime) ||
      cacheTime > healthTime
    )
  ) {
    healthView = {
      checkedAt: cacheCheckedAt,
      ok: true,
      stage: 'success',
      year,
      month,
      schedule,
      liveRows: cached?.meta?.liveRows || 0,
      ratings: cached?.meta?.ratings || 0,
      message: 'Base NEPPO atualizada no Worker/KV.',
    };
  }
  return jsonResponse({
    ok: true,
    schedule,
    health: healthView,
    cache,
  });
}

async function handleNeppoLiveCronTrigger(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Metodo nao permitido.' }, 405);
  }
  const expected = neppoRefreshSecret(env);
  if (!expected) {
    return jsonResponse({ error: 'Segredo de atualizacao NEPPO nao configurado.' }, 503);
  }
  const received = requestSecret(request);
  if (!received || !timingSafeEqual(received, expected)) {
    return jsonResponse({ error: 'Nao autorizado.' }, 401);
  }
  const status = await refreshNeppoLiveDashboardForCron(env);
  return jsonResponse({
    ok: status?.ok !== false,
    status: status || null,
    schedule: neppoBusinessSchedule(),
  });
}

function isGenericReportClientName(value) {
  const normalized = normalizeClientLookupName(value);
  return (
    !normalized ||
    normalized.length < 3 ||
    /^(CLIENTE|ATENDENTE|BOT|SISTEMA|MENSAGEM|MESSAGE|NONE|TRANSFER|QUEUE)$/.test(normalized) ||
    /^(MULTSOFT|MULTSOFT CONSULTOR|IMPLANTACAO MULTSOFT|DEP DE COBRANCA MULTSOFT)$/.test(normalized) ||
    /^(WHATSAPP|VOICE)\s*\d+$/.test(normalized)
  );
}

function contractNameFromConversationSender(value) {
  const cleaned = stripHtmlText(value)
    .replace(/\s+-\s+\d{2}\/\d{2}\/\d{4}.*$/i, '')
    .trim();
  if (isGenericReportClientName(cleaned)) return '';
  const parts = cleaned.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1 && !isGenericReportClientName(parts[parts.length - 1])) return parts[parts.length - 1];
  return cleaned;
}

function conversationClientName(histories) {
  for (const { history } of histories || []) {
    if (!history.body?.ok) continue;
    for (const message of findMessageList(history.body)) {
      const sender = messageSender(message);
      if (!/^CLIENTE\b/i.test(sender)) continue;
      const rawName = sender.replace(/^CLIENTE\s*-\s*/i, '').trim();
      const name = contractNameFromConversationSender(rawName);
      if (name) return name;
    }
  }
  return '';
}

function privateClientByName(name) {
  const wanted = normalizeClientLookupName(name);
  if (!wanted) return null;
  const seen = new Set();
  for (const info of Object.values(PRIVATE_CLIENT_MAP || {})) {
    if (!info || seen.has(info.codigo)) continue;
    seen.add(info.codigo);
    if (normalizeClientLookupName(info.nome) === wanted) return info;
  }
  return null;
}

function rewriteDashboardBrand(response) {
  const contentType = response.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('text/html')) return response;
  return new HTMLRewriter()
    .on('head', {
      element(element) {
        element.append(`<meta name="gestao-release" content="${DASHBOARD_RELEASE_MARKER}">`, { html: true });
      },
    })
    .on('body', {
      element(element) {
        element.setAttribute('data-gestao-release', DASHBOARD_RELEASE_MARKER);
      },
    })
    .on('.logo-gem', {
      element(element) {
        element.setInnerContent('M');
        element.setAttribute('aria-label', 'Multsoft');
        element.setAttribute(
          'style',
          "color:#fff;font-family:'Fraunces',serif;font-size:1rem;font-weight:900;letter-spacing:.01em;line-height:1;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);",
        );
      },
    })
    .transform(response);
}

async function injectLiveDashboardIntoHtml(env, response) {
  const contentType = response.headers.get('Content-Type') || '';
  if (!response.ok || !contentType.toLowerCase().includes('text/html')) return response;
  const { year, month } = currentSaoPauloYearMonth();
  const liveBody = await readNeppoLiveKv(env, year, month).catch(() => null);
  if (!liveBody?.data) return response;
  const body = await withNeppoContactCache(env, liveBody);

  const html = await response.text();
  const nextHtml = replaceDashboardDataInHtml(html, body.data);
  if (!nextHtml || nextHtml === html) {
    return new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.set('X-Gestao-Dashboard-Source', 'neppo-live-kv');
  headers.set('X-Gestao-Dashboard-Checked-At', body.meta?.checkedAt || body.checkedAt || '');
  headers.set('X-Gestao-Dashboard-Rows', String(Array.isArray(liveBody.data.rows) ? liveBody.data.rows.length : 0));
  return new Response(nextHtml, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
  return PRIVATE_CLIENT_MAP[String(code)]?.nome || '';
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
  const histories = await getAttendanceHistoryBundle(protocol, env);
  const historyClientName = conversationClientName(histories);
  const historyClientInfo = privateClientByName(historyClientName);
  const code = historyClientInfo?.codigo || row[18] || payload?.code || '';
  const payloadCode = payload?.code || payloadRow[18] || '';
  const payloadNameStillMatches = !currentRow || String(payloadCode) === String(code);
  const privateClientName = historyClientInfo?.nome || (await getPrivateClientName(request, env, code).catch(() => ''));
  const clientName =
    privateClientName ||
    historyClientName ||
    (payloadNameStillMatches ? payload?.clientName : '') ||
    row[19] ||
    row[12] ||
    code ||
    'Cliente não informado';
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
const TREATMENT_PATTERNS_KEY = 'treatment-patterns-v1';
const REVIEW_REQUESTS_KEY = 'treatment-review-requests-v1';
const REVIEW_REQUESTS_MAX_ITEMS = 3000;
const INITIAL_DELETED_TREATMENT_PATTERNS = ['WA00000119688'];
const WHATSAPP_GROUP_ORIGIN = 'WHATSAPP_GRUPO';
const WHATSAPP_GROUP_SETTINGS_KEY = 'monitor_mode';
const WHATSAPP_GROUP_DEFAULT_MODE = 'ALL_GROUPS';
const WHATSAPP_GROUP_REGISTERED_MODE = 'REGISTERED_ONLY';
const WHATSAPP_WEBHOOK_MAX_BYTES = 32 * 1024 * 1024;
const WHATSAPP_WEBHOOK_RAW_MAX_BYTES = 512 * 1024;
const WHATSAPP_MEDIA_BASE64_MAX_BYTES = 24 * 1024 * 1024;
const WHATSAPP_MEDIA_D1_INLINE_MAX_BYTES = 512 * 1024;
const WHATSAPP_MEDIA_KV_EXPIRATION_TTL = 30 * 24 * 60 * 60;
const WHATSAPP_MEDIA_KV_PREFIX = 'whatsapp-group-media-v1';
const WHATSAPP_SESSION_OPEN = 'OPEN';
const WHATSAPP_SESSION_UNANSWERED = 'SEM_RESPOSTA';
const WHATSAPP_SESSION_IN_PROGRESS = 'EM_ATENDIMENTO';
const WHATSAPP_SESSION_ANSWERED = 'ANSWERED';
const WHATSAPP_SESSION_RESPONDED = 'RESPONDIDO';
const WHATSAPP_SESSION_CLOSED = 'CLOSED';
const WHATSAPP_SESSION_MAX_IDLE_MS = 4 * 60 * 60 * 1000;
const WHATSAPP_SESSION_BACKFILL_GRACE_MS = 15 * 60 * 1000;
const WHATSAPP_DEFAULT_AGENTS = [
  ['Suporte N1', '5562981980261'],
  ['Guilherme', '+55 62 9232-1529'],
  ['Anita', '+55 62 8320-0028'],
  ['Lucas Pereira', '+55 62 8303-0088'],
  ['Jose Carlos', '+55 62 8247-0040'],
  ['Thiago Ribeiro', '+55 62 9456-0981'],
  ['Gabriel Alexandre', '+55 62 8198-0521'],
  ['Maria Eduarda', '+55 62 8303-4365'],
  ['Natalia', '+55 62 8292-4552'],
  ['Wiviane', '+55 62 9944-7683'],
  ['Ana Paula', '+55 87 8116-7359'],
  ['Marcos Vinicius', '+55 62 8407-8898'],
  ['Ledayane', '+55 62 8142-6890'],
  ['Reinaldo Pessoal', '+55 62 8469-2722'],
  ['Yasmin Doro', '+55 16 99296-0688'],
  ['Wanderley', '+55 62 8126-2943'],
  ['Sergio Castro', '+55 62 8136-3800'],
].map(([nome, telefone]) => ({ nome, telefone: String(telefone || '').replace(/\D/g, '') }));

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
  const itemProtocol = String(item.protocolo || '').trim().toUpperCase();
  const list = Array.isArray(current) ? current.filter((a) =>
    String(a.id) !== String(item.id) &&
    adjustmentSignature(a) !== itemSig &&
    String(a?.protocolo || '').trim().toUpperCase() !== itemProtocol
  ) : [];
  list.push(item);
  await env.ADJUSTMENTS.put(MANUAL_ADJUSTMENTS_KEY, JSON.stringify(list.slice(-2000)));
  return jsonResponse({ ok: true, adjustment: item, total: list.length });
}

function cleanTreatmentPattern(value) {
  return String(value || '').trim().slice(0, 1200);
}

async function handleTreatmentPatterns(request, env, profile = {}) {
  if (!env.ADJUSTMENTS) {
    return jsonResponse({ patterns: [], deleted: INITIAL_DELETED_TREATMENT_PATTERNS, storage: false, message: 'ADJUSTMENTS_KV nao configurado' }, request.method === 'GET' ? 200 : 501);
  }

  const stored = (await env.ADJUSTMENTS.get(TREATMENT_PATTERNS_KEY, 'json')) || {};
  let patterns = Array.isArray(stored.patterns) ? stored.patterns.map(cleanTreatmentPattern).filter(Boolean) : [];
  let deleted = [...new Set([
    ...INITIAL_DELETED_TREATMENT_PATTERNS,
    ...(Array.isArray(stored.deleted) ? stored.deleted.map(cleanTreatmentPattern).filter(Boolean) : []),
  ])];
  const deletedSet = new Set(deleted);
  patterns = [...new Set(patterns)].filter((pattern) => !deletedSet.has(pattern));

  if (request.method === 'GET') {
    return jsonResponse({ patterns, deleted, storage: true });
  }

  const body = await request.json().catch(() => null);
  if (request.method === 'DELETE') {
    if (profile.role !== 'admin') return jsonResponse({ error: 'Somente administradores podem excluir padrões.' }, 403);
    const value = cleanTreatmentPattern(body?.value);
    if (!value) return jsonResponse({ error: 'Padrão obrigatório.' }, 400);
    patterns = patterns.filter((pattern) => pattern !== value);
    deleted = [...new Set([...deleted, value])];
    await env.ADJUSTMENTS.put(TREATMENT_PATTERNS_KEY, JSON.stringify({ patterns, deleted }));
    return jsonResponse({ ok: true, patterns, deleted, storage: true });
  }

  if (request.method !== 'POST') return jsonResponse({ error: 'Metodo nao permitido' }, 405);

  const oldValue = cleanTreatmentPattern(body?.oldValue);
  const incoming = [
    ...(Array.isArray(body?.patterns) ? body.patterns : []),
    body?.value,
  ].map(cleanTreatmentPattern).filter(Boolean);
  if (!incoming.length) return jsonResponse({ error: 'Padrão obrigatório.' }, 400);
  if (oldValue && !incoming.includes(oldValue)) {
    patterns = patterns.filter((pattern) => pattern !== oldValue);
    deleted = [...new Set([...deleted, oldValue])];
    deletedSet.add(oldValue);
  }
  const allowedIncoming = incoming.filter((pattern) => !deletedSet.has(pattern));
  patterns = [...new Set([...patterns, ...allowedIncoming])];
  await env.ADJUSTMENTS.put(TREATMENT_PATTERNS_KEY, JSON.stringify({ patterns, deleted }));
  return jsonResponse({ ok: true, patterns, deleted, storage: true });
}

function cleanReviewRequest(input, profile = {}) {
  const item = input && typeof input === 'object' ? input : {};
  const protocolo = String(item.protocolo || '').trim().toUpperCase().slice(0, 80);
  const defesa = String(item.defesa || '').trim().slice(0, 3000);
  if (!protocolo || !defesa) return null;
  const allowedTypes = new Set(['CSAT', 'TMA', 'TME/SLA', 'Outro']);
  const tipo = allowedTypes.has(String(item.tipo || '')) ? String(item.tipo) : 'Outro';
  const now = new Date().toISOString();
  return {
    id: String(item.id || `${protocolo}-${Date.now()}`).slice(0, 180),
    protocolo,
    tipo,
    defesa,
    evidencia: String(item.evidencia || '').trim().slice(0, 1500),
    solicitante: String(profile.name || profile.user || 'Agente').slice(0, 120),
    solicitanteUser: String(profile.user || '').slice(0, 120),
    status: 'pendente',
    criadoEm: now,
    atualizadoEm: now,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mutateReviewRequests(env, mutator) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const stored = (await env.ADJUSTMENTS.get(REVIEW_REQUESTS_KEY, 'json')) || [];
    const current = Array.isArray(stored) ? stored : [];
    const next = mutator(current);
    const list = Array.isArray(next?.list) ? next.list : current;
    if (next?.skipSave) return { ...next, list };
    try {
      await env.ADJUSTMENTS.put(REVIEW_REQUESTS_KEY, JSON.stringify(list.slice(-REVIEW_REQUESTS_MAX_ITEMS)));
      return { ...next, list };
    } catch (err) {
      lastError = err;
      if (attempt >= 3) break;
      await sleep(1150 * (attempt + 1));
    }
  }
  throw lastError;
}

let reviewD1SchemaReady = false;

function d1ReviewToPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    protocolo: row.protocolo,
    tipo: row.tipo || 'Outro',
    defesa: row.defesa || '',
    evidencia: row.evidencia || '',
    solicitante: row.solicitante || 'Agente',
    solicitanteUser: row.solicitante_user || '',
    status: row.status || 'pendente',
    criadoEm: row.criado_em || '',
    atualizadoEm: row.atualizado_em || '',
    decisaoMotivo: row.decisao_motivo || '',
    decididoPor: row.decidido_por || '',
    decididoEm: row.decidido_em || '',
    visualizadoSolicitanteEm: row.visualizado_solicitante_em || '',
  };
}

async function ensureReviewD1(env) {
  if (!env.REVIEWS_DB) return false;
  if (reviewD1SchemaReady) return true;
  await env.REVIEWS_DB.prepare(`
    CREATE TABLE IF NOT EXISTS review_requests (
      id TEXT PRIMARY KEY,
      protocolo TEXT NOT NULL,
      tipo TEXT NOT NULL,
      defesa TEXT NOT NULL,
      evidencia TEXT NOT NULL DEFAULT '',
      solicitante TEXT NOT NULL,
      solicitante_user TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente',
      criado_em TEXT NOT NULL,
      atualizado_em TEXT NOT NULL,
      decisao_motivo TEXT NOT NULL DEFAULT '',
      decidido_por TEXT NOT NULL DEFAULT '',
      decidido_em TEXT NOT NULL DEFAULT '',
      visualizado_solicitante_em TEXT NOT NULL DEFAULT ''
    )
  `).run();
  await env.REVIEWS_DB.prepare('CREATE INDEX IF NOT EXISTS idx_review_status_created ON review_requests(status, criado_em)').run();
  await env.REVIEWS_DB.prepare('CREATE INDEX IF NOT EXISTS idx_review_user_created ON review_requests(solicitante_user, criado_em)').run();
  reviewD1SchemaReady = true;
  return true;
}

function d1InsertReviewStatement(env, item) {
  return env.REVIEWS_DB.prepare(`
    INSERT OR REPLACE INTO review_requests (
      id, protocolo, tipo, defesa, evidencia, solicitante, solicitante_user,
      status, criado_em, atualizado_em, decisao_motivo, decidido_por, decidido_em, visualizado_solicitante_em
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    item.id,
    item.protocolo,
    item.tipo || 'Outro',
    item.defesa || '',
    item.evidencia || '',
    item.solicitante || 'Agente',
    item.solicitanteUser || '',
    item.status || 'pendente',
    item.criadoEm || new Date().toISOString(),
    item.atualizadoEm || new Date().toISOString(),
    item.decisaoMotivo || '',
    item.decididoPor || '',
    item.decididoEm || '',
    item.visualizadoSolicitanteEm || '',
  );
}

async function migrateReviewRequestsFromKv(env) {
  if (!env.ADJUSTMENTS || !env.REVIEWS_DB) return;
  const countRow = await env.REVIEWS_DB.prepare('SELECT COUNT(*) AS total FROM review_requests').first();
  if (Number(countRow?.total || 0) > 0) return;
  const stored = (await env.ADJUSTMENTS.get(REVIEW_REQUESTS_KEY, 'json')) || [];
  const items = Array.isArray(stored) ? stored.filter((item) => item && item.id && item.protocolo && item.defesa).slice(-40) : [];
  if (!items.length) return;
  for (const item of items) {
    await d1InsertReviewStatement(env, item).run();
  }
}

async function handleReviewRequestsD1(request, env, profile = {}) {
  await ensureReviewD1(env);
  await migrateReviewRequestsFromKv(env);

  if (request.method === 'GET') {
    const admin = profile.role === 'admin';
    const stmt = admin
      ? env.REVIEWS_DB.prepare('SELECT * FROM review_requests ORDER BY criado_em DESC LIMIT 3000')
      : env.REVIEWS_DB.prepare('SELECT * FROM review_requests WHERE lower(solicitante_user) = lower(?) ORDER BY criado_em DESC LIMIT 3000').bind(String(profile.user || ''));
    const result = await stmt.all();
    return jsonResponse({ requests: (result.results || []).map(d1ReviewToPublic), storage: true, store: 'd1' });
  }

  if (request.method !== 'POST') return jsonResponse({ error: 'Metodo nao permitido' }, 405);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Corpo da requisição inválido. JSON esperado.' }, 400);
  }

  if (!body || typeof body !== 'object') return jsonResponse({ error: 'Corpo da requisição inválido.' }, 400);
  if (body?.markSeen === true) return jsonResponse({ ok: true, marked: 0, localOnly: true, store: 'd1' });

  if (body?.decision) {
    if (profile.role !== 'admin') return jsonResponse({ error: 'Somente administradores podem decidir pedidos.' }, 403);
    const id = String(body.id || '').trim();
    const decision = String(body.decision || '').toLowerCase();
    if (!id || !['aprovado', 'rejeitado', 'pendente'].includes(decision)) return jsonResponse({ error: 'Decisao invalida.' }, 400);
    const now = new Date().toISOString();
    const current = await env.REVIEWS_DB.prepare('SELECT * FROM review_requests WHERE id = ?').bind(id).first();
    if (!current) return jsonResponse({ error: 'Pedido nao encontrado.' }, 404);
    await env.REVIEWS_DB.prepare(`
      UPDATE review_requests
      SET status = ?, decisao_motivo = ?, decidido_por = ?, decidido_em = ?, visualizado_solicitante_em = '', atualizado_em = ?
      WHERE id = ?
    `).bind(
      decision,
      String(body.motivo || '').trim().slice(0, 2000),
      String(profile.name || profile.user || 'Administrador').slice(0, 120),
      now,
      now,
      id,
    ).run();
    const updated = await env.REVIEWS_DB.prepare('SELECT * FROM review_requests WHERE id = ?').bind(id).first();
    return jsonResponse({ ok: true, request: d1ReviewToPublic(updated), store: 'd1' });
  }

  const item = cleanReviewRequest(body, profile);
  if (!item) return jsonResponse({ error: 'Protocolo e defesa sao obrigatorios.' }, 400);
  await d1InsertReviewStatement(env, item).run();
  const countRow = await env.REVIEWS_DB.prepare('SELECT COUNT(*) AS total FROM review_requests').first();
  return jsonResponse({ ok: true, request: item, total: Number(countRow?.total || 0), store: 'd1' });
}

async function handleReviewRequests(request, env, profile = {}) {
  try {
    if (env.REVIEWS_DB) {
      return handleReviewRequestsD1(request, env, profile);
    }
    if (!env.ADJUSTMENTS) {
      return jsonResponse({ requests: [], storage: false, message: 'ADJUSTMENTS_KV nao configurado' }, request.method === 'GET' ? 200 : 501);
    }
    const stored = (await env.ADJUSTMENTS.get(REVIEW_REQUESTS_KEY, 'json')) || [];
    let list = Array.isArray(stored) ? stored : [];

    if (request.method === 'GET') {
      const visible = profile.role === 'admin'
        ? list
        : list.filter((item) => String(item.solicitanteUser || '').toLowerCase() === String(profile.user || '').toLowerCase());
      return jsonResponse({ requests: visible, storage: true });
    }

    if (request.method !== 'POST') return jsonResponse({ error: 'Metodo nao permitido' }, 405);

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'Corpo da requisição inválido. JSON esperado.' }, 400);
    }

    if (!body || typeof body !== 'object') {
      return jsonResponse({ error: 'Corpo da requisição inválido.' }, 400);
    }

    if (body?.markSeen === true) {
      return jsonResponse({ ok: true, marked: 0, localOnly: true });
    }

    if (body?.decision) {
      if (profile.role !== 'admin') return jsonResponse({ error: 'Somente administradores podem decidir pedidos.' }, 403);
      const id = String(body.id || '').trim();
      const decision = String(body.decision || '').toLowerCase();
      if (!id || !['aprovado', 'rejeitado', 'pendente'].includes(decision)) return jsonResponse({ error: 'Decisao invalida.' }, 400);
      let missing = false;
      const result = await mutateReviewRequests(env, (current) => {
        const index = current.findIndex((item) => String(item.id) === id);
        if (index < 0) {
          missing = true;
          return { list: current, request: null, skipSave: true };
        }
        const nextList = [...current];
        nextList[index] = {
          ...nextList[index],
          status: decision,
          decisaoMotivo: String(body.motivo || '').trim().slice(0, 2000),
          decididoPor: String(profile.name || profile.user || 'Administrador').slice(0, 120),
          decididoEm: new Date().toISOString(),
          visualizadoSolicitanteEm: '',
          atualizadoEm: new Date().toISOString(),
        };
        missing = false;
        return { list: nextList, request: nextList[index] };
      });
      if (missing || !result.request) return jsonResponse({ error: 'Pedido nao encontrado.' }, 404);
      return jsonResponse({ ok: true, request: result.request });
    }

    const item = cleanReviewRequest(body, profile);
    if (!item) return jsonResponse({ error: 'Protocolo e defesa sao obrigatorios.' }, 400);

    const result = await mutateReviewRequests(env, (current) => {
      const listWithoutSameId = current.filter((existing) => String(existing.id) !== String(item.id));
      listWithoutSameId.push(item);
      return { list: listWithoutSameId, request: item, total: listWithoutSameId.length };
    });
    return jsonResponse({ ok: true, request: item, total: result.total || result.list.length });
  } catch (err) {
    console.error('Erro em handleReviewRequests:', err);
    return jsonResponse({ error: `Erro ao processar pedido de revisão: ${err.message || err}` }, 500);
  }
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

let whatsappGroupD1SchemaReady = false;

function normalizeWebhookEvent(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.toLowerCase().replace(/_/g, '.');
}

function cleanWebhookText(value, limit = 2000) {
  return String(value ?? '').trim().slice(0, limit);
}

function cleanWebhookBase64(value, limit = WHATSAPP_MEDIA_BASE64_MAX_BYTES) {
  return String(value ?? '').trim().slice(0, limit);
}

function unixTimestampToIso(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  const millis = n > 9999999999 ? n : n * 1000;
  return new Date(millis).toISOString();
}

function whatsappGroupMode(value) {
  const mode = String(value || '').trim().toUpperCase();
  return mode === WHATSAPP_GROUP_REGISTERED_MODE ? WHATSAPP_GROUP_REGISTERED_MODE : WHATSAPP_GROUP_DEFAULT_MODE;
}

function whatsappGroupIdForSql(value) {
  return String(value || '').trim().slice(0, 180);
}

async function tryAddD1Column(env, table, columnSql) {
  try {
    await env.REVIEWS_DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnSql}`).run();
  } catch (error) {
    if (!String(error?.message || error).toLowerCase().includes('duplicate column')) throw error;
  }
}

function unwrapEvolutionMessage(message = {}) {
  let current = message && typeof message === 'object' ? message : {};
  const seen = new Set();
  for (let i = 0; i < 8; i += 1) {
    if (!current || typeof current !== 'object' || seen.has(current)) break;
    seen.add(current);
    const next =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message ||
      current.editedMessage?.message ||
      current.protocolMessage?.editedMessage ||
      current.message;
    if (!next || typeof next !== 'object') break;
    current = next;
  }
  return current && typeof current === 'object' ? current : {};
}

function extractEvolutionMessage(message = {}) {
  const msg = unwrapEvolutionMessage(message);
  const media = extractEvolutionMediaInfo(msg);
  if (media?.type) {
    const labels = {
      image: 'Imagem recebida',
      audio: 'Audio recebido',
      video: 'Video recebido',
      document: 'Documento recebido',
      sticker: 'Sticker recebido',
    };
    return {
      tipoMensagem: media.type,
      conteudo: cleanWebhookText(media.caption || media.fileName || labels[media.type] || 'Midia recebida', 5000),
    };
  }
  const checks = [
    ['conversation', 'text', msg.conversation],
    ['extendedTextMessage', 'text', msg.extendedTextMessage?.text],
    ['audioMessage', 'audio', msg.audioMessage?.mimetype || 'Audio recebido'],
    ['imageMessage', 'image', msg.imageMessage?.caption || msg.imageMessage?.mimetype || 'Imagem recebida'],
    ['videoMessage', 'video', msg.videoMessage?.caption || msg.videoMessage?.mimetype || 'Video recebido'],
    ['documentMessage', 'document', msg.documentMessage?.fileName || msg.documentMessage?.caption || msg.documentMessage?.mimetype || 'Documento recebido'],
    ['stickerMessage', 'sticker', msg.stickerMessage?.mimetype || 'Sticker recebido'],
    ['reactionMessage', 'reaction', msg.reactionMessage?.text || msg.reactionMessage?.key?.id || 'Reacao recebida'],
  ];

  for (const [, type, content] of checks) {
    if (content !== undefined && content !== null && String(content).trim() !== '') {
      return { tipoMensagem: type, conteudo: cleanWebhookText(content, 5000) };
    }
  }

  const firstKey = Object.keys(msg)[0] || '';
  return {
    tipoMensagem: firstKey ? firstKey.replace(/Message$/i, '').toLowerCase() : 'unknown',
    conteudo: '',
  };
}

function inferEvolutionMediaType(type = '', item = {}, url = '', base64 = '') {
  const dataPrefix = /^data:([^;,]+)/i.exec(String(base64 || ''));
  const mime = String(item?.mimetype || item?.mimeType || dataPrefix?.[1] || '').toLowerCase();
  if (/^image\//.test(mime)) return 'image';
  if (/^audio\//.test(mime)) return 'audio';
  if (/^video\//.test(mime)) return 'video';
  if (/webp/.test(mime) && /sticker/.test(String(type || '').toLowerCase())) return 'sticker';
  if (/pdf|document|officedocument|msword|sheet|presentation/.test(mime)) return 'document';
  const text = [
    type,
    mime,
    item?.fileName,
    item?.filename,
    url,
  ].map((value) => String(value || '').toLowerCase()).join(' ');
  if (/image|jpeg|jpg|png|gif|webp/.test(text)) return 'image';
  if (/audio|ogg|opus|mpeg|mp3|m4a|wav|aac/.test(text)) return 'audio';
  if (/video|mp4|webm|mov/.test(text)) return 'video';
  if (/sticker/.test(text)) return 'sticker';
  if (/pdf|document|doc|xls|ppt|zip/.test(text)) return 'document';
  return type || 'media';
}

function inferEvolutionMediaMime(media = {}) {
  const dataPrefix = /^data:([^;,]+)/i.exec(String(media.base64 || ''));
  return cleanWebhookText(media.mimetype || dataPrefix?.[1] || '', 120);
}

function normalizeEvolutionMediaContentType(media = {}) {
  const mime = String(media.mimetype || '').toLowerCase();
  if (media.type === 'audio' && !mime.startsWith('audio/')) return 'audio/ogg';
  if (media.type === 'image' && !mime.startsWith('image/')) return 'image/jpeg';
  if (media.type === 'video' && !mime.startsWith('video/')) return 'video/mp4';
  return media.mimetype || (media.type === 'audio' ? 'audio/ogg' : media.type === 'image' ? 'image/jpeg' : media.type === 'video' ? 'video/mp4' : 'application/octet-stream');
}

function whatsappMediaKvKey(id, suffix) {
  return `${WHATSAPP_MEDIA_KV_PREFIX}:${id}:${suffix}`;
}

function decodeBase64Bytes(base64 = '') {
  const raw = String(base64 || '');
  const clean = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function readWhatsappMediaKv(env, id) {
  if (!env.ADJUSTMENTS || !id) return null;
  const [meta, base64] = await Promise.all([
    env.ADJUSTMENTS.get(whatsappMediaKvKey(id, 'meta'), 'json').catch(() => null),
    env.ADJUSTMENTS.get(whatsappMediaKvKey(id, 'base64'), 'text').catch(() => ''),
  ]);
  return base64 ? { ...(meta || {}), base64 } : null;
}

async function writeWhatsappMediaCache(env, id, media = {}, base64Value = '') {
  if (!env.REVIEWS_DB || !id || !media?.type) return false;
  const base64 = cleanWebhookBase64(base64Value || media.base64 || '');
  if (!base64) return false;
  const mimetype = normalizeEvolutionMediaContentType(media);
  const fileName = cleanWebhookText(media.fileName || `whatsapp-${media.type}`, 240);
  const now = new Date().toISOString();
  let inlineBase64 = base64;
  if (env.ADJUSTMENTS && base64.length > WHATSAPP_MEDIA_D1_INLINE_MAX_BYTES) {
    await Promise.all([
      env.ADJUSTMENTS.put(whatsappMediaKvKey(id, 'base64'), base64, { expirationTtl: WHATSAPP_MEDIA_KV_EXPIRATION_TTL }),
      env.ADJUSTMENTS.put(
        whatsappMediaKvKey(id, 'meta'),
        JSON.stringify({ mimetype, fileName, type: media.type, updatedAt: now }),
        { expirationTtl: WHATSAPP_MEDIA_KV_EXPIRATION_TTL },
      ),
    ]);
    inlineBase64 = '';
  }
  await env.REVIEWS_DB.prepare(`
    INSERT INTO whatsapp_group_media_cache (attendance_id, mimetype, file_name, base64, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(attendance_id) DO UPDATE SET
      mimetype = excluded.mimetype,
      file_name = excluded.file_name,
      base64 = CASE WHEN excluded.base64 <> '' THEN excluded.base64 ELSE whatsapp_group_media_cache.base64 END,
      updated_at = excluded.updated_at
  `).bind(id, mimetype, fileName, inlineBase64, now, now).run();
  return true;
}

function extractEvolutionMediaInfo(message = {}) {
  const msg = unwrapEvolutionMessage(message);
  const candidates = [
    ['image', msg.imageMessage],
    ['audio', msg.audioMessage],
    ['video', msg.videoMessage],
    ['document', msg.documentMessage],
    ['sticker', msg.stickerMessage],
  ];
  for (const [type, item] of candidates) {
    if (!item || typeof item !== 'object') continue;
    const url = cleanWebhookText(item.url || item.mediaUrl || item.fileUrl || item.link || '', 2000);
    const base64 = cleanWebhookText(item.base64 || item.base64Data || item.data || '', WHATSAPP_MEDIA_BASE64_MAX_BYTES);
    const directPath = cleanWebhookText(item.directPath || '', 1200);
    if (!url && !base64 && !directPath) continue;
    const inferredType = inferEvolutionMediaType(type, item, url, base64);
    return {
      type: inferredType,
      url,
      base64,
      directPath,
      mimetype: inferEvolutionMediaMime({ mimetype: item.mimetype || item.mimeType || '', base64 }),
      fileName: cleanWebhookText(item.fileName || item.filename || '', 240),
      caption: cleanWebhookText(item.caption || '', 500),
    };
  }
  return null;
}

function extractEvolutionMediaInfoFromRaw(rawPayloadJson = '') {
  try {
    const payload = JSON.parse(String(rawPayloadJson || '{}'));
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
    const message = unwrapEvolutionMessage(data.message);
    const media = extractEvolutionMediaInfo(message) || null;
    const base64 = pickEvolutionBase64(payload) || pickEvolutionBase64(data);
    if (media) {
      if (!media.base64 && base64) media.base64 = base64;
      return media;
    }
    if (!base64) return null;
    const msg = message && typeof message === 'object' ? message : {};
    const candidates = [
      ['audio', msg.audioMessage],
      ['image', msg.imageMessage],
      ['video', msg.videoMessage],
      ['document', msg.documentMessage],
      ['sticker', msg.stickerMessage],
    ];
    for (const [type, item] of candidates) {
      if (!item || typeof item !== 'object') continue;
      return {
        type: inferEvolutionMediaType(type, item, '', base64),
        url: '',
        base64,
        directPath: '',
        mimetype: inferEvolutionMediaMime({ mimetype: item.mimetype || item.mimeType || '', base64 }),
        fileName: cleanWebhookText(item.fileName || item.filename || '', 240),
        caption: cleanWebhookText(item.caption || '', 500),
      };
    }
    return {
      type: inferEvolutionMediaType('', {}, '', base64),
      url: '',
      base64,
      directPath: '',
      mimetype: inferEvolutionMediaMime({ base64 }),
      fileName: '',
      caption: '',
    };
  } catch {
    return null;
  }
}

function evolutionApiBase(env) {
  return String(env.EVOLUTION_API_URL || env.EVOLUTION_URL || '').trim().replace(/\/+$/, '');
}

function evolutionApiKey(env) {
  return String(env.EVOLUTION_API_KEY || env.EVOLUTION_KEY || '').trim();
}

function pickEvolutionBase64(data) {
  if (!data || typeof data !== 'object') return '';
  const candidates = [
    data.base64,
    data.data?.base64,
    data.media?.base64,
    data.message?.base64,
    data.result?.base64,
  ];
  const direct = candidates.find(Boolean);
  if (direct) return cleanWebhookBase64(direct);
  const seen = new Set();
  const walk = (value, key = '', depth = 0) => {
    if (!value || depth > 8) return '';
    if (typeof value === 'string') {
      const text = value.trim();
      const looksLikeMedia = /base64|media|file|data/i.test(key) || /^data:(image|audio|video|application)\//i.test(text);
      const looksLikeBase64 = text.length > 120 && /^[A-Za-z0-9+/=\r\n]+$/.test(text.slice(0, Math.min(text.length, 500)));
      return looksLikeMedia && looksLikeBase64 ? cleanWebhookBase64(text) : '';
    }
    if (typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);
    for (const [childKey, childValue] of Object.entries(value)) {
      const found = walk(childValue, childKey, depth + 1);
      if (found) return found;
    }
    return '';
  };
  return walk(data);
}

async function fetchEvolutionMediaBase64(env, rawPayloadJson = '') {
  const baseUrl = evolutionApiBase(env);
  const apiKey = evolutionApiKey(env);
  if (!baseUrl || !apiKey) return null;
  let payload;
  try {
    payload = JSON.parse(String(rawPayloadJson || '{}'));
  } catch {
    return null;
  }
  const instance = cleanWebhookText(payload?.instance, 120);
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  if (!instance || !data.message) return null;
  const bodyOptions = [
    { message: data.message, key: data.key || {}, convertToMp4: false },
    { message: { key: data.key || {}, message: data.message }, convertToMp4: false },
    { key: data.key || {}, message: data.message, convertToMp4: false },
  ];
  const endpoints = [
    `${baseUrl}/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`,
    `${baseUrl}/message/getBase64FromMediaMessage/${encodeURIComponent(instance)}`,
  ];
  for (const endpoint of endpoints) {
    for (const body of bodyOptions) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: apiKey,
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) continue;
        const json = await response.json().catch(() => null);
        const base64 = pickEvolutionBase64(json);
        if (base64) return base64;
      } catch {}
    }
  }
  return null;
}

function extractEvolutionGroupName(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  return cleanWebhookText(
    data.groupName ||
      data.groupSubject ||
      data.chatName ||
      data.pushNameGroup ||
      payload?.groupName ||
      payload?.groupSubject,
    180,
  );
}

function isWhatsappGroupSystemEventPayload(payload = {}) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const message = unwrapEvolutionMessage(data.message);
  const messageType = String(data.messageType || payload?.messageType || '').toLowerCase();
  const hasUserContent = !!(
    message.conversation ||
    message.extendedTextMessage ||
    message.imageMessage ||
    message.audioMessage ||
    message.videoMessage ||
    message.documentMessage ||
    message.stickerMessage ||
    message.reactionMessage
  );
  if (data.messageStubType !== undefined || data.messageStubParameters !== undefined || data.messageStubParametersJson !== undefined) return true;
  if (data.participants || data.action || data.update || data.author) return true;
  if (!hasUserContent && (message.protocolMessage || message.senderKeyDistributionMessage)) return true;
  if (!hasUserContent && /protocol|senderkeydistribution|group_participants|participant|group.*update/.test(messageType)) return true;
  return false;
}

function extractWhatsAppGroupRecord(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const key = data.key && typeof data.key === 'object' ? data.key : {};
  const grupoId = whatsappGroupIdForSql(key.remoteJid || data.remoteJid);
  const participantId = key.participant || data.participant || data.sender || '';
  const participantAlt = key.participantAlt || data.participantAlt || key.remoteJidAlt || data.remoteJidAlt || '';
  const remetenteId = cleanWebhookText(
    String(participantId || '').includes('@lid') && participantAlt ? participantAlt : (participantId || participantAlt || key.remoteJid),
    180,
  );
  const instance = cleanWebhookText(payload?.instance, 120);
  const event = normalizeWebhookEvent(payload?.event);
  const timestamp = Number(data.messageTimestamp || payload?.messageTimestamp || 0);
  const messageInfo = extractEvolutionMessage(data.message);
  const messageId = cleanWebhookText(key.id || data.messageId || data.id, 180);
  const externalSeed = [
    instance,
    grupoId,
    messageId,
    remetenteId,
    timestamp || '',
    messageInfo.tipoMensagem,
    messageInfo.conteudo.slice(0, 160),
  ].join('|');

  return {
    id: `WG-${Date.now()}-${crypto.randomUUID()}`,
    externalId: externalSeed.slice(0, 900),
    origin: WHATSAPP_GROUP_ORIGIN,
    instance,
    event,
    grupoId,
    grupoNome: extractEvolutionGroupName(payload),
    remetenteId,
    remetenteNome: cleanWebhookText(data.pushName || data.senderName || payload?.pushName, 180),
    fromMe: key.fromMe === true ? 1 : 0,
    messageTimestamp: timestamp || Math.floor(Date.now() / 1000),
    messageDatetime: unixTimestampToIso(timestamp),
    tipoMensagem: messageInfo.tipoMensagem,
    conteudo: messageInfo.conteudo,
    messageId,
    rawPayloadJson: JSON.stringify(payload).slice(0, WHATSAPP_WEBHOOK_RAW_MAX_BYTES),
    createdAt: new Date().toISOString(),
  };
}

async function ensureWhatsappGroupD1(env) {
  if (!env.REVIEWS_DB) return false;
  if (whatsappGroupD1SchemaReady) return true;

  await env.REVIEWS_DB.prepare(`
    CREATE TABLE IF NOT EXISTS whatsapp_group_attendances (
      id TEXT PRIMARY KEY,
      external_id TEXT NOT NULL UNIQUE,
      origin TEXT NOT NULL DEFAULT 'WHATSAPP_GRUPO',
      instance TEXT NOT NULL DEFAULT '',
      event TEXT NOT NULL DEFAULT '',
      grupo_id TEXT NOT NULL,
      grupo_nome TEXT NOT NULL DEFAULT '',
      cliente_id TEXT NOT NULL DEFAULT '',
      cliente_nome TEXT NOT NULL DEFAULT '',
      remetente_id TEXT NOT NULL DEFAULT '',
      remetente_nome TEXT NOT NULL DEFAULT '',
      from_me INTEGER NOT NULL DEFAULT 0,
      message_timestamp INTEGER NOT NULL DEFAULT 0,
      message_datetime TEXT NOT NULL DEFAULT '',
      tipo_mensagem TEXT NOT NULL DEFAULT '',
      conteudo TEXT NOT NULL DEFAULT '',
      message_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '',
      session_protocol TEXT NOT NULL DEFAULT '',
      session_status TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL DEFAULT '',
      agent_name TEXT NOT NULL DEFAULT '',
      raw_payload_json TEXT NOT NULL,
      processing_status TEXT NOT NULL DEFAULT 'ok',
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )
  `).run();
  await tryAddD1Column(env, 'whatsapp_group_attendances', "session_id TEXT NOT NULL DEFAULT ''");
  await tryAddD1Column(env, 'whatsapp_group_attendances', "session_protocol TEXT NOT NULL DEFAULT ''");
  await tryAddD1Column(env, 'whatsapp_group_attendances', "session_status TEXT NOT NULL DEFAULT ''");
  await tryAddD1Column(env, 'whatsapp_group_attendances', "cliente_id TEXT NOT NULL DEFAULT ''");
  await tryAddD1Column(env, 'whatsapp_group_attendances', "cliente_nome TEXT NOT NULL DEFAULT ''");
  await tryAddD1Column(env, 'whatsapp_group_attendances', "agent_id TEXT NOT NULL DEFAULT ''");
  await tryAddD1Column(env, 'whatsapp_group_attendances', "agent_name TEXT NOT NULL DEFAULT ''");
  await env.REVIEWS_DB.prepare(`
    CREATE TABLE IF NOT EXISTS whatsapp_group_sessions (
      id TEXT PRIMARY KEY,
      protocol TEXT NOT NULL UNIQUE,
      origin TEXT NOT NULL DEFAULT 'WHATSAPP_GRUPO',
      instance TEXT NOT NULL DEFAULT '',
      grupo_id TEXT NOT NULL,
      grupo_nome TEXT NOT NULL DEFAULT '',
      cliente_id TEXT NOT NULL DEFAULT '',
      cliente_nome TEXT NOT NULL DEFAULT '',
      remetente_id TEXT NOT NULL DEFAULT '',
      remetente_nome TEXT NOT NULL DEFAULT '',
      agente_id TEXT NOT NULL DEFAULT '',
      agente_nome TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'OPEN',
      started_at TEXT NOT NULL,
      first_message_at TEXT NOT NULL,
      first_response_at TEXT NOT NULL DEFAULT '',
      first_response_seconds INTEGER NOT NULL DEFAULT 0,
      last_message_at TEXT NOT NULL,
      closed_at TEXT NOT NULL DEFAULT '',
      closed_by TEXT NOT NULL DEFAULT '',
      close_reason TEXT NOT NULL DEFAULT '',
      titulo_atendimento TEXT NOT NULL DEFAULT '',
      resumo_atendimento TEXT NOT NULL DEFAULT '',
      observacoes_internas TEXT NOT NULL DEFAULT '',
      message_count INTEGER NOT NULL DEFAULT 0,
      participant_count INTEGER NOT NULL DEFAULT 0,
      from_me_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await tryAddD1Column(env, 'whatsapp_group_sessions', "cliente_id TEXT NOT NULL DEFAULT ''");
  await tryAddD1Column(env, 'whatsapp_group_sessions', "cliente_nome TEXT NOT NULL DEFAULT ''");
  await tryAddD1Column(env, 'whatsapp_group_sessions', "agente_id TEXT NOT NULL DEFAULT ''");
  await tryAddD1Column(env, 'whatsapp_group_sessions', "agente_nome TEXT NOT NULL DEFAULT ''");
  await tryAddD1Column(env, 'whatsapp_group_sessions', "titulo_atendimento TEXT NOT NULL DEFAULT ''");
  await tryAddD1Column(env, 'whatsapp_group_sessions', "resumo_atendimento TEXT NOT NULL DEFAULT ''");
  await tryAddD1Column(env, 'whatsapp_group_sessions', "observacoes_internas TEXT NOT NULL DEFAULT ''");
  await env.REVIEWS_DB.prepare(`
    CREATE TABLE IF NOT EXISTS whatsapp_instances (
      instance TEXT PRIMARY KEY,
      nome TEXT NOT NULL DEFAULT '',
      telefone TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await env.REVIEWS_DB.prepare(`
    CREATE TABLE IF NOT EXISTS whatsapp_groups (
      instance TEXT NOT NULL DEFAULT '',
      grupo_id TEXT NOT NULL,
      grupo_nome TEXT NOT NULL DEFAULT '',
      cliente_id TEXT NOT NULL DEFAULT '',
      cliente_nome TEXT NOT NULL DEFAULT '',
      agentes_json TEXT NOT NULL DEFAULT '[]',
      monitorado INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (instance, grupo_id)
    )
  `).run();
  await tryAddD1Column(env, 'whatsapp_groups', "cliente_id TEXT NOT NULL DEFAULT ''");
  await tryAddD1Column(env, 'whatsapp_groups', "cliente_nome TEXT NOT NULL DEFAULT ''");
  await tryAddD1Column(env, 'whatsapp_groups', "agentes_json TEXT NOT NULL DEFAULT '[]'");
  await env.REVIEWS_DB.prepare(`
    CREATE TABLE IF NOT EXISTS whatsapp_group_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await env.REVIEWS_DB.prepare(`
    CREATE TABLE IF NOT EXISTS whatsapp_webhook_failures (
      id TEXT PRIMARY KEY,
      instance TEXT NOT NULL DEFAULT '',
      event TEXT NOT NULL DEFAULT '',
      grupo_id TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL,
      raw_payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();
  await env.REVIEWS_DB.prepare(`
    CREATE TABLE IF NOT EXISTS whatsapp_group_media_cache (
      attendance_id TEXT PRIMARY KEY,
      mimetype TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL DEFAULT '',
      base64 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await env.REVIEWS_DB.prepare('CREATE INDEX IF NOT EXISTS idx_wg_att_created ON whatsapp_group_attendances(created_at DESC)').run();
  await env.REVIEWS_DB.prepare('CREATE INDEX IF NOT EXISTS idx_wg_att_group_created ON whatsapp_group_attendances(grupo_id, created_at DESC)').run();
  await env.REVIEWS_DB.prepare('CREATE INDEX IF NOT EXISTS idx_wg_att_origin_created ON whatsapp_group_attendances(origin, created_at DESC)').run();
  await env.REVIEWS_DB.prepare('CREATE INDEX IF NOT EXISTS idx_wg_att_session ON whatsapp_group_attendances(session_id)').run();
  await env.REVIEWS_DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_wg_att_message_unique ON whatsapp_group_attendances(instance, grupo_id, message_id) WHERE message_id <> ''").run();
  await env.REVIEWS_DB.prepare('CREATE INDEX IF NOT EXISTS idx_wg_sess_status_updated ON whatsapp_group_sessions(status, updated_at DESC)').run();
  await env.REVIEWS_DB.prepare('CREATE INDEX IF NOT EXISTS idx_wg_sess_group_updated ON whatsapp_group_sessions(instance, grupo_id, updated_at DESC)').run();
  await env.REVIEWS_DB.prepare('CREATE INDEX IF NOT EXISTS idx_wg_sess_sender_status ON whatsapp_group_sessions(instance, grupo_id, remetente_id, status)').run();
  await env.REVIEWS_DB.prepare('CREATE INDEX IF NOT EXISTS idx_wg_fail_created ON whatsapp_webhook_failures(created_at DESC)').run();
  await env.REVIEWS_DB.prepare('CREATE INDEX IF NOT EXISTS idx_wg_media_cache_updated ON whatsapp_group_media_cache(updated_at DESC)').run();
  await env.REVIEWS_DB.prepare(`
    INSERT OR IGNORE INTO whatsapp_group_settings (key, value, updated_at)
    VALUES (?, ?, ?)
  `).bind(WHATSAPP_GROUP_SETTINGS_KEY, WHATSAPP_GROUP_DEFAULT_MODE, new Date().toISOString()).run();

  whatsappGroupD1SchemaReady = true;
  return true;
}

async function whatsappGroupSettingMode(env) {
  await ensureWhatsappGroupD1(env);
  const row = await env.REVIEWS_DB.prepare('SELECT value FROM whatsapp_group_settings WHERE key = ?')
    .bind(WHATSAPP_GROUP_SETTINGS_KEY)
    .first();
  return whatsappGroupMode(row?.value);
}

async function saveWhatsappWebhookFailure(env, detail = {}) {
  if (!env.REVIEWS_DB) return;
  await ensureWhatsappGroupD1(env);
  await env.REVIEWS_DB.prepare(`
    INSERT INTO whatsapp_webhook_failures (
      id, instance, event, grupo_id, error_message, raw_payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    `WGF-${Date.now()}-${crypto.randomUUID()}`,
    cleanWebhookText(detail.instance, 120),
    cleanWebhookText(detail.event, 120),
    whatsappGroupIdForSql(detail.grupoId),
    cleanWebhookText(detail.error || detail.errorMessage || 'Erro desconhecido', 2000),
    cleanWebhookText(detail.rawPayloadJson || detail.raw || '', WHATSAPP_WEBHOOK_RAW_MAX_BYTES),
    new Date().toISOString(),
  ).run();
}

async function isWhatsappGroupMonitored(env, record) {
  const mode = await whatsappGroupSettingMode(env);
  if (mode !== WHATSAPP_GROUP_REGISTERED_MODE) return true;
  const row = await env.REVIEWS_DB.prepare(`
    SELECT monitorado FROM whatsapp_groups
    WHERE instance = ? AND grupo_id = ?
  `).bind(record.instance || '', record.grupoId).first();
  return Number(row?.monitorado || 0) === 1;
}

async function upsertWhatsappGroupFromRecord(env, record) {
  if (!record?.grupoId) return;
  const now = new Date().toISOString();
  await env.REVIEWS_DB.prepare(`
    INSERT INTO whatsapp_groups (instance, grupo_id, grupo_nome, cliente_id, cliente_nome, agentes_json, monitorado, created_at, updated_at)
    VALUES (?, ?, ?, '', '', '[]', 1, ?, ?)
    ON CONFLICT(instance, grupo_id) DO UPDATE SET
      grupo_nome = CASE
        WHEN excluded.grupo_nome <> '' THEN excluded.grupo_nome
        ELSE whatsapp_groups.grupo_nome
      END,
      updated_at = excluded.updated_at
  `).bind(record.instance || '', record.grupoId, record.grupoNome || '', now, now).run();
}

async function upsertWhatsappInstanceFromRecord(env, record) {
  const instance = cleanWebhookText(record?.instance, 120);
  if (!instance) return;
  const now = new Date().toISOString();
  await env.REVIEWS_DB.prepare(`
    INSERT INTO whatsapp_instances (instance, nome, telefone, status, created_at, updated_at)
    VALUES (?, ?, '', ?, ?, ?)
    ON CONFLICT(instance) DO UPDATE SET
      status = excluded.status,
      updated_at = excluded.updated_at
  `).bind(instance, instance, 'recebendo webhook', now, now).run();
}

async function fetchEvolutionGroupName(env, instance, groupJid) {
  const base = String(env.EVOLUTION_API_URL || '').trim().replace(/\/+$/, '');
  const apiKey = String(env.EVOLUTION_API_KEY || '').trim();
  if (!base || !apiKey || !instance || !groupJid) return '';

  const url = new URL(`${base}/group/findGroupInfos/${encodeURIComponent(instance)}`);
  url.searchParams.set('groupJid', groupJid);
  const response = await fetch(url.toString(), { headers: { apikey: apiKey } });
  if (!response.ok) throw new Error(`Evolution group info HTTP ${response.status}`);
  const data = await response.json();
  return cleanWebhookText(data?.group?.subject || data?.subject || data?.name, 180);
}

async function enrichWhatsappGroupName(env, record) {
  if (!record?.id || record.grupoNome) return;
  const groupName = await fetchEvolutionGroupName(env, record.instance, record.grupoId).catch((error) => {
    console.error('Erro ao buscar nome do grupo na Evolution:', error);
    return '';
  });
  if (!groupName) return;
  await env.REVIEWS_DB.prepare(`
    UPDATE whatsapp_group_attendances
    SET grupo_nome = ?
    WHERE id = ? AND grupo_nome = ''
  `).bind(groupName, record.id).run();
  await upsertWhatsappGroupFromRecord(env, { ...record, grupoNome: groupName });
}

function normalizeWhatsappCommandText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function whatsappGroupCommand(record) {
  if (record?.tipoMensagem !== 'text') return '';
  const text = normalizeWhatsappCommandText(record.conteudo);
  if (!text) return '';
  if (/^(#|\/)?(fim|finalizar|encerrar)(\s+atendimento)?(\s|$)/.test(text)) return 'close';
  if (/^(#|\/)?(inicio|iniciar|abrir)(\s+atendimento)?(\s|$)/.test(text)) return 'start';
  if (/^(#|\/)?(assumir|assumi|atender|peguei)(\s+atendimento)?(\s|$)/.test(text)) return 'assign';
  return '';
}

function normalizeWhatsappName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s._@-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function whatsappMetricText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function whatsappIsExcludedMetricGroup(row = {}) {
  const text = [
    row.grupo_nome,
    row.grupoNome,
    row.grupo_id,
    row.grupoId,
    row.cliente_nome,
    row.clienteNome,
  ].map(whatsappMetricText).join(' ');
  return text.includes('teste integracao');
}

function whatsappNameMatches(name, candidate) {
  const a = normalizeWhatsappName(name);
  const b = normalizeWhatsappName(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  return false;
}

function parseWhatsappAgentNames(value) {
  const cleanAgentName = (item) => {
    if (item && typeof item === 'object') return String(item.nome || item.name || item.label || '').trim();
    return String(item || '').trim().replace(/^[\s"'[\]]+|[\s"'[\]]+$/g, '').trim();
  };
  if (Array.isArray(value)) return value.map(cleanAgentName).filter(Boolean).slice(0, 80);
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed.map(cleanAgentName).filter(Boolean).slice(0, 80);
  } catch {}
  return String(value)
    .split(/[,;\n]/)
    .map(cleanAgentName)
    .filter(Boolean)
    .slice(0, 80);
}

function parseWhatsappAgents(value) {
  const cleanPhone = (phone) => String(phone || '').replace(/\D/g, '').slice(0, 32);
  const cleanName = (name) => String(name || '').trim().replace(/^[\s"'[\]]+|[\s"'[\]]+$/g, '').trim().slice(0, 160);
  const parseOne = (item) => {
    if (item && typeof item === 'object') {
      const nome = cleanName(item.nome || item.name || item.label);
      const telefone = cleanPhone(item.telefone || item.phone || item.celular || item.mobile || item.id || item.jid);
      return nome ? { nome, telefone } : null;
    }
    const raw = String(item || '').trim().replace(/^[\s"'[\]]+|[\s"'[\]]+$/g, '').trim();
    if (!raw) return null;
    const match = raw.match(/^(.*?)(?:\s*(?:=|\||:)\s*)([\d\s()+.-]{8,}(?:@\w+(?:\.\w+)*)?)$/);
    const nome = cleanName(match ? match[1] : raw);
    const telefone = cleanPhone(match ? match[2] : '');
    return nome ? { nome, telefone } : null;
  };
  let list = [];
  if (Array.isArray(value)) list = value;
  else if (value) {
    try {
      const parsed = JSON.parse(String(value));
      list = Array.isArray(parsed) ? parsed : [];
    } catch {
      list = String(value).split(/[,;\n]/);
    }
  }
  const seen = new Set();
  return list.map(parseOne).filter(Boolean).filter((agent) => {
    const key = `${agent.nome.toLowerCase()}|${agent.telefone}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 80);
}

function whatsappMergedAgents(value) {
  const seen = new Set();
  return [...WHATSAPP_DEFAULT_AGENTS, ...parseWhatsappAgents(value)].filter((agent) => {
    const key = agent.telefone ? `phone:${agent.telefone}` : `name:${normalizeWhatsappName(agent.nome)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 120);
}

async function whatsappGroupMeta(env, record) {
  const row = await env.REVIEWS_DB.prepare(`
    SELECT grupo_nome, cliente_id, cliente_nome, agentes_json
    FROM whatsapp_groups
    WHERE instance = ? AND grupo_id = ?
  `).bind(record.instance || '', record.grupoId).first();
  return {
    grupoNome: cleanWebhookText(row?.grupo_nome, 180),
    clienteId: cleanWebhookText(row?.cliente_id, 120),
    clienteNome: cleanWebhookText(row?.cliente_nome, 180),
    agentNames: whatsappMergedAgents(row?.agentes_json).map((agent) => agent.nome),
    agents: whatsappMergedAgents(row?.agentes_json),
  };
}

async function whatsappInstancePhone(env, instance) {
  const name = cleanWebhookText(instance || '', 120);
  if (!name) return '';
  const row = await env.REVIEWS_DB.prepare('SELECT telefone FROM whatsapp_instances WHERE instance = ? LIMIT 1')
    .bind(name)
    .first()
    .catch(() => null);
  return String(row?.telefone || '').replace(/\D/g, '');
}

async function whatsappKnownAgentNames(env, meta) {
  const users = [
    ...parseAppUsers(env).flatMap((item) => [item.name, item.user]),
    ...(await loadManagedUsers(env)).flatMap((item) => [item.name, item.user]),
    ...parseWhatsappAgentNames(env.WHATSAPP_GROUP_AGENT_NAMES),
    ...WHATSAPP_DEFAULT_AGENTS.map((agent) => agent.nome),
    ...(meta?.agentNames || []),
  ];
  return [...new Set(users.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 300);
}

async function whatsappActorInfo(env, record, meta, command) {
  const name = record.remetenteNome || record.remetenteId || '';
  const senderPhone = String(record.remetenteId || '').replace(/\D/g, '');
  const phoneMatched = (meta?.agents || []).find((agent) => (
    agent.telefone &&
    senderPhone.length >= Math.min(agent.telefone.length, 10) &&
    senderPhone.endsWith(agent.telefone)
  ));
  if (record.fromMe) {
    const instancePhone = await whatsappInstancePhone(env, record.instance);
    const instanceMatched = (meta?.agents || []).find((agent) => (
      agent.telefone &&
      instancePhone.length >= Math.min(agent.telefone.length, 10) &&
      instancePhone.endsWith(agent.telefone)
    ));
    return {
      isAgent: true,
      agentName: phoneMatched?.nome || instanceMatched?.nome || name || 'Número conectado',
      agentId: phoneMatched ? (record.remetenteId || phoneMatched.telefone || '') : (instanceMatched?.telefone || record.remetenteId || ''),
    };
  }
  if (command === 'assign') {
    return { isAgent: true, agentName: name || record.remetenteId || 'Agente', agentId: record.remetenteId || '' };
  }
  if (phoneMatched) {
    return { isAgent: true, agentName: phoneMatched.nome || name, agentId: record.remetenteId || phoneMatched.telefone || '' };
  }
  const known = await whatsappKnownAgentNames(env, meta);
  const matched = known.find((candidate) => {
    const normalized = normalizeWhatsappName(candidate);
    if (normalized.split(' ').filter(Boolean).length < 2) return false;
    return whatsappNameMatches(name, candidate);
  });
  return {
    isAgent: !!matched,
    agentName: matched || name,
    agentId: matched ? (record.remetenteId || '') : '',
  };
}

function whatsappSessionProtocol() {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 14);
  return `WG-${stamp}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
}

function secondsBetweenIso(start, end) {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 1000);
}

function whatsappBusinessParts(value) {
  const date = value instanceof Date ? value : new Date(value || '');
  if (!Number.isFinite(date.getTime())) return null;
  const br = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  return {
    year: br.getUTCFullYear(),
    month: br.getUTCMonth(),
    day: br.getUTCDate(),
    dow: br.getUTCDay(),
    hour: br.getUTCHours(),
  };
}

function whatsappBusinessBoundaryUtc(parts, hour) {
  return Date.UTC(parts.year, parts.month, parts.day, hour, 0, 0, 0) + 3 * 60 * 60 * 1000;
}

function whatsappBusinessOpen(value) {
  const parts = whatsappBusinessParts(value);
  return Boolean(parts && parts.dow >= 1 && parts.dow <= 5 && parts.hour >= 8 && parts.hour < 18);
}

function whatsappBusinessSecondsBetween(startValue, endValue) {
  let start = new Date(startValue || '').getTime();
  const end = new Date(endValue || '').getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  let total = 0;
  let guard = 0;
  while (start < end && guard < 45) {
    guard += 1;
    const parts = whatsappBusinessParts(new Date(start));
    if (!parts) break;
    const dayStart = whatsappBusinessBoundaryUtc(parts, 8);
    const dayEnd = whatsappBusinessBoundaryUtc(parts, 18);
    if (parts.dow >= 1 && parts.dow <= 5) {
      const from = Math.max(start, dayStart);
      const to = Math.min(end, dayEnd);
      if (to > from) total += to - from;
    }
    start = Date.UTC(parts.year, parts.month, parts.day + 1, 8, 0, 0, 0) + 3 * 60 * 60 * 1000;
  }
  return Math.round(total / 1000);
}

function whatsappSessionCountsAsOpen(row = {}) {
  const status = String(row.status || '').toUpperCase();
  if (![WHATSAPP_SESSION_OPEN, WHATSAPP_SESSION_UNANSWERED, 'UNANSWERED', 'PENDING'].includes(status)) return false;
  if (row.first_response_at) return false;
  if (whatsappIsExcludedMetricGroup(row)) return false;
  const first = row.first_message_at || row.started_at || row.created_at || '';
  return !first || whatsappBusinessOpen(first);
}

function whatsappMessageTime(row = {}) {
  return row.message_datetime || row.created_at || row.first_message_at || row.started_at || '';
}

function whatsappIsAgentAttendance(row = {}) {
  return Number(row.from_me || 0) === 1 || !!String(row.agent_name || '').trim();
}

async function recalculateWhatsappSessionTiming(env, sessionId) {
  const id = cleanWebhookText(sessionId, 160);
  if (!id || !env.REVIEWS_DB) return null;
  await ensureWhatsappGroupD1(env);
  const session = await env.REVIEWS_DB.prepare('SELECT * FROM whatsapp_group_sessions WHERE id = ? LIMIT 1')
    .bind(id)
    .first();
  if (!session) return null;
  const result = await env.REVIEWS_DB.prepare(`
    SELECT message_datetime, created_at, from_me, agent_name
    FROM whatsapp_group_attendances
    WHERE session_id = ?
    ORDER BY message_datetime ASC, created_at ASC
  `).bind(id).all();
  const rows = (Array.isArray(result?.results) ? result.results : [])
    .map((row) => ({ ...row, at: whatsappMessageTime(row) }))
    .filter((row) => row.at);
  if (!rows.length) return session;

  const firstAny = rows[0];
  const firstParticipant = rows.find((row) => !whatsappIsAgentAttendance(row)) || null;
  const firstMessageAt = (firstParticipant || firstAny).at;
  const firstResponse = firstParticipant
    ? rows.find((row) => whatsappIsAgentAttendance(row) && String(row.at) >= String(firstParticipant.at))
    : rows.find((row) => whatsappIsAgentAttendance(row)) || null;
  const firstResponseAt = firstResponse ? firstResponse.at : '';
  const firstResponseSeconds = firstResponseAt
    ? (whatsappBusinessSecondsBetween(firstMessageAt, firstResponseAt) || secondsBetweenIso(firstMessageAt, firstResponseAt))
    : 0;
  const participantCount = rows.filter((row) => !whatsappIsAgentAttendance(row)).length;
  const fromMeCount = rows.filter((row) => Number(row.from_me || 0) === 1).length;
  const nextStatus = String(session.status || '').toUpperCase() === WHATSAPP_SESSION_CLOSED
    ? WHATSAPP_SESSION_CLOSED
    : firstResponseAt ? WHATSAPP_SESSION_IN_PROGRESS : WHATSAPP_SESSION_UNANSWERED;
  const now = new Date().toISOString();

  await env.REVIEWS_DB.prepare(`
    UPDATE whatsapp_group_sessions
    SET
      status = ?,
      started_at = ?,
      first_message_at = ?,
      first_response_at = ?,
      first_response_seconds = ?,
      last_message_at = ?,
      message_count = ?,
      participant_count = ?,
      from_me_count = ?,
      updated_at = ?
    WHERE id = ?
  `).bind(
    nextStatus,
    firstMessageAt,
    firstMessageAt,
    firstResponseAt,
    firstResponseSeconds,
    rows[rows.length - 1].at,
    rows.length,
    participantCount,
    fromMeCount,
    now,
    id,
  ).run();
  await env.REVIEWS_DB.prepare(`
    UPDATE whatsapp_group_attendances
    SET session_status = ?
    WHERE session_id = ?
  `).bind(nextStatus, id).run();
  return env.REVIEWS_DB.prepare('SELECT * FROM whatsapp_group_sessions WHERE id = ? LIMIT 1')
    .bind(id)
    .first();
}

async function recalculateRecentWhatsappSessions(env, limit = 200) {
  if (!env.REVIEWS_DB) return 0;
  await ensureWhatsappGroupD1(env);
  const result = await env.REVIEWS_DB.prepare(`
    SELECT id
    FROM whatsapp_group_sessions
    ORDER BY updated_at DESC
    LIMIT ?
  `).bind(Math.max(1, Math.min(Number(limit || 200), 500))).all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  let count = 0;
  for (const row of rows) {
    if (!row?.id) continue;
    const updated = await recalculateWhatsappSessionTiming(env, row.id).catch(() => null);
    if (updated) count += 1;
  }
  return count;
}

function openSessionStatuses() {
  return [
    WHATSAPP_SESSION_OPEN,
    WHATSAPP_SESSION_UNANSWERED,
    WHATSAPP_SESSION_IN_PROGRESS,
    WHATSAPP_SESSION_ANSWERED,
    WHATSAPP_SESSION_RESPONDED,
  ];
}

async function latestWhatsappGroupSession(env, record) {
  const statuses = openSessionStatuses();
  const placeholders = statuses.map(() => '?').join(', ');
  const result = await env.REVIEWS_DB.prepare(`
    SELECT * FROM whatsapp_group_sessions
    WHERE instance = ? AND grupo_id = ? AND status IN (${placeholders})
    ORDER BY last_message_at DESC, updated_at DESC
    LIMIT 1
  `).bind(record.instance || '', record.grupoId, ...statuses).first();
  return result || null;
}

async function latestWhatsappParticipantSession(env, record) {
  const statuses = openSessionStatuses();
  const placeholders = statuses.map(() => '?').join(', ');
  const result = await env.REVIEWS_DB.prepare(`
    SELECT * FROM whatsapp_group_sessions
    WHERE instance = ? AND grupo_id = ? AND remetente_id = ? AND status IN (${placeholders})
    ORDER BY last_message_at DESC, updated_at DESC
    LIMIT 1
  `).bind(record.instance || '', record.grupoId, record.remetenteId || '', ...statuses).first();
  return result || null;
}

function whatsappSameParticipant(left = {}, right = {}) {
  const a = String(left.remetente_id || left.remetenteId || '').trim();
  const b = String(right.remetente_id || right.remetenteId || '').trim();
  if (a && b && a === b) return true;
  const an = normalizeWhatsappName(left.remetente_nome || left.remetenteNome || '');
  const bn = normalizeWhatsappName(right.remetente_nome || right.remetenteNome || '');
  return Boolean(an && bn && an === bn);
}

function whatsappSessionDateKey(value) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function whatsappSessionWindowMatches(session, record) {
  if (!session?.id) return false;
  const messageAt = record.messageDatetime || '';
  const messageTime = new Date(messageAt).getTime();
  if (!Number.isFinite(messageTime)) return true;
  const firstAt = session.first_message_at || session.started_at || session.created_at || '';
  const lastAt = session.last_message_at || session.updated_at || firstAt;
  const firstTime = new Date(firstAt).getTime();
  const lastTime = new Date(lastAt).getTime();
  const messageDay = whatsappSessionDateKey(messageAt);
  const sessionDay = whatsappSessionDateKey(firstAt || lastAt);
  const businessContinuation = whatsappSameParticipantBusinessContinuation(session, record);
  if (messageDay && sessionDay && messageDay !== sessionDay && !businessContinuation) return false;
  if (Number.isFinite(firstTime) && messageTime < firstTime - WHATSAPP_SESSION_BACKFILL_GRACE_MS) return false;
  if (Number.isFinite(lastTime) && messageTime > lastTime + WHATSAPP_SESSION_MAX_IDLE_MS && !businessContinuation) return false;
  return true;
}

function whatsappSameParticipantBusinessContinuation(left = {}, right = {}) {
  if (!whatsappSameParticipant(left, right)) return false;
  const leftAt = left.last_message_at || left.messageDatetime || left.message_datetime || left.updated_at || left.first_message_at || left.started_at || left.created_at || '';
  const rightAt = right.messageDatetime || right.message_datetime || right.last_message_at || right.updated_at || right.first_message_at || right.started_at || right.created_at || '';
  const leftTime = new Date(leftAt).getTime();
  const rightTime = new Date(rightAt).getTime();
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return false;
  const start = leftTime <= rightTime ? leftAt : rightAt;
  const end = leftTime <= rightTime ? rightAt : leftAt;
  const calendarGap = Math.abs(rightTime - leftTime);
  if (calendarGap <= WHATSAPP_SESSION_MAX_IDLE_MS) return true;
  const businessGap = whatsappBusinessSecondsBetween(start, end);
  return businessGap >= 0 && businessGap <= Math.round(WHATSAPP_SESSION_MAX_IDLE_MS / 1000);
}

function whatsappSessionSameParticipantDayMatches(session, record) {
  if (!session?.id || !record?.grupoId) return false;
  if (String(session.instance || '') !== String(record.instance || '')) return false;
  if (String(session.grupo_id || '') !== String(record.grupoId || '')) return false;
  if (!whatsappSameParticipant(session, record)) return false;
  const messageAt = record.messageDatetime || '';
  const firstAt = session.first_message_at || session.started_at || session.created_at || '';
  const lastAt = session.last_message_at || session.updated_at || firstAt;
  const messageDay = whatsappSessionDateKey(messageAt);
  const sessionDay = whatsappSessionDateKey(firstAt || lastAt);
  if (messageDay && sessionDay && messageDay !== sessionDay && !whatsappSameParticipantBusinessContinuation(session, record)) return false;
  const messageTime = new Date(messageAt).getTime();
  const firstTime = new Date(firstAt).getTime();
  if (Number.isFinite(messageTime) && Number.isFinite(firstTime) && messageTime < firstTime - WHATSAPP_SESSION_BACKFILL_GRACE_MS) return false;
  return true;
}

async function whatsappGroupSessionForRecord(env, record) {
  if (!record.agentId && !record.fromMe) {
    const participantSession = await latestWhatsappParticipantSession(env, record);
    if (whatsappSessionSameParticipantDayMatches(participantSession, record)) return participantSession;
  }
  const session = await latestWhatsappGroupSession(env, record);
  return whatsappSessionWindowMatches(session, record) ? session : null;
}

function whatsappSessionsShareWindow(left, right) {
  if (!left?.id || !right?.id) return false;
  const leftFirst = left.first_message_at || left.started_at || left.created_at || '';
  const rightFirst = right.first_message_at || right.started_at || right.created_at || '';
  const leftLast = left.last_message_at || left.updated_at || leftFirst;
  const rightLast = right.last_message_at || right.updated_at || rightFirst;
  const leftDay = whatsappSessionDateKey(leftFirst || leftLast);
  const rightDay = whatsappSessionDateKey(rightFirst || rightLast);
  if (leftDay && rightDay && leftDay !== rightDay) return false;
  const leftLastTime = new Date(leftLast).getTime();
  const rightFirstTime = new Date(rightFirst).getTime();
  const rightLastTime = new Date(rightLast).getTime();
  const leftFirstTime = new Date(leftFirst).getTime();
  if (Number.isFinite(leftLastTime) && Number.isFinite(rightFirstTime) && Math.abs(rightFirstTime - leftLastTime) <= WHATSAPP_SESSION_MAX_IDLE_MS) return true;
  if (Number.isFinite(rightLastTime) && Number.isFinite(leftFirstTime) && Math.abs(leftFirstTime - rightLastTime) <= WHATSAPP_SESSION_MAX_IDLE_MS) return true;
  return false;
}

function whatsappSessionsShareParticipantDay(left, right) {
  if (!left?.id || !right?.id) return false;
  if (String(left.instance || '') !== String(right.instance || '')) return false;
  if (String(left.grupo_id || '') !== String(right.grupo_id || '')) return false;
  if (!whatsappSameParticipant(left, right)) return false;
  const leftFirst = left.first_message_at || left.started_at || left.created_at || '';
  const rightFirst = right.first_message_at || right.started_at || right.created_at || '';
  const leftLast = left.last_message_at || left.updated_at || leftFirst;
  const rightLast = right.last_message_at || right.updated_at || rightFirst;
  const leftDay = whatsappSessionDateKey(leftFirst || leftLast);
  const rightDay = whatsappSessionDateKey(rightFirst || rightLast);
  if (leftDay && rightDay && leftDay === rightDay) return true;
  return whatsappSameParticipantBusinessContinuation(left, right);
}

function whatsappDuplicateSessionClusters(rows) {
  const sorted = rows.slice().sort((a, b) => String(a.first_message_at || a.started_at || a.created_at || '').localeCompare(String(b.first_message_at || b.started_at || b.created_at || '')));
  const clusters = [];
  for (const row of sorted) {
    const cluster = clusters.find((group) => group.some((item) => whatsappSessionsShareParticipantDay(row, item) || whatsappSessionsShareWindow(row, item)));
    if (cluster) cluster.push(row);
    else clusters.push([row]);
  }
  return clusters;
}

function chooseWhatsappSessionMergeTarget(rows, preferredId = '') {
  const preferred = rows.find((row) => row.id === preferredId);
  if (preferred && (preferred.first_response_at || String(preferred.status || '').toUpperCase() === WHATSAPP_SESSION_IN_PROGRESS)) return preferred;
  return rows.find((row) => row.first_response_at || String(row.status || '').toUpperCase() === WHATSAPP_SESSION_IN_PROGRESS)
    || preferred
    || rows[0]
    || null;
}

async function mergeWhatsappGroupSessionDuplicates(env, record, preferredId = '') {
  if (!env.REVIEWS_DB || !record?.grupoId) return null;
  const statuses = openSessionStatuses();
  const placeholders = statuses.map(() => '?').join(', ');
  const result = await env.REVIEWS_DB.prepare(`
    SELECT *
    FROM whatsapp_group_sessions
    WHERE instance = ? AND grupo_id = ? AND status IN (${placeholders})
    ORDER BY first_message_at ASC, started_at ASC, created_at ASC
    LIMIT 30
  `).bind(record.instance || '', record.grupoId, ...statuses).all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const base = rows.find((row) => row.id === preferredId) || rows.find((row) => whatsappSessionWindowMatches(row, record));
  if (!base) return null;
  const group = rows.filter((row) => row.id === base.id || whatsappSessionsShareParticipantDay(row, base) || whatsappSessionsShareWindow(row, base));
  if (group.length < 2) return base;
  const target = chooseWhatsappSessionMergeTarget(group, preferredId);
  if (!target?.id) return base;
  const duplicates = group.filter((row) => row.id !== target.id);
  for (const duplicate of duplicates) {
    await env.REVIEWS_DB.prepare(`
      UPDATE whatsapp_group_attendances
      SET session_id = ?, session_protocol = ?, session_status = ?
      WHERE session_id = ?
    `).bind(target.id, target.protocol || '', target.status || WHATSAPP_SESSION_UNANSWERED, duplicate.id).run();
    await env.REVIEWS_DB.prepare('DELETE FROM whatsapp_group_sessions WHERE id = ?').bind(duplicate.id).run();
  }
  return recalculateWhatsappSessionTiming(env, target.id);
}

async function mergeRecentWhatsappGroupSessionDuplicates(env, limit = 250) {
  if (!env.REVIEWS_DB) return 0;
  await ensureWhatsappGroupD1(env);
  const statuses = openSessionStatuses();
  const placeholders = statuses.map(() => '?').join(', ');
  const result = await env.REVIEWS_DB.prepare(`
    SELECT *
    FROM whatsapp_group_sessions
    WHERE status IN (${placeholders})
    ORDER BY updated_at DESC, last_message_at DESC
    LIMIT ?
  `).bind(...statuses, Math.max(1, Math.min(Number(limit || 250), 500))).all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const buckets = new Map();
  for (const row of rows) {
    const participant = String(row.remetente_id || '').trim() || normalizeWhatsappName(row.remetente_nome || '');
    if (!participant) continue;
    const key = [row.instance || '', row.grupo_id || '', participant].join('|');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  let merged = 0;
  for (const bucket of buckets.values()) {
    for (const group of whatsappDuplicateSessionClusters(bucket)) {
      if (group.length < 2) continue;
      const target = chooseWhatsappSessionMergeTarget(
        group.sort((a, b) => String(a.first_message_at || a.started_at || a.created_at || '').localeCompare(String(b.first_message_at || b.started_at || b.created_at || ''))),
      );
      if (!target?.id) continue;
      for (const duplicate of group) {
        if (duplicate.id === target.id) continue;
        await env.REVIEWS_DB.prepare(`
          UPDATE whatsapp_group_attendances
          SET session_id = ?, session_protocol = ?, session_status = ?
          WHERE session_id = ?
        `).bind(target.id, target.protocol || '', target.status || WHATSAPP_SESSION_UNANSWERED, duplicate.id).run();
        await env.REVIEWS_DB.prepare('DELETE FROM whatsapp_group_sessions WHERE id = ?').bind(duplicate.id).run();
        merged += 1;
      }
      await recalculateWhatsappSessionTiming(env, target.id).catch(() => null);
    }
  }
  return merged;
}

async function createWhatsappGroupSession(env, record, actor, status = WHATSAPP_SESSION_UNANSWERED) {
  const now = new Date().toISOString();
  const id = `WGS-${Date.now()}-${crypto.randomUUID()}`;
  const protocol = whatsappSessionProtocol();
  await env.REVIEWS_DB.prepare(`
    INSERT INTO whatsapp_group_sessions (
      id, protocol, origin, instance, grupo_id, grupo_nome, cliente_id, cliente_nome,
      remetente_id, remetente_nome, agente_id, agente_nome,
      status, started_at, first_message_at, first_response_at, first_response_seconds,
      last_message_at, closed_at, closed_by, close_reason, message_count,
      participant_count, from_me_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', 1, ?, ?, ?, ?)
  `).bind(
    id,
    protocol,
    WHATSAPP_GROUP_ORIGIN,
    record.instance || '',
    record.grupoId,
    record.grupoNome || '',
    record.clienteId || '',
    record.clienteNome || '',
    record.remetenteId || '',
    record.remetenteNome || '',
    actor?.isAgent ? (actor.agentId || record.remetenteId || '') : '',
    actor?.isAgent ? (actor.agentName || record.remetenteNome || '') : '',
    status,
    record.messageDatetime || now,
    record.messageDatetime || now,
    actor?.isAgent ? (record.messageDatetime || now) : '',
    actor?.isAgent ? 0 : 0,
    record.messageDatetime || now,
    actor?.isAgent ? 0 : 1,
    record.fromMe ? 1 : 0,
    now,
    now,
  ).run();
  return {
    id,
    protocol,
    status,
    first_message_at: record.messageDatetime || now,
    agente_id: actor?.isAgent ? (actor.agentId || record.remetenteId || '') : '',
    agente_nome: actor?.isAgent ? (actor.agentName || record.remetenteNome || '') : '',
  };
}

async function touchWhatsappGroupSession(env, session, record, actor = {}) {
  if (!session?.id) return null;
  const now = new Date().toISOString();
  const messageAt = record.messageDatetime || now;
  const incomingTime = new Date(messageAt).getTime();
  const currentLastTime = new Date(session.last_message_at || session.updated_at || session.started_at || '').getTime();
  const isOlderThanLast = Number.isFinite(incomingTime) && Number.isFinite(currentLastTime) && incomingTime < currentLastTime;
  const hasFirstResponse = !!session.first_response_at;
  const agentMessage = actor?.isAgent || record.fromMe;
  const firstResponseAt = agentMessage && !hasFirstResponse ? messageAt : (session.first_response_at || '');
  const nextStatus = isOlderThanLast ? (session.status || WHATSAPP_SESSION_UNANSWERED) : (agentMessage ? WHATSAPP_SESSION_IN_PROGRESS : WHATSAPP_SESSION_UNANSWERED);
  const nextLastMessageAt = isOlderThanLast ? (session.last_message_at || messageAt) : messageAt;
  const firstResponseStartAt = session.first_message_at || session.started_at || messageAt;
  const firstResponseSeconds = agentMessage && !hasFirstResponse
    ? (whatsappBusinessSecondsBetween(firstResponseStartAt, messageAt) || secondsBetweenIso(firstResponseStartAt, messageAt))
    : Number(session.first_response_seconds || 0);
  const agentName = actor?.isAgent ? (actor.agentName || record.remetenteNome || '') : '';
  const agentId = actor?.isAgent ? (actor.agentId || record.remetenteId || '') : '';
  await env.REVIEWS_DB.prepare(`
    UPDATE whatsapp_group_sessions
    SET
      grupo_nome = CASE WHEN ? <> '' THEN ? ELSE grupo_nome END,
      cliente_id = CASE WHEN ? <> '' THEN ? ELSE cliente_id END,
      cliente_nome = CASE WHEN ? <> '' THEN ? ELSE cliente_nome END,
      remetente_nome = CASE WHEN remetente_nome = '' AND ? <> '' THEN ? ELSE remetente_nome END,
      agente_id = CASE WHEN ? <> '' THEN ? ELSE agente_id END,
      agente_nome = CASE WHEN ? <> '' THEN ? ELSE agente_nome END,
      status = ?,
      first_response_at = ?,
      first_response_seconds = ?,
      last_message_at = ?,
      message_count = message_count + 1,
      participant_count = participant_count + ?,
      from_me_count = from_me_count + ?,
      updated_at = ?
    WHERE id = ?
  `).bind(
    record.grupoNome || '',
    record.grupoNome || '',
    record.clienteId || '',
    record.clienteId || '',
    record.clienteNome || '',
    record.clienteNome || '',
    record.remetenteNome || '',
    record.remetenteNome || '',
    agentId,
    agentId,
    agentName,
    agentName,
    nextStatus,
    firstResponseAt,
    firstResponseSeconds,
    nextLastMessageAt,
    agentMessage ? 0 : 1,
    record.fromMe ? 1 : 0,
    now,
    session.id,
  ).run();
  return {
    ...session,
    status: nextStatus,
    first_response_at: firstResponseAt,
    first_response_seconds: firstResponseSeconds,
    last_message_at: nextLastMessageAt,
    agente_id: agentId || session.agente_id || '',
    agente_nome: agentName || session.agente_nome || '',
  };
}

async function closeWhatsappGroupSession(env, session, record, actor = {}, reason = 'Comando recebido no WhatsApp') {
  if (!session?.id) return null;
  const now = new Date().toISOString();
  const closedAt = record.messageDatetime || now;
  const agentMessage = actor?.isAgent || record.fromMe;
  await env.REVIEWS_DB.prepare(`
    UPDATE whatsapp_group_sessions
    SET
      status = ?,
      last_message_at = ?,
      closed_at = ?,
      closed_by = ?,
      close_reason = ?,
      agente_id = CASE WHEN ? <> '' THEN ? ELSE agente_id END,
      agente_nome = CASE WHEN ? <> '' THEN ? ELSE agente_nome END,
      message_count = message_count + 1,
      from_me_count = from_me_count + ?,
      participant_count = participant_count + ?,
      updated_at = ?
    WHERE id = ?
  `).bind(
    WHATSAPP_SESSION_CLOSED,
    closedAt,
    closedAt,
    actor?.agentName || record.remetenteNome || record.remetenteId || 'WhatsApp',
    reason,
    actor?.agentId || record.remetenteId || '',
    actor?.agentId || record.remetenteId || '',
    actor?.agentName || record.remetenteNome || '',
    actor?.agentName || record.remetenteNome || '',
    record.fromMe ? 1 : 0,
    agentMessage ? 0 : 1,
    now,
    session.id,
  ).run();
  return {
    ...session,
    status: WHATSAPP_SESSION_CLOSED,
    closed_at: closedAt,
    close_reason: reason,
    agente_id: actor?.agentId || session.agente_id || '',
    agente_nome: actor?.agentName || session.agente_nome || '',
  };
}

async function closeWhatsappGroupSessionFromPanel(env, sessionId, profile = {}, reason = 'Encerrado pelo painel') {
  const id = cleanWebhookText(sessionId, 120);
  if (!id) return { error: 'Informe o atendimento.' };
  const session = await env.REVIEWS_DB.prepare('SELECT * FROM whatsapp_group_sessions WHERE id = ? LIMIT 1')
    .bind(id)
    .first();
  if (!session) return { error: 'Atendimento nao encontrado.', status: 404 };
  if (String(session.status || '').toUpperCase() === WHATSAPP_SESSION_CLOSED) {
    return { session, alreadyClosed: true };
  }

  const now = new Date().toISOString();
  const closedBy = String(profile.name || profile.user || 'Painel').slice(0, 160);
  const agentId = String(profile.user || '').slice(0, 160);
  const agentName = String(profile.name || profile.user || '').slice(0, 160);
  const closeReason = cleanWebhookText(reason, 240) || 'Encerrado pelo painel';
  await env.REVIEWS_DB.prepare(`
    UPDATE whatsapp_group_sessions
    SET
      status = ?,
      closed_at = ?,
      closed_by = ?,
      close_reason = ?,
      agente_id = CASE WHEN agente_id = '' AND ? <> '' THEN ? ELSE agente_id END,
      agente_nome = CASE WHEN agente_nome = '' AND ? <> '' THEN ? ELSE agente_nome END,
      updated_at = ?
    WHERE id = ?
  `).bind(
    WHATSAPP_SESSION_CLOSED,
    now,
    closedBy,
    closeReason,
    agentId,
    agentId,
    agentName,
    agentName,
    now,
    id,
  ).run();
  await env.REVIEWS_DB.prepare(`
    UPDATE whatsapp_group_attendances
    SET session_status = ?
    WHERE session_id = ?
  `).bind(WHATSAPP_SESSION_CLOSED, id).run();
  const updated = await env.REVIEWS_DB.prepare('SELECT * FROM whatsapp_group_sessions WHERE id = ? LIMIT 1')
    .bind(id)
    .first();
  return { session: updated || { ...session, status: WHATSAPP_SESSION_CLOSED, closed_at: now, closed_by: closedBy, close_reason: closeReason } };
}

async function assignWhatsappGroupSessionFromPanel(env, sessionId, profile = {}) {
  const id = cleanWebhookText(sessionId, 120);
  if (!id) return { error: 'Informe o atendimento.' };
  const session = await env.REVIEWS_DB.prepare('SELECT * FROM whatsapp_group_sessions WHERE id = ? LIMIT 1')
    .bind(id)
    .first();
  if (!session) return { error: 'Atendimento nao encontrado.', status: 404 };
  if (String(session.status || '').toUpperCase() === WHATSAPP_SESSION_CLOSED) {
    return { error: 'Atendimento ja encerrado.', status: 409 };
  }
  const now = new Date().toISOString();
  const agentId = String(profile.user || '').slice(0, 160);
  const agentName = String(profile.name || profile.user || 'Agente').slice(0, 160);
  await env.REVIEWS_DB.prepare(`
    UPDATE whatsapp_group_sessions
    SET
      status = ?,
      agente_id = ?,
      agente_nome = ?,
      updated_at = ?
    WHERE id = ?
  `).bind(WHATSAPP_SESSION_IN_PROGRESS, agentId, agentName, now, id).run();
  await env.REVIEWS_DB.prepare(`
    UPDATE whatsapp_group_attendances
    SET session_status = ?, agent_id = ?, agent_name = ?
    WHERE session_id = ?
  `).bind(WHATSAPP_SESSION_IN_PROGRESS, agentId, agentName, id).run();
  const updated = await env.REVIEWS_DB.prepare('SELECT * FROM whatsapp_group_sessions WHERE id = ? LIMIT 1')
    .bind(id)
    .first();
  return { session: updated };
}

async function updateWhatsappGroupSessionDetails(env, sessionId, body = {}) {
  const id = cleanWebhookText(sessionId, 120);
  if (!id) return { error: 'Informe o atendimento.' };
  const title = cleanWebhookText(body.tituloAtendimento ?? body.titulo ?? body.title, 220);
  const summary = cleanWebhookText(body.resumoAtendimento ?? body.resumo ?? body.summary, 1600);
  const notes = cleanWebhookText(body.observacoesInternas ?? body.observacoes ?? body.notes, 2000);
  const now = new Date().toISOString();
  const result = await env.REVIEWS_DB.prepare(`
    UPDATE whatsapp_group_sessions
    SET titulo_atendimento = ?, resumo_atendimento = ?, observacoes_internas = ?, updated_at = ?
    WHERE id = ?
  `).bind(title, summary, notes, now, id).run();
  if (Number(result?.meta?.changes || 0) < 1) return { error: 'Atendimento nao encontrado.', status: 404 };
  const updated = await env.REVIEWS_DB.prepare('SELECT * FROM whatsapp_group_sessions WHERE id = ? LIMIT 1')
    .bind(id)
    .first();
  return { session: updated };
}

async function processWhatsappGroupSession(env, record) {
  const command = whatsappGroupCommand(record);
  const meta = await whatsappGroupMeta(env, record);
  if (meta.grupoNome && !record.grupoNome) record.grupoNome = meta.grupoNome;
  record.clienteId = meta.clienteId || '';
  record.clienteNome = meta.clienteNome || '';
  const actor = await whatsappActorInfo(env, record, meta, command);
  record.agentId = actor.isAgent ? (actor.agentId || record.remetenteId || '') : '';
  record.agentName = actor.isAgent ? (actor.agentName || record.remetenteNome || '') : '';

  if (command === 'close' && actor.isAgent) {
    const session = await latestWhatsappGroupSession(env, record);
    if (!session) return { command, ignoredCommand: true };
    const closed = await closeWhatsappGroupSession(env, session, record, actor);
    return {
      command,
      sessionId: closed.id,
      sessionProtocol: closed.protocol,
      sessionStatus: WHATSAPP_SESSION_CLOSED,
      closed: true,
    };
  }

  if ((command === 'start' || command === 'assign') && actor.isAgent) {
    const open = await whatsappGroupSessionForRecord(env, record);
    const session = open
      ? await touchWhatsappGroupSession(env, open, record, actor)
      : await createWhatsappGroupSession(env, record, actor, WHATSAPP_SESSION_IN_PROGRESS);
    return {
      command,
      sessionId: session.id,
      sessionProtocol: session.protocol,
      sessionStatus: session.status || WHATSAPP_SESSION_IN_PROGRESS,
    };
  }

  if (actor.isAgent) {
    const session = (await whatsappGroupSessionForRecord(env, record)) || (await createWhatsappGroupSession(env, record, actor, WHATSAPP_SESSION_IN_PROGRESS));
    if (session.message_count !== undefined) {
      const touched = await touchWhatsappGroupSession(env, session, record, actor);
      return {
        command,
        sessionId: touched.id,
        sessionProtocol: touched.protocol,
        sessionStatus: touched.status || WHATSAPP_SESSION_IN_PROGRESS,
      };
    }
    return {
      command,
      sessionId: session.id,
      sessionProtocol: session.protocol,
      sessionStatus: session.status || WHATSAPP_SESSION_IN_PROGRESS,
    };
  }

  const session = (await whatsappGroupSessionForRecord(env, record)) || (await createWhatsappGroupSession(env, record, actor));
  if (session.message_count !== undefined) {
    const touched = await touchWhatsappGroupSession(env, session, record, actor);
    return {
      command,
      sessionId: touched.id,
      sessionProtocol: touched.protocol,
      sessionStatus: touched.status || WHATSAPP_SESSION_UNANSWERED,
    };
  }
  return {
    command,
    sessionId: session.id,
    sessionProtocol: session.protocol,
    sessionStatus: session.status || WHATSAPP_SESSION_UNANSWERED,
  };
}

async function insertWhatsappGroupAttendance(env, record) {
  await ensureWhatsappGroupD1(env);
  const result = await env.REVIEWS_DB.prepare(`
    INSERT OR IGNORE INTO whatsapp_group_attendances (
      id, external_id, origin, instance, event, grupo_id, grupo_nome, cliente_id, cliente_nome, remetente_id,
      remetente_nome, from_me, message_timestamp, message_datetime, tipo_mensagem,
      conteudo, message_id, session_id, session_protocol, session_status,
      agent_id, agent_name, raw_payload_json, processing_status, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', '', ?)
  `).bind(
    record.id,
    record.externalId,
    record.origin,
    record.instance,
    record.event,
    record.grupoId,
    record.grupoNome,
    record.clienteId || '',
    record.clienteNome || '',
    record.remetenteId,
    record.remetenteNome,
    record.fromMe,
    record.messageTimestamp,
    record.messageDatetime,
    record.tipoMensagem,
    record.conteudo,
    record.messageId,
    record.sessionId || '',
    record.sessionProtocol || '',
    record.sessionStatus || '',
    record.agentId || '',
    record.agentName || '',
    record.rawPayloadJson,
    record.createdAt,
  ).run();
  return Number(result?.meta?.changes || 0) > 0;
}

async function whatsappGroupAttendanceExists(env, record) {
  await ensureWhatsappGroupD1(env);
  const result = await env.REVIEWS_DB.prepare(`
    SELECT id, session_id, session_protocol, session_status
    FROM whatsapp_group_attendances
    WHERE external_id = ?
      OR (? <> '' AND instance = ? AND grupo_id = ? AND message_id = ?)
      OR (? > 0 AND instance = ? AND grupo_id = ? AND message_timestamp = ? AND from_me = ? AND remetente_id = ? AND conteudo = ?)
    LIMIT 1
  `).bind(
    record.externalId || '',
    record.messageId || '',
    record.instance || '',
    record.grupoId || '',
    record.messageId || '',
    Number(record.messageTimestamp || 0),
    record.instance || '',
    record.grupoId || '',
    Number(record.messageTimestamp || 0),
    Number(record.fromMe || 0),
    record.remetenteId || '',
    record.conteudo || '',
  ).first();
  return result || null;
}

async function processWhatsappGroupItemPayload(env, itemPayload, ctx = null) {
  if (isWhatsappGroupSystemEventPayload(itemPayload)) {
    return { inserted: false, ignored: true, reason: 'group_system_event' };
  }
  const record = extractWhatsAppGroupRecord(itemPayload);
  record.rawPayloadJson = JSON.stringify(itemPayload).slice(0, WHATSAPP_WEBHOOK_RAW_MAX_BYTES);
  if (!record.grupoId.endsWith('@g.us')) {
    return { inserted: false, ignored: true, reason: 'not_group_message' };
  }

  if (!(await isWhatsappGroupMonitored(env, record))) {
    return { inserted: false, ignored: true, reason: 'group_not_monitored', grupoId: record.grupoId };
  }

  const duplicate = await whatsappGroupAttendanceExists(env, record);
  if (duplicate) {
    const recalculated = duplicate.session_id ? await recalculateWhatsappSessionTiming(env, duplicate.session_id).catch(() => null) : null;
    const merged = duplicate.session_id ? await mergeWhatsappGroupSessionDuplicates(env, record, duplicate.session_id).catch(() => null) : null;
    return {
      inserted: false,
      duplicate: true,
      origin: WHATSAPP_GROUP_ORIGIN,
      grupoId: record.grupoId,
      tipoMensagem: record.tipoMensagem,
      sessionId: merged?.id || duplicate.session_id || '',
      sessionProtocol: merged?.protocol || duplicate.session_protocol || '',
      sessionStatus: merged?.status || recalculated?.status || duplicate.session_status || '',
    };
  }

  const session = await processWhatsappGroupSession(env, record);
  record.sessionId = session.sessionId || '';
  record.sessionProtocol = session.sessionProtocol || '';
  record.sessionStatus = session.sessionStatus || '';

  const inserted = await insertWhatsappGroupAttendance(env, record);
  if (inserted) {
    const media = extractEvolutionMediaInfoFromRaw(record.rawPayloadJson) || extractEvolutionMediaInfo(unwrapEvolutionMessage(itemPayload?.data?.message));
    const base64 = media?.base64 || pickEvolutionBase64(itemPayload);
    if (media?.type && base64) {
      const cachePromise = writeWhatsappMediaCache(env, record.id, media, base64).catch(() => false);
      if (ctx) ctx.waitUntil(cachePromise);
      else await cachePromise;
    }
  }
  const recalculated = record.sessionId ? await recalculateWhatsappSessionTiming(env, record.sessionId).catch(() => null) : null;
  const merged = record.sessionId ? await mergeWhatsappGroupSessionDuplicates(env, record, record.sessionId).catch(() => null) : null;
  await upsertWhatsappInstanceFromRecord(env, record);
  await upsertWhatsappGroupFromRecord(env, record);
  if (ctx && !record.grupoNome) ctx.waitUntil(enrichWhatsappGroupName(env, record));

  return {
    inserted,
    duplicate: !inserted,
    origin: WHATSAPP_GROUP_ORIGIN,
    grupoId: record.grupoId,
    tipoMensagem: record.tipoMensagem,
    sessionProtocol: merged?.protocol || record.sessionProtocol,
    sessionStatus: merged?.status || recalculated?.status || record.sessionStatus,
    command: session.command || '',
  };
}

function webhookSecretFromRequest(request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const url = new URL(request.url);
  return (
    request.headers.get('x-webhook-secret') ||
    request.headers.get('x-evolution-secret') ||
    request.headers.get('x-gestao-webhook-secret') ||
    request.headers.get('x-api-key') ||
    request.headers.get('apikey') ||
    url.searchParams.get('secret') ||
    url.searchParams.get('webhook_secret') ||
    ''
  ).trim();
}

function isWebhookSecretValid(request, env) {
  const expected = String(env.WEBHOOK_SECRET || '').trim();
  if (!expected) return false;
  const received = webhookSecretFromRequest(request);
  return received ? timingSafeEqual(received, expected) : false;
}

async function handleWhatsappGroupWebhook(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'Metodo nao permitido' }, 405);
  if (!env.REVIEWS_DB) return jsonResponse({ error: 'Banco D1 nao configurado.' }, 501);
  if (!env.WEBHOOK_SECRET) return jsonResponse({ error: 'WEBHOOK_SECRET nao configurado.' }, 503);
  if (!isWebhookSecretValid(request, env)) return jsonResponse({ error: 'Nao autorizado.' }, 401);

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > WHATSAPP_WEBHOOK_MAX_BYTES) {
    return jsonResponse({ error: 'Payload muito grande.' }, 413);
  }

  let raw = '';
  let payload = null;
  try {
    raw = await request.text();
    if (raw.length > WHATSAPP_WEBHOOK_MAX_BYTES) return jsonResponse({ error: 'Payload muito grande.' }, 413);
    payload = JSON.parse(raw);
  } catch (error) {
    console.error('Webhook WhatsApp Grupo com JSON invalido:', error);
    await saveWhatsappWebhookFailure(env, { error: 'JSON invalido', raw });
    return jsonResponse({ error: 'JSON invalido.' }, 400);
  }

  try {
    await ensureWhatsappGroupD1(env);
    const event = normalizeWebhookEvent(payload?.event);
    if (event !== 'messages.upsert') {
      return jsonResponse({ ok: true, ignored: true, reason: 'event_not_supported', event });
    }

    const dataItems = Array.isArray(payload?.data) ? payload.data : [payload?.data];
    const results = [];
    let insertedCount = 0;
    for (const dataItem of dataItems) {
      const itemPayload = { ...payload, event, data: dataItem };
      const result = await processWhatsappGroupItemPayload(env, itemPayload, ctx);
      if (result.inserted) insertedCount += 1;
      results.push(result);
    }

    const first = results[0] || {};
    return jsonResponse({
      ok: true,
      inserted: insertedCount > 0,
      insertedCount,
      batch: dataItems.length,
      results,
      ...(!Array.isArray(payload?.data) ? first : {}),
    }, insertedCount > 0 ? 201 : 200);
  } catch (error) {
    console.error('Erro ao processar webhook WhatsApp Grupo:', error);
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
    await saveWhatsappWebhookFailure(env, {
      instance: payload?.instance,
      event: payload?.event,
      grupoId: data?.key?.remoteJid || data?.remoteJid,
      error: error?.message || String(error),
      rawPayloadJson: raw,
    });
    return jsonResponse({ error: 'Erro ao processar webhook.' }, 500);
  }
}

function isEvolutionHistoryMessageLike(item) {
  if (!item || typeof item !== 'object') return false;
  const key = item.key || item.message?.key || item.data?.key || {};
  return !!(
    item.message ||
    item.data?.message ||
    item.messageTimestamp ||
    item.timestamp ||
    item.createdAt ||
    key.remoteJid ||
    item.remoteJid ||
    item.chatId
  );
}

function collectEvolutionHistoryMessages(value, out = [], depth = 0) {
  if (!value || depth > 5) return out;
  if (Array.isArray(value)) {
    value.forEach((item) => collectEvolutionHistoryMessages(item, out, depth + 1));
    return out;
  }
  if (typeof value !== 'object') return out;
  if (isEvolutionHistoryMessageLike(value)) out.push(value);
  for (const key of ['messages', 'records', 'items', 'data', 'result', 'results', 'history', 'rows']) {
    if (value[key] && value[key] !== value) collectEvolutionHistoryMessages(value[key], out, depth + 1);
  }
  return out;
}

function evolutionTimestampSeconds(item = {}) {
  const raw = item.messageTimestamp ?? item.timestamp ?? item.createdAt ?? item.created_at ?? '';
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 9999999999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  const date = new Date(String(raw || ''));
  if (Number.isFinite(date.getTime())) return Math.floor(date.getTime() / 1000);
  return Math.floor(Date.now() / 1000);
}

function normalizeEvolutionHistoryPayload(instance, group, item = {}) {
  const source = item.data && typeof item.data === 'object' ? item.data : item;
  let key = source.key || source.message?.key || {};
  let message = source.message?.message || source.message || {};
  if (message?.key && message?.message) {
    key = { ...message.key, ...key };
    message = message.message;
  }
  const remoteJid = key.remoteJid || source.remoteJid || source.chatId || source.chat?.id || group.grupo_id || group.grupoId || '';
  const messageId = key.id || source.messageId || source.id || source.message_id || '';
  const fromMe = Boolean(key.fromMe ?? source.fromMe ?? source.from_me);
  return {
    instance,
    event: 'messages.upsert',
    data: {
      ...source,
      key: {
        ...key,
        id: messageId,
        remoteJid,
        fromMe,
        participant: key.participant || source.participant || source.sender || source.from || source.author || '',
      },
      message,
      messageTimestamp: evolutionTimestampSeconds(source),
      pushName: source.pushName || source.senderName || source.notifyName || source.name || '',
      messageId,
      groupName: source.groupName || source.groupSubject || group.grupo_nome || group.grupoNome || '',
    },
  };
}

async function evolutionPostJson(env, path, body) {
  const base = evolutionApiBase(env);
  const apiKey = evolutionApiKey(env);
  if (!base || !apiKey) return null;
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

async function fetchEvolutionRecentGroupMessages(env, group, limit = 50) {
  const instance = cleanWebhookText(group.instance || 'principal', 120);
  const groupId = cleanWebhookText(group.grupo_id || group.grupoId, 180);
  if (!instance || !groupId) return [];
  const path = `/chat/findMessages/${encodeURIComponent(instance)}`;
  const bodies = [
    { where: { key: { remoteJid: groupId } }, limit },
    { where: { remoteJid: groupId }, limit },
    { remoteJid: groupId, limit },
    { jid: groupId, limit },
  ];
  const seen = new Set();
  const messages = [];
  for (const body of bodies) {
    const data = await evolutionPostJson(env, path, body).catch(() => null);
    for (const item of collectEvolutionHistoryMessages(data)) {
      const payload = normalizeEvolutionHistoryPayload(instance, group, item);
      const key = payload.data.key?.id || `${payload.data.key?.remoteJid}|${payload.data.messageTimestamp}|${payload.data.pushName}`;
      if (!payload.data.key?.remoteJid?.endsWith('@g.us') || seen.has(key)) continue;
      seen.add(key);
      messages.push(payload);
    }
    if (messages.length) break;
  }
  return messages
    .sort((a, b) => Number(a?.data?.messageTimestamp || 0) - Number(b?.data?.messageTimestamp || 0))
    .slice(-limit);
}

async function whatsappGroupsForReconcile(env) {
  await ensureWhatsappGroupD1(env);
  const rows = await env.REVIEWS_DB.prepare(`
    SELECT instance, grupo_id, grupo_nome
    FROM (
      SELECT instance, grupo_id, grupo_nome, updated_at
      FROM whatsapp_groups
      WHERE monitorado = 1
      UNION
      SELECT instance, grupo_id, MAX(grupo_nome) AS grupo_nome, MAX(created_at) AS updated_at
      FROM whatsapp_group_attendances
      WHERE grupo_id <> ''
      GROUP BY instance, grupo_id
    )
    ORDER BY updated_at DESC
    LIMIT 100
  `).all();
  return Array.isArray(rows?.results) ? rows.results : [];
}

async function reconcileWhatsappGroups(env, ctx = null, options = {}) {
  if (!env.REVIEWS_DB) return { ok: false, skipped: true, reason: 'missing_db' };
  if (!evolutionApiBase(env) || !evolutionApiKey(env)) return { ok: false, skipped: true, reason: 'missing_evolution_config' };
  await ensureWhatsappGroupD1(env);
  const limit = Math.max(5, Math.min(Number(options.limit || 50), 100));
  const groups = await whatsappGroupsForReconcile(env);
  const results = [];
  let insertedCount = 0;
  let checkedCount = 0;
  for (const group of groups) {
    const messages = await fetchEvolutionRecentGroupMessages(env, group, limit).catch((error) => {
      console.error('Erro ao reconciliar mensagens Evolution:', error);
      results.push({
        inserted: false,
        error: true,
        grupoId: group.grupo_id || group.grupoId || '',
        reason: error?.message || String(error || 'erro_evolution'),
      });
      return [];
    });
    if (!messages.length) {
      results.push({
        inserted: false,
        checked: false,
        grupoId: group.grupo_id || group.grupoId || '',
        reason: 'sem_mensagens_retorno_evolution',
      });
    }
    for (const payload of messages) {
      checkedCount += 1;
      const result = await processWhatsappGroupItemPayload(env, payload, ctx);
      if (result.inserted) insertedCount += 1;
      results.push(result);
    }
  }
  const recalculatedCount = await recalculateRecentWhatsappSessions(env, 200).catch(() => 0);
  const ok = groups.length === 0 || checkedCount > 0;
  const result = {
    ok,
    groups: groups.length,
    checkedCount,
    insertedCount,
    recalculatedCount,
    reason: ok ? '' : 'evolution_nao_retornou_mensagens',
    finishedAt: new Date().toISOString(),
    results: results.slice(-100),
  };
  await saveWhatsappGroupSetting(env, 'last_reconcile_result', JSON.stringify({
    ok: result.ok,
    groups: result.groups,
    checkedCount: result.checkedCount,
    insertedCount: result.insertedCount,
    recalculatedCount: result.recalculatedCount,
    reason: result.reason,
    finishedAt: result.finishedAt,
  })).catch(() => {});
  return result;
}

async function saveWhatsappGroupSetting(env, key, value) {
  if (!env.REVIEWS_DB) return;
  await ensureWhatsappGroupD1(env);
  await env.REVIEWS_DB.prepare(`
    INSERT INTO whatsapp_group_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(String(key || ''), String(value || ''), new Date().toISOString()).run();
}

async function whatsappGroupSettingValue(env, key) {
  if (!env.REVIEWS_DB) return '';
  await ensureWhatsappGroupD1(env);
  const row = await env.REVIEWS_DB.prepare('SELECT value FROM whatsapp_group_settings WHERE key = ?')
    .bind(String(key || ''))
    .first();
  return String(row?.value || '');
}

async function fetchEvolutionInstanceHealth(env, instance) {
  const base = evolutionApiBase(env);
  const apiKey = evolutionApiKey(env);
  const name = cleanWebhookText(instance || 'principal', 120);
  if (!base || !apiKey || !name) return { instance: name, ok: false, configured: !!base && !!apiKey, state: 'sem_configuracao' };
  const endpoints = [
    `${base}/instance/connectionState/${encodeURIComponent(name)}`,
    `${base}/instance/fetchInstances`,
  ];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: { apikey: apiKey },
        signal: AbortSignal.timeout(4500),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) continue;
      if (endpoint.includes('/fetchInstances')) {
        const list = Array.isArray(data) ? data : (Array.isArray(data?.instances) ? data.instances : []);
        const item = list.find((row) => String(row?.name || row?.instanceName || row?.instance || '').toLowerCase() === name.toLowerCase()) || null;
        const state = String(item?.connectionStatus || item?.status || item?.state || item?.connectionState || '').toLowerCase();
        return { instance: name, ok: /open|connected|conect|recebendo/.test(state), configured: true, state: state || 'retornou_dados', source: 'fetchInstances' };
      }
      const state = String(data?.instance?.state || data?.state || data?.status || data?.connectionStatus || data?.connectionState || '').toLowerCase();
      return { instance: name, ok: /open|connected|conect|recebendo/.test(state), configured: true, state: state || 'retornou_dados', source: 'connectionState' };
    } catch {}
  }
  return { instance: name, ok: false, configured: true, state: 'sem_resposta_evolution' };
}

async function handleWhatsappGroupHealth(request, env, profile = {}) {
  if (!env.REVIEWS_DB) return jsonResponse({ ok: false, error: 'REVIEWS_DB nao configurado.' }, 501);
  if (request.method !== 'GET') return jsonResponse({ error: 'Metodo nao permitido.' }, 405);
  await ensureWhatsappGroupD1(env);
  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const since1h = new Date(now - 60 * 60 * 1000).toISOString();
  const [instancesResult, groupsResult, lastMessagesResult, lastFailure, failures24h, failures1h, mediaCache, sessionRows] = await Promise.all([
    env.REVIEWS_DB.prepare('SELECT instance, nome, telefone, status, updated_at FROM whatsapp_instances ORDER BY updated_at DESC LIMIT 20').all(),
    env.REVIEWS_DB.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN monitorado = 1 THEN 1 ELSE 0 END) AS monitored FROM whatsapp_groups').first(),
    env.REVIEWS_DB.prepare('SELECT id, instance, grupo_id, grupo_nome, remetente_nome, tipo_mensagem, message_datetime, created_at FROM whatsapp_group_attendances ORDER BY created_at DESC LIMIT 20').all(),
    env.REVIEWS_DB.prepare('SELECT instance, grupo_id, error_message, created_at FROM whatsapp_webhook_failures ORDER BY created_at DESC LIMIT 1').first(),
    env.REVIEWS_DB.prepare('SELECT COUNT(*) AS total FROM whatsapp_webhook_failures WHERE created_at >= ?').bind(since24h).first(),
    env.REVIEWS_DB.prepare('SELECT COUNT(*) AS total FROM whatsapp_webhook_failures WHERE created_at >= ?').bind(since1h).first(),
    env.REVIEWS_DB.prepare('SELECT COUNT(*) AS total, MAX(updated_at) AS lastCachedAt FROM whatsapp_group_media_cache').first(),
    env.REVIEWS_DB.prepare(`
      SELECT *
      FROM whatsapp_group_sessions
      ORDER BY updated_at DESC
      LIMIT 1000
    `).all(),
  ]);
  const instances = Array.isArray(instancesResult?.results) ? instancesResult.results : [];
  const instanceNames = [...new Set((instances.length ? instances : [{ instance: 'principal' }]).map((row) => String(row.instance || 'principal')).filter(Boolean))].slice(0, 5);
  const evolution = await Promise.all(instanceNames.map((instance) => fetchEvolutionInstanceHealth(env, instance)));
  const lastReconcileRaw = await whatsappGroupSettingValue(env, 'last_reconcile_result');
  let lastReconcile = null;
  try { lastReconcile = lastReconcileRaw ? JSON.parse(lastReconcileRaw) : null; } catch {}
  const lastMessage = (lastMessagesResult?.results || []).find((row) => !whatsappIsExcludedMetricGroup(row)) || null;
  const sessionList = (sessionRows?.results || []).filter((row) => !whatsappIsExcludedMetricGroup(row));
  const sessions = {};
  for (const row of sessionList) sessions[String(row.status || '')] = Number(sessions[String(row.status || '')] || 0) + 1;
  const openStatuses = [WHATSAPP_SESSION_OPEN, WHATSAPP_SESSION_UNANSWERED];
  const progressStatuses = [WHATSAPP_SESSION_IN_PROGRESS, WHATSAPP_SESSION_ANSWERED, WHATSAPP_SESSION_RESPONDED];
  const openCount = sessionList.filter(whatsappSessionCountsAsOpen).length;
  const progressCount = progressStatuses.reduce((sum, key) => sum + Number(sessions[key] || 0), 0);
  return jsonResponse({
    ok: true,
    checkedAt: new Date().toISOString(),
    role: profile.role || 'agente',
    configured: {
      evolutionUrl: !!evolutionApiBase(env),
      evolutionApiKey: !!evolutionApiKey(env),
      webhookSecret: !!env.WEBHOOK_SECRET,
      cron: true,
    },
    evolution,
    groups: {
      total: Number(groupsResult?.total || 0),
      monitored: Number(groupsResult?.monitored || 0),
    },
    sessions: {
      raw: sessions,
      semResposta: openCount,
      emTratativa: progressCount,
      encerrados: Number(sessions[WHATSAPP_SESSION_CLOSED] || 0),
    },
    lastMessage: lastMessage || null,
    lastReconcile,
    failures: {
      last: lastFailure || null,
      last24h: Number(failures24h?.total || 0),
      last1h: Number(failures1h?.total || 0),
    },
    mediaCache: {
      total: Number(mediaCache?.total || 0),
      lastCachedAt: mediaCache?.lastCachedAt || '',
    },
  });
}

async function handleWhatsappGroupReconcile(request, env, profile = {}) {
  if (profile.role !== 'admin') return jsonResponse({ error: 'Acesso negado.' }, 403);
  if (request.method !== 'POST') return jsonResponse({ error: 'Metodo nao permitido.' }, 405);
  const body = await request.json().catch(() => ({}));
  const result = await reconcileWhatsappGroups(env, null, { limit: body.limit || 50 });
  return jsonResponse(result, result.insertedCount > 0 ? 201 : 200);
}

async function handleWhatsappGroupReconcileCron(request, env, ctx = null) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Metodo nao permitido.' }, 405);
  const expected = whatsappReconcileSecret(env);
  if (!expected) return jsonResponse({ error: 'Segredo de reconciliacao WhatsApp nao configurado.' }, 503);
  const received = requestSecret(request);
  if (!received || !timingSafeEqual(received, expected)) return jsonResponse({ error: 'Nao autorizado.' }, 401);
  const body = await request.json().catch(() => ({}));
  const result = await reconcileWhatsappGroups(env, ctx, { limit: body.limit || 50 });
  return jsonResponse(result, result.insertedCount > 0 ? 201 : 200);
}

async function handleWhatsappGroupReconcileTargets(request, env) {
  if (!env.REVIEWS_DB) return jsonResponse({ error: 'Banco D1 nao configurado.' }, 501);
  if (!env.WEBHOOK_SECRET) return jsonResponse({ error: 'WEBHOOK_SECRET nao configurado.' }, 503);
  if (!isWebhookSecretValid(request, env)) return jsonResponse({ error: 'Nao autorizado.' }, 401);
  if (request.method !== 'GET') return jsonResponse({ error: 'Metodo nao permitido.' }, 405);
  const groups = await whatsappGroupsForReconcile(env);
  return jsonResponse({
    ok: true,
    groups: groups.map((group) => ({
      instance: group.instance || 'principal',
      grupoId: group.grupo_id || '',
      grupoNome: group.grupo_nome || '',
    })),
  });
}

function whatsappAttendanceToPublic(row) {
  const mediaInfo = extractEvolutionMediaInfoFromRaw(row.raw_payload_json || '');
  const rowMediaType = inferEvolutionMediaType(row.tipo_mensagem || '', {}, '', '');
  const hasMediaType = /^(image|audio|video|document|sticker)$/.test(rowMediaType);
  const mediaLabels = {
    image: 'Imagem recebida',
    audio: 'Audio recebido',
    video: 'Video recebido',
    document: 'Documento recebido',
    sticker: 'Sticker recebido',
  };
  let content = row.conteudo || '';
  const publicMediaType = mediaInfo?.type || (hasMediaType ? rowMediaType : '');
  if (publicMediaType && (/^(audio|imagem|image|video|documento|sticker) recebido$/i.test(content) || /^image\/|^audio\/|^video\//i.test(content))) {
    content = mediaInfo?.caption || mediaInfo?.fileName || mediaLabels[publicMediaType] || content;
  }
  return {
    id: row.id,
    origin: row.origin || WHATSAPP_GROUP_ORIGIN,
    instance: row.instance || '',
    event: row.event || '',
    grupoId: row.grupo_id || '',
    grupoNome: row.grupo_nome || '',
    clienteId: row.cliente_id || '',
    clienteNome: row.cliente_nome || '',
    remetenteId: row.remetente_id || '',
    remetenteNome: row.remetente_nome || '',
    fromMe: Number(row.from_me || 0) === 1,
    timestamp: Number(row.message_timestamp || 0),
    messageDatetime: row.message_datetime || '',
    tipoMensagem: publicMediaType || row.tipo_mensagem || '',
    conteudo: content,
    messageId: row.message_id || '',
    sessionId: row.session_id || '',
    sessionProtocol: row.session_protocol || '',
    sessionStatus: row.session_status || '',
    agentId: row.agent_id || '',
    agentName: row.agent_name || '',
    media: publicMediaType ? {
      type: publicMediaType,
      mimetype: normalizeEvolutionMediaContentType(mediaInfo || { type: publicMediaType }),
      fileName: mediaInfo?.fileName || '',
      caption: mediaInfo?.caption || '',
      available: true,
      url: `/api/whatsapp-grupo/media/${encodeURIComponent(row.id || '')}`,
    } : null,
    createdAt: row.created_at || '',
  };
}

function whatsappSessionToPublic(row) {
  return {
    id: row.id || '',
    protocol: row.protocol || '',
    origin: row.origin || WHATSAPP_GROUP_ORIGIN,
    instance: row.instance || '',
    grupoId: row.grupo_id || '',
    grupoNome: row.grupo_nome || '',
    clienteId: row.cliente_id || '',
    clienteNome: row.cliente_nome || '',
    remetenteId: row.remetente_id || '',
    remetenteNome: row.remetente_nome || '',
    agenteId: row.agente_id || '',
    agenteNome: row.agente_nome || '',
    status: row.status || WHATSAPP_SESSION_UNANSWERED,
    startedAt: row.started_at || '',
    firstMessageAt: row.first_message_at || '',
    firstResponseAt: row.first_response_at || '',
    firstResponseSeconds: Number(row.first_response_seconds || 0),
    lastMessageAt: row.last_message_at || '',
    closedAt: row.closed_at || '',
    closedBy: row.closed_by || '',
    closeReason: row.close_reason || '',
    tituloAtendimento: row.titulo_atendimento || '',
    resumoAtendimento: row.resumo_atendimento || '',
    observacoesInternas: row.observacoes_internas || '',
    messageCount: Number(row.message_count || 0),
    participantCount: Number(row.participant_count || 0),
    fromMeCount: Number(row.from_me_count || 0),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

async function handleWhatsappGroupAttendances(request, env) {
  if (!env.REVIEWS_DB) return jsonResponse({ attendances: [], storage: false, message: 'REVIEWS_DB nao configurado' }, 501);
  await ensureWhatsappGroupD1(env);
  if (request.method !== 'GET') return jsonResponse({ error: 'Metodo nao permitido' }, 405);
  await mergeRecentWhatsappGroupSessionDuplicates(env, 300).catch(() => 0);

  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit') || 300)));
  const filters = [];
  const binds = [];
  const group = whatsappGroupIdForSql(url.searchParams.get('grupoId'));
  const type = cleanWebhookText(url.searchParams.get('tipoMensagem'), 40);
  const q = cleanWebhookText(url.searchParams.get('q'), 120).toLowerCase();
  const fromMe = url.searchParams.get('fromMe');
  const start = cleanWebhookText(url.searchParams.get('start'), 30);
  const end = cleanWebhookText(url.searchParams.get('end'), 30);

  if (group) {
    filters.push('grupo_id = ?');
    binds.push(group);
  }
  if (type) {
    filters.push('tipo_mensagem = ?');
    binds.push(type);
  }
  if (fromMe === 'true' || fromMe === 'false') {
    filters.push('from_me = ?');
    binds.push(fromMe === 'true' ? 1 : 0);
  }
  if (start) {
    filters.push('message_datetime >= ?');
    binds.push(start.length === 10 ? `${start}T00:00:00.000Z` : start);
  }
  if (end) {
    filters.push('message_datetime <= ?');
    binds.push(end.length === 10 ? `${end}T23:59:59.999Z` : end);
  }
  if (q) {
    filters.push('(lower(conteudo) LIKE ? OR lower(remetente_nome) LIKE ? OR lower(grupo_nome) LIKE ? OR lower(grupo_id) LIKE ?)');
    const like = `%${q}%`;
    binds.push(like, like, like, like);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await env.REVIEWS_DB.prepare(`
    SELECT * FROM whatsapp_group_attendances
    ${where}
    ORDER BY message_datetime DESC, created_at DESC
    LIMIT ?
  `).bind(...binds, limit).all();
  const sessionResult = await env.REVIEWS_DB.prepare(`
    SELECT * FROM whatsapp_group_sessions
    ORDER BY updated_at DESC
    LIMIT 500
  `).all();
  const attendances = (result.results || []).filter((row) => !whatsappIsExcludedMetricGroup(row));
  const sessions = (sessionResult.results || []).filter((row) => !whatsappIsExcludedMetricGroup(row));

  return jsonResponse({
    attendances: attendances.map(whatsappAttendanceToPublic),
    sessions: sessions.map(whatsappSessionToPublic),
    storage: true,
    origin: WHATSAPP_GROUP_ORIGIN,
    limit,
  });
}

async function handleWhatsappGroupMedia(request, env, id) {
  if (!env.REVIEWS_DB) return jsonResponse({ error: 'REVIEWS_DB nao configurado' }, 501);
  await ensureWhatsappGroupD1(env);
  if (request.method !== 'GET') return jsonResponse({ error: 'Metodo nao permitido' }, 405);
  const mediaId = cleanWebhookText(decodeURIComponent(id || ''), 160);
  if (!mediaId) return jsonResponse({ error: 'Midia nao informada.' }, 400);
  const cached = await env.REVIEWS_DB.prepare('SELECT mimetype, file_name, base64 FROM whatsapp_group_media_cache WHERE attendance_id = ? LIMIT 1')
    .bind(mediaId)
    .first();
  const kvCached = await readWhatsappMediaKv(env, mediaId);
  const row = await env.REVIEWS_DB.prepare('SELECT raw_payload_json, tipo_mensagem, conteudo FROM whatsapp_group_attendances WHERE id = ? LIMIT 1')
    .bind(mediaId)
    .first();
  const rawPayloadJson = row?.raw_payload_json || '';
  const rawMedia = extractEvolutionMediaInfoFromRaw(rawPayloadJson);
  const fallbackType = inferEvolutionMediaType(row?.tipo_mensagem || '', {}, '', '');
  const media = rawMedia || (/^(image|audio|video|document|sticker)$/.test(fallbackType) ? { type: fallbackType, mimetype: cached?.mimetype || kvCached?.mimetype || '', fileName: cached?.file_name || kvCached?.fileName || '', base64: '' } : null);
  if (!media && !cached?.base64 && !kvCached?.base64) return jsonResponse({ error: 'Midia nao encontrada no payload/cache.' }, 404);
  const contentType = cleanWebhookText(cached?.mimetype || kvCached?.mimetype, 120) || normalizeEvolutionMediaContentType(media || { type: fallbackType || 'media' });
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'private, max-age=300',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Disposition': `inline; filename="${(cached?.file_name || kvCached?.fileName || media?.fileName || `whatsapp-${media?.type || 'media'}`).replace(/"/g, '')}"`,
  };
  if (cached?.base64) {
    return new Response(decodeBase64Bytes(cached.base64), { headers });
  }
  if (kvCached?.base64) {
    return new Response(decodeBase64Bytes(kvCached.base64), { headers });
  }
  if (media.base64) {
    return new Response(decodeBase64Bytes(media.base64), { headers });
  }
  const evolutionBase64 = await fetchEvolutionMediaBase64(env, rawPayloadJson);
  if (evolutionBase64) {
    await writeWhatsappMediaCache(env, mediaId, media, evolutionBase64).catch(() => false);
    return new Response(decodeBase64Bytes(evolutionBase64), { headers });
  }
  if (media?.url && /^https:\/\//i.test(media.url)) {
    return jsonResponse({ error: 'A Evolution enviou apenas a URL criptografada do WhatsApp. Para mensagens novas, mantenha webhookBase64 ativo; para mensagens antigas, e necessario configurar uma EVOLUTION_API_URL publica.' }, 502);
  }
  return jsonResponse({ error: 'Midia sem URL acessivel. Consulte o payload bruto.' }, 404);
}

async function handleWhatsappGroupMediaCache(request, env) {
  if (!env.REVIEWS_DB) return jsonResponse({ error: 'REVIEWS_DB nao configurado' }, 501);
  await ensureWhatsappGroupD1(env);
  if (!isWebhookSecretValid(request, env)) return jsonResponse({ error: 'Nao autorizado.' }, 401);
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 50)));
    const result = await env.REVIEWS_DB.prepare(`
      SELECT id, instance, raw_payload_json
      FROM whatsapp_group_attendances
      WHERE tipo_mensagem IN ('image','audio','video','document','sticker')
        AND id NOT IN (SELECT attendance_id FROM whatsapp_group_media_cache)
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(limit).all();
    const items = (result.results || []).map((row) => {
      try {
        const payload = JSON.parse(String(row.raw_payload_json || '{}'));
        const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
        return {
          id: row.id || '',
          instance: payload?.instance || row.instance || '',
          key: data.key || {},
          message: data.message || {},
          messageType: data.messageType || '',
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
    return jsonResponse({ items, limit });
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'Metodo nao permitido' }, 405);
  const body = await request.json().catch(() => ({}));
  const id = cleanWebhookText(body.id || body.attendanceId, 180);
  const base64 = cleanWebhookText(body.base64, WHATSAPP_MEDIA_BASE64_MAX_BYTES);
  if (!id || !base64) return jsonResponse({ error: 'id e base64 obrigatorios.' }, 400);
  const exists = await env.REVIEWS_DB.prepare('SELECT id FROM whatsapp_group_attendances WHERE id = ? LIMIT 1')
    .bind(id)
    .first();
  if (!exists) return jsonResponse({ error: 'Atendimento nao encontrado.' }, 404);
  await writeWhatsappMediaCache(env, id, {
    type: inferEvolutionMediaType('', { mimetype: body.mimetype || body.contentType, fileName: body.fileName || body.filename }, '', base64),
    mimetype: cleanWebhookText(body.mimetype || body.contentType, 120),
    fileName: cleanWebhookText(body.fileName || body.filename, 240),
    base64,
  }, base64);
  return jsonResponse({ ok: true, id });
}

async function handleWhatsappGroupSessionClose(request, env, profile = {}) {
  if (!env.REVIEWS_DB) return jsonResponse({ error: 'REVIEWS_DB nao configurado' }, 501);
  await ensureWhatsappGroupD1(env);
  if (request.method !== 'POST') return jsonResponse({ error: 'Metodo nao permitido' }, 405);

  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'JSON invalido.' }, 400);
  }
  const result = await closeWhatsappGroupSessionFromPanel(env, body.id || body.sessionId, profile, body.reason);
  if (result.error) return jsonResponse({ error: result.error }, result.status || 400);
  return jsonResponse({
    ok: true,
    alreadyClosed: !!result.alreadyClosed,
    session: whatsappSessionToPublic(result.session || {}),
  });
}

async function handleWhatsappGroupSessionAssign(request, env, profile = {}) {
  if (!env.REVIEWS_DB) return jsonResponse({ error: 'REVIEWS_DB nao configurado' }, 501);
  await ensureWhatsappGroupD1(env);
  if (request.method !== 'POST') return jsonResponse({ error: 'Metodo nao permitido' }, 405);
  const body = await request.json().catch(() => ({}));
  const result = await assignWhatsappGroupSessionFromPanel(env, body.id || body.sessionId, profile);
  if (result.error) return jsonResponse({ error: result.error }, result.status || 400);
  return jsonResponse({ ok: true, session: whatsappSessionToPublic(result.session || {}) });
}

async function handleWhatsappGroupSessionDetails(request, env) {
  if (!env.REVIEWS_DB) return jsonResponse({ error: 'REVIEWS_DB nao configurado' }, 501);
  await ensureWhatsappGroupD1(env);
  if (request.method !== 'POST') return jsonResponse({ error: 'Metodo nao permitido' }, 405);
  const body = await request.json().catch(() => ({}));
  const result = await updateWhatsappGroupSessionDetails(env, body.id || body.sessionId, body);
  if (result.error) return jsonResponse({ error: result.error }, result.status || 400);
  return jsonResponse({ ok: true, session: whatsappSessionToPublic(result.session || {}) });
}

async function handleWhatsappGroupInstances(request, env, profile = {}) {
  if (!env.REVIEWS_DB) return jsonResponse({ error: 'REVIEWS_DB nao configurado' }, 501);
  await ensureWhatsappGroupD1(env);
  if (request.method === 'GET') {
    const result = await env.REVIEWS_DB.prepare(`
      SELECT instance, nome, telefone, status, created_at, updated_at
      FROM whatsapp_instances
      ORDER BY instance COLLATE NOCASE
      LIMIT 500
    `).all();
    return jsonResponse({ instances: result.results || [] });
  }
  if (profile.role !== 'admin') return jsonResponse({ error: 'Somente administradores podem alterar instancias.' }, 403);
  const body = await request.json().catch(() => ({}));
  const instance = cleanWebhookText(body.instance, 120);
  if (!instance) return jsonResponse({ error: 'instance obrigatoria.' }, 400);
  if (request.method === 'DELETE') {
    await env.REVIEWS_DB.prepare('DELETE FROM whatsapp_instances WHERE instance = ?').bind(instance).run();
    return jsonResponse({ ok: true });
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'Metodo nao permitido' }, 405);
  const now = new Date().toISOString();
  await env.REVIEWS_DB.prepare(`
    INSERT INTO whatsapp_instances (instance, nome, telefone, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(instance) DO UPDATE SET
      nome = excluded.nome,
      telefone = excluded.telefone,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).bind(
    instance,
    cleanWebhookText(body.nome || body.name, 180),
    cleanWebhookText(body.telefone || body.phone, 80),
    cleanWebhookText(body.status, 80),
    now,
    now,
  ).run();
  return jsonResponse({ ok: true });
}

async function handleWhatsappGroupConfig(request, env, profile = {}) {
  if (!env.REVIEWS_DB) return jsonResponse({ error: 'REVIEWS_DB nao configurado' }, 501);
  await ensureWhatsappGroupD1(env);

  if (request.method === 'GET') {
    const mode = await whatsappGroupSettingMode(env);
    const result = await env.REVIEWS_DB.prepare(`
      SELECT instance, grupo_id, grupo_nome, cliente_id, cliente_nome, agentes_json, monitorado, created_at, updated_at
      FROM whatsapp_groups
      ORDER BY grupo_nome COLLATE NOCASE, grupo_id
      LIMIT 2000
    `).all();
    const instanceResult = await env.REVIEWS_DB.prepare(`
      SELECT instance, nome, telefone, status, created_at, updated_at
      FROM whatsapp_instances
      ORDER BY instance COLLATE NOCASE
      LIMIT 500
    `).all();
    return jsonResponse({
      settings: { mode },
      instances: instanceResult.results || [],
      groups: (result.results || []).map((row) => ({
        instance: row.instance || '',
        grupoId: row.grupo_id || '',
        grupoNome: row.grupo_nome || '',
        clienteId: row.cliente_id || '',
        clienteNome: row.cliente_nome || '',
        agentes: parseWhatsappAgentNames(row.agentes_json),
        monitorado: Number(row.monitorado || 0) === 1,
        createdAt: row.created_at || '',
        updatedAt: row.updated_at || '',
      })),
    });
  }

  if (request.method !== 'POST' && request.method !== 'DELETE') return jsonResponse({ error: 'Metodo nao permitido' }, 405);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return jsonResponse({ error: 'JSON invalido.' }, 400);
  const now = new Date().toISOString();

  if (request.method === 'DELETE') {
    if (profile.role !== 'admin') return jsonResponse({ error: 'Somente administradores podem remover grupos monitorados.' }, 403);
    const instance = cleanWebhookText(body.instance, 120);
    const grupoId = whatsappGroupIdForSql(body.grupoId || body.groupId);
    if (!grupoId) return jsonResponse({ error: 'grupoId obrigatorio.' }, 400);
    await env.REVIEWS_DB.prepare('DELETE FROM whatsapp_groups WHERE instance = ? AND grupo_id = ?')
      .bind(instance, grupoId)
      .run();
    return jsonResponse({ ok: true });
  }

  if (body.mode !== undefined) {
    if (profile.role !== 'admin') return jsonResponse({ error: 'Somente administradores podem alterar o modo de monitoramento.' }, 403);
    await env.REVIEWS_DB.prepare(`
      INSERT INTO whatsapp_group_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(WHATSAPP_GROUP_SETTINGS_KEY, whatsappGroupMode(body.mode), now).run();
  }

  const groups = Array.isArray(body.groups) ? body.groups : (body.grupoId || body.groupId ? [body] : []);
  let saved = 0;
  for (const group of groups) {
    const instance = cleanWebhookText(group.instance, 120);
    const grupoId = whatsappGroupIdForSql(group.grupoId || group.groupId);
    if (!grupoId) continue;
    const grupoNome = cleanWebhookText(group.grupoNome || group.groupName, 180);
    const clienteId = cleanWebhookText(group.clienteId || group.clientId, 120);
    const clienteNome = cleanWebhookText(group.clienteNome || group.clientName, 180);
    const agentes = parseWhatsappAgentNames(group.agentes || group.agentNames || group.agentesTexto || group.agentsText);
    const agentesJson = JSON.stringify(agentes);
    await env.REVIEWS_DB.prepare(`
      INSERT INTO whatsapp_groups (instance, grupo_id, grupo_nome, cliente_id, cliente_nome, agentes_json, monitorado, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance, grupo_id) DO UPDATE SET
        grupo_nome = excluded.grupo_nome,
        cliente_id = excluded.cliente_id,
        cliente_nome = excluded.cliente_nome,
        agentes_json = excluded.agentes_json,
        monitorado = excluded.monitorado,
        updated_at = excluded.updated_at
    `).bind(
      instance,
      grupoId,
      grupoNome,
      clienteId,
      clienteNome,
      agentesJson,
      group.monitorado === false ? 0 : 1,
      now,
      now,
    ).run();
    await env.REVIEWS_DB.prepare(`
      UPDATE whatsapp_group_attendances
      SET grupo_nome = CASE WHEN ? <> '' THEN ? ELSE grupo_nome END,
          cliente_id = ?,
          cliente_nome = ?
      WHERE instance = ? AND grupo_id = ?
    `).bind(grupoNome, grupoNome, clienteId, clienteNome, instance, grupoId).run();
    await env.REVIEWS_DB.prepare(`
      UPDATE whatsapp_group_sessions
      SET grupo_nome = CASE WHEN ? <> '' THEN ? ELSE grupo_nome END,
          cliente_id = ?,
          cliente_nome = ?,
          updated_at = ?
      WHERE instance = ? AND grupo_id = ?
    `).bind(grupoNome, grupoNome, clienteId, clienteNome, now, instance, grupoId).run();
    saved += 1;
  }

  return jsonResponse({ ok: true, saved, mode: await whatsappGroupSettingMode(env) });
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/atendimentos/whatsapp-grupo' && (request.method === 'POST' || request.method === 'OPTIONS')) {
      return handleWhatsappGroupWebhook(request, env, ctx);
    }

    if (url.pathname === '/api/whatsapp-grupo/media-cache') {
      return handleWhatsappGroupMediaCache(request, env);
    }

    if (url.pathname === '/api/whatsapp-grupo/reconcile-targets') {
      return handleWhatsappGroupReconcileTargets(request, env);
    }

    if (url.pathname === '/api/neppo-live/cron') {
      return handleNeppoLiveCronTrigger(request, env);
    }

    if (url.pathname === '/api/whatsapp-grupo/reconcile-cron') {
      return handleWhatsappGroupReconcileCron(request, env, ctx);
    }

    if (url.pathname === '/api/release-info') {
      return jsonResponse({
        ok: true,
        release: DASHBOARD_RELEASE_MARKER,
        worker: 'gestaoatendimento',
        now: new Date().toISOString(),
      });
    }

    if (!parseAppUsers(env).length && !(await loadManagedUsers(env)).length) {
      return setupRequired();
    }

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
      if (url.pathname.startsWith('/api/')) {
        return jsonResponse({ error: 'Sessao expirada. Entre novamente e tente de novo.' }, 401);
      }
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

    if (url.pathname === '/api/treatment-patterns') {
      return handleTreatmentPatterns(request, env, appProfile);
    }

    if (url.pathname === '/api/review-requests') {
      return handleReviewRequests(request, env, appProfile);
    }

    if (url.pathname === '/api/neppo-live/dashboard') {
      return handleNeppoLiveDashboard(request, env, ctx);
    }

    if (url.pathname === '/api/neppo-live/health') {
      return handleNeppoLiveHealth(env);
    }

    if (url.pathname === '/api/atendimentos/whatsapp-grupo') {
      return handleWhatsappGroupAttendances(request, env);
    }

    const whatsappMediaMatch = url.pathname.match(/^\/api\/whatsapp-grupo\/media\/([^/]+)$/);
    if (whatsappMediaMatch) {
      return handleWhatsappGroupMedia(request, env, whatsappMediaMatch[1]);
    }

    if (url.pathname === '/api/whatsapp-grupo/media-cache') {
      return handleWhatsappGroupMediaCache(request, env);
    }

    if (url.pathname === '/api/whatsapp-grupo/health') {
      return handleWhatsappGroupHealth(request, env, appProfile);
    }

    if (url.pathname === '/api/whatsapp-grupo/sessions/close') {
      return handleWhatsappGroupSessionClose(request, env, appProfile);
    }

    if (url.pathname === '/api/whatsapp-grupo/sessions/assign') {
      return handleWhatsappGroupSessionAssign(request, env, appProfile);
    }

    if (url.pathname === '/api/whatsapp-grupo/sessions/details') {
      return handleWhatsappGroupSessionDetails(request, env);
    }

    if (url.pathname === '/api/whatsapp-grupo/instances') {
      return handleWhatsappGroupInstances(request, env, appProfile);
    }

    if (url.pathname === '/api/whatsapp-grupo/config') {
      return handleWhatsappGroupConfig(request, env, appProfile);
    }

    if (url.pathname === '/api/whatsapp-grupo/reconcile') {
      return handleWhatsappGroupReconcile(request, env, appProfile);
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
      const script = `window.CLIENTE_PRIVADO = ${JSON.stringify(PRIVATE_CLIENT_MAP)};\nwindow.CLIENTE_PRIVADO_STATUS = "ok"; window.CLIENTE_PRIVADO_STATUS_DETAIL = "mapa_embutido_autenticado";`;
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
    headers.set('X-Gestao-Release', DASHBOARD_RELEASE_MARKER);

    const assetResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    const liveDashboardResponse = await injectLiveDashboardIntoHtml(env, assetResponse);
    return rewriteDashboardBrand(liveDashboardResponse);
  },
  async scheduled(event, env, ctx) {
    if (event?.cron === '1-59/2 * * * *') {
      if (evolutionApiBase(env) && evolutionApiKey(env)) {
        ctx.waitUntil(reconcileWhatsappGroups(env, ctx, { limit: 50 }));
      }
      return;
    }
    ctx.waitUntil(refreshNeppoLiveDashboardForCron(env));
  },
};
