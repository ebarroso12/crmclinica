# crmclinica

Base nova do sistema de atendimento da Clínica Dr. Edson Barroso.

## Arquitetura

- OpenClaw: controlador de eventos, ferramentas e tarefas.
- Serena: agente de atendimento, barreiras clínicas e escalonamento humano.
- CRM: fonte de verdade para contatos, leads, conversas, mensagens e tarefas.
- Prontuário: sistema clínico existente, acessado somente por ferramentas autorizadas.
- Canais: WhatsApp, Instagram, site e formulário como adaptadores independentes.

O n8n não participa do fluxo novo. O sistema antigo fica separado como legado.

## Segurança

Nunca coloque chaves reais neste repositório. Copie `.env.exemplo` para `.env` apenas no ambiente local e mantenha os segredos fora do Git.

## Estado

Esta é a fundação inicial. Nenhuma mensagem real, paciente real ou banco de produção é acessado por este código ainda.
