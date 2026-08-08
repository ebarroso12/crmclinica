# Plano técnico — Frente Codex (agenda, Google Calendar, usuários, contatos, banco, deploy)

Branch: `agent/codex-agenda-usuarios`
Base: `main` em `0e690d343f365ff3ca2e10c03ecd4499d940ebc2` (migrações 019 e 020 já incorporadas por outra frente; esta frente usa 021–024, conforme reserva).

Escopo exclusivo desta frente: P0-09 a P0-12 (sincronia transacional com o Google Calendar), P1-01 a P1-09 (usuários e contatos), P2-01, P2-02, P2-04, P2-08, P2-09, P2-10 (banco, painel, deploy, acessibilidade, qualidade) e P3-01 (onboarding). Não toca auditoria/segurança (ChatGPT) nem Serena/leads (Claude).

## Decisões de arquitetura

1. **O CRM é a fonte administrativa da verdade.** Toda escrita nasce no CRM; o Google é espelho. Mudança externa volta pela leitura incremental e é reconciliada.
2. **Outbox transacional.** A intenção de sincronizar é gravada na tabela `google_outbox` DENTRO da mesma transação da escrita no agendamento. Isso funciona sem costurar nada no `http.js`: os repositórios irmãos (`repositorio-google`) usam a conexão ambiente do `contexto.js` (AsyncLocalStorage), com a mesma serialização por cliente (`filasPorCliente`). A rota do agente (`/api/agente/acao`) roda fora do `comIdentidade`: lá o outbox é best-effort, e a reconciliação fecha a lacuna.
3. **Ids determinísticos no Google.** O evento do agendamento N é `crmagendamento-N`. Retry do outbox é seguro por construção: recriar devolve 409, tratado como sucesso — nunca evento duplicado.
4. **Concorrência por ETag.** PATCH e DELETE levam `If-Match` com o etag conhecido. 412 = edição concorrente → estado `conflito` + registro em `google_sincronia_conflitos`. Nunca retry cego sobre 412.
5. **Leitura incremental com syncToken.** Cursor gravado só depois da última página; `showDeleted=true`; 410 → full sync controlado com janela; full sync poda sombras ausentes.
6. **Estados de sincronia:** `ok`, `pendente`, `falhou`, `conflito`, com `sync_version` local, `origem_alteracao` (`crm`|`google`), `last_synced_at`, `last_sync_error`.
7. **Nada sensível no Google.** O evento leva só nome do contato, telefone, local e horários (o `montarEvento` já existente). Sem diagnóstico, motivo clínico ou observação.
8. **CPF/RG protegidos.** Cifrados com AES-256-GCM (chave derivada por HKDF do segredo JWT, rótulos de domínio separados para cifra e busca); busca exata por hash HMAC-SHA-256 sobre os dígitos normalizados. Documentos não saem no SELECT padrão: leitura dedicada (`obterDocumentosDo*`), com permissão e auditoria.
9. **Exclusão de usuário é lógica.** `excluido_em/por/motivo`; autoria histórica (audit_log, conversas, agendamentos) permanece. Suspender/excluir revoga sessões no mesmo gesto. Mudança de papel já é auditada (`papel_alterado`).
10. **Termos versionados.** `termos` (escopo, versão, um vigente por escopo) + `termo_assinaturas` referenciando a assinatura no provedor externo. O texto semeado é TEMPLATE, sujeito a revisão jurídica — não é redação jurídica definitiva.
11. **2FA obrigatório para master/admin.** Marca `p2f` no access token; o guarda do HTTP limita quem a carrega às rotas de conta até ativar o TOTP. Ligado por padrão; `CRMCLINICA_2FA_OBRIGATORIO=nao` só em desenvolvimento/teste.
12. **Módulos novos, poucas edições.** `public/app.js`, `http.js` e `repositorio.js` recebem só acréscimos pontuais; toda a lógica nova mora em módulos novos.

## Mapa tarefa → entregas

| ID | Entregas |
| --- | --- |
| P0-09 | `db/021_google_outbox.sql`, `src/dados/repositorio-google(.js|-memoria.js)`, `src/dominio/google-outbox.js`, `bin/worker-google-outbox.js` |
| P0-10 | `src/integracoes/google-calendario.js` (criar/atualizar/cancelar), enfileiramento em `agenda-servico.js` (criar/remarcar/cancelar) |
| P0-11 | `db/022_google_sincronia_inbound.sql`, `src/dominio/google-sincronia.js` (`sincronizar`: syncToken, paginação, excluídos, 410) |
| P0-12 | `src/dominio/google-sincronia.js` (`reconciliar`, `resolverConflito`), tabela `google_sincronia_conflitos` |
| P1-01 | `src/dominio/usuarios-servico.js` (`editarUsuario`), `PUT /api/equipe/:id` |
| P1-02 | `suspenderUsuario`/`reativarUsuario`/`excluirUsuario` (revogação de sessões, exclusão lógica), rotas `POST /api/equipe/:id/{suspender,reativar,excluir}` |
| P1-03 | `listarSessoes`/`revogarSessao`, rotas `GET /api/equipe/:id/sessoes`, `POST .../sessoes/:id/revogar` |
| P1-04 | marca `p2f` em `sessoes.js`, guarda em `http.js`, `pendenciasDeSegundoFator`, config `CRMCLINICA_2FA_OBRIGATORIO` |
| P1-05 | `db/023_usuarios_contatos.sql`, `src/seguranca/dados-sensiveis.js`, `definir/obterDocumentosDo{Usuario,Contato}`, rotas `/documentos` |
| P1-06 | `definirAutorizacaoWhatsappParticular`, rota `POST /api/equipe/:id/whatsapp-particular` |
| P1-07 | tabelas `termos`/`termo_assinaturas`, rotas `/api/termos*` |
| P1-08 | `registrarResponsavelDoContato`, rota `PUT /api/contatos/:id/responsavel` |
| P1-09 | `src/dominio/contatos-dedup.js`, `buscarCandidatosADuplicata`/`fundirContatos`, rotas `/api/contatos/dedup/*` |
| P2-01 | `db/024_indices_extensoes_qualidade.sql` (cada índice nomeia a consulta que atende) |
| P2-02 | `db/024`: schema `extensions`, `ALTER EXTENSION ... SET SCHEMA` guardado |
| P2-04 | painel `GET /api/sincronia/saude` + seção em `public/operacao.js` |
| P2-08 | `docs/DEPLOY-E-ROLLBACK.md` |
| P2-09 | ajustes de acessibilidade (alvos ≥ 44px, aria) em `public/estilo.css`/`index.html` |
| P2-10 | `src/dominio/qualidade-cadastral.js`, `GET /api/qualidade-cadastral`, visão `qualidade_cadastral_duplicidades` |
| P3-01 | `src/dominio/onboarding.js`, rotas `/api/onboarding/*`, ajuda contextual |

## Provas

- Suíte inteira verde (`node --test testes/*.test.js`, 729+ testes).
- Testes novos: outbox (retry, backoff, 409→sucesso, 412→conflito, obsolescência), sincronia (paginação, excluídos, 410→full sync, cursor só no fim), reconciliação e resolução de conflito, usuários (suspensão revoga sessão, 2FA obrigatório, documentos cifrados, WhatsApp, termos), dedup, qualidade, onboarding.
- E2E `ferramentas/smoke-google-sync.js`: app real + Google falso local, evidências CRM→Google e Google→CRM impressas.
