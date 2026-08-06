# ADR — Handoff humano por conversa na Serena

**Data:** 2026-08-06
**Status:** decidido — Arquitetura A classificada incompatível com handoff por conversa; Arquitetura B preparada para ensaio
**Contexto:** bloqueio P0.1 da estabilização final. Sem provar que uma conversa assumida
pela equipe fica silenciosa **sem desligar o atendimento dos demais pacientes**, a
Serena permanece desligada no WhatsApp.

---

## O problema

Quando alguém da equipe assume uma conversa, a Serena precisa calar **naquela conversa**
e continuar atendendo todas as outras. Hoje o único controle que o CRM exerce sobre o
agente do canal é global: `dmPolicy = open` (atende todo mundo) ou `allowlist` com
`allowFrom = []` (não atende ninguém). É um interruptor de disjuntor — serve para
ligar e desligar a clínica inteira, não para o handoff de um paciente.

### Por que allowFrom com "todos os telefones menos um" está vetado

1. `allowFrom` é **allowlist**, não denylist: para calar um número, seria preciso listar
   todos os outros — e paciente novo, ainda desconhecido, ficaria bloqueado por omissão.
2. A lista cresceria sem limite e viraria o cadastro paralelo de quem já escreveu.
3. Dois handoffs simultâneos fariam duas leituras e duas escritas da mesma lista — o
   segundo `config.set` sobrescreveria o primeiro (o `baseHash` do gateway recusa a
   segunda escrita, mas aí o segundo handoff **falha**, o que também não serve).
4. Reescrever a configuração exige `operator.admin` — poder de administração usado como
   ferramenta de rotina.
5. O formato canônico do número em `allowFrom` (nono dígito, prefixo `+`) nunca foi
   comprovado contra o gateway real.
6. Errar qualquer um dos itens acima interrompe o atendimento de TODOS os pacientes.

## O que o gateway real oferece (sondado em 2026-08-06, somente leitura)

Sonda contra a instância da clínica (gateway `2026.7.x`, 220 métodos no `hello`),
sem nenhuma escrita:

| Capacidade investigada | Resultado | Classificação |
| --- | --- | --- |
| Pausa por sessão (`*.pause`, `*.mute`, `*.silence`) | Nenhum método com esses nomes existe | **NÃO EXISTE (COMPROVADO)** |
| Campo de pausa/política no objeto de sessão | `sessions.list` devolve ~30 campos por sessão (`archived`, `pinned`, `thinkingLevels`, custos…) — nenhum de pausa ou resposta automática | **NÃO ENCONTRADO (COMPROVADO na resposta atual)** |
| `sessions.patch` | Existe; exige `key`. O conjunto de campos aceitáveis não está documentado nem foi sondado com escrita | **NÃO COMPROVADO** |
| Política por sessão na configuração | `config.schema.lookup('channels.whatsapp')`: `enabled`, `dmPolicy` (`open`/`allowlist`/`pairing`), `allowFrom`, `groupPolicy`, `groupAllowFrom`, `defaultTo`, prefixos, limites — nada por sessão, nada de denylist | **NÃO EXISTE (COMPROVADO no schema)** |
| Denylist | Não há campo de negação no schema do canal | **NÃO EXISTE (COMPROVADO no schema)** |
| Hook de ingresso / middleware / filtro pré-agente | Nada no `hello` (métodos e eventos) com essa semântica | **NÃO ENCONTRADO** |
| Roteamento por contato / agent binding por sessão | Cada sessão carrega `agent:serena:main`; `agents.list/create/update` existem. Vincular um "agente mudo" a uma sessão específica não tem método visível | **INFERIDO possível, NÃO COMPROVADO** |
| Canal conectado sem resposta automática global | `dmPolicy=allowlist` + `allowFrom=[]` — é o estado ATUAL da instância (lido no `config.get`): telefone vinculado, mensagens chegando, agente calado | **COMPROVADO** |
| Envio pelo canal sem acionar o agente | Método `send` — já usado em produção pelos lembretes e pela resposta da equipe (`canal.enviar`) | **COMPROVADO** |
| Instruções do agente por RPC | `agents.files.list/get/set` — caminho para alinhar o USER.md da Serena à política do CRM | **EXISTE, uso NÃO ENSAIADO** |

## Decisão

### Arquitetura A — o OpenClaw responde direto no canal

**Classificada INCOMPATÍVEL com handoff humano por conversa**, pelo critério fixado:
o gateway não oferece pausa individual real. Com o agente respondendo sozinho no canal,
o CRM não tem onde interpor a regra "esta conversa está com a equipe" — as gates de
`assumida_por_humano`, pausa e horário existem no CRM, mas o agente não as consulta.

A Arquitetura A permanece válida para o que ela já faz bem: importação de histórico
(`sincronia-conversas.js`, estratégia `openclaw_gerencia`) e operação liga/desliga
global (`openclaw-politica.js`).

### Arquitetura B — o CRM é o dono da resposta

**Preparada nesta branch; publicação condicionada ao E2E de ensaio.**

```
WhatsApp conectado (dmPolicy=allowlist, allowFrom=[] — estado atual)
→ resposta automática direta: desabilitada (é o estado de hoje)
→ CRM importa a mensagem (sincronia-conversas)
→ CRM verifica, na ordem: Serena globalmente ativa? dentro do horário?
  conversa assumida? conversa pausada? mensagem duplicada?
  (tudo já existe: serena.podeResponder + idempotência por id_externo)
→ só então aciona a Serena headless
  (despacharEvento com sessão interna, linha de base e correlação por runId —
   implementado nesta branch; sem sessão configurada, falha fechado)
→ envia a resposta pelo adaptador do canal (método `send`, o mesmo dos lembretes)
→ grava a saída no histórico e audita cada passo
```

O handoff por conversa vira consequência natural: `assumir()` já pausa a automação
**no CRM**, e na Arquitetura B é o CRM que responde — logo a conversa assumida cala
sem tocar nenhuma configuração global, e os demais pacientes seguem atendidos.

### Arquitetura híbrida

Descartada por ora: dependia de pausa real por sessão, que não foi comprovada. Se uma
versão futura do gateway expuser `sessions.patch` com campo de política de resposta
(ou agent binding por sessão), a decisão pode ser revisitada — a sonda está descrita
acima e é reproduzível.

## Consequências

1. **Religar a Serena na Arquitetura A está vetado** enquanto o handoff por conversa
   for exigência — e ele é (P0.1).
2. O caminho para religar é o ensaio da Arquitetura B: instância/número de ensaio,
   `OPENCLAW_SESSION_ID` de uma sessão interna dedicada, `LEMBRETES_MODO_ENTREGA`
   e adaptador de canal apontados para o ensaio, e os E2E A–E do plano de
   estabilização executados.
3. A mudança de estratégia do sincronizador (`openclaw_gerencia` → `crm_despacha`)
   é UMA linha por desenho — mas só muda em ambiente de ensaio, nunca direto em
   produção.
4. Alinhar as instruções do agente (USER.md) via `agents.files.set` passa a ser um
   passo de operação possível por RPC; segue NÃO ENSAIADO e fora desta branch.

## O que fica em aberto

- Contrato de escrita de `sessions.patch` (campos aceitos) — exige ensaio de escrita
  em instância que não seja a de produção.
- Formato canônico de número em `allowFrom` — irrelevante na Arquitetura B, registrado
  por honestidade.
- E2E A–E (duplicação, releitura, resposta antiga, concorrência, handoff) — pendentes
  de ambiente de ensaio; ver o relatório de integração.
