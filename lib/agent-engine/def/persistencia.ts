/**
 * [fork wallaceleite] Leitura e escrita das tabelas do Método DEF
 * (`supabase/fork/rangel.sql`). Toda consulta filtra `organization_id` vindo do
 * turno (linha do job ou da prévia), nunca de payload.
 *
 * Escrita de evento é best-effort: medir não pode derrubar o atendimento.
 */
import type pg from 'pg';
import type { Logger } from '../obs/logger';
import type { HorarioDef } from './agenda';
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

export type TipoDeEventoDef = 'extracao' | 'etapa' | 'mensagem' | 'revisor' | 'passagem' | 'turno' | 'reserva';

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

// ── HORÁRIOS (P0.3) ─────────────────────────────────────────────────────────

interface LinhaDeHorario {
  data: string;
  hora: string;
  modalidade: HorarioDef['modalidade'];
  local: string | null;
  status: HorarioDef['status'];
  reservado_para: string | null;
  reserva_ate: Date | null;
}

/** As vagas do agente que ainda não foram ocupadas (a escolha é de `agenda.ts`). */
export async function listarHorariosDef(
  db: pg.Pool,
  organizationId: string,
  agentId: string,
  log: Logger,
): Promise<HorarioDef[]> {
  try {
    const r = await db.query<LinhaDeHorario>(
      `select to_char(data, 'YYYY-MM-DD') as data, hora, modalidade, local, status, reservado_para, reserva_ate
         from def_horarios
        where organization_id = $1 and agent_id = $2 and status <> 'ocupado'
        order by data, hora`,
      [organizationId, agentId],
    );
    return r.rows.map((l) => ({ ...l, reserva_ate: l.reserva_ate === null ? null : l.reserva_ate.getTime() }));
  } catch (err) {
    log.warn('def: horários não lidos', { error: (err instanceof Error ? err.message : String(err)).slice(0, 160) });
    return [];
  }
}

/**
 * Segura a vaga escolhida para a família por `horas`. Só pega vaga livre, com
 * reserva vencida ou já desta família — duas famílias nunca seguram a mesma.
 */
export async function reservarHorarioDef(
  db: pg.Pool,
  args: { organizationId: string; agentId: string; contactId: string; data: string; hora: string; horas: number },
): Promise<boolean> {
  const r = await db.query(
    `update def_horarios
        set status = 'reservado_provisorio', reservado_para = $3,
            reserva_ate = now() + make_interval(hours => $6), updated_at = now()
      where organization_id = $1 and agent_id = $2 and data = $4::date and hora = $5
        and (status = 'livre'
             or (status = 'reservado_provisorio' and (reserva_ate is null or reserva_ate <= now() or reservado_para = $3)))`,
    [args.organizationId, args.agentId, args.contactId, args.data, args.hora, args.horas],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Acrescenta campos à ficha sem reescrever o resto (rotulador, preço enviado). */
export async function completarFichaDef(
  db: pg.Pool,
  log: Logger,
  args: { organizationId: string; contactId: string; campos: Record<string, unknown>; soSeVazio?: boolean },
): Promise<void> {
  try {
    await db.query(
      args.soSeVazio
        ? `update def_fichas set ficha = $3::jsonb || ficha where organization_id = $1 and contact_id = $2`
        : `update def_fichas set ficha = ficha || $3::jsonb where organization_id = $1 and contact_id = $2`,
      [args.organizationId, args.contactId, JSON.stringify(args.campos)],
    );
  } catch (err) {
    log.warn('def: ficha não completada', { error: (err instanceof Error ? err.message : String(err)).slice(0, 160) });
  }
}

/** Junta os rótulos do rotulador ao evento da mensagem (P1.6). */
export async function rotularEventoDef(
  db: pg.Pool,
  log: Logger,
  args: { organizationId: string; messageId: string; rotulos: Record<string, unknown> },
): Promise<void> {
  try {
    await db.query(
      `update def_eventos set dados = dados || $3::jsonb
        where organization_id = $1 and message_id = $2 and tipo = 'mensagem'`,
      [args.organizationId, args.messageId, JSON.stringify(args.rotulos)],
    );
  } catch (err) {
    log.warn('def: rótulo não gravado', { error: (err instanceof Error ? err.message : String(err)).slice(0, 160) });
  }
}
