import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * [fork wallaceleite] GET/PUT /api/v1/def/roteiros — o roteiro do Método DEF de
 * um agente (etapas, frases, passagens e regras do revisor).
 *
 * Sem roteiro ativo, o agente atende exatamente como no upstream: é esta linha
 * que liga a camada DEF do turno (`lib/agent-engine/def/turno.ts`).
 *
 * Pool do servidor, não a sessão: `def_roteiros` não está nos tipos gerados do
 * Supabase (é tabela do fork, `supabase/fork/rangel.sql`). O `organization_id`
 * vem do papel validado pelo `requireRole` — nunca do corpo — e filtra toda
 * consulta à mão, inclusive a conferência de que o agente é desta organização.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { roteiroDefSchema } from "@/lib/agent-engine/def/tipos";

export const dynamic = "force-dynamic";

const agentIdSchema = z.string().uuid();

async function agenteDaOrganizacao(orgId: string, agentId: string): Promise<boolean> {
  const r = await getRequestPool().query("select 1 from ai_agents where id = $1 and organization_id = $2", [
    agentId,
    orgId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

export async function GET(req: NextRequest): Promise<Response> {
  const authz = await requireRole("manager", { resource: "def_roteiros" });
  if (!authz.ok) return authz.response;
  const agentId = agentIdSchema.safeParse(req.nextUrl.searchParams.get("agent_id"));
  if (!agentId.success) return fail("invalid_query", "agent_id inválido", 422);

  const r = await getRequestPool().query(
    "select agent_id, ativo, conteudo, revisao, updated_at from def_roteiros where organization_id = $1 and agent_id = $2",
    [authz.org.orgId, agentId.data],
  );
  return ok(r.rows[0] ?? null);
}

const corpoDoPut = z.object({
  agent_id: z.string().uuid(),
  ativo: z.boolean().default(true),
  conteudo: roteiroDefSchema,
});

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("admin", { resource: "def_roteiros" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const parsed = corpoDoPut.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", "roteiro inválido", 422, { details: parsed.error.issues.slice(0, 20) });
  }
  const corpo = parsed.data;
  if (!(await agenteDaOrganizacao(org.orgId, corpo.agent_id))) {
    return fail("not_found", "agente não encontrado nesta organização", 404);
  }

  const r = await getRequestPool().query<{ revisao: number }>(
    `insert into def_roteiros (organization_id, agent_id, ativo, conteudo, revisao, updated_at, updated_by)
     values ($1, $2, $3, $4::jsonb, 1, now(), $5)
     on conflict (organization_id, agent_id) do update
       set ativo = excluded.ativo,
           conteudo = excluded.conteudo,
           revisao = def_roteiros.revisao + 1,
           updated_at = now(),
           updated_by = excluded.updated_by
     returning revisao`,
    [org.orgId, corpo.agent_id, corpo.ativo, JSON.stringify(corpo.conteudo), user.id],
  );

  void audit({
    action: "def.roteiro_atualizado",
    organizationId: org.orgId,
    actorUserId: user.id,
    resourceType: "ai_agents",
    resourceId: corpo.agent_id,
    metadata: { ativo: corpo.ativo, revisao: r.rows[0]?.revisao ?? null },
  });

  return ok({ agent_id: corpo.agent_id, ativo: corpo.ativo, revisao: r.rows[0]?.revisao ?? null });
}
