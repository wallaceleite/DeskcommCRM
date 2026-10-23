import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * [fork wallaceleite] GET/PUT /api/v1/def/horarios — as vagas da consulta que o
 * agente do Método DEF pode oferecer (P0.3).
 *
 * As secretárias mantêm a lista (papel `agent` basta: é o dia a dia delas). O
 * PUT manda a lista INTEIRA do agente: o que não veio sai, o que veio entra ou
 * é atualizado. A reserva provisória que o agente fez para uma família continua
 * valendo — só `ocupado` passa por cima dela.
 *
 * Data e hora no fuso da organização ("2026-11-03", "09:00"). Pool do servidor:
 * `def_horarios` é tabela do fork; `organization_id` vem do papel validado,
 * nunca do corpo.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";

export const dynamic = "force-dynamic";

async function agenteDaOrganizacao(orgId: string, agentId: string): Promise<boolean> {
  const r = await getRequestPool().query("select 1 from ai_agents where id = $1 and organization_id = $2", [
    agentId,
    orgId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

export async function GET(req: NextRequest): Promise<Response> {
  const authz = await requireRole("agent", { resource: "def_horarios" });
  if (!authz.ok) return authz.response;
  const agentId = z.string().uuid().safeParse(req.nextUrl.searchParams.get("agent_id"));
  if (!agentId.success) return fail("invalid_query", "agent_id inválido", 422);

  const r = await getRequestPool().query(
    `select to_char(data, 'YYYY-MM-DD') as data, hora, modalidade, local, status,
            reservado_para, reserva_ate, updated_at
       from def_horarios
      where organization_id = $1 and agent_id = $2
      order by data, hora`,
    [authz.org.orgId, agentId.data],
  );
  return ok(r.rows);
}

const vagaSchema = z.object({
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "data no formato AAAA-MM-DD"),
  hora: z.string().regex(/^[0-2]\d:[0-5]\d$/, "hora no formato HH:MM"),
  modalidade: z.enum(["presencial", "online", "ambas"]).default("ambas"),
  local: z.string().trim().min(1).max(120).nullable().default(null),
  status: z.enum(["livre", "ocupado"]).default("livre"),
});

const corpoDoPut = z.object({
  agent_id: z.string().uuid(),
  horarios: z.array(vagaSchema).max(500),
});

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { resource: "def_horarios" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const parsed = corpoDoPut.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", "lista de horários inválida", 422, { details: parsed.error.issues.slice(0, 20) });
  }
  const { agent_id, horarios } = parsed.data;
  if (!(await agenteDaOrganizacao(org.orgId, agent_id))) {
    return fail("not_found", "agente não encontrado nesta organização", 404);
  }
  const chaves = new Set(horarios.map((h) => `${h.data} ${h.hora}`));
  if (chaves.size !== horarios.length) return fail("invalid_body", "horário repetido na lista", 422);

  const cliente = await getRequestPool().connect();
  try {
    await cliente.query("begin");
    const removidos = await cliente.query(
      `delete from def_horarios
        where organization_id = $1 and agent_id = $2
          and (to_char(data, 'YYYY-MM-DD') || ' ' || hora) <> all($3::text[])`,
      [org.orgId, agent_id, [...chaves]],
    );
    for (const h of horarios) {
      await cliente.query(
        `insert into def_horarios (organization_id, agent_id, data, hora, modalidade, local, status)
         values ($1, $2, $3::date, $4, $5, $6, $7)
         on conflict (organization_id, agent_id, data, hora) do update
           set modalidade = excluded.modalidade,
               local = excluded.local,
               status = case
                 when excluded.status = 'ocupado' then 'ocupado'
                 when def_horarios.status = 'reservado_provisorio' then def_horarios.status
                 else excluded.status
               end,
               updated_at = now()`,
        [org.orgId, agent_id, h.data, h.hora, h.modalidade, h.local, h.status],
      );
    }
    await cliente.query("commit");
    void audit({
      action: "def.roteiro_atualizado",
      organizationId: org.orgId,
      actorUserId: user.id,
      resourceType: "ai_agents",
      resourceId: agent_id,
      metadata: { parte: "horarios", horarios: horarios.length, removidos: removidos.rowCount ?? 0 },
    });
    return ok({ agent_id, horarios: horarios.length, removidos: removidos.rowCount ?? 0 });
  } catch (err) {
    await cliente.query("rollback").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}
