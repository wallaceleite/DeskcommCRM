/**
 * [fork wallaceleite] POST /api/v1/def/titular/recomecar — a ficha DEF de um
 * contato volta ao começo (etapa contato, ficha e provas vazias).
 *
 * Para recomeçar um teste ou um atendimento do zero: o roteador nunca volta de
 * etapa, então quem já chegou ao fechamento recomeçaria no valor. Nada se
 * perde: a ficha antiga vai para um evento `recomeco` antes de ser zerada, e
 * as mensagens da conversa não são tocadas. Vaga que estava segura para o
 * contato volta a ficar livre.
 *
 * Só admin (o mesmo papel do GET de `titular`). `organization_id` do papel.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";

export const dynamic = "force-dynamic";

const corpo = z.object({ contact_id: z.string().uuid() });

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("admin", { resource: "def_titular" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const parsed = corpo.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("invalid_body", "contact_id inválido", 422);
  const contactId = parsed.data.contact_id;

  const cliente = await getRequestPool().connect();
  try {
    await cliente.query("begin");
    const antiga = await cliente.query<{ etapa: string; ficha: unknown; provas: unknown; agent_id: string | null }>(
      `select etapa, ficha, provas, agent_id from def_fichas
        where organization_id = $1 and contact_id = $2 for update`,
      [org.orgId, contactId],
    );
    const linha = antiga.rows[0];
    if (linha) {
      await cliente.query(
        `insert into def_eventos (organization_id, contact_id, agent_id, tipo, etapa, dados)
         values ($1, $2, $3, 'recomeco', $4, $5::jsonb)`,
        [org.orgId, contactId, linha.agent_id, linha.etapa, JSON.stringify({ ficha: linha.ficha, provas: linha.provas })],
      );
      await cliente.query(
        `update def_fichas set etapa = 'contato', ficha = '{}'::jsonb, provas = '{}'::jsonb, atualizada_em = now()
          where organization_id = $1 and contact_id = $2`,
        [org.orgId, contactId],
      );
    }
    const vagas = await cliente.query(
      `update def_horarios set status = 'livre', reservado_para = null, reserva_ate = null, updated_at = now()
        where organization_id = $1 and reservado_para = $2 and status = 'reservado_provisorio'`,
      [org.orgId, contactId],
    );
    await cliente.query("commit");
    const resultado = { contact_id: contactId, tinha_ficha: linha !== undefined, etapa_anterior: linha?.etapa ?? null, vagas_liberadas: vagas.rowCount ?? 0 };
    if (linha !== undefined || (vagas.rowCount ?? 0) > 0) {
      void audit({
        action: "def.ficha_recomecada",
        organizationId: org.orgId,
        actorUserId: user.id,
        resourceType: "contacts",
        resourceId: contactId,
        metadata: { etapa_anterior: resultado.etapa_anterior, vagas_liberadas: resultado.vagas_liberadas },
      });
    }
    return ok(resultado);
  } catch (err) {
    await cliente.query("rollback").catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}
