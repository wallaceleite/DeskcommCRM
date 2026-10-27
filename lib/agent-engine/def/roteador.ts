/**
 * [fork wallaceleite] O ROTEADOR DO MÉTODO DEF — código, sem IA.
 *
 * Decide a etapa olhando só para a ficha (o que o extrator leu da conversa) e
 * para as intenções da última mensagem. É a tradução do `estados.json` e da aba
 * "Estados e portões" do pacote: a etapa só avança quando o critério de saída é
 * verdadeiro, e nunca volta — a única volta prevista é a retomada (quem já foi
 * encantado e reaparece depois de dias vai direto ao isolamento).
 *
 * Puro: sem banco, sem relógio, sem modelo. Testável linha a linha.
 */
import {
  ETAPAS_DEF,
  type EtapaDef,
  type FichaDef,
  type FluxoDef,
  type IntencaoDef,
  type PassagemDef,
  type RoteiroDef,
} from './tipos';

export type ModoDef = 'normal' | 'objecao' | 'dispensa' | 'urgencia' | 'passagem' | 'decidido' | 'retomada';

export interface DecisaoDef {
  etapa: EtapaDef;
  etapaAnterior: EtapaDef;
  modo: ModoDef;
  /** A passagem que encerra o turno (equipe, dispensa ou urgência). */
  passagem: PassagemDef | null;
  /** Respostas padrão a dar ANTES de seguir a etapa (ex.: pergunta clínica). */
  respostas: PassagemDef[];
  /** O que falta para sair da etapa atual — guia a próxima pergunta. */
  faltam: string[];
}

function indice(etapa: EtapaDef): number {
  return ETAPAS_DEF.indexOf(etapa);
}

