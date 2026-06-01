import { BONUS_HTML_BASE64 } from './bonus-html.js';

function decodeHtml() {
  const binary = atob(BONUS_HTML_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function serveBonusHtml() {
  const headers = new Headers();
  headers.set('Content-Type', 'text/html; charset=UTF-8');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(decodeHtml(), { status: 200, headers });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/session') {
      return json({
        user: { user: 'Reinaldo Bueno', name: 'Reinaldo Bueno' },
        bonusPrivate: true,
        emergency: true,
      });
    }

    if (url.pathname === '/api/bonus-closures') {
      if (request.method === 'GET') return json({ items: [] });
      if (request.method === 'POST') {
        let body = {};
        try {
          body = await request.json();
        } catch {}
        return json({ ok: true, item: body, emergency: true });
      }
      return json({ error: 'Metodo nao permitido' }, 405);
    }

    return serveBonusHtml();
  },
};
