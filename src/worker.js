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
    'Proteção pendente: configure AUTH_USER e AUTH_PASSWORD nas variáveis do Worker na Cloudflare.',
    {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=UTF-8',
        'Cache-Control': 'no-store',
      },
    },
  );
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
  const keys = await derivePrivateMapKeys(env.AUTH_PASSWORD, salt, iterations);

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

  return (
    timingSafeEqual(user, env.AUTH_USER || '') &&
    timingSafeEqual(password, env.AUTH_PASSWORD || '')
  );
}

function pdfAuthRequired() {
  return new Response(
    'PDF pendente: configure NEPPO_CLIENT_KEY, NEPPO_CLIENT_SECRET, NEPPO_USERNAME e NEPPO_PASSWORD no Worker.',
    {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=UTF-8',
        'Cache-Control': 'no-store',
      },
    },
  );
}

async function getNeppoAccessToken(env) {
  if (!env.NEPPO_CLIENT_KEY || !env.NEPPO_CLIENT_SECRET || !env.NEPPO_USERNAME || !env.NEPPO_PASSWORD) {
    return null;
  }

  const basic = btoa(`${env.NEPPO_CLIENT_KEY}:${env.NEPPO_CLIENT_SECRET}`);
  const body = new URLSearchParams();
  body.set('grant_type', 'password');
  body.set('username', env.NEPPO_USERNAME);
  body.set('password', env.NEPPO_PASSWORD);

  const response = await fetch('https://api-auth.neppo.com.br/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`auth ${response.status}`);
  }

  const data = await response.json();
  return data.access_token || null;
}

async function fetchIssuePdf(protocol, env) {
  if (!/^WA\d{8,}$/.test(protocol)) {
    return new Response('Protocolo inválido.', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'Cache-Control': 'no-store' },
    });
  }

  const token = await getNeppoAccessToken(env);
  if (!token) return pdfAuthRequired();

  const headers = new Headers();
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Accept', 'application/json, text/plain, */*');
  headers.set('Content-Type', 'application/json;charset=UTF-8');
  headers.set('Origin', 'https://multsoft.neppo.com.br');
  headers.set('Referer', 'https://multsoft.neppo.com.br/');
  headers.set('X-Requested-With', 'XMLHttpRequest');

  const neppoResponse = await fetch(
    `https://multsoft.neppo.com.br/chat/api/reports/downloadIssuePDF/${protocol}`,
    {
      method: 'POST',
      headers,
      body: 'null',
    },
  );

  if (!neppoResponse.ok) {
    return new Response(`Não consegui baixar o PDF no NEPPO. Status ${neppoResponse.status}.`, {
      status: neppoResponse.status,
      headers: {
        'Content-Type': 'text/plain; charset=UTF-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  const responseHeaders = new Headers();
  responseHeaders.set('Content-Type', 'application/pdf');
  responseHeaders.set('Cache-Control', 'private, no-store');
  responseHeaders.set('Content-Disposition', `inline; filename="Issue_${protocol}.pdf"`);
  return new Response(neppoResponse.body, { status: 200, headers: responseHeaders });
}

export default {
  async fetch(request, env) {
    if (!env.AUTH_USER || !env.AUTH_PASSWORD) {
      return setupRequired();
    }

    if (!isAuthorized(request, env)) {
      return unauthorized();
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith('/pdf/')) {
      const protocol = decodeURIComponent(url.pathname.replace('/pdf/', '')).trim();
      return fetchIssuePdf(protocol, env);
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
