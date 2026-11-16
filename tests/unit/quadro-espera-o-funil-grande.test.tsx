import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { get } = vi.hoisted(() => ({
  get: vi.fn(async () => ({ data: { pipeline: {}, stages: [], leads: [] } })),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { get } }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({ useRealtimeChannel: () => ({ status: "SUBSCRIBED" }) }));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({
  useRefetchDeSeguranca: () => undefined,
}));

import { QUADRO_TIMEOUT_MS, useBoard } from "@/hooks/kanban/useBoard";

/**
 * Funil grande travava em "carregando": o quadro lê o funil INTEIRO, passava
 * dos 10s padrão do apiClient, e o navegador desistia e repetia três vezes —
 * cada repetição recomeçando do zero no servidor. Medido em produção em
 * 16/11/2026: três GET /board seguidos, todos abortados aos 9,99s.
 */
describe("o quadro espera o funil grande", () => {
  it("pede o board com prazo bem acima dos 10s padrão", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    renderHook(() => useBoard("pipe-1"), { wrapper });
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(get).toHaveBeenCalledWith("/api/v1/pipelines/pipe-1/board", {
      timeoutMs: QUADRO_TIMEOUT_MS,
    });
    expect(QUADRO_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});