function preenchido(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

/** A família já respondeu alguma pergunta de contexto? */
function respondeuContexto(f: FichaDef): boolean {
  return (
    (f.para_quem !== undefined && f.para_quem !== 'nao_informado') ||
    (f.idade_anos !== undefined && f.idade_anos !== null) ||
    preenchido(f.cidade)
  );
}

/** O que o fluxo enxuto pergunta antes do valor, NA ORDEM em que pergunta. */
export function faltamNaDescobertaEnxuta(f: FichaDef): string[] {
  const falta: string[] = [];
  if (f.idade_anos === undefined || f.idade_anos === null) falta.push('nome e idade do paciente');
  if (!preenchido(f.cidade)) falta.push('cidade e estado (ou país)');
  if (f.ja_e_paciente === undefined || f.ja_e_paciente === 'nao_informado') {
    falta.push('se é a primeira consulta ou se já é paciente');
  }
  if (f.tem_diagnostico === undefined || f.tem_diagnostico === 'nao_informado') {
    falta.push('se já tem diagnóstico ou está em investigação');
  } else if (f.tem_diagnostico === 'sim' && (f.acompanhamento_atual ?? []).length === 0) {
    // Só quem já tem diagnóstico: quem busca diagnóstico segue sem esta pergunta.
    falta.push('se faz acompanhamento com outros profissionais');
  }
  if (f.formato_preferido === undefined || f.formato_preferido === 'nao_informado') {
    falta.push('modalidade: online ou presencial');
  }
  return falta;
}

/** O critério do fluxo enxuto, ou `undefined` onde ele é igual ao do DEF. */
function faltamNoFluxoEnxuto(etapa: EtapaDef, f: FichaDef, equipeJaFalou: boolean): string[] | undefined {
  switch (etapa) {
    case 'contato':
      // A apresentação vai na mesma mensagem da primeira pergunta; sem recuo.
      if (!equipeJaFalou) {
        const primeira = faltamNaDescobertaEnxuta(f)[0];
        return [`apresentar-se em uma frase${primeira ? ` e, na mesma mensagem, perguntar: ${primeira}` : ''}`];
      }
      return respondeuContexto(f) || preenchido(f.preco_informado_em) ? [] : ['a família responder à primeira pergunta'];
    case 'descoberta':
      return faltamNaDescobertaEnxuta(f);
    case 'encantamento':
    case 'isolamento':
      return [];
    case 'fechamento':
      if (preenchido(f.horario_escolhido)) return [];
      // Sem a modalidade deste atendimento, nada de valor nem horário: perguntar antes.
      return semFormato(f) ? ['modalidade: online ou presencial'] : ['apresentar o que está incluso e o valor, e oferecer os horários'];
    default:
      return undefined;
  }
}

/** O critério de saída de cada etapa, como lista do que ainda falta (vazia = sai). */
export function faltamNaEtapa(
  etapa: EtapaDef,
  f: FichaDef,
  ctx: { fluxo?: FluxoDef; equipeJaFalou?: boolean } = {},
): string[] {
  if (ctx.fluxo === 'enxuto') {
    const enxuto = faltamNoFluxoEnxuto(etapa, f, ctx.equipeJaFalou ?? true);
    if (enxuto !== undefined) return enxuto;
  }
  switch (etapa) {
    case 'contato': {
      if (respondeuContexto(f) && (f.recuo_estrategico_feito === true || preenchido(f.preco_informado_em))) {
        return [];
      }
      return f.recuo_estrategico_feito === true
        ? ['a família responder à primeira pergunta']
        : ['recuo estratégico (dizer que a avaliação começa antes e pedir licença para perguntar)'];
    }
    case 'descoberta': {
      const falta: string[] = [];
      if (f.idade_anos === undefined || f.idade_anos === null) falta.push('idade');
      if (!preenchido(f.cidade)) falta.push('cidade');
      if (f.motivo === undefined || f.motivo === null) falta.push('motivo da procura');
      if (f.decisor === undefined || f.decisor === 'nao_mapeado') falta.push('quem decide');
      if (f.pressa !== true) {
        if (f.formato_preferido === undefined || f.formato_preferido === 'nao_informado') {
          falta.push('formato (online ou presencial)');
        }
        if (f.termometro === undefined || f.termometro === 'nao_perguntado') falta.push('termômetro');
        if (f.parafraseou !== true) falta.push('paráfrase do caso');
      }
      if (f.acordo_sinceridade === undefined || f.acordo_sinceridade === 'nao_feito') {
        falta.push('acordo de sinceridade');
      }
      return falta;
    }
    case 'encantamento': {
      const falta: string[] = [];
      const dif = f.diferenciais_lembrados;
      if (dif === undefined || dif === null) {
        falta.push('pergunta de verificação ("de tudo, o que mais fez sentido?")');
      } else if (dif.quantidade <= 1 && f.verificacao_repetida !== true) {
        falta.push('reforçar os outros diferenciais ligados ao caso e repetir a verificação, uma vez');
      }
      const abertas = (f.red_flags ?? []).filter((r) => !r.resolvida);
      if (abertas.length > 0) {
        falta.push(`resolver os sinais de risco: ${abertas.map((r) => r.descricao).join('; ')}`);
      }
      return falta;
    }
    case 'isolamento':
      return f.isolamento === 'so_financeiro' ? [] : ['confirmar que só falta a parte financeira'];
    case 'fechamento':
      return f.reacao_preco === 'sim' || preenchido(f.horario_escolhido)
        ? []
        : ['apresentar o valor com comparação e ouvir a reação'];
    case 'reserva': {
      const falta: string[] = [];
      if (!preenchido(f.preferencia_turno) && !preenchido(f.horario_escolhido)) falta.push('turno e dias preferidos');
      if (f.ficha_nf_completa !== true) falta.push('ficha da nota fiscal');
      if (f.pagamento !== 'pix' && f.pagamento !== 'cartao') falta.push('forma de pagamento da taxa');
      return falta;
    }
    case 'pos_reserva':
      return ['a equipe confirmar a marcação'];
  }
}

function semFormato(f: FichaDef): boolean {
  return f.formato_preferido === undefined || f.formato_preferido === 'nao_informado';
}

/** O que o atalho do decidido ainda precisa confirmar antes dos horários. */
export function faltamNoAtalhoDecidido(f: FichaDef, fluxo?: FluxoDef): string[] {
  const falta: string[] = [];
  if (f.idade_anos === undefined || f.idade_anos === null) falta.push('idade');
  if (fluxo === 'enxuto') {
    // No enxuto a vaga depende da modalidade: a cidade sozinha não basta.
    if (!preenchido(f.cidade)) falta.push('cidade');
    if (semFormato(f)) falta.push('modalidade: online ou presencial');
  } else if (!preenchido(f.cidade) && semFormato(f)) {
    falta.push('cidade (ou o formato)');
  }
  return falta;
}

export function decidirEtapaDef(args: {
  roteiro: RoteiroDef;
  ficha: FichaDef;
  etapaAnterior: EtapaDef;
  intencoes: readonly IntencaoDef[];
  objecaoAtual: string | null;
  /** A família voltou depois de um silêncio longo (ver `turno.ts`). */
  retomada: boolean;
  /** A equipe já mandou alguma mensagem neste atendimento (fluxo enxuto). */
  equipeJaFalou?: boolean;
}): DecisaoDef {
  const { roteiro, ficha: f, etapaAnterior } = args;
  // paciente_antigo tira a conversa da IA: só vale quando a própria ficha diz que já é
  // paciente. O extrator chegou a marcar a intenção com ja_e_paciente "nao" na mesma
  // saída ("faço acompanhamento com um neuro, mas quero trocar").
  const intencoes = args.intencoes.filter((i) => i !== 'paciente_antigo' || f.ja_e_paciente === 'sim');
  const ctx = { fluxo: roteiro.fluxo, equipeJaFalou: args.equipeJaFalou ?? true };
  const passagemDa = (intencao: IntencaoDef) => roteiro.passagens.find((p) => p.intencao === intencao) ?? null;

  // ── a etapa ────────────────────────────────────────────────────────────────
  let etapa: EtapaDef = etapaAnterior;
  let modo: ModoDef = 'normal';

  const encantada = indice(etapaAnterior) >= indice('encantamento');
  if (args.retomada && encantada && indice(etapaAnterior) < indice('reserva')) {
    etapa = 'isolamento';
    modo = 'retomada';
  } else if (f.perfil === 'decidido' && indice(etapa) <= indice('descoberta')) {
    // Atalho do lead decidido (aba Perfis): confirma idade e cidade (ou formato)
    // e vai direto aos horários — sem recuo nem Descoberta completa.
    modo = 'decidido';
    if (faltamNoAtalhoDecidido(f, roteiro.fluxo).length === 0) etapa = 'fechamento';
  }

  // Avança enquanto o critério de saída estiver cumprido. Nunca volta.
  while (indice(etapa) < ETAPAS_DEF.length - 1 && faltamNaEtapa(etapa, f, ctx).length === 0) {
    etapa = ETAPAS_DEF[indice(etapa) + 1]!;
  }

  // ── o modo do turno, pela intenção da última mensagem ─────────────────────
  let passagem: PassagemDef | null = null;
  const respostas: PassagemDef[] = [];

  const urgencia = intencoes.includes('urgencia') ? passagemDa('urgencia') : null;
  const adulto =
    intencoes.includes('adulto') || (typeof f.idade_anos === 'number' && f.idade_anos >= 18);

  if (urgencia !== null) {
    passagem = urgencia;
    modo = 'urgencia';
  } else if (adulto) {
    passagem = passagemDa('adulto');
    modo = 'dispensa';
  } else {
    for (const intencao of intencoes) {
      const p = passagemDa(intencao);
      if (p === null) continue;
      if (p.acao === 'responder') {
        respostas.push(p);
      } else if (passagem === null) {
        passagem = p;
        modo = p.acao === 'dispensar' ? 'dispensa' : p.acao === 'urgencia' ? 'urgencia' : 'passagem';
      }
    }
    if (passagem === null && intencoes.includes('desistiu')) modo = 'dispensa';
    if (passagem === null && modo === 'normal' && args.objecaoAtual !== null) modo = 'objecao';
  }

  const faltam =
    modo === 'decidido' && indice(etapa) < indice('fechamento') ? faltamNoAtalhoDecidido(f, roteiro.fluxo) : faltamNaEtapa(etapa, f, ctx);
  return { etapa, etapaAnterior, modo, passagem, respostas, faltam };
}

/**
 * A equipe está trabalhando agora? Decide qual mensagem de passagem usar.
 * `agora` em epoch ms; `fuso` IANA (o da organização).
 */
export function equipeNoHorario(
  equipe: RoteiroDef['equipe'],
  agora: number,
  fuso: string,
): boolean {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(agora));
  const valor = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '';
  const dia = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(valor('weekday'));
  const hhmm = `${valor('hour')}:${valor('minute')}`;
  return equipe.dias.includes(dia) && hhmm >= equipe.inicio && hhmm < equipe.fim;
}

/** O passo do funil do agente que corresponde a cada etapa DEF. */
export const PASSO_DO_FUNIL_DA_ETAPA: Record<EtapaDef, string> = {
  contato: 'contacted',
  descoberta: 'qualifying',
  encantamento: 'qualified',
  isolamento: 'negotiating',
  fechamento: 'negotiating',
  reserva: 'negotiating',
  pos_reserva: 'negotiating',
};
