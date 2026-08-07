# Política operacional de retenção e exportação da auditoria

## Retenção

- A trilha `audit_log` é append-only para a aplicação.
- Não haverá exclusão automática pela aplicação.
- A retenção mínima operacional definida para a trilha é de cinco anos, contados do evento.
- Antes de qualquer descarte, a clínica deve obter validação jurídica/LGPD e executar uma revisão humana registrada. Dados que componham prontuário ou estejam sujeitos a outra obrigação devem seguir a regra mais longa aplicável.

## Exportação

- Só administrador pode solicitar uma exportação.
- Um segundo administrador, diferente do solicitante, deve aprovar.
- O pedido expira em 24 horas.
- O arquivo é gerado sob demanda, sempre com o redator central; não é persistido no banco nem em armazenamento externo pela aplicação.
- Solicitação, aprovação, negação e download devem gerar evento no `audit_log` sem valores sensíveis.

## Revisão

- A política será revisada trimestralmente pelo administrador responsável e por consultoria jurídica/LGPD quando houver alteração legal, incidente ou mudança de integração.
