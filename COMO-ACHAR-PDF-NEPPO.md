# Como achar a chamada do PDF no NEPPO

Use isso quando o botão do NEPPO baixa um PDF, mas a barra do navegador não mostra link.

1. Abra o NEPPO no Chrome.
2. Aperte `F12`.
3. Clique na aba `Network` ou `Rede`.
4. Marque `Preserve log`.
5. No filtro, digite `pdf`. Se não aparecer nada, tente `issue`, `report`, `session`, `WA000`.
6. No NEPPO, clique para baixar/abrir o PDF do atendimento.
7. Na lista do Network, clique na requisição que apareceu.
8. Copie estas informações:
   - `Request URL`
   - `Request Method`
   - `Status Code`
   - `Content-Type`
   - se aparece `Authorization` em `Request Headers` ou se usa `Cookie`
9. Se o Chrome mostrar `Copy as cURL`, pode copiar e colar em um bloco de notas, mas antes apague valores de `Authorization`, `Cookie` e qualquer token.

O que eu preciso para integrar no painel:

- o formato do `Request URL`;
- se ele usa `GET` ou `POST`;
- se a URL tem o protocolo, por exemplo `WA00000119294`;
- se a URL tem o `sessionId`;
- se o retorno é `application/pdf`.

Não envie token, cookie ou senha.

## Depois que a rota foi identificada

O painel já usa esta rota:

`/pdf/WA00000119294`

Ela chama o NEPPO em:

`https://multsoft.neppo.com.br/chat/api/reports/downloadIssuePDF/WA00000119294`

Para funcionar no Cloudflare Worker, configure **uma** destas secrets em `Workers & Pages > gestaoatendimento > Settings > Variables and Secrets`:

- `NEPPO_WEB_AUTHORIZATION`: valor completo do header `Authorization`, se existir.
- `NEPPO_WEB_COOKIE`: valor completo do header `Cookie`, se o PDF usar cookie de sessão.

Use `Secret`, não `Text`, e configure em `Production`.
