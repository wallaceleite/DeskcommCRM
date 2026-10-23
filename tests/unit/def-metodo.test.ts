/**
 * [fork wallaceleite] Método DEF — roteador, revisor por código e extrator.
 *
 * As frases vêm do pacote "Agente de IA · Método DEF · Consulta Dr. Raphael
 * Rangel" (documentos 02, 03 e 05 e planilha 04).
 */
import { describe, expect, it } from "vitest";

import { decidirEtapaDef, equipeNoHorario, faltamNaEtapa } from "@/lib/agent-engine/def/roteador";
import { checagensDeCodigo, lerVereditoDoRevisor, suspeitasDoNuncaDiga } from "@/lib/agent-engine/def/revisor";
import { lerSaidaDoExtrator, mesclarFicha } from "@/lib/agent-engine/def/extrator";
import { houveRetomada } from "@/lib/agent-engine/def/turno";
import { roteiroDefSchema, type FichaDef, type RoteiroDef } from "@/lib/agent-engine/def/tipos";

const bloco = (titulo: string) => ({ titulo, instrucoes: `instruções de ${titulo}`, frases: [] });

const ROTEIRO: RoteiroDef = roteiroDefSchema.parse({
  versao: 1,
  equipe: { dias: [1, 2, 3, 4, 5], inicio: "08:00", fim: "17:45" },
  etapas: {
    contato: bloco("Contato"),
    descoberta: bloco("Descoberta"),
    encantamento: bloco("Encantamento"),
    isolamento: bloco("Isolamento"),
    fechamento: bloco("Fechamento"),
    reserva: bloco("Reserva"),
    pos_reserva: bloco("Pós-reserva"),
  },
  modos: { objecao: bloco("Objeção"), dispensa: bloco("Dispensa"), decidido: bloco("Decidido"), retomada: bloco("Retomada") },
  passagens: [
    { intencao: "urgencia", acao: "urgencia", mensagem: "procure imediatamente um serviço de urgência" },
    { intencao: "adulto", acao: "dispensar", mensagem: "atende até 17 anos e 11 meses" },
    { intencao: "dermatologia", acao: "passar", mensagem: "equipe da Dra. Manoela" },
    { intencao: "pergunta_clinica", acao: "responder", mensagem: "o Dr. Raphael precisa avaliar" },
  ],
  extrator: { instrucoes: "extraia" },
  revisor: {
    base: "fatos",
    regras_modelo: ["afirma diagnóstico"],
    links_permitidos: ["instagram.com/dr.raphaelrangel"],
    mensagem_espera: "Já te respondo, {nome}, só um instante.",
  },
});

const DESCOBERTA_COMPLETA: FichaDef = {
  recuo_estrategico_feito: true,
  para_quem: "filho",
  idade_anos: 7,
  cidade: "São Paulo",
  formato_preferido: "online",
  motivo: "suspeita",
  decisor: "proprio",
  termometro: "imediato",
  parafraseou: true,
  acordo_sinceridade: "aceito",
};

const decidir = (ficha: FichaDef, extra: Partial<Parameters<typeof decidirEtapaDef>[0]> = {}) =>
  decidirEtapaDef({
    roteiro: ROTEIRO,
    ficha,
    etapaAnterior: "contato",
    intencoes: [],
    objecaoAtual: null,
    retomada: false,
    ...extra,
  });

