# Arquitetura do crmclinica

## Decisão

O `crmclinica` é um projeto novo, sem orquestrador visual externo. O **OpenClaw** orquestra
eventos, ferramentas e tarefas; a **Serena** é o agente de atendimento e aplica as barreiras
clínicas; o **CRM** é a fonte de verdade operacional; e o prontuário existente continua sendo
o sistema clínico. O **Kimi** é um provedor opcional de modelo — troca-se ou desliga-se sem
alterar o produto.

```text
WhatsApp / Instagram / Site / Formulário
                 ↓
          Adaptadores de canal
                 ↓
        Contrato de eventos  ← única porta de entrada, com idempotência
                 ↓
    OpenClaw — orquestração de eventos, ferramentas e tarefas
                 ↓
     Serena — conversa, triagem e barreiras clínicas
                 ↓
  CRM — contatos, leads, mensagens, agenda e auditoria
                 ↓
  Prontuário — acesso mínimo e autorizado
```

O provedor de modelo fica atrás da Serena e do OpenClaw. Ele não aparece no contrato do CRM,
não decide encaminhamento e não é pré-requisito para o sistema operar.

## Regras de fronteira

- O OpenClaw orquestra, mas não guarda prontuário nem substitui o CRM.
- A Serena não diagnostica, não prescreve, não interpreta exame e não promete resultado clínico.
- O CRM grava evento recebido, resposta, responsável, tarefa e trilha de auditoria.
- O prontuário só é consultado por ferramenta autorizada e com escopo mínimo.
- Cada evento externo recebe chave idempotente **antes** de gerar resposta ou tarefa.
- Webhook exige HTTPS, assinatura conferida antes da interpretação do corpo, teto de tamanho e proteção contra reenvio.
- Segredos vivem em variáveis de ambiente. Nunca em código, Git, navegador ou prompt versionado.
- O provedor de modelo é substituível: nenhuma regra de atendimento pode depender de qual modelo responde.

## Contrato de eventos

Implementado em `src/contratos/evento.js` e detalhado em [`CONTRATOS_DE_EVENTOS.md`](CONTRATOS_DE_EVENTOS.md).

A chave de idempotência é `sha256(versão | canal | tipo | id_externo)` — derivada de identidade,
nunca de conteúdo. Reenviar o mesmo evento com o texto corrigido continua sendo o mesmo evento,
e o CRM devolve o recibo original em vez de abrir uma segunda conversa.

## Camadas do código

| Camada | Responsabilidade | Depende de |
| --- | --- | --- |
| `servidor/` | HTTP, roteamento, cabeçalhos, leitura de corpo | contratos, domínio, integrações |
| `contratos/` | Validar e normalizar tudo que entra | nada |
| `dominio/` | Regras do CRM | config |
| `integracoes/` | Falar com o orquestrador | config |
| `provedores/` | Falar com um modelo (opcional) | nada |
| `armazenamento/` | Persistir idempotência | nada |

As dependências apontam sempre para dentro. `contratos/` não conhece HTTP; `provedores/` não
conhece o CRM. Trocar o orquestrador ou o provedor toca um arquivo só.

## Primeiro MVP

1. health check, configuração validada e cabeçalhos de segurança — **feito**;
2. contrato de eventos com idempotência — **feito**;
3. interface operacional com painel, conversas, leads, agenda, Serena e auditoria — **feito**;
4. adaptador de entrada do WhatsApp;
5. consulta/criação de contato e conversa no CRM, com banco ligado;
6. chamada da Serena orquestrada pelo OpenClaw;
7. gravação da resposta e escalonamento humano;
8. fila de tarefas para follow-up;
9. teste com número separado antes do número oficial.

Agenda, Instagram, documentos, pré-consulta e follow-ups clínicos entram depois que o ciclo
básico estiver auditado.

## Não fazer nesta base

- não copiar a tabela genérica de pacientes do protótipo anterior;
- não usar chave de serviço do banco diretamente no navegador;
- não expor webhook HTTP aberto, sem assinatura;
- não enviar o prontuário inteiro para o modelo;
- não ligar o número oficial antes de testes de duplicidade, crise e atendimento humano;
- não deixar o produto depender de um provedor de modelo específico.
