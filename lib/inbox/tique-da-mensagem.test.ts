import { describe, expect, it } from "vitest";

import { tiqueDaMensagem } from "./tique-da-mensagem";

describe("tiqueDaMensagem", () => {
  it("número oficial: status fica 'sent' e a entrega vem na data → ✓✓", () => {
    expect(
      tiqueDaMensagem({ status: "sent", delivered_at: "2026-11-04T18:19:08Z", read_at: null }),
    ).toBe("delivered");
  });

  it("número oficial: com a data de leitura → ✓✓ azul", () => {
    expect(
      tiqueDaMensagem({
        status: "sent",
        delivered_at: "2026-11-04T18:19:08Z",
        read_at: "2026-11-04T18:20:00Z",
      }),
    ).toBe("read");
  });

  it("número oficial: só enviada → ✓", () => {
    expect(tiqueDaMensagem({ status: "sent", delivered_at: null, read_at: null })).toBe("sent");
  });

  it("número por QR: o status já diz, como antes", () => {
    expect(tiqueDaMensagem({ status: "read" })).toBe("read");
    expect(tiqueDaMensagem({ status: "delivered" })).toBe("delivered");
  });

  it("na fila ou falhada não ganha tique", () => {
    expect(tiqueDaMensagem({ status: "queued" })).toBeNull();
    expect(tiqueDaMensagem({ status: "sending" })).toBeNull();
  });
});
