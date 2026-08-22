# Agenda real — TribeMD → Google → crmclinica

**Problema que este acoplamento resolve:** a Serena oferecia e marcava horários
"sem critério" porque a agenda que ela consultava (a do CRM) não refletia a
agenda real do Dr. Edson, que vive no **TribeMD**. Ela confirmava horário que
já estava ocupado e em horas em que a clínica não atendia.

**Decisão da clínica (2026-08):** a Serena **só propõe** horários; quem
confirma a consulta é a **recepção**, no TribeMD, como sempre fez.

## O desenho

```
TribeMD (agenda real, medico_id 56528)
   │  sincronia nativa do TribeMD com o Google Agenda
   ▼
Google Calendar do Dr. Edson
   │  leitura ao vivo (google-agenda.js → ocupados({de, ate}))
   ▼
oferecerHorarios() — cruza: disponibilidade do profissional
                    menos bloqueios, menos agendamentos do CRM,
                    MENOS o que está ocupado no Google
   │
   ▼
Serena chama consultar_horarios (POST /api/agente/acao)
→ ela só consegue oferecer o que está livre DE VERDADE
→ paciente escolhe → Serena registra o interesse no lead
→ recepção confirma no TribeMD → o horário vira ocupado no Google
→ ninguém mais o oferece
```

Nenhum dado clínico atravessa essa linha: o que o CRM lê do Google são
intervalos ocupados (início/fim), não o conteúdo dos compromissos.

## Por que não scrapear a tela do TribeMD

A agenda web do TribeMD exige sessão autenticada e muda sem aviso. Uma
raspagem quebraria em silêncio — exatamente o tipo de falha que este projeto
está fechando. A porta oficial é a sincronia com o Google Agenda, que o
TribeMD já oferece.

## Configuração (passo a passo)

### 1. No TribeMD — ligar a sincronia

Nas configurações da agenda do Dr. Edson no TribeMD, ative a sincronia com o
Google Agenda apontando para **a mesma conta Google configurada no CRM**
(`GOOGLE_AGENDA_USUARIO`). Se o TribeMD criar um calendário próprio dentro
dessa conta (ex.: "TribeMD"), anote o nome/id dele para o passo 3.

### 2. Na Vercel — variáveis de ambiente

```
GOOGLE_AGENDA_CREDENCIAL   (já existe — conta de serviço)
GOOGLE_AGENDA_USUARIO      (já existe — conta Google do médico)
GOOGLE_AGENDA_CALENDARIO   (id do calendário que recebe o TribeMD;
                            padrão 'primary')

# Novas, desta mudança:
CRMCLINICA_AGENTE_PROFISSIONAL_ID=<id do Dr. Edson no CRM>
# CRMCLINICA_AGENTE_PODE_AGENDAR  → NÃO definir (padrão: desligado)
```

**Para descobrir o id do Dr. Edson no CRM:** painel → Agenda → Profissionais,
ou `GET /api/agenda/profissionais`. Se ele ainda não existir como
profissional, cadastre com a disponibilidade (janelas de atendimento) — é ela
que define os horários oferecíveis; o Google só remove os ocupados.

> Se `CRMCLINICA_AGENTE_PROFISSIONAL_ID` apontar para um profissional
> inexistente ou inativo, `consultar_horarios` devolve lista vazia — de
> propósito: melhor nenhum horário do que o horário do médico errado.

### 3. No OpenClaw — as instruções da Serena (regra rígida de agenda)

Acrescentar ao TOOLS.md / system prompt da Serena:

```text
## Agenda — regras que não têm exceção

- NUNCA ofereça dia ou horário sem antes chamar a ação consultar_horarios.
  Ofereça apenas horários devolvidos por ela, usando o campo "quando" que já
  vem formatado (ex.: "quinta-feira, 28/08, 14:00"). Não converta datas você
  mesma.
- Você NÃO marca consulta. Quando o paciente escolher um horário, registre o
  interesse com qualificar_lead (campo disponibilidade) e responda:
  "Perfeito, anotei sua preferência para {quando}. Nossa recepção vai
  confirmar o horário aqui pelo WhatsApp ainda hoje."
- Se consultar_horarios devolver uma lista vazia, diga que no momento não há
  vagas naquela semana e que a recepção entrará em contato para combinar.
- NUNCA diga "está marcado", "confirmado" ou equivalente. Quem confirma
  consulta é a recepção.
- Se o paciente pedir para remarcar ou cancelar, registre com
  enviar_resumo_equipe e informe que a recepção cuidará disso.
```

## Verificação antes de ligar para pacientes

1. Crie no Google Calendar do médico um evento de teste amanhã, 14h–15h
   ("TESTE — apagar").
2. No painel do CRM, `/api/agente/acao` com `acao: consultar_horarios`
   (ou peça horários na conversa de teste da Serena): o intervalo 14h–15h de
   amanhã **não pode** aparecer.
3. Apague o evento de teste; repita: o horário volta a aparecer.
4. Se o passo 2 falhar, a leitura do Google está quebrada — **não ligue a
   Serena para pacientes** até resolver (ver diagnóstico abaixo).

## Modos de falha e o que acontece em cada um

| Falha | Efeito | Defesa |
| --- | --- | --- |
| Google fora do ar | `ocupadosNoGoogle` devolve `[]` e registra erro no log; a oferta continua, mas sem a visão do Google | A recepção confirma tudo no fim — o pior caso é ela oferecer outro horário ao paciente |
| TribeMD demora a sincronizar com o Google (minutos) | Um horário recém-ocupado ainda aparece livre por alguns minutos | Mesma defesa: confirmação humana |
| `GOOGLE_AGENDA_CALENDARIO` aponta para o calendário errado | Serena oferece horários ignorando a agenda real | Passo 2 da verificação pega isso antes de ir ao ar |
| Profissional errado em `CRMCLINICA_AGENTE_PROFISSIONAL_ID` | Lista vazia (id inativo) ou agenda de outra pessoa | Lista vazia é segura; agenda errada é pega pela verificação |

## O que mudou no código (referência)

- `src/config.js` — `agente.podeAgendar` (padrão **desligado**) e
  `agente.profissionalId` (`CRMCLINICA_AGENTE_PODE_AGENDAR`,
  `CRMCLINICA_AGENTE_PROFISSIONAL_ID`).
- `src/servidor/rotas-agente.js` — barreira física do `agendar` (sem a flag,
  devolve `agendado: false, motivo: 'agendamento_pela_recepcao'` e não grava
  nada) e seleção do profissional configurado em `consultar_horarios`.
- Testes: `testes/agente-http.test.js` (barreira, flag, profissional certo,
  id inválido).
