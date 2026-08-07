# Política oficial da Serena no OpenClaw

Estes arquivos versionam as regras operacionais e a personalidade da Serena sem
substituir as demais instruções locais do workspace.

- `AGENTS.md`: limites, fluxo, valores, segurança, CRM e administradores.
- `SOUL.md`: tom acolhedor, carismático, breve e humano.
- `instalar.sh`: faz backup, substitui somente o bloco oficial V2, reinicia o
  serviço e verifica a instalação.

A instalação preserva todo o conteúdo local anterior. O bloco oficial é
delimitado por marcadores e pode ser atualizado de forma idempotente.

Uso no servidor, a partir de uma cópia verificada deste diretório:

```bash
chmod 700 instalar.sh
./instalar.sh
```

Destino padrão:

```text
/root/.openclaw-clinica/workspace-serena
```

Serviço padrão:

```text
openclaw-clinica.service
```

Para testar uma sessão já existente, envie `/new` sozinho pelo número sintético
de ensaio antes da próxima mensagem. Não abra o canal para pacientes reais antes
de concluir a matriz E2E da arquitetura B.
