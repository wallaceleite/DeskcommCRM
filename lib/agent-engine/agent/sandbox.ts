import type pg from "pg";
import { loadAgentVersionConfig } from "./agent-config";
import { runAgentPreview, type InboundTurnDeps } from "./inbound-turn";
import { newPreviewResult, scenarioContext } from "./preview";
export async function testAgentVersion(
  pool: pg.Pool,
  deps: InboundTurnDeps,
  input: {
    organizationId: string;
    agentId: string;
    versionId: string;
    runId: string;
    sampleMessage: string;
    sampleContact?: { name?: string; phone?: string };
    /** [fork wallaceleite] Ensaio: as mensagens anteriores, da mais antiga à mais nova. */
    history?: ReadonlyArray<{ direction: "inbound" | "outbound"; body: string }>;
    channelId: string | null;
  },
) {
  const agent = await loadAgentVersionConfig(
    pool,
    input.organizationId,
    input.agentId,
    input.versionId,
  );
  if (!agent) throw new Error("preview_version_unavailable");
  const result = newPreviewResult();
  const agora = (deps.clock?.() ?? new Date()).getTime();
  const anteriores = input.history ?? [];
  const context = scenarioContext(
    [
      // Um minuto entre as mensagens do ensaio, terminando um minuto antes de agora.
      ...anteriores.map((m, i) => ({
        direction: m.direction,
        body: m.body,
        sent_at: new Date(agora - (anteriores.length - i) * 60_000).toISOString(),
      })),
      {
        direction: "inbound" as const,
        body: input.sampleMessage,
        sent_at: new Date(agora).toISOString(),
      },
    ],
    input.sampleContact,
  );
  await runAgentPreview(deps, pool, {
    kind: "sandbox",
    organizationId: input.organizationId,
    runId: input.runId,
    agent,
    context,
    contactId: null,
    channelId: input.channelId,
    result,
  });
  return result;
}
