# Auditoria da Planilha e Dashboard

Arquivo analisado: `c:\Users\Suporte2\Downloads\Base Atendimentos 2026 - Reinaldo V11 oficial(Recuperado Automaticamente) (Recuperado) (6).xlsx`
Gerado em: 11/05/2026 16:04:02

## Estrutura das abas

| Aba | Linhas usadas | Colunas usadas | Fórmulas | Erros visíveis |
|---|---:|---:|---:|---:|
| MENU | 1 | 1 | 0 | 0 |
| RESUMO | 45 | 33 | 488 | 0 |
| CALENDARIO | 24 | 34 | 460 | 0 |
| AGENTES | 37 | 14 | 325 | 2 |
| GRUPO | 782 | 35 | 1350 | 358 |
| PERIODOS | 19 | 16 | 140 | 20 |
| CALENDARIO-PERIODOS | 69 | 67 | 3407 | 0 |
| DIÁRIO | 445 | 10 | 0 | 0 |
| PROTOCOLOS_CLIENTES | 22742 | 12 | 7454 | 0 |
| BASE COMPLETA | 24196 | 22 | 92944 | 0 |
| CONFIG | 199 | 6 | 0 | 0 |

## Métricas recalculadas da BASE COMPLETA

| Mês | Atendimentos | Avaliações | Cobertura | CSAT | TMA min | TME seg | SLA <= 2min |
|---|---:|---:|---:|---:|---:|---:|---:|
| Jan | 1943 | 939 | 48.3% | 9.916 | 23.49 | 2.08 | 100% |
| Fev | 1704 | 855 | 50.2% | 9.903 | 23.78 | 1.44 | 100% |
| Mar | 1942 | 874 | 45% | 9.912 | 26.18 | 1.06 | 100% |
| Abr | 1687 | 826 | 49% | 9.891 | 31.39 | 1.1 | 100% |
| Mai | 178 | 96 | 53.9% | 9.833 | 30.01 | 5.67 | 100% |

## Comparação com aba RESUMO

| Métrica | Jan | Fev | Mar | Abr | Mai |
|---|---:|---:|---:|---:|---:|
| TME | 00:00:02 | 00:00:01 | 00:00:01 | 00:00:01 | 00:00:06 |
| Qtd. Avaliações | 939 | 855 | 874 | 826 | 96 |
| Qtd. Atendimentos | 1.943 | 1.704 | 1.942 | 1.687 | 178 |
| Satisfação Média | 9,92 | 9,90 | 9,91 | 9,89 | 9,83 |
| TMA | 00:23:30 | 00:23:47 | 00:26:11 | 00:31:24 | 00:30:01 |

## Top 10 grupos por mês na BASE COMPLETA

### Jan
- Estoque Animais: 546
- Reproducao: 515
- Infraestrutura: 310
- SISBOV: 123
- Retorno envio ativo: 116
- Confinamento: 110
- Financeiro: 68
- fila Suporte: 53
- PMG e Comunicacao para Associacao: 45
- Configuracao de balanca e bastao: 39

### Fev
- Estoque Animais: 484
- Reproducao: 447
- Infraestrutura: 285
- Confinamento: 116
- Retorno envio ativo: 87
- SISBOV: 83
- PMG e Comunicacao para Associacao: 71
- Configuracao de balanca e bastao: 50
- Financeiro: 40
- fila Suporte: 24

### Mar
- Estoque Animais: 551
- Reproducao: 524
- Infraestrutura: 275
- Confinamento: 128
- SISBOV: 122
- Retorno envio ativo: 117
- PMG e Comunicacao para Associacao: 69
- Financeiro: 65
- Configuracao de balanca e bastao: 55
- fila Suporte: 19

### Abr
- Estoque Animais: 524
- Reproducao: 392
- Infraestrutura: 285
- Confinamento: 128
- Retorno envio ativo: 86
- SISBOV: 73
- Financeiro: 69
- PMG e Comunicacao para Associacao: 62
- Configuracao de balanca e bastao: 49
- fila Suporte: 9

### Mai
- Estoque Animais: 64
- Infraestrutura: 36
- Reproducao: 27
- Confinamento: 15
- Retorno envio ativo: 11
- Configuracao de balanca e bastao: 8
- SISBOV: 6
- PMG e Comunicacao para Associacao: 6
- Financeiro: 4
- Agricola: 1

## Top agentes em Maio

- Raissa Ribeiro: 27 atend., 16 aval., CSAT 10
- Natalia Vieira: 22 atend., 12 aval., CSAT 9.9167
- Alexandre Lobo: 20 atend., 10 aval., CSAT 10
- Beatriz Araujo: 17 atend., 10 aval., CSAT 10
- Gabriel Freire: 16 atend., 4 aval., CSAT 10
- Marcus Silva: 16 atend., 11 aval., CSAT 9.9091
- Evelyn GonÃ§alves: 16 atend., 10 aval., CSAT 8.9
- Marcelo Costa: 16 atend., 7 aval., CSAT 9.7143
- Dhon Freitas: 13 atend., 7 aval., CSAT 10
- Marcelo Santos: 9 atend., 4 aval., CSAT 10
- Wiviane Borges: 6 atend., 5 aval., CSAT 9.8

## Dashboard HTML atual

- Mês de foco: Maio 2026
- Atendimentos no array: 1943, 1704, 1942, 1687, 178
- Avaliações no array: 939, 855, 874, 826, 96
- CSAT no array: 9,916, 9,903, 9,912, 9,891, 9,833
- Diário no array: 124 registros


## Erros de fórmula localizados

- `AGENTES`: `J6` e `J31` retornam `#DIV/0!` por média de faixas sem base válida.
- `GRUPO`: 358 erros em `W39:W...`, fórmula `=1/CONT.SES(...)`; acontece quando a combinação grupo/agente não existe e o divisor vira zero.
- `PERIODOS`: 20 erros em `N5:N14` e `R5:R14`; percentuais dividem por totais zerados (`$M$15` e `$Q$15`).

Esses erros não aparecem na aba `RESUMO`, mas poluem abas de detalhe e podem contaminar gráficos/tabelas quando a visão usa esses campos.
