/**
 * [fork wallaceleite] O MÉTODO DEF DENTRO DO TURNO — o único ponto que o
 * `inbound-turn.ts` conhece.
 *
 * `iniciarTurnoDef` roda em paralelo com os classificadores do turno e devolve:
 *  - o BLOCO que vai no sufixo por-lead (etapa, o que falta, ficha, modo);
 *  - `envolverFerramentas`, que põe o REVISOR na frente do `send_message`.
 *
 * Agente sem roteiro ativo em `def_roteiros` → `null`, e o turno é exatamente o
 * do upstream. Qualquer falha do DEF (menos orçamento) também cai em `null`.
 *
 * O envoltório fica POR FORA da política da prévia: no "Testar" o revisor roda do
 * mesmo jeito, e o `send_message` de dentro é o da prévia (nada sai para o canal).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ToolSet } from 'ai';
import type { Logger } from '../obs/logger';
import type { ProviderRegistry } from '../edge/llm/providers';
import { LlmBudgetExceededError, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import type { LeadContext } from '../edge/crm/get-lead-context';
import { agoraNoFuso, encontrarVagaEscolhida, escolherVagas, vagasDisponiveis, type HorarioDef } from './agenda';
import { extrairFichaDef, mesclarFicha } from './extrator';
import { renderizarBlocosDef, type AgendaDoTurno } from './blocos';
import {
  carregarFichaDef,
  carregarRoteiroDef,
  completarFichaDef,
  listarHorariosDef,
  marcarMensagemDef,
  registrarEventoDef,
  reservarHorarioDef,
  salvarFichaDef,
} from './persistencia';
import { decidirEtapaDef, equipeNoHorario, type DecisaoDef } from './roteador';
import {
  checagensDeCodigo,
  contarPerguntas,
  semelhanca,
  eAvisoDePagamento,
  limiteDoTurno,
  perguntouPreco,
  revisarComModelo,
  SEM_PERGUNTA,
  terminaEmPergunta,
  type VereditoDef,
} from './revisor';
import { rotularMensagemDef } from './rotulador';
import type { EtapaDef, FichaDef, IntencaoDef, PassagemDef, RoteiroDef } from './tipos';

/** Silêncio a partir do qual a volta da família conta como retomada. */
export const SILENCIO_DA_RETOMADA_MS = 24 * 60 * 60 * 1000;

/** Vetos do revisor no mesmo turno antes de passar para a equipe. */
export const MAX_VETOS_DO_REVISOR_DEF = 2;

/** A partir daqui a mensagem é o texto do roteiro (com o nome trocado). */
export const SEMELHANCA_COM_O_ROTEIRO = 0.75;

export interface AgenteDoTurnoDef {
  agentId: string;
  model?: string | undefined;
  provider: string;
  credentialId: string | null;
}

export interface TurnoDef {
  etapa: EtapaDef;
  decisao: DecisaoDef;
  bloco: string;
  envolverFerramentas(tools: ToolSet): ToolSet;
  /** Fim do turno: registra o KPI N4 e devolve o resumo (a prévia o mostra). */
  finalizar(): ResumoDoTurnoDef | null;
}

type AnyExecute = (input: unknown, options: unknown) => Promise<unknown>;

/** A família voltou depois de um silêncio longo? (última inbound × mensagem anterior) */
export function houveRetomada(contexto: LeadContext): boolean {
  const msgs = contexto.messages;
  for (let i = msgs.length - 1; i > 0; i--) {
    if (msgs[i]!.direction !== 'inbound') continue;
    const atual = Date.parse(msgs[i]!.sent_at);
    const anterior = Date.parse(msgs[i - 1]!.sent_at);
    if (Number.isNaN(atual) || Number.isNaN(anterior)) return false;
    return atual - anterior >= SILENCIO_DA_RETOMADA_MS;
  }
  return false;
}

function primeiroNome(nome: string | null): string | null {
  const n = nome?.trim();
  return n ? n.split(/\s+/)[0]! : null;
}

function mensagemDeEspera(roteiro: RoteiroDef, nome: string | null): string {
  const modelo = roteiro.revisor.mensagem_espera;
  const primeiro = primeiroNome(nome);
  return primeiro ? modelo.replace('{nome}', primeiro) : modelo.replace(/,?\s*\{nome\}/, '');
}

