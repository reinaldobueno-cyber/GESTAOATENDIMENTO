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
