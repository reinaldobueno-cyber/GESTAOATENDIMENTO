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
  if (env.NEPPO_WEB_COOKIE) return env.NEPPO_WEB_COOKIE;

  const username = env.NEPPO_WEB_USERNAME || env.NEPPO_USERNAME;
  const password = env.NEPPO_WEB_PASSWORD || env.NEPPO_PASSWORD;
  if (!username || !password) return '';

  const body = new URLSearchParams();
  body.set('username', username);
  body.set('password', toBase64Utf8(password));
  body.set('verificationToken', '');

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

  if (!response.ok && response.status !== 302) {
    return '';
  }

  return cookieHeaderFrom(response);
}

async function fetchAttendanceHistory(protocol, env) {
  const match = String(protocol || '').match(/^WA0*(\d+)$/i);
  if (!match) {
    return jsonResponse({ ok: false, message: 'Protocolo inválido.' }, 400);
  }

  const cookie = await getNeppoWebCookie(env);
  if (!cookie) {
    return jsonResponse(
      {
        ok: false,
        message:
          'Conversa não configurada: salve NEPPO_WEB_USERNAME e NEPPO_WEB_PASSWORD no Worker, ou NEPPO_WEB_COOKIE como alternativa.',
      },
      424,
    );
  }

  const sessionId = match[1];
  const response = await fetch(
    `https://multsoft.neppo.com.br/chat/api/sessions/issue/history?id=${encodeURIComponent(sessionId)}&size=500`,
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
    return jsonResponse(
      {
        ok: false,
        status: response.status,
        message: `NEPPO retornou ${response.status} ao buscar a conversa.`,
        detail: text.slice(0, 500),
      },
      502,
    );
  }

  try {
    return jsonResponse({ ok: true, protocol, sessionId, messages: JSON.parse(text) });
  } catch {
    return jsonResponse({ ok: true, protocol, sessionId, text });
  }
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
