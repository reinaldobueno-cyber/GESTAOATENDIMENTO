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
    return 'window.CLIENTE_PRIVADO = {};';
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
    return 'window.CLIENTE_PRIVADO = {}; console.warn("Mapa privado de clientes não pôde ser aberto.");';
  }

  const aesKey = await crypto.subtle.importKey('raw', keys.aes, 'AES-CBC', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, data);
  return new TextDecoder().decode(plain);
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

export default {
  async fetch(request, env) {
    if (!env.AUTH_USER || !env.AUTH_PASSWORD) {
      return setupRequired();
    }

    if (!isAuthorized(request, env)) {
      return unauthorized();
    }

    const url = new URL(request.url);
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
