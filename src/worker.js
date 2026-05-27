function unauthorized() {
  return new Response('Login necessário para acessar o painel.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Gestao de Atendimento", charset="UTF-8"',
      'Cache-Control': 'no-store',
    },
  });
}

function setupRequired() {
  return new Response(
    'Proteção pendente: configure APP_USER e APP_PASSWORD nas variáveis do Worker na Cloudflare.',
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
  const privateMapPassword = env.AUTH_PASSWORD || env.APP_PASSWORD;
  const keys = await derivePrivateMapKeys(privateMapPassword, salt, iterations);

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

  if (!bytesEqual(mac, expectedMac)) {
    return 'window.CLIENTE_PRIVADO = {}; window.CLIENTE_PRIVADO_STATUS = "senha_incorreta_para_mapa_privado"; console.warn("Mapa privado de clientes não pôde ser aberto.");';
  }

  const aesKey = await crypto.subtle.importKey('raw', keys.aes, 'AES-CBC', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, data);
  return `${new TextDecoder().decode(plain)}\nwindow.CLIENTE_PRIVADO_STATUS = "ok";`;
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
  const match = String(protocol || '').match(/^WA0*(\d+)$/i);
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

async function renderPdfReport(request, env, protocol) {
  const url = new URL(request.url);
  let payload = null;
  try {
    payload = fromBase64UrlJson(url.searchParams.get('r'));
  } catch {
    return reportErrorPage('Atendimento', 'Não consegui abrir os dados deste atendimento.');
  }

  const row = Array.isArray(payload?.row) ? payload.row : [];
  const code = payload?.code || row[18] || '';
  const clientName = payload?.clientName || row[19] || row[12] || code || 'Cliente não informado';
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
    return new Response('Imagem inválida.', { status: 400 });
  }

  let mediaUrl = null;
  try {
    mediaUrl = new URL(target);
  } catch {
    return new Response('Imagem inválida.', { status: 400 });
  }

  if (mediaUrl.protocol !== 'https:' || !/(\.|^)neppo\.com\.br$/i.test(mediaUrl.hostname)) {
    return new Response('Imagem fora do NEPPO não permitida.', { status: 403 });
  }

  const headers = {
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
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
    return new Response(`Não consegui carregar a imagem do atendimento. NEPPO retornou ${response.status}.`, {
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

function isAuthorized(request, env) {
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
  const expectedUser = env.APP_USER || env.AUTH_USER || '';
  const expectedPassword = env.APP_PASSWORD || env.AUTH_PASSWORD || '';

  return (
    timingSafeEqual(user.trim(), String(expectedUser).trim()) &&
    timingSafeEqual(password, String(expectedPassword))
  );
}

export default {
  async fetch(request, env) {
    if (!(env.APP_USER || env.AUTH_USER) || !(env.APP_PASSWORD || env.AUTH_PASSWORD)) {
      return setupRequired();
    }

    if (!isAuthorized(request, env)) {
      return unauthorized();
    }

    const url = new URL(request.url);
    if (url.pathname === '/media') {
      return fetchMediaProxy(request, env);
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