describe("roteador DEF: os portões de etapa", () => {
  it("sem recuo e sem resposta, fica no contato", () => {
    expect(decidir({}).etapa).toBe("contato");
  });

  it("recuo feito e a família respondeu: sai do contato para a descoberta", () => {
    const d = decidir({ recuo_estrategico_feito: true, para_quem: "filho" });
    expect(d.etapa).toBe("descoberta");
    expect(d.faltam).toContain("idade");
  });

  it("preço respondido de cara também tira do contato quando a família responde", () => {
    expect(decidir({ preco_informado_em: "contato", idade_anos: 7 }).etapa).toBe("descoberta");
  });

  it("descoberta só sai com idade, cidade, formato, motivo, decisor, termômetro, paráfrase e acordo", () => {
    const { acordo_sinceridade: _sem, ...semAcordo } = DESCOBERTA_COMPLETA;
    expect(decidir(semAcordo).etapa).toBe("descoberta");
    expect(decidir({ ...DESCOBERTA_COMPLETA, parafraseou: false }).etapa).toBe("descoberta");
    expect(decidir({ ...DESCOBERTA_COMPLETA, termometro: "nao_perguntado" }).etapa).toBe("descoberta");
    expect(decidir({ ...DESCOBERTA_COMPLETA, decisor: "nao_mapeado" }).etapa).toBe("descoberta");
    expect(decidir(DESCOBERTA_COMPLETA).etapa).toBe("encantamento");
  });

  it("família com pressa: o mínimo é idade, cidade, motivo, decisor e acordo", () => {
    const pressa: FichaDef = {
      recuo_estrategico_feito: true,
      pressa: true,
      idade_anos: 9,
      cidade: "Curitiba",
      motivo: "laudo",
      decisor: "conjuge",
      acordo_sinceridade: "aceito",
    };
    expect(decidir(pressa).etapa).toBe("encantamento");
  });

  it("encantamento exige a verificação e as red flags resolvidas", () => {
    const base = { ...DESCOBERTA_COMPLETA, red_flags: [{ descricao: "acha que é em SP", resolvida: false }] };
    expect(decidir({ ...base, diferenciais_lembrados: { quantidade: 2, quais: ["a", "b"] } }).etapa).toBe("encantamento");
    expect(
      decidir({
        ...base,
        red_flags: [{ descricao: "acha que é em SP", resolvida: true }],
        diferenciais_lembrados: { quantidade: 2, quais: ["a", "b"] },
      }).etapa,
    ).toBe("isolamento");
  });

  it("um diferencial só: reforça e repete a verificação uma vez antes de sair", () => {
    const um = { ...DESCOBERTA_COMPLETA, diferenciais_lembrados: { quantidade: 1, quais: ["a"] } };
    expect(decidir(um).etapa).toBe("encantamento");
    expect(decidir({ ...um, verificacao_repetida: true }).etapa).toBe("isolamento");
  });

  it("preço só depois do isolamento = só financeiro; reserva depois do sim", () => {
    const encantada = { ...DESCOBERTA_COMPLETA, diferenciais_lembrados: { quantidade: 3, quais: ["a", "b", "c"] } };
    expect(decidir({ ...encantada, isolamento: "outra_variavel" }).etapa).toBe("isolamento");
    expect(decidir({ ...encantada, isolamento: "so_financeiro" }).etapa).toBe("fechamento");
    expect(decidir({ ...encantada, isolamento: "so_financeiro", reacao_preco: "sim" }).etapa).toBe("reserva");
  });

  it("nunca volta de etapa", () => {
    expect(decidir({}, { etapaAnterior: "fechamento" }).etapa).toBe("fechamento");
  });

  it("atalho do decidido: idade e cidade levam direto ao fechamento", () => {
    const d = decidir({ perfil: "decidido", idade_anos: 6, cidade: "Serra" });
    expect(d.etapa).toBe("fechamento");
    expect(d.modo).toBe("decidido");
  });

  it("retomada: quem já foi encantado e volta depois de dias vai ao isolamento", () => {
    const d = decidir({}, { etapaAnterior: "encantamento", retomada: true });
    expect(d.etapa).toBe("isolamento");
    expect(d.modo).toBe("retomada");
  });
});

describe("roteador DEF: o modo do turno pela intenção", () => {
  it("urgência vence tudo", () => {
    const d = decidir({}, { intencoes: ["dermatologia", "urgencia"] });
    expect(d.modo).toBe("urgencia");
    expect(d.passagem?.intencao).toBe("urgencia");
  });

  it("18 anos ou mais é dispensa, mesmo sem a intenção marcada", () => {
    expect(decidir({ idade_anos: 32 }).modo).toBe("dispensa");
  });

  it("dermatologia passa para a equipe com a mensagem da planilha", () => {
    const d = decidir({}, { intencoes: ["dermatologia"] });
    expect(d.modo).toBe("passagem");
    expect(d.passagem?.mensagem).toContain("Manoela");
  });

  it("pergunta clínica responde e segue a venda (não passa)", () => {
    const d = decidir({}, { intencoes: ["pergunta_clinica"] });
    expect(d.modo).toBe("normal");
    expect(d.respostas.map((r) => r.intencao)).toEqual(["pergunta_clinica"]);
  });

  it("objeção sem passagem entra no modo objeção", () => {
    expect(decidir({}, { objecaoAtual: "valor" }).modo).toBe("objecao");
  });
});

