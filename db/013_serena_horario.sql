-- 013 — Horário programado, pausa e plantão da Serena
--
-- O interruptor de 011 responde "a Serena está ligada?". A operação precisa de
-- três perguntas que ele não responde:
--
-- 1. **"Ela atende a que horas?"** Sem grade, ou a clínica deixa a automação
--    respondendo às 3h da manhã, ou alguém desliga à mão toda noite e liga toda
--    manhã — e um dia esquece de ligar. O esquecimento é silencioso: ninguém
--    percebe que a Serena está muda, porque mudo é o estado normal de quem não
--    recebeu mensagem ainda.
--
-- 2. **"Dá para calar por dez minutos?"** Quando alguém da equipe assume uma
--    conversa difícil, desligar a Serena inteira é grande demais e desligar só
--    aquela conversa é pequeno demais. A pausa global com prazo resolve: cala
--    tudo, e volta sozinha. O prazo é a parte que importa — pausa sem prazo é
--    desligamento que ninguém lembra de desfazer.
--
-- 3. **"Dá para atender neste sábado?"** Editar a grade para um sábado e depois
--    lembrar de desfazer é o mesmo esquecimento do item 1, ao contrário. O
--    plantão tem prazo e não toca na grade.
--
-- Tudo em `timestamptz`: prazo gravado sem fuso é prazo que muda de significado
-- conforme quem lê.
--
-- Aplicar depois de 012.

BEGIN;

ALTER TABLE serena_configuracao
  -- A grade. `jsonb` e não tabela filha porque isto é editado como um documento
  -- inteiro — a tela salva os sete dias de uma vez — e nunca é consultado por
  -- partes. Uma tabela `serena_horarios` daria sete linhas para ler, escrever e
  -- manter em transação, para responder a mesma pergunta.
  --
  -- Forma: {"ativa": bool, "fuso": "America/Sao_Paulo",
  --         "dias": {"0".."6": [["08:00","18:00"], ...]}}
  --
  -- `ativa: false` (ou coluna nula) = sem limite de horário. A ausência de
  -- configuração nunca pode virar silêncio: quem não entrou na tela não pediu
  -- para calar nada.
  ADD COLUMN IF NOT EXISTS agenda jsonb,

  -- Pausa global com prazo. Nula ou no passado = não vigora.
  ADD COLUMN IF NOT EXISTS pausada_ate timestamptz,

  -- Plantão esporádico: responde fora do horário até este instante.
  ADD COLUMN IF NOT EXISTS ligada_ate timestamptz;

-- A grade precisa ser um objeto. Um array ou um número aqui viraria "a Serena
-- não responde de manhã" sem nada no log — o pior tipo de defeito de dados.
ALTER TABLE serena_configuracao
  DROP CONSTRAINT IF EXISTS serena_agenda_e_objeto;
ALTER TABLE serena_configuracao
  ADD CONSTRAINT serena_agenda_e_objeto
  CHECK (agenda IS NULL OR jsonb_typeof(agenda) = 'object');

COMMENT ON COLUMN serena_configuracao.agenda IS
  'Grade de horários: {ativa, fuso, dias:{"0".."6":[[inicio,fim]]}}. Nula = sem limite.';
COMMENT ON COLUMN serena_configuracao.pausada_ate IS
  'Pausa global com prazo, para intervenção humana. Vence sozinha.';
COMMENT ON COLUMN serena_configuracao.ligada_ate IS
  'Plantão: responde fora do horário até este instante. Não toca na grade.';

COMMIT;
