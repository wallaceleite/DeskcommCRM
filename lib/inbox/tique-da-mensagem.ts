/**
 * Fork: qual tique a mensagem enviada mostra — ✓ enviada, ✓✓ entregue, ✓✓ azul lida.
 *
 * Os dois canais gravam o mesmo fato em lugares diferentes. O não-oficial
 * (`lib/waha/ingest.ts`, `handleAck`) escreve `status = delivered | read` E as
 * datas. O oficial (`lib/channels/meta/status-update.ts`) mantém `status` em
 * `sent | failed` de propósito — é o domínio que métricas e envio leem — e põe a
 * entrega e a leitura só em `delivered_at` / `read_at`. A tela olhava só o
 * `status`, então no número oficial toda mensagem ficava em ✓ para sempre.
 */
export type Tique = "read" | "delivered" | "sent";

export function tiqueDaMensagem(m: {
  status: string;
  delivered_at?: string | null;
  read_at?: string | null;
}): Tique | null {
  if (m.status === "read" || m.read_at) return "read";
  if (m.status === "delivered" || m.delivered_at) return "delivered";
  if (m.status === "sent") return "sent";
  return null;
}
