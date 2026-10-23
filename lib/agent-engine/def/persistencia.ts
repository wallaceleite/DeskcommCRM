/**
 * [fork wallaceleite] Leitura e escrita das tabelas do Método DEF
 * (`supabase/fork/rangel.sql`). Toda consulta filtra `organization_id` vindo do
 * turno (linha do job ou da prévia), nunca de payload.
 *
 * Escrita de evento é best-effort: medir não pode derrubar o atendimento.
 */
import type pg from 'pg';
import type { Logger } from '../obs/logger';
import { eEtapaDef, fichaDefSchema, roteiroDefSchema, type EtapaDef, type FichaDef, type RoteiroDef } from './tipos';

export async function carregarRoteiroDef(
  db: pg.Pool,
  organizationId: string,
  agentId: string,
  log: Logger,
): Promise<RoteiroDef | null> {
  let linhas: { conteudo: unknown }[];
  try {
    const r = await db.query<{ conteudo: unknown }>(
      'select conteudo from def_roteiros where organization_id = $1 and agent_id = $2 and ativo = true',
      [organizationId, agentId],
    );
    linhas = r.rows;
  } catch (err) {
    // Tabela ausente (fork sem o schema aplicado) = agente sem DEF, como no upstream.
    log.warn('def: roteiro não carregado — turno segue sem o Método DEF', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
    return null;
  }
  if (linhas.length === 0) return null;
  const roteiro = roteiroDefSchema.safeParse(linhas[0]!.conteudo);
  if (!roteiro.success) {
    log.warn('def: roteiro inválido — turno segue sem o Método DEF', {
      issues: roteiro.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    return null;
  }
  return roteiro.data;
}

export async function carregarFichaDef(
  db: pg.Pool,
  organizationId: string,
  contactId: string,
): Promise<{ etapa: EtapaDef; ficha: FichaDef } | null> {
  const r = await db.query<{ etapa: string; ficha: unknown }>(
    'select etapa, ficha from def_fichas where organization_id = $1 and contact_id = $2',
    [organizationId, contactId],
  );
  const linha = r.rows[0];
  if (!linha) return null;
  const ficha = fichaDefSchema.safeParse(linha.ficha);
  return {
    etapa: eEtapaDef(linha.etapa) ? linha.etapa : 'contato',
    ficha: ficha.success ? ficha.data : {},
  };
}

export async function salvarFichaDef(
  db: pg.Pool,
  args: {
    organizationId: string;
    contactId: string;
    agentId: string | null;
    etapa: EtapaDef;
    ficha: FichaDef;
    provas: Record<string, string>;
  },
): Promise<void> {
  await db.query(
    `insert into def_fichas (organization_id, contact_id, agent_id, etapa, ficha, provas, atualizada_em)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now())
     on conflict (organization_id, contact_id) do update
       set agent_id = excluded.agent_id,
           etapa = excluded.etapa,
           ficha = excluded.ficha,
           provas = def_fichas.provas || excluded.provas,
           atualizada_em = now()`,
    [
      args.organizationId,
      args.contactId,
      args.agentId,
      args.etapa,
      JSON.stringify(args.ficha),
      JSON.stringify(args.provas),
    ],
  );
}

export type TipoDeEventoDef = 'extracao' | 'etapa' | 'mensagem' | 'revisor' | 'passagem';

export async function registrarEventoDef(
  db: pg.Pool,
  log: Logger,
  args: {
    organizationId: string;
    contactId: string | null;
    agentId: string | null;
    messageId?: string | null;
    tipo: TipoDeEventoDef;
    etapa: EtapaDef | null;
    dados: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await db.query(
      `insert into def_eventos (organization_id, contact_id, agent_id, message_id, tipo, etapa, dados)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        args.organizationId,
        args.contactId,
        args.agentId,
        args.messageId ?? null,
        args.tipo,
        args.etapa,
        JSON.stringify(args.dados),
      ],
    );
  } catch (err) {
    log.warn('def: evento não registrado', {
      tipo: args.tipo,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
  }
}

/** A etapa DEF vai junto da mensagem enviada, para a régua dos KPIs. */
export async function marcarMensagemDef(
  db: pg.Pool,
  log: Logger,
  args: { organizationId: string; messageId: string; dados: Record<string, unknown> },
): Promise<void> {
  try {
    await db.query(
      `update messages set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('def', $3::jsonb)
       where organization_id = $1 and id = $2`,
      [args.organizationId, args.messageId, JSON.stringify(args.dados)],
    );
  } catch (err) {
    log.warn('def: mensagem não marcada', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
  }
}
