// Fork: A COLUNA DESENHA 50 CARDS E OFERECE "MOSTRAR MAIS".
//
// Uma etapa com 878 cards montava 32 mil elementos e travava o funil a cada
// recarga. Os dados continuam inteiros — contagem, total e "selecionar a etapa"
// valem para todos — e só o desenho para. Desfazer o corte (voltar a
// `leads.map`) deixa este arquivo vermelho.

import { fireEvent, render, screen } from "@testing-library/react";
import { DragDropContext } from "@hello-pangea/dnd";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/kanban/KanbanCard", () => ({
  KanbanCard: ({ lead }: { lead: { id: string } }) => <div data-testid={`cartao-${lead.id}`} />,
}));

import { StageColumn, CARDS_DESENHADOS } from "@/components/kanban/StageColumn";
import type { Lead } from "@/lib/types/leads";
import type { Stage } from "@/lib/kanban/types";

const etapa = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  pipeline_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Base",
  position: 1,
  color: null,
} as unknown as Stage;

function leads(n: number): Lead[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `lead-${i}`,
    pipeline_id: etapa.pipeline_id,
    stage_id: etapa.id,
    title: `Negócio ${i}`,
    value_cents: null,
    currency: "BRL",
    status: "open",
    tags: [],
    position_in_stage: (i + 1) * 1000,
  })) as unknown as Lead[];
}

function montar(lista: Lead[]) {
  return render(
    <DragDropContext onDragEnd={() => {}}>
      <StageColumn stage={etapa} leads={lista} pipelineId={etapa.pipeline_id} />
    </DragDropContext>,
  );
}

const cartoes = () => screen.queryAllByTestId(/^cartao-/);

describe("coluna com muitos cards", () => {
  it("desenha só os primeiros, na ordem, e a contagem segue sendo a da etapa inteira", () => {
    montar(leads(878));
    expect(cartoes()).toHaveLength(CARDS_DESENHADOS);
    expect(cartoes()[0]).toHaveAttribute("data-testid", "cartao-lead-0");
    expect(screen.getByText("878")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mostrar mais \(828\)/ })).toBeInTheDocument();
  });

  it("mostrar mais desenha o próximo bloco, até acabar o botão", () => {
    montar(leads(120));
    fireEvent.click(screen.getByRole("button", { name: /Mostrar mais \(70\)/ }));
    expect(cartoes()).toHaveLength(120);
    expect(screen.queryByRole("button", { name: /Mostrar mais/ })).not.toBeInTheDocument();
  });

  it("coluna curta não ganha botão", () => {
    montar(leads(12));
    expect(cartoes()).toHaveLength(12);
    expect(screen.queryByRole("button", { name: /Mostrar mais/ })).not.toBeInTheDocument();
  });
});
