/**
 * [fork wallaceleite] Os blocos que o Método DEF põe no SUFIXO por-lead do
 * prompt: a etapa (texto do documento 02), o que falta para sair dela, as frases
 * da Matriz, a ficha e o modo do turno (passagem, urgência, objeção…).
 *
 * Volátil por natureza — muda a cada turno — e por isso NUNCA vai no prefixo
 * estável (regra do cache de prompt, `edge/llm/stable-prefix.ts`).
 */
import { descreverVaga, type HorarioDef, type VagaOferecida } from './agenda';
import { PASSO_DO_FUNIL_DA_ETAPA, type DecisaoDef } from './roteador';
import type { BlocoDef, FichaDef, PassagemDef, RoteiroDef } from './tipos';

/** O que a agenda decidiu neste turno (ausente = roteiro sem agenda). */
export interface AgendaDoTurno {
  /** As vagas a oferecer agora (vazio = nenhuma serve). */
  vagas: VagaOferecida[];
  /** A vaga que a família escolheu e ficou segura para ela. */
  reservada: HorarioDef | null;
  /** A família escolheu um horário que não está mais livre. */
  escolhaIndisponivel: boolean;
  reservaHoras: number;
}

const ROTULOS: Record<string, string> = {
  perfil: 'perfil',
  para_quem: 'para quem',
  idade_anos: 'idade',
  nome_crianca: 'nome da criança',
  nome_responsavel: 'nome de quem conversa',
  cidade: 'cidade',
  uf: 'UF',
  formato_preferido: 'formato',
  tem_diagnostico: 'diagnóstico',
  acompanhamento_atual: 'acompanhamento',
  motivo: 'motivo',
  motivo_texto: 'motivo (nas palavras da família)',
  prazo: 'prazo',
  dor_aprofundada: 'dor aprofundada',
  convenio_citado: 'citou convênio',
  decisor: 'quem decide',
  termometro: 'termômetro',
  data_retorno_pedida: 'pediu retorno em',
  pressa: 'com pressa',
  recuo_estrategico_feito: 'recuo estratégico feito',
  parafraseou: 'paráfrase feita',
  acordo_sinceridade: 'acordo de sinceridade',
  red_flags: 'sinais de risco',
  diferenciais_lembrados: 'diferenciais lembrados',
  isolamento: 'isolamento',
  preco_informado_em: 'preço informado na etapa',
  reacao_preco: 'reação ao preço',
  preferencia_turno: 'preferência de turno',
  horario_escolhido: 'horário escolhido',
  ficha_nf_completa: 'ficha da nota fiscal completa',
  pagamento: 'pagamento',
  objecoes: 'objeções',
  motivo_perda: 'motivo da perda',
};

function valorLegivel(valor: unknown): string {
  if (typeof valor === 'boolean') return valor ? 'sim' : 'não';
  if (typeof valor === 'string' || typeof valor === 'number') return String(valor);
  return JSON.stringify(valor);
}

export function renderizarFicha(ficha: FichaDef): string {
  const linhas = Object.entries(ficha)
    .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
    .map(([campo, v]) => `- ${ROTULOS[campo] ?? campo}: ${valorLegivel(v)}`);
  return linhas.length === 0 ? '- (nada ainda)' : linhas.join('\n');
}

function renderizarBloco(bloco: BlocoDef, filtroDeFrases?: (quando: string | undefined) => boolean): string {
  const filtradas = filtroDeFrases ? bloco.frases.filter((f) => filtroDeFrases(f.quando)) : bloco.frases;
  // Nenhuma frase casou com o tipo da objeção: mostra todas, em vez de nenhuma.
  const frases = (filtradas.length > 0 ? filtradas : bloco.frases)
    .map((f) => `- [${f.id}] ${f.texto}${f.quando ? ` (quando: ${f.quando})` : ''}`)
    .join('\n');
  return frases === ''
    ? bloco.instrucoes
    : `${bloco.instrucoes}\n\n### Frases de referência (use o sentido, com as suas palavras; adapte o nome)\n${frases}`;
}

function textoDaPassagem(p: PassagemDef, dentroDoHorario: boolean): string {
  const fora = !dentroDoHorario && p.fora_do_horario ? `\nFora do horário da equipe: ${p.fora_do_horario}` : '';
  return `"${p.mensagem}"${fora}`;
}

function renderizarAgenda(agenda: AgendaDoTurno): string {
  if (agenda.reservada) {
    return `## HORARIOS — horário escolhido (segurado por ${agenda.reservaHoras}h para a família)\n- ${descreverVaga(agenda.reservada)}`;
  }
  const aviso = agenda.escolhaIndisponivel
    ? 'O horário que a família escolheu não está mais livre: diga isso e ofereça estes.\n'
    : '';
  if (agenda.vagas.length === 0) return '';
  return `## HORARIOS — para oferecer (só estes, nesta ordem; nunca invente outra data)\n${aviso}${agenda.vagas
    .map((v) => `- [${v.rotulo}] ${descreverVaga(v)}`)
    .join('\n')}`;
}