/**
 * A mensagem de passagem do roteiro pronta para sair pelo código: troca os
 * colchetes pelo que a ficha sabe. `[nome]` sem valor some com a vírgula;
 * `[nome da criança]` sem valor vira "seu filho"/"sua filha". Qualquer outro
 * colchete (ex.: `[data]`) não tem como ser preenchido aqui → `null`.
 */
export function prepararMensagemDePassagem(mensagem: string, nome: string | null, ficha: FichaDef): string | null {
  let desconhecido = false;
  const filha = ficha.para_quem === 'filha';
  const texto = mensagem
    .replace(/(,\s*)?\[([^\]]+)\](,)?/g, (_t, antes: string | undefined, chaveBruta: string, depois: string | undefined) => {
      const chave = chaveBruta.trim().toLowerCase();
      if (chave === 'nome') {
        const v = primeiroNome(nome);
        if (v) return `${antes ?? ''}${v}${depois ?? ''}`;
        return antes && depois ? ',' : '';
      }
      if (chave === 'nome da criança' || chave === 'nome da crianca') {
        const v = ficha.nome_crianca?.trim() || (filha ? 'sua filha' : 'seu filho');
        return `${antes ?? ''}${v}${depois ?? ''}`;
      }
      desconhecido = true;
      return '';
    })
    .replace(/\bo (sua filha|seu filho)\b/g, (_t, quem: string) => (quem === 'sua filha' ? 'a sua filha' : 'o seu filho'))
    .replace(/\bdo sua filha\b/g, 'da sua filha')
    .replace(/^\s+/, '')
    .replace(/^([a-zà-ú])/, (c) => c.toUpperCase());
  return desconhecido ? null : texto;
}

/** A ficha em uma linha curta, para o resumo que a equipe lê na passagem. */
export function resumoCurtoDaFicha(etapa: EtapaDef, ficha: FichaDef): string {
  const partes = [
    ficha.nome_crianca ? `criança ${ficha.nome_crianca}` : null,
    typeof ficha.idade_anos === 'number' ? `${ficha.idade_anos} anos` : null,
    ficha.cidade ?? null,
    ficha.formato_preferido && ficha.formato_preferido !== 'nao_informado' ? ficha.formato_preferido : null,
    ficha.motivo_texto ?? ficha.motivo ?? null,
    ficha.decisor && ficha.decisor !== 'nao_mapeado' ? `decide: ${ficha.decisor}` : null,
    ficha.horario_escolhido ? `horário: ${ficha.horario_escolhido}` : null,
  ].filter((p): p is string => typeof p === 'string' && p !== '');
  return `Método DEF, etapa ${etapa}${partes.length > 0 ? `: ${partes.join('; ')}` : ''}`.slice(0, 200);
}

/** Etapas em que a família pode precisar de horário agora. */
function precisaDeHorario(decisao: DecisaoDef, ficha: FichaDef): boolean {
  if (decisao.etapa === 'reserva') return true;
  if (decisao.modo === 'decidido') return decisao.etapa === 'fechamento';
  return decisao.etapa === 'fechamento' && (ficha.reacao_preco === 'sim' || ficha.reacao_preco === 'sim_sem_firmeza');
}

