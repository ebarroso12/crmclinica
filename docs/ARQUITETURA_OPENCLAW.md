# Arquitetura do crmclinica

## Decisão

O `crmclinica` não usará n8n no fluxo principal. O OpenClaw será o controlador de eventos e ferramentas; a Serena será o agente de atendimento; o CRM será a fonte de verdade operacional; e o prontuário existente continuará sendo o sistema clínico.

```text
WhatsApp / Instagram / Site / Formulário
                 ↓
          Adaptadores de canal
                 ↓
       OpenClaw — controle e tarefas
                 ↓
       Serena — conversa e barreiras
                 ↓
 CRM — contatos, leads, mensagens e agenda
                 ↓
 Prontuário — acesso mínimo e autorizado
```

Kimi pode ser apenas um provedor de modelo dentro da Serena/OpenClaw. KimiClaw não é uma dependência da arquitetura.

## Regras de fronteira

- OpenClaw não guarda prontuário nem substitui o CRM.
- Serena não diagnostica, prescreve, interpreta exame ou promete resultado clínico.
- O CRM grava evento recebido, resposta, responsável, tarefa e auditoria.
- O prontuário só é consultado por ferramenta autorizada e com escopo mínimo.
- Cada evento externo recebe uma chave idempotente antes de gerar resposta ou tarefa.
- Webhooks exigem HTTPS, assinatura/segredo, limite de tamanho e proteção contra replay.
- Segredos ficam em variáveis do ambiente; nunca em código, Git ou prompt.

## Primeiro MVP

1. health check e configuração segura;
2. adaptador de entrada WhatsApp;
3. consulta/criação de contato e conversa no CRM;
4. chamada da Serena pelo OpenClaw;
5. gravação da resposta e escalonamento humano;
6. fila de tarefas para follow-up;
7. teste com número separado antes do número oficial.

Agenda, Instagram, documentos, pré-consulta e follow-ups clínicos entram depois que o ciclo básico estiver auditado.

## Não fazer nesta base

- não copiar a tabela genérica `patients` do protótipo anterior;
- não usar `service_role` diretamente no navegador;
- não expor um webhook HTTP aberto na porta 4000;
- não enviar o prontuário inteiro para o modelo;
- não ligar o número oficial antes de testes de duplicidade, crise e atendimento humano.
