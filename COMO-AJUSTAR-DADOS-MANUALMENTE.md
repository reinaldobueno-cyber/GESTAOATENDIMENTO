# Como ajustar dados manualmente

O caminho recomendado agora é pelo proprio site, a partir do atendimento que precisa de correcao:

1. Abra o atendimento pelo detalhe, historico, lista ou drill de algum indicador.
2. Clique em **Ajustar**.
3. Informe protocolo, motivo, acao e diario/evidencia.
4. Salve. O painel recalcula os indicadores tratados na hora.

O arquivo `manual-adjustments.js` continua existindo apenas como plano B tecnico.

Cada ajuste precisa ter `protocolo`, `motivo`, `acao` e, quando possivel, `diario`.

## Desconsiderar CSAT

Use quando a nota foi para produto, bot, plataforma ou outro assunto fora do atendimento.

```js
{
  protocolo: "WA00000123456",
  tipo: "csat_produto",
  desconsiderarCsat: true,
  motivo: "Cliente avaliou o produto, nao o atendimento.",
  acao: "Desconsiderar CSAT do calculo mensal.",
  diario: "Registro validado no diario operacional.",
  responsavel: "Reinaldo",
  data: "27/05/2026"
}
```

## Corrigir CSAT

```js
{
  protocolo: "WA00000123456",
  tipo: "corrigir_csat",
  csat: 10,
  motivo: "Nota corrigida apos conferencia do atendimento.",
  acao: "Substituir CSAT bruto.",
  diario: "Ajuste validado no fechamento."
}
```

## Corrigir TMA ou TE

O tempo deve ser informado em segundos.

```js
{
  protocolo: "WA00000123456",
  tipo: "problema_plataforma",
  tmaSec: 600,
  tmeSec: 0,
  motivo: "Instabilidade da plataforma contaminou o tempo bruto.",
  acao: "Ajustar TMA/TME para refletir o atendimento real.",
  diario: "Evidencia registrada no diario operacional."
}
```

## Ignorar atendimento inteiro

Use com cuidado, somente quando o protocolo nao deve compor nenhum indicador.

```js
{
  protocolo: "WA00000123456",
  tipo: "duplicado_ou_erro",
  ignorarAtendimento: true,
  motivo: "Registro duplicado ou atendimento invalido.",
  acao: "Retirar atendimento dos indicadores tratados.",
  diario: "Conferido no fechamento."
}
```

Depois de alterar, publique novamente na Cloudflare com `Publicar-Cloudflare-Agora.cmd`.
