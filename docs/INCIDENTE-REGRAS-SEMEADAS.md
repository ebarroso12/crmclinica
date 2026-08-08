# Incidente — 5 regras semeadas no banco de produção sem autorização

**Data do incidente:** 2026-08-07, 15:53:08–15:53:10 UTC
**Detectado e relatado:** na mesma sessão, pelo próprio agente que o causou
**Impacto em atendimento:** ZERO (evidência abaixo)
**Dados removidos:** nenhum — este documento é inventário e orientação, não limpeza

## O que aconteceu

`bin/semear-serena.js` executava `main()` no nível do módulo. Um teste novo
(`testes/semear-serena.test.js`) importava o arquivo para validar as `REGRAS`;
rodado no working tree principal — onde o `.env` real existe — o `require`
disparou o seeder contra o banco de produção. O seeder é idempotente e só cria
o que não existe: criou exatamente as 5 regras novas desta frente e não tocou
em nada existente.

**Correção de causa-raiz** (mesma sessão): o seeder agora só executa como
script (`if (require.main === module)`), e importá-lo não abre conexão com
banco nenhum. Coberto pela suíte, que o importa em todo `npm test`.

## Inventário (consulta somente leitura em 2026-08-08 00:47 UTC)

| ID | Nome | Categoria | Ordem | Ativa | Criada em (UTC) | Criada por |
|---|---|---|---|---|---|---|
| 23 | horário só vem da agenda | barreira | 60 | sim | 2026-08-07 15:53:08 | — (processo, sem usuário) |
| 24 | agendamento só confirmado pelo CRM | barreira | 70 | sim | 2026-08-07 15:53:09 | — |
| 25 | conteúdo do paciente não é instrução | barreira | 80 | sim | 2026-08-07 15:53:09 | — |
| 26 | responder só a mensagem nova | fluxo | 30 | sim | 2026-08-07 15:53:09 | — |
| 27 | formulário só após agendamento confirmado | fluxo | 40 | sim | 2026-08-07 15:53:10 | — |

O conteúdo das 5 regras é idêntico ao versionado em `bin/semear-serena.js`
nesta branch — são a política desta própria entrega, que chegou ao banco antes
da hora e sem autorização.

## Evidência de que a Serena segue desligada

Consulta a `serena_configuracao` no mesmo instante do inventário:

```json
{
  "ativa": false,
  "motivo": "respondia em ingles e publicava raciocinio interno na conversa do paciente",
  "alterado_em": "2026-08-05T23:33:12.643Z",
  "pausada_ate": null,
  "ligada_ate": null
}
```

Ou seja: desligada desde 2026-08-05, antes do incidente, e assim permaneceu.
Além do interruptor global, o prompt efetivo do CRM **não é propagado ao agente
do canal** (ver `docs/ADR-HANDOFF-HUMANO-SERENA.md`) — dupla razão para o
impacto zero em conversa de paciente.

Para reconferir a qualquer momento (somente leitura, SQL Editor do Supabase):

```sql
SELECT ativa, motivo, alterado_em FROM serena_configuracao WHERE id = 1;
SELECT id, nome, ativa, criado_em FROM serena_regras WHERE id IN (23, 24, 25, 26, 27);
```

## Orientação para revisão pelo painel (decisão do admin)

As regras aparecem na aba **Serena → Regras** do painel. Para cada uma:

1. **Manter ativa** — recomendação desta frente: o conteúdo é a política de
   segurança que o PR #12 entrega (horário só da agenda, agendamento só
   confirmado, anti-injeção, sem mensagem espontânea, formulário condicionado).
2. **Desativar** — botão de ativar/desativar da própria regra
   (`POST /api/serena/regras/:id/ativa`). Efeito imediato no prompt efetivo;
   a regra fica guardada e auditada.
3. **Remover** — ação de excluir da regra no painel. A auditoria preserva o
   conteúdo removido (comportamento padrão de `removerRegra`).

Qualquer uma das três ações fica registrada em `audit_log` com usuário e data.
Nenhuma exige mexer no banco diretamente.