describe("revisor DEF: as checagens por código do documento 05", () => {
  const checar = (body: string, extra: Partial<Parameters<typeof checagensDeCodigo>[0]> = {}) =>
    checagensDeCodigo({
      body,
      etapa: "descoberta",
      modo: "normal",
      intencoes: [],
      enviosNoTurno: 0,
      linksPermitidos: ROTEIRO.revisor.links_permitidos,
      ...extra,
    }).map((v) => v.regra);

  it("aprova a mensagem curta que termina em pergunta", () => {
    expect(checar("Qual a idade dele?")).toEqual([]);
  });

  it("1: mais de 2 parágrafos, e a 3ª mensagem do turno", () => {
    expect(checar("a\n\nb\n\nc?")).toContain("1");
    expect(checar("Qual a idade?", { enviosNoTurno: 2 })).toContain("1");
  });

  it("2: tem que terminar em pergunta — menos na urgência e no pagamento recebido", () => {
    expect(checar("Entendi.")).toContain("2");
    expect(checar("Procure um serviço de urgência.", { modo: "urgencia" })).toEqual([]);
    expect(checar("Parabéns pela decisão, Ana! O horário está garantido.")).toEqual([]);
  });

  it("3: sem senhor ou senhora", () => {
    expect(checar("A senhora prefere manhã?")).toContain("3");
  });

  it("4: só o link do Instagram oficial", () => {
    expect(checar("Confira https://www.instagram.com/dr.raphaelrangel/ ?")).toEqual([]);
    expect(checar("Veja https://golpe.example/pix ?")).toContain("4");
  });

  it("5: valor antes do isolamento só se a família perguntou", () => {
    expect(checar("A consulta é R$ 1.200. Para quem é?")).toContain("5");
    expect(checar("A consulta é R$ 1.200. Para quem é?", { intencoes: ["pergunta_preco"] })).toEqual([]);
    expect(checar("A consulta é R$ 1.200, em até 3x. Fica bem acessível, né?", { etapa: "fechamento" })).toEqual([]);
  });

  it("6: não informa a duração da consulta", () => {
    expect(checar("A consulta dura cerca de uma hora, tudo bem?")).toContain("6");
  });

  it("7: desconto só o de irmãos; negar desconto pode", () => {
    expect(checar("Consigo um desconto para você, fechamos?")).toContain("7");
    expect(checar("Para irmãos a gente tem 10% de desconto em cada consulta. Quer dois horários?")).toEqual([]);
    expect(checar("Hoje não temos desconto à vista. Assim fica bom para vocês?")).toEqual([]);
  });

  it("o nunca-diga é suspeita para o modelo, não veto de código", () => {
    expect(suspeitasDoNuncaDiga("Ele é o melhor neuropediatra", ["melhor (neuro|medico|neuropediatra)"])).toHaveLength(1);
    expect(suspeitasDoNuncaDiga("expressão quebrada", ["("])).toEqual([]);
  });

  it("lê o veredito do modelo e recusa saída sem o campo aprovada", () => {
    expect(lerVereditoDoRevisor('{"aprovada": false, "regras_violadas": [3], "trecho": "o melhor", "como_corrigir": "tire"}'))
      .toMatchObject({ aprovada: false, regras: ["3"] });
    expect(lerVereditoDoRevisor("ok, aprovado")).toBeNull();
  });
});

describe("extrator DEF: saída de modelo é dado não confiável", () => {
  it("valor fora do vocabulário vira não sabido, sem derrubar a ficha", () => {
    const saida = lerSaidaDoExtrator(
      '{"ficha": {"idade_anos": 7, "decisor": "avó", "cidade": "Serra"}, "intencoes": ["pergunta_preco", "inventada"], "objecao_atual": null}',
    );
    expect(saida?.ficha).toMatchObject({ idade_anos: 7, cidade: "Serra" });
    expect(saida?.ficha.decisor).toBeUndefined();
    expect(saida?.intencoes).toEqual(["pergunta_preco"]);
  });

  it("sem JSON: null", () => {
    expect(lerSaidaDoExtrator("não sei")).toBeNull();
  });

  it("campo ausente ou vazio mantém o valor anterior", () => {
    const anterior: FichaDef = { idade_anos: 7, cidade: "Serra", acompanhamento_atual: ["fono"] };
    const nova: FichaDef = { idade_anos: null, motivo: "laudo", acompanhamento_atual: [] };
    expect(mesclarFicha(anterior, nova)).toEqual({ idade_anos: 7, cidade: "Serra", acompanhamento_atual: ["fono"], motivo: "laudo" });
  });
});

describe("horário da equipe e retomada", () => {
  it("segunda 10h em São Paulo está no horário; sábado não; 17h50 não", () => {
    const fuso = "America/Sao_Paulo";
    expect(equipeNoHorario(ROTEIRO.equipe, Date.parse("2026-10-26T13:00:00Z"), fuso)).toBe(true);
    expect(equipeNoHorario(ROTEIRO.equipe, Date.parse("2026-10-24T13:00:00Z"), fuso)).toBe(false);
    expect(equipeNoHorario(ROTEIRO.equipe, Date.parse("2026-10-26T20:50:00Z"), fuso)).toBe(false);
  });

  it("retomada = a família volta depois de 24h de silêncio", () => {
    const ctx = (antes: string, agora: string) => ({
      lead_id: "",
      contact: { name: null, phone: null, email: null, tags: [], is_blocked: false },
      conversation_id: null,
      last_human_decision: null,
      messages: [
        { direction: "outbound" as const, body: "Oi", sent_at: antes },
        { direction: "inbound" as const, body: "Voltei", sent_at: agora },
      ],
    });
    expect(houveRetomada(ctx("2026-10-20T10:00:00-03:00", "2026-10-23T10:00:00-03:00") as never)).toBe(true);
    expect(houveRetomada(ctx("2026-10-23T09:00:00-03:00", "2026-10-23T10:00:00-03:00") as never)).toBe(false);
  });

  it("faltamNaEtapa da reserva lista turno, ficha e pagamento", () => {
    expect(faltamNaEtapa("reserva", {})).toHaveLength(3);
  });
});