export function renderizarBlocosDef(args: {
  roteiro: RoteiroDef;
  decisao: DecisaoDef;
  ficha: FichaDef;
  dentroDoHorario: boolean;
  objecaoAtual: string | null;
  agenda?: AgendaDoTurno | null;
  /** Turno de cadência: retomar de onde parou. */
  cadencia?: boolean;
}): string {
  const { roteiro, decisao, ficha } = args;
  const partes: string[] = [];
  const etapa = roteiro.etapas[decisao.etapa];

  partes.push(`## Método DEF — etapa atual: ${etapa.titulo.toUpperCase()}`);
  if (decisao.etapa !== decisao.etapaAnterior) {
    partes.push(`A conversa acabou de passar de "${roteiro.etapas[decisao.etapaAnterior].titulo}" para "${etapa.titulo}".`);
  }
  partes.push(
    `No funil, esta etapa corresponde ao passo "${PASSO_DO_FUNIL_DA_ETAPA[decisao.etapa]}": se ainda não estiver nele, marque com update_lead_state.`,
  );

  // Atalho do decidido (P1.3): só o bloco do atalho e os horários — o bloco do
  // fechamento (comparação, condição) não entra.
  const atalhoDecidido = decisao.modo === 'decidido' && roteiro.modos.decidido !== undefined;
  if (atalhoDecidido) {
    const preco = ficha.preco_informado_em ? 'A família já ouviu o valor.' : 'A família ainda NÃO ouviu o valor.';
    const falta =
      decisao.faltam.length > 0
        ? `\n\n### Confirme antes dos horários (uma pergunta por vez)\n${decisao.faltam.map((f) => `- ${f}`).join('\n')}`
        : '';
    partes.push(`### Atalho: família decidida\n${renderizarBloco(roteiro.modos.decidido!)}\n\n${preco}${falta}`);
  }
  if (args.cadencia && roteiro.modos.cadencia) {
    partes.push(`## AGORA: CADÊNCIA (a família não respondeu)\n${renderizarBloco(roteiro.modos.cadencia)}`);
  }
  if (decisao.modo === 'retomada' && roteiro.modos.retomada) {
    partes.push(`### Atalho: família que voltou\n${renderizarBloco(roteiro.modos.retomada)}`);
  }

  if (!atalhoDecidido) {
    partes.push(renderizarBloco(etapa));
    partes.push(
      decisao.faltam.length === 0
        ? '### O que falta nesta etapa\n- Nada: conduza para a próxima.'
        : `### O que falta nesta etapa (uma pergunta por vez)\n${decisao.faltam.map((f) => `- ${f}`).join('\n')}`,
    );
  }
  const blocoDaAgenda = args.agenda ? renderizarAgenda(args.agenda) : '';
  if (blocoDaAgenda !== '') partes.push(blocoDaAgenda);

  partes.push(`## Ficha DEF (o que a família já contou; NÃO pergunte de novo)\n${renderizarFicha(ficha)}`);

  for (const r of decisao.respostas) {
    partes.push(
      r.exclusiva
        ? `## AGORA: RESPONDA SÓ ISTO (${r.intencao})\nEnvie esta mensagem, com o sentido e sem mudar nenhum fato, e não pergunte mais nada neste turno: ${textoDaPassagem(r, args.dentroDoHorario)}`
        : `## Responda primeiro (${r.intencao})\nUse o sentido desta mensagem e depois siga a etapa: ${textoDaPassagem(r, args.dentroDoHorario)}`,
    );
  }

  if (decisao.modo === 'urgencia' && decisao.passagem) {
    partes.push(
      `## AGORA: URGÊNCIA\nEnvie SOMENTE esta mensagem (troque [nome] pelo nome, se souber): ${textoDaPassagem(decisao.passagem, args.dentroDoHorario)}\nDepois chame request_human_handoff. NÃO continue a venda.`,
    );
  } else if (decisao.modo === 'passagem' && decisao.passagem) {
    partes.push(
      `## AGORA: PASSAGEM PARA A EQUIPE (${decisao.passagem.intencao})\nEnvie esta mensagem (troque os colchetes pelo que já sabe): ${textoDaPassagem(decisao.passagem, args.dentroDoHorario)}\nDepois chame request_human_handoff, com o resumo do caso.`,
    );
  } else if (decisao.modo === 'dispensa') {
    const msg = decisao.passagem ? `\nMensagem: ${textoDaPassagem(decisao.passagem, args.dentroDoHorario)}` : '';
    partes.push(`## AGORA: DISPENSA\n${renderizarBloco(roteiro.modos.dispensa)}${msg}`);
  } else if (decisao.modo === 'objecao') {
    const tipo = (args.objecaoAtual ?? '').toLowerCase();
    const filtro = tipo === '' ? undefined : (quando: string | undefined) => !quando || quando.toLowerCase().includes(tipo) || tipo.includes(quando.toLowerCase());
    partes.push(`## AGORA: OBJEÇÃO (${args.objecaoAtual})\n${renderizarBloco(roteiro.modos.objecao, filtro)}`);
  }

  partes.push(
    args.dentroDoHorario
      ? '_A equipe está no horário de atendimento agora._'
      : '_A equipe está FORA do horário agora: quem depende dela fica para o próximo horário de atendimento._',
  );
  return partes.join('\n\n');
}
