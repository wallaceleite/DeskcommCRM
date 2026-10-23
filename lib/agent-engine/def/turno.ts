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
import type pg from 'pg';
import type { ToolSet } from 'ai';
import type { Logger } from '../obs/logger';
import type { ProviderRegistry } from '../edge/llm/providers';
import { LlmBudgetExceededError, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import type { LeadContext } from '../edge/crm/get-lead-context';
import { extrairFichaDef, mesclarFicha } from './extrator';
import { renderizarBlocosDef } from './blocos';
import {
  carregarFichaDef,
  carregarRoteiroDef,
  marcarMensagemDef,
  registrarEventoDef,
  salvarFichaDef,
} from './persistencia';
import { decidirEtapaDef, equipeNoHorario, type DecisaoDef } from './roteador';
import { checagensDeCodigo, revisarComModelo, type VereditoDef } from './revisor';
import type { EtapaDef, FichaDef, IntencaoDef, RoteiroDef } from './tipos';

/** Silêncio a partir do qual a volta da família conta como retomada. */
export const SILENCIO_DA_RETOMADA_MS = 24 * 60 * 60 * 1000;

/** Vetos do revisor no mesmo turno antes de passar para a equipe. */
export const MAX_VETOS_DO_REVISOR_DEF = 2;

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

function mensagemDeEspera(roteiro: RoteiroDef, nome: string | null): string {
  const modelo = roteiro.revisor.mensagem_espera;
  return nome && nome.trim() !== ''
    ? modelo.replace('{nome}', nome.trim().split(/\s+/)[0]!)
    : modelo.replace(/,?\s*\{nome\}/, '');
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
      }
    }

    const decisao = decidirEtapaDef({
      roteiro,
      ficha,
      etapaAnterior,
      intencoes,
      objecaoAtual,
      retomada: args.temMensagemNova && houveRetomada(args.contexto),
    });
    const dentroDoHorario = equipeNoHorario(roteiro.equipe, args.agora, args.fuso);

    const contactId = args.leadId === '' ? null : args.leadId;
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

    const bloco = renderizarBlocosDef({ roteiro, decisao, ficha, dentroDoHorario, objecaoAtual });
    const nome = args.contexto.contact.name ?? ficha.nome_responsavel ?? null;

    return {
      etapa: decisao.etapa,
      decisao,
      bloco,
      envolverFerramentas: (tools) =>
        envolverComRevisor(tools, {
          ...args,
          agente,
          roteiro,
          decisao,
          intencoes,
          nome,
          ids,
          auxRevisor: aux(roteiro.modelo_revisor),
          contactId: args.persistir ? contactId : null,
        }),
    };
  } catch (err) {
    if (err instanceof LlmBudgetExceededError) throw err;
    args.log.warn('def: camada desligada neste turno por falha — atendimento segue sem o Método DEF', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
    return null;
  }
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
    nome: string | null;
    ids: { tenantId: string; leadId: string | null; jobId?: string; agentId: string | null };
    auxRevisor: { model?: string; llmOverride?: { provider: string; credentialId: string | null } };
    contactId: string | null;
  },
): ToolSet {
  const envio = tools.send_message as { execute?: AnyExecute } | undefined;
  if (envio?.execute === undefined) return tools;
  const enviarDeVerdade = envio.execute.bind(envio) as AnyExecute;
  const passagem = tools.request_human_handoff as { execute?: AnyExecute } | undefined;
  const passarParaEquipe = passagem?.execute?.bind(passagem) as AnyExecute | undefined;

  let envios = 0;
  let vetos = 0;
  let encerrado = false;

  const execute: AnyExecute = async (input, options) => {
    if (encerrado) {
      return {
        ok: false,
        error: { code: 'def_turno_encerrado', message: 'A conversa já foi passada para a equipe neste turno. Não envie mais nada.' },
      };
    }
    const body = typeof (input as { body?: unknown })?.body === 'string' ? (input as { body: string }).body : '';

    let veredito: VereditoDef;
    const vetosDeCodigo = checagensDeCodigo({
      body,
      etapa: ctx.decisao.etapa,
      modo: ctx.decisao.modo,
      intencoes: ctx.intencoes,
      enviosNoTurno: envios,
      linksPermitidos: ctx.roteiro.revisor.links_permitidos,
    });
    if (vetosDeCodigo.length > 0) {
      veredito = {
        aprovada: false,
        regras: vetosDeCodigo.map((v) => v.regra),
        motivo: vetosDeCodigo.map((v) => v.motivo).join(' '),
        origem: 'codigo',
      };
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
      if (ctx.contactId !== null) void registrarEventoDef(ctx.pool, ctx.log, {
        organizationId: ctx.tenantId,
        contactId: ctx.contactId,
        agentId: ctx.agente.agentId,
        tipo: 'revisor',
        etapa: ctx.decisao.etapa,
        dados: { regras: veredito.regras, origem: veredito.origem, tentativa: vetos },
      });
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
      const aviso = await enviarDeVerdade({ body: mensagemDeEspera(ctx.roteiro, ctx.nome) }, options);
      if (passarParaEquipe !== undefined) {
        await passarParaEquipe(
          { por_que: 'O revisor de compliance reprovou a resposta duas vezes neste turno.' },
          options,
        );
      }
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
    const ok = (resultado as { ok?: unknown })?.ok === true;
    if (ok) {
      envios += 1;
      const messageId = (resultado as { message_id?: unknown }).message_id;
      const dados = {
        etapa: ctx.decisao.etapa,
        modo: ctx.decisao.modo,
        tem_preco: /\b1\.?200\b/.test(body),
        termina_em_pergunta: body.trim().endsWith('?'),
        revisor: veredito.origem,
      };
      if (typeof messageId === 'string' && messageId !== '') {
        void marcarMensagemDef(ctx.pool, ctx.log, { organizationId: ctx.tenantId, messageId, dados });
      }
      if (ctx.contactId !== null) void registrarEventoDef(ctx.pool, ctx.log, {
        organizationId: ctx.tenantId,
        contactId: ctx.contactId,
        agentId: ctx.agente.agentId,
        messageId: typeof messageId === 'string' && messageId !== '' ? messageId : null,
        tipo: 'mensagem',
        etapa: ctx.decisao.etapa,
        dados,
      });
    }
    return resultado;
  };

  return { ...tools, send_message: { ...tools.send_message, execute } as (typeof tools)['send_message'] };
}