export async function iniciarTurnoDef(args: {
  pool: pg.Pool;
  llmCfg: LlmEdgeConfig;
  registry?: ProviderRegistry;
  log: Logger;
  tenantId: string;
  /** contacts.id; '' na prévia de cenário. */
  leadId: string;
  jobId?: string;
  agente: AgenteDoTurnoDef | null;
  contexto: LeadContext;
  /** Há mensagem nova da família neste turno (inbound ou prévia)? Só então o extrator roda. */
  temMensagemNova: boolean;
  /** Turno de cadência (follow-up de IA): entra o bloco de retomada. */
  cadencia?: boolean;
  /** Persistir a ficha? Falso na prévia de cenário (contato fictício). */
  persistir: boolean;
  fuso: string;
  agora: number;
}): Promise<TurnoDef | null> {
  if (args.agente === null) return null;
  const agente = args.agente;
  try {
    const roteiro = await carregarRoteiroDef(args.pool, args.tenantId, agente.agentId, args.log);
    if (roteiro === null) return null;

    const salvo = args.persistir && args.leadId !== '' ? await carregarFichaDef(args.pool, args.tenantId, args.leadId) : null;
    let ficha: FichaDef = salvo?.ficha ?? {};
    const etapaAnterior: EtapaDef = salvo?.etapa ?? 'contato';
    let intencoes: IntencaoDef[] = [];
    let objecaoAtual: string | null = null;
    let provas: Record<string, string> = {};

    const aux = (modelo: string | undefined) =>
      modelo !== undefined
        ? { model: modelo, llmOverride: { provider: agente.provider, credentialId: agente.credentialId } }
        : agente.model !== undefined
          ? { model: agente.model, llmOverride: { provider: agente.provider, credentialId: agente.credentialId } }
          : {};
    const ids = {
      tenantId: args.tenantId,
      leadId: args.leadId === '' ? null : args.leadId,
      ...(args.jobId !== undefined ? { jobId: args.jobId } : {}),
      agentId: agente.agentId,
    };
    const contactId = args.leadId === '' ? null : args.leadId;

    if (args.temMensagemNova) {
      const extracao = await extrairFichaDef(
        args.pool,
        args.llmCfg,
        ids,
        { roteiro, ficha, mensagens: args.contexto.messages, ...aux(roteiro.modelo_extrator) },
        { registry: args.registry, log: args.log },
      );
      if (extracao !== null) {
        ficha = mesclarFicha(ficha, extracao.ficha);
        intencoes = extracao.intencoes;
        objecaoAtual = extracao.objecao_atual;
        provas = extracao.provas;
      } else {
        // P1.5: sem extração, a pergunta de preço ainda é reconhecida — senão a
        // resposta ao preço leva o veto da regra 5 duas vezes e vira passagem.
        const ultima = [...args.contexto.messages].reverse().find((m) => m.direction === 'inbound');
        if (ultima !== undefined && perguntouPreco(ultima.body)) intencoes = ['pergunta_preco'];
      }
    }

    let decisao = decidirEtapaDef({
      roteiro,
      ficha,
      etapaAnterior,
      intencoes,
      objecaoAtual,
      retomada: args.temMensagemNova && houveRetomada(args.contexto),
    });
    const dentroDoHorario = equipeNoHorario(roteiro.equipe, args.agora, args.fuso);

    // ── a agenda (P0.3) ────────────────────────────────────────────────────
    let agenda: AgendaDoTurno | null = null;
    if (roteiro.agenda !== undefined) {
      const horarios: HorarioDef[] = await listarHorariosDef(args.pool, args.tenantId, agente.agentId, args.log);
      const agoraLocal = agoraNoFuso(args.agora, args.fuso);
      const disponiveis = vagasDisponiveis({
        horarios,
        roteiro,
        formato: ficha.formato_preferido,
        agora: agoraLocal,
        contactId,
      });
      const reservaHoras = roteiro.agenda.reserva_horas;
      let reservada: HorarioDef | null = null;
      let escolhaIndisponivel = false;
      if (ficha.horario_escolhido) {
        const vaga = encontrarVagaEscolhida(ficha.horario_escolhido, disponiveis);
        if (vaga !== null) {
          const segurou =
            args.persistir && contactId !== null
              ? await reservarHorarioDef(args.pool, {
                  organizationId: args.tenantId,
                  agentId: agente.agentId,
                  contactId,
                  data: vaga.data,
                  hora: vaga.hora,
                  horas: reservaHoras,
                })
              : true;
          if (segurou) {
            reservada = vaga;
            ficha = { ...ficha, horario_escolhido: `${vaga.data} ${vaga.hora}` };
          } else {
            escolhaIndisponivel = true;
          }
        } else if (encontrarVagaEscolhida(ficha.horario_escolhido, horarios) !== null) {
          // Era uma vaga de verdade, mas outra família já a segurou.
          escolhaIndisponivel = true;
        }
        if (escolhaIndisponivel) ficha = { ...ficha, horario_escolhido: null };
      }
      const vagas =
        reservada === null && precisaDeHorario(decisao, ficha)
          ? escolherVagas({ horarios, roteiro, formato: ficha.formato_preferido, agora: agoraLocal, contactId })
          : [];
      agenda = { vagas, reservada, escolhaIndisponivel, reservaHoras };
      // Sem vaga para oferecer: a equipe assume. Nunca inventar data.
      const semHorario = roteiro.passagens.find((p) => p.intencao === 'sem_horario');
      if (reservada === null && vagas.length === 0 && precisaDeHorario(decisao, ficha) && decisao.passagem === null && semHorario) {
        decisao = { ...decisao, passagem: semHorario, modo: 'passagem' };
      }
      if (reservada !== null && contactId !== null && args.persistir) {
        void registrarEventoDef(args.pool, args.log, {
          organizationId: args.tenantId,
          contactId,
          agentId: agente.agentId,
          tipo: 'reserva',
          etapa: decisao.etapa,
          dados: { data: reservada.data, hora: reservada.hora, modalidade: reservada.modalidade },
        });
      }
    }

    if (args.persistir && contactId !== null) {
      await salvarFichaDef(args.pool, {
        organizationId: args.tenantId,
        contactId,
        agentId: agente.agentId,
        etapa: decisao.etapa,
        ficha,
        provas,
      });
      if (args.temMensagemNova) {
        void registrarEventoDef(args.pool, args.log, {
          organizationId: args.tenantId,
          contactId,
          agentId: agente.agentId,
          tipo: 'extracao',
          etapa: decisao.etapa,
          dados: { intencoes, objecao_atual: objecaoAtual, modo: decisao.modo, faltam: decisao.faltam.length },
        });
      }
      if (decisao.etapa !== etapaAnterior) {
        void registrarEventoDef(args.pool, args.log, {
          organizationId: args.tenantId,
          contactId,
          agentId: agente.agentId,
          tipo: 'etapa',
          etapa: decisao.etapa,
          dados: { de: etapaAnterior, para: decisao.etapa, modo: decisao.modo },
        });
      }
      if (decisao.passagem !== null) {
        void registrarEventoDef(args.pool, args.log, {
          organizationId: args.tenantId,
          contactId,
          agentId: agente.agentId,
          tipo: 'passagem',
          etapa: decisao.etapa,
          dados: { intencao: decisao.passagem.intencao, acao: decisao.passagem.acao, dentro_do_horario: dentroDoHorario },
        });
      }
    }

    const bloco = renderizarBlocosDef({ roteiro, decisao, ficha, dentroDoHorario, objecaoAtual, agenda, cadencia: args.cadencia === true });
    const nome = args.contexto.contact.name ?? ficha.nome_responsavel ?? null;
    // O que a equipe já mandou nesta conversa (régua da repetição).
    const anterioresDaEquipe = args.contexto.messages.filter((m) => m.direction === 'outbound').map((m) => m.body);

    let revisorDoTurno: RevisorDoTurno | null = null;
    return {
      etapa: decisao.etapa,
      decisao,
      bloco,
      envolverFerramentas: (tools) => {
        revisorDoTurno = envolverComRevisor(tools, {
          ...args,
          agente,
          roteiro,
          decisao,
          intencoes,
          ficha,
          nome,
          ids,
          anterioresDaEquipe,
          auxRevisor: aux(roteiro.modelo_revisor),
          auxRotulador: aux(roteiro.modelo_extrator),
          contactId: args.persistir ? contactId : null,
        });
        return revisorDoTurno.tools;
      },
      finalizar: () => revisorDoTurno?.finalizar() ?? null,
    };
  } catch (err) {
    if (err instanceof LlmBudgetExceededError) throw err;
    args.log.warn('def: camada desligada neste turno por falha — atendimento segue sem o Método DEF', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
    return null;
  }
}

/** O que o turno mandou, para o fim do turno e para a prévia (bateria). */
export interface ResumoDoTurnoDef {
  etapa: EtapaDef;
  modo: DecisaoDef['modo'];
  passagem: string | null;
  mensagens: number;
  perguntas: number;
  termina_em_pergunta: boolean;
  vetos: { regras: string[]; origem: VereditoDef['origem'] | 'limite' }[];
  passou_para_equipe: boolean;
}

interface RevisorDoTurno {
  tools: ToolSet;
  finalizar(): ResumoDoTurnoDef;
}

function envolverComRevisor(
  tools: ToolSet,
  ctx: {
    pool: pg.Pool;
    llmCfg: LlmEdgeConfig;
    registry?: ProviderRegistry;
    log: Logger;
    tenantId: string;
    agente: AgenteDoTurnoDef;
    roteiro: RoteiroDef;
    decisao: DecisaoDef;
    intencoes: IntencaoDef[];
    ficha: FichaDef;
    nome: string | null;
    ids: { tenantId: string; leadId: string | null; jobId?: string; agentId: string | null };
    anterioresDaEquipe: string[];
    auxRevisor: { model?: string; llmOverride?: { provider: string; credentialId: string | null } };
    auxRotulador: { model?: string; llmOverride?: { provider: string; credentialId: string | null } };
    contactId: string | null;
  },
): RevisorDoTurno {
  const turno = randomUUID();
  const enviados: string[] = [];
  // O texto do próprio roteiro (passagens e frases da Matriz) já é aprovado: o
  // revisor de MODELO não o julga de novo — a bateria mediu o modelo barato
  // vetando a frase do manual. As checagens de código continuam valendo.
  const textosDoRoteiro = [
    ...ctx.roteiro.passagens.map((p) => p.mensagem),
    ...[...Object.values(ctx.roteiro.etapas), ...Object.values(ctx.roteiro.modos)].flatMap((b) => b?.frases.map((f) => f.texto) ?? []),
  ];
  const doRoteiro = (body: string) => textosDoRoteiro.some((t) => semelhanca(body, t) >= SEMELHANCA_COM_O_ROTEIRO);
  const registroDeVetos: ResumoDoTurnoDef['vetos'] = [];
  let vetos = 0;
  let encerrado = false;
  let passouParaEquipe = false;

  const evento = (tipo: 'revisor' | 'turno', dados: Record<string, unknown>) => {
    if (ctx.contactId === null) return;
    void registrarEventoDef(ctx.pool, ctx.log, {
      organizationId: ctx.tenantId,
      contactId: ctx.contactId,
      agentId: ctx.agente.agentId,
      tipo,
      etapa: ctx.decisao.etapa,
      dados: { ...dados, turno },
    });
  };

  const resumo = (): ResumoDoTurnoDef => {
    const ultima = enviados[enviados.length - 1] ?? '';
    return {
      etapa: ctx.decisao.etapa,
      modo: ctx.decisao.modo,
      passagem: ctx.decisao.passagem?.intencao ?? null,
      mensagens: enviados.length,
      perguntas: enviados.reduce((n, b) => n + contarPerguntas(b), 0),
      termina_em_pergunta: terminaEmPergunta(ultima),
      vetos: registroDeVetos,
      passou_para_equipe: passouParaEquipe,
    };
  };

  const envio = tools.send_message as { execute?: AnyExecute } | undefined;
  if (envio?.execute === undefined) return { tools, finalizar: resumo };
  const enviarDeVerdade = envio.execute.bind(envio) as AnyExecute;
  const passagemOriginal = tools.request_human_handoff as { execute?: AnyExecute } | undefined;
  const chamarEquipe = passagemOriginal?.execute?.bind(passagemOriginal) as AnyExecute | undefined;

  const registrarEnvio = (body: string, resultado: unknown) => {
    enviados.push(body);
    const messageId = (resultado as { message_id?: unknown })?.message_id;
    const idValido = typeof messageId === 'string' && messageId !== '' ? messageId : null;
    const temPreco = /\b1\.?200\b/.test(body);
    const dados = {
      etapa: ctx.decisao.etapa,
      modo: ctx.decisao.modo,
      tem_preco: temPreco,
      termina_em_pergunta: terminaEmPergunta(body),
      turno,
      seq: enviados.length,
    };
    if (idValido !== null) void marcarMensagemDef(ctx.pool, ctx.log, { organizationId: ctx.tenantId, messageId: idValido, dados });
    if (ctx.contactId === null) return;
    void registrarEventoDef(ctx.pool, ctx.log, {
      organizationId: ctx.tenantId,
      contactId: ctx.contactId,
      agentId: ctx.agente.agentId,
      messageId: idValido,
      tipo: 'mensagem',
      etapa: ctx.decisao.etapa,
      dados,
    });
    // O preço que SAIU marca a ficha pelo código (documento 03), só a 1ª vez.
    if (temPreco) {
      void completarFichaDef(ctx.pool, ctx.log, {
        organizationId: ctx.tenantId,
        contactId: ctx.contactId,
        campos: { preco_informado_em: ctx.decisao.etapa },
        soSeVazio: true,
      });
    }
    if (idValido !== null) {
      void rotularMensagemDef(
        ctx.pool,
        ctx.llmCfg,
        ctx.ids,
        { roteiro: ctx.roteiro, etapa: ctx.decisao.etapa, body, messageId: idValido, contactId: ctx.contactId, ...ctx.auxRotulador },
        { registry: ctx.registry, log: ctx.log },
      );
    }
  };

  /**
   * Envio que é a porta da equipe (espera, passagem). Promete gente, então a
   * trava de promessa do núcleo veta a 1ª tentativa sem caso aberto e, na 2ª,
   * abre o caso sozinha e deixa sair (`case_promise_autofallback`). Uma
   * repetição, e só por esse motivo.
   */
  const enviarPromessaDeEquipe = async (body: string, options: unknown) => {
    let r = await enviarDeVerdade({ body }, options);
    if ((r as { error?: { code?: unknown } })?.error?.code === 'case_promise_without_case') {
      r = await enviarDeVerdade({ body }, options);
    }
    if ((r as { ok?: unknown })?.ok === true) registrarEnvio(body, r);
    return r;
  };

  /** A passagem do roteiro ANTES de chamar a equipe — nunca o aviso genérico. */
  const passagemDoTurno = (): PassagemDef | null => {
    const p = ctx.decisao.passagem;
    if (p !== null && (p.acao === 'passar' || p.acao === 'urgencia')) return p;
    return ctx.roteiro.passagens.find((x) => x.intencao === 'quer_humano') ?? null;
  };

  const passarParaEquipe = async (input: unknown, options: unknown, porQueDoCodigo?: string) => {
    if (chamarEquipe === undefined) return { ok: false, error: { code: 'sem_passagem', message: 'Passagem indisponível.' } };
    passouParaEquipe = true;
    const bruto = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const tentei = Array.isArray(bruto.o_que_tentei) ? [...(bruto.o_que_tentei as unknown[])] : [];
    if (tentei.length < 6) tentei.push({ o_que: resumoCurtoDaFicha(ctx.decisao.etapa, ctx.ficha) });
    const entrada = {
      ...bruto,
      ...(porQueDoCodigo !== undefined ? { por_que: porQueDoCodigo } : {}),
      o_que_tentei: tentei,
    };
    return chamarEquipe(entrada, options);
  };

  const executeEnvio: AnyExecute = async (input, options) => {
    if (encerrado) {
      return {
        ok: false,
        error: { code: 'def_turno_encerrado', message: 'A conversa já foi passada para a equipe neste turno. Não envie mais nada.' },
      };
    }
    const body = typeof (input as { body?: unknown })?.body === 'string' ? (input as { body: string }).body : '';

    // P0.4/P0.5: limite do turno não é veto — não conta, não passa para a equipe.
    const limite = limiteDoTurno({ enviosNoTurno: enviados.length, perguntasNoTurno: resumo().perguntas });
    if (limite !== null) {
      registroDeVetos.push({ regras: ['limite'], origem: 'limite' });
      evento('revisor', { regras: ['limite'], origem: 'codigo', conta: false });
      return { ok: false, error: { code: 'def_turno_encerrado', message: limite } };
    }

    let veredito: VereditoDef;
    const vetosDeCodigo = checagensDeCodigo({
      body,
      etapa: ctx.decisao.etapa,
      modo: ctx.decisao.modo,
      intencoes: ctx.intencoes,
      linksPermitidos: ctx.roteiro.revisor.links_permitidos,
      regexTom: ctx.roteiro.revisor.regex_tom,
      perguntasDaFicha: ctx.roteiro.revisor.perguntas_da_ficha,
      ficha: ctx.ficha,
      anterioresDaEquipe: [...ctx.anterioresDaEquipe, ...enviados],
      similaridadeMaxima: ctx.roteiro.revisor.similaridade_maxima,
    });
    if (vetosDeCodigo.length > 0) {
      veredito = {
        aprovada: false,
        regras: vetosDeCodigo.map((v) => v.regra),
        motivo: vetosDeCodigo.map((v) => v.motivo).join(' '),
        origem: 'codigo',
      };
    } else if (ctx.decisao.modo === 'urgencia' || doRoteiro(body)) {
      // Urgência: a mensagem TEM de sair; e texto do roteiro já foi aprovado.
      veredito = { aprovada: true, regras: [], motivo: '', origem: 'codigo' };
    } else if (ctx.roteiro.revisor.ativo) {
      veredito = await revisarComModelo(
        ctx.pool,
        ctx.llmCfg,
        ctx.ids,
        { roteiro: ctx.roteiro, etapa: ctx.decisao.etapa, body, ...ctx.auxRevisor },
        { registry: ctx.registry, log: ctx.log },
      );
    } else {
      veredito = { aprovada: true, regras: [], motivo: '', origem: 'codigo' };
    }

    if (!veredito.aprovada) {
      vetos += 1;
      registroDeVetos.push({ regras: veredito.regras, origem: veredito.origem });
      evento('revisor', { regras: veredito.regras, origem: veredito.origem, tentativa: vetos, conta: true });
      if (vetos < MAX_VETOS_DO_REVISOR_DEF) {
        return {
          ok: false,
          error: {
            code: 'def_revisor',
            message: `O revisor de compliance reprovou a mensagem (regras ${veredito.regras.join(', ') || '?'}). ${veredito.motivo} Reescreva corrigindo isso e envie de novo.`,
          },
        };
      }
      // Segunda reprovação: a família recebe o aviso de espera e a equipe assume.
      encerrado = true;
      // Na urgência a família recebe a orientação de urgência, nunca "já te respondo".
      const urgencia = ctx.decisao.modo === 'urgencia' ? ctx.decisao.passagem : null;
      const textoDaUrgencia = urgencia ? prepararMensagemDePassagem(urgencia.mensagem, ctx.nome, ctx.ficha) : null;
      const aviso = await enviarPromessaDeEquipe(textoDaUrgencia ?? mensagemDeEspera(ctx.roteiro, ctx.nome), options);
      await passarParaEquipe({}, options, 'O revisor de compliance reprovou a resposta duas vezes neste turno.');
      return {
        ok: false,
        error: {
          code: 'def_revisor_passou_para_equipe',
          message:
            'A resposta foi reprovada duas vezes. A família já recebeu um aviso de espera e a conversa foi passada para a equipe. Não envie mais nada neste turno.',
        },
        aviso,
      };
    }

    const resultado = await enviarDeVerdade(input, options);
    if ((resultado as { ok?: unknown })?.ok !== true) return resultado;
    registrarEnvio(body, resultado);
    // A última mensagem do turno termina em pergunta: sem pergunta aqui, pede a
    // segunda (curta, com a pergunta). A 1ª de duas pode ser só o valor (P0.5).
    const precisaDePergunta =
      !SEM_PERGUNTA.includes(ctx.decisao.modo) && !eAvisoDePagamento(body) && contarPerguntas(body) === 0;
    if (precisaDePergunta && enviados.length < 2) {
      return {
        ...(resultado as Record<string, unknown>),
        def_aviso:
          'Esta mensagem não terminou em pergunta. Mande agora a segunda e última mensagem deste turno, curta, terminando em uma pergunta.',
      };
    }
    return resultado;
  };

  const executePassagem: AnyExecute = async (input, options) => {
    // A família ouve a passagem do ROTEIRO antes de a equipe assumir. Sem isto,
    // o piso do runtime manda o aviso genérico — ou nada, na prévia.
    if (enviados.length === 0 && !encerrado) {
      const p = passagemDoTurno();
      const padrao = ctx.roteiro.passagens.find((x) => x.intencao === 'quer_humano');
      const texto =
        (p !== null ? prepararMensagemDePassagem(p.mensagem, ctx.nome, ctx.ficha) : null) ??
        (padrao !== undefined ? prepararMensagemDePassagem(padrao.mensagem, ctx.nome, ctx.ficha) : null);
      if (texto !== null) await enviarPromessaDeEquipe(texto, options);
    }
    encerrado = true;
    return passarParaEquipe(input, options);
  };

  const comEnvio = { ...tools, send_message: { ...tools.send_message, execute: executeEnvio } as (typeof tools)['send_message'] };
  const final =
    chamarEquipe === undefined
      ? comEnvio
      : {
          ...comEnvio,
          request_human_handoff: { ...tools.request_human_handoff, execute: executePassagem } as (typeof tools)['request_human_handoff'],
        };

  return {
    tools: final,
    finalizar: () => {
      const r = resumo();
      // N4: o turno que falou sem terminar em pergunta (fora dos modos que não pedem).
      if (
        r.mensagens > 0 &&
        !r.termina_em_pergunta &&
        !r.passou_para_equipe &&
        !SEM_PERGUNTA.includes(r.modo) &&
        !eAvisoDePagamento(enviados[enviados.length - 1] ?? '')
      ) {
        evento('revisor', { regras: ['2'], origem: 'codigo_turno', conta: false });
      }
      evento('turno', { modo: r.modo, mensagens: r.mensagens, perguntas: r.perguntas, termina_em_pergunta: r.termina_em_pergunta, vetos: r.vetos.length, passou: r.passou_para_equipe });
      return r;
    },
  };
}
