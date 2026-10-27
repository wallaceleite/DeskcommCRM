/**
 * [fork wallaceleite] Método DEF — roteador, revisor por código e extrator.
 *
 * As frases vêm do pacote "Agente de IA · Método DEF · Consulta Dr. Raphael
 * Rangel" (documentos 02, 03 e 05 e planilha 04).
 */
import { describe, expect, it } from "vitest";

import { decidirEtapaDef, equipeNoHorario, faltamNaEtapa } from "@/lib/agent-engine/def/roteador";
import {
  checagensDeCodigo,
  lerVereditoDoRevisor,
  limiteDoTurno,
  perguntouPreco,
  semelhanca,
  trechoExisteNaMensagem,
  suspeitasDoNuncaDiga,
  vereditoSemModelo,
} from "@/lib/agent-engine/def/revisor";
import { lerSaidaDoExtrator, mesclarFicha } from "@/lib/agent-engine/def/extrator";
import { fichaParaEsteAtendimento, houveRetomada, iniciarTurnoDef, prepararMensagemDePassagem, resumoCurtoDaFicha } from "@/lib/agent-engine/def/turno";
import { renderizarBlocosDef } from "@/lib/agent-engine/def/blocos";
import { agoraNoFuso, encontrarVagaEscolhida, escolherVagas, type HorarioDef } from "@/lib/agent-engine/def/agenda";
import { camposConfirmadosPelaFrase, lerRotulos } from "@/lib/agent-engine/def/rotulador";
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
    { intencao: "paciente_antigo", acao: "passar", mensagem: "condições para quem já é paciente" },
    { intencao: "pergunta_clinica", acao: "responder", mensagem: "o Dr. Raphael precisa avaliar" },
    {
      intencao: "pergunta_se_e_ia",
      acao: "responder",
      exclusiva: true,
      mensagem: "Sou a assistente virtual da equipe do Dr. Raphael e acompanho o seu atendimento junto com a equipe. Se preferir falar com uma pessoa, eu chamo agora. Quer que eu chame?",
    },
    { intencao: "quer_humano", acao: "passar", mensagem: "Claro! Vou chamar alguém da equipe para continuar com você, combinado?" },
    { intencao: "quer_data_antes", acao: "passar", mensagem: "Vou colocar o [nome da criança] na lista. Garantimos o dia [data], combinado?" },
    { intencao: "sem_horario", acao: "passar", mensagem: "Vou ver com a equipe os próximos horários e já te passo, combinado?" },
  ],
  agenda: { opcoes: 2, reserva_horas: 24, regras_de_local: [{ dia: 1, a_partir_de: "12:00", local: "Aracruz", modalidade: "presencial" }] },
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

  it("paciente_antigo só passa quando a ficha diz que já é paciente", () => {
    // A Thais: "faço acompanhamento com um neuro, mas quero trocar" — intenção marcada, ficha "nao".
    expect(decidir({ ja_e_paciente: "nao" }, { intencoes: ["paciente_antigo"] }).modo).toBe("normal");
    expect(decidir({}, { intencoes: ["paciente_antigo"] }).modo).toBe("normal");
    const d = decidir({ ja_e_paciente: "sim" }, { intencoes: ["paciente_antigo"] });
    expect(d.modo).toBe("passagem");
    expect(d.passagem?.intencao).toBe("paciente_antigo");
  });
});

describe("fluxo enxuto (pedido do Dr.): perguntas curtas numa ordem fixa", () => {
  const ENXUTO: RoteiroDef = { ...ROTEIRO, fluxo: "enxuto" };
  const enxuto = (ficha: FichaDef, extra: Partial<Parameters<typeof decidirEtapaDef>[0]> = {}) =>
    decidir(ficha, { roteiro: ENXUTO, equipeJaFalou: true, ...extra });

  it("1ª mensagem: apresentação e a primeira pergunta juntas, sem recuo", () => {
    const d = enxuto({}, { equipeJaFalou: false });
    expect(d.etapa).toBe("contato");
    expect(d.faltam).toEqual(["apresentar-se em uma frase e, na mesma mensagem, perguntar: nome e idade do paciente"]);
  });

  it("a família respondeu nome e idade: sai do contato e a próxima é a cidade", () => {
    const d = enxuto({ nome_crianca: "Pedro", idade_anos: 7 });
    expect(d.etapa).toBe("descoberta");
    expect(d.faltam[0]).toBe("cidade e estado (ou país)");
  });

  it("a ordem: cidade, primeira consulta, diagnóstico, modalidade", () => {
    const base: FichaDef = { idade_anos: 7, cidade: "Vitória" };
    expect(enxuto(base).faltam[0]).toBe("se é a primeira consulta ou se já é paciente");
    expect(enxuto({ ...base, ja_e_paciente: "nao" }).faltam[0]).toBe("se já tem diagnóstico ou está em investigação");
    expect(enxuto({ ...base, ja_e_paciente: "nao", tem_diagnostico: "investigando" }).faltam).toEqual([
      "modalidade: online ou presencial",
    ]);
  });

  it("acompanhamento só para quem já tem diagnóstico", () => {
    const base: FichaDef = { idade_anos: 7, cidade: "Vitória", ja_e_paciente: "nao", tem_diagnostico: "sim" };
    expect(enxuto(base).faltam[0]).toBe("se faz acompanhamento com outros profissionais");
    expect(enxuto({ ...base, acompanhamento_atual: ["nenhum"] }).faltam[0]).toBe("modalidade: online ou presencial");
  });

  it("tudo respondido: vai direto ao valor com horários, sem Encantamento nem Isolamento", () => {
    const ficha: FichaDef = {
      idade_anos: 7,
      cidade: "Vitória",
      ja_e_paciente: "nao",
      tem_diagnostico: "investigando",
      formato_preferido: "presencial",
    };
    const d = enxuto(ficha);
    expect(d.etapa).toBe("fechamento");
    expect(d.faltam).toEqual(["apresentar o que está incluso e o valor, e oferecer os horários"]);
    expect(enxuto({ ...ficha, horario_escolhido: "2026-11-18 14:00" }).etapa).toBe("reserva");
  });

  it("o DEF completo não muda: sem `fluxo`, a descoberta ainda pede motivo, decisor e acordo", () => {
    const d = decidir({ idade_anos: 7, cidade: "Vitória", ja_e_paciente: "nao", tem_diagnostico: "investigando", formato_preferido: "online" }, { equipeJaFalou: true });
    expect(d.etapa).toBe("contato");
    expect(faltamNaEtapa("descoberta", { idade_anos: 7, cidade: "Vitória", formato_preferido: "online" })).toContain("quem decide");
  });

  it("no fechamento sem modalidade, pergunta a modalidade antes do valor e dos horários", () => {
    const d = enxuto({}, { etapaAnterior: "fechamento" });
    expect(d.etapa).toBe("fechamento");
    expect(d.faltam).toEqual(["modalidade: online ou presencial"]);
  });

  it("atalho do decidido no enxuto: sem modalidade não vai aos horários", () => {
    const d = enxuto({ perfil: "decidido", idade_anos: 7, cidade: "Vitória" });
    expect(d.modo).toBe("decidido");
    expect(d.etapa).not.toBe("fechamento");
    expect(d.faltam).toContain("modalidade: online ou presencial");
    expect(enxuto({ perfil: "decidido", idade_anos: 7, cidade: "Vitória", formato_preferido: "presencial" }).etapa).toBe("fechamento");
  });

  it("o bloco mostra só o próximo passo", () => {
    const decisao = enxuto({ idade_anos: 7 });
    const bloco = renderizarBlocosDef({ roteiro: ENXUTO, decisao, ficha: { idade_anos: 7 }, dentroDoHorario: true, objecaoAtual: null });
    expect(bloco).toContain("### Próximo passo (só este");
    expect(bloco).toContain("- cidade e estado (ou país)");
    expect(bloco).not.toContain("se é a primeira consulta");
  });
});

describe("ficha de um atendimento anterior", () => {
  const ficha: FichaDef = { idade_anos: 6, cidade: "Campinas", formato_preferido: "online", horario_escolhido: "2026-11-17 09:00", reacao_preco: "sim" };
  const msgs = [{ sent_at: "2026-10-27T09:40:34-03:00" }, { sent_at: "2026-10-27T09:40:41-03:00" }];

  it("gravada antes deste atendimento: formato, horário e reação ao preço voltam a ser perguntados", () => {
    const f = fichaParaEsteAtendimento(ficha, new Date("2026-10-24T21:21:31Z"), msgs);
    expect(f).toMatchObject({ idade_anos: 6, cidade: "Campinas", formato_preferido: "nao_informado", horario_escolhido: null, reacao_preco: null });
  });

  it("gravada neste atendimento: fica como está", () => {
    expect(fichaParaEsteAtendimento(ficha, new Date("2026-10-27T12:41:00Z"), msgs)).toBe(ficha);
    expect(fichaParaEsteAtendimento(ficha, null, msgs)).toBe(ficha);
    expect(fichaParaEsteAtendimento(ficha, new Date("2026-10-24T21:21:31Z"), [])).toBe(ficha);
  });
});

describe("revisor DEF: as checagens por código do documento 05", () => {
  const checar = (body: string, extra: Partial<Parameters<typeof checagensDeCodigo>[0]> = {}) =>
    checagensDeCodigo({
      body,
      etapa: "descoberta",
      modo: "normal",
      intencoes: [],
      linksPermitidos: ROTEIRO.revisor.links_permitidos,
      ...extra,
    }).map((v) => v.regra);

  it("tamanho: acima do teto é vetada; urgência nunca", () => {
    const longa = "A consulta inclui os questionários digitais antes do encontro. ".repeat(6) + "Qual fica melhor?";
    expect(checar(longa, { maxCaracteres: 350 })).toContain("tamanho");
    expect(checar(longa)).not.toContain("tamanho");
    expect(checar(longa, { maxCaracteres: 350, modo: "urgencia" })).not.toContain("tamanho");
    expect(checar("Qual a idade dele?", { maxCaracteres: 350 })).toEqual([]);
  });

  it("aprova a mensagem curta que termina em pergunta", () => {
    expect(checar("Qual a idade dele?")).toEqual([]);
  });

  it("1: mais de 2 parágrafos", () => {
    expect(checar("a\n\nb\n\nc?")).toContain("1");
  });

  it("2 (P0.5): a 1ª mensagem pode não ter pergunta; uma pergunta só, e no fim", () => {
    expect(checar("A consulta inclui os questionários antes do encontro.")).toEqual([]);
    expect(checar("Tudo bem? Posso te perguntar umas coisas?")).toContain("2");
    expect(checar("Qual a idade dele? Fico no aguardo.")).toContain("2");
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
    // perguntou de desconto/Pix: responder a condição com o 3x não é preço antes da hora
    expect(checar("Hoje não temos desconto à vista. Dá para dividir em até 3x sem juros. Assim fica bom?", { familiaPerguntouValor: true })).toEqual([]);
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

describe("P0.4/P0.5: o limite do turno não é veto", () => {
  it("2 mensagens enviadas ou pergunta já feita: aguarde a família", () => {
    expect(limiteDoTurno({ enviosNoTurno: 0, perguntasNoTurno: 0 })).toBeNull();
    expect(limiteDoTurno({ enviosNoTurno: 1, perguntasNoTurno: 0 })).toBeNull();
    expect(limiteDoTurno({ enviosNoTurno: 2, perguntasNoTurno: 0 })).toMatch(/aguarde/);
    expect(limiteDoTurno({ enviosNoTurno: 1, perguntasNoTurno: 1 })).toMatch(/aguarde/);
  });
});

// O turno inteiro com banco e modelo falsos: o revisor de modelo desligado, sem
// extração (o envoltório é o que se mede aqui).
function poolFalso(roteiro: RoteiroDef, horarios: unknown[] = []) {
  const consultas: string[] = [];
  return {
    consultas,
    pool: {
      query: async (sql: string) => {
        consultas.push(sql);
        if (sql.includes("from def_roteiros")) return { rows: [{ conteudo: roteiro }], rowCount: 1 };
        if (sql.includes("from def_horarios")) return { rows: horarios, rowCount: horarios.length };
        return { rows: [], rowCount: 0 };
      },
    },
  };
}

const LOG = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };

function contexto(mensagens: { direction: "inbound" | "outbound"; body: string }[], nome: string | null = "Juliana Souza") {
  return {
    lead_id: "",
    contact: { name: nome, phone: null, email: null, tags: [], is_blocked: false },
    conversation_id: null,
    last_human_decision: null,
    messages: mensagens.map((m, i) => ({ ...m, sent_at: new Date(Date.parse("2026-10-23T12:00:00Z") + i * 60_000).toISOString() })),
  };
}

async function turnoDeTeste(opts: {
  roteiro?: RoteiroDef;
  mensagens?: { direction: "inbound" | "outbound"; body: string }[];
  temMensagemNova?: boolean;
  horarios?: unknown[];
  agora?: number;
}) {
  const roteiro = opts.roteiro ?? roteiroDefSchema.parse({ ...ROTEIRO, revisor: { ...ROTEIRO.revisor, ativo: false } });
  const { pool } = poolFalso(roteiro, opts.horarios);
  const turno = await iniciarTurnoDef({
    pool: pool as never,
    llmCfg: {} as never,
    log: LOG as never,
    tenantId: "org",
    leadId: "",
    agente: { agentId: "agente", provider: "openai", credentialId: null },
    contexto: contexto(opts.mensagens ?? [{ direction: "inbound", body: "Oi" }]) as never,
    temMensagemNova: opts.temMensagemNova ?? false,
    persistir: false,
    fuso: "America/Sao_Paulo",
    agora: opts.agora ?? Date.parse("2026-10-23T15:00:00Z"),
  });
  const enviados: string[] = [];
  const passagens: unknown[] = [];
  const tools = turno!.envolverFerramentas({
    send_message: { execute: async (i: { body: string }) => (enviados.push(i.body), { ok: true, message_id: `m${enviados.length}` }) },
    request_human_handoff: { execute: async (i: unknown) => (passagens.push(i), { ok: true }) },
  } as never) as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<{ ok?: boolean; error?: { code: string } }> }>;
  return { turno: turno!, tools, enviados, passagens };
}

describe("P0.4: o modelo tenta 4 envios", () => {
  it("saem 2 mensagens, nenhuma passagem e nenhuma mensagem de espera", async () => {
    const t = await turnoDeTeste({});
    const r = [] as { ok?: boolean; error?: { code: string } }[];
    for (const body of ["A avaliação começa antes da consulta.", "Posso te fazer umas perguntas rápidas?", "Qual a idade?", "E a cidade?"]) {
      r.push(await t.tools.send_message!.execute({ body }, {}));
    }
    expect(t.enviados).toEqual(["A avaliação começa antes da consulta.", "Posso te fazer umas perguntas rápidas?"]);
    expect(t.passagens).toHaveLength(0);
    expect(t.enviados.some((b) => b.startsWith("Já te respondo"))).toBe(false);
    expect(r.slice(2).map((x) => x.error?.code)).toEqual(["def_turno_encerrado", "def_turno_encerrado"]);
    const resumo = t.turno.finalizar()!;
    expect(resumo).toMatchObject({ mensagens: 2, perguntas: 1, termina_em_pergunta: true, passou_para_equipe: false });
  });

  it("P0.5: duas mensagens com pergunta cada uma — a segunda é recusada", async () => {
    const t = await turnoDeTeste({});
    await t.tools.send_message!.execute({ body: "Qual a idade dele?" }, {});
    const segunda = await t.tools.send_message!.execute({ body: "E vocês moram em qual cidade?" }, {});
    expect(segunda.error?.code).toBe("def_turno_encerrado");
    expect(t.enviados).toHaveLength(1);
  });

  it("P0.5: a 1ª sem pergunta recebe o aviso de mandar a 2ª com a pergunta", async () => {
    const t = await turnoDeTeste({});
    const r = (await t.tools.send_message!.execute({ body: "A avaliação começa antes da consulta." }, {})) as { def_aviso?: string };
    expect(r.def_aviso).toMatch(/segunda e última/);
  });

  it("veto numa mensagem e veto na seguinte (com uma enviada no meio) não passam para a equipe", async () => {
    const t = await turnoDeTeste({});
    await t.tools.send_message!.execute({ body: "A senhora prefere manhã?" }, {});
    await t.tools.send_message!.execute({ body: "A avaliação começa antes da consulta." }, {});
    const r = await t.tools.send_message!.execute({ body: "A senhora prefere tarde?" }, {});
    expect(r.error?.code).toBe("def_revisor");
    expect(t.passagens).toHaveLength(0);
  });

  it("dois vetos de conteúdo ainda passam para a equipe com a mensagem de espera", async () => {
    const t = await turnoDeTeste({});
    await t.tools.send_message!.execute({ body: "A senhora prefere manhã?" }, {});
    const r = await t.tools.send_message!.execute({ body: "A senhora prefere tarde?" }, {});
    expect(r.error?.code).toBe("def_revisor_passou_para_equipe");
    expect(t.enviados).toEqual(["Já te respondo, Juliana, só um instante."]);
    expect(t.passagens).toHaveLength(1);
  });
});

describe("passagem: a família ouve a mensagem do roteiro, nunca o aviso genérico", () => {
  it("o modelo chama a equipe sem falar: o código manda a passagem antes", async () => {
    const t = await turnoDeTeste({});
    await t.tools.request_human_handoff!.execute({ por_que: "pediu uma pessoa" }, {});
    expect(t.enviados).toEqual(["Claro! Vou chamar alguém da equipe para continuar com você, combinado?"]);
    expect(t.passagens).toHaveLength(1);
    expect(JSON.stringify(t.passagens[0])).toContain("Método DEF, etapa contato");
  });

  it("a trava de promessa do núcleo veta a 1ª: o código tenta de novo (o núcleo abre o caso)", async () => {
    const t = await turnoDeTeste({});
    let tentativas = 0;
    const enviados: string[] = [];
    const tools = t.turno.envolverFerramentas({
      send_message: {
        execute: async (i: { body: string }) =>
          ++tentativas === 1
            ? { ok: false, error: { code: "case_promise_without_case" } }
            : (enviados.push(i.body), { ok: true, message_id: "m1" }),
      },
      request_human_handoff: { execute: async () => ({ ok: true }) },
    } as never) as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;
    await tools.request_human_handoff!.execute({}, {});
    expect(tentativas).toBe(2);
    expect(enviados).toHaveLength(1);
  });

  it("se o modelo já falou, o código não repete", async () => {
    const t = await turnoDeTeste({});
    await t.tools.send_message!.execute({ body: "Claro, vou chamar alguém da equipe, combinado?" }, {});
    await t.tools.request_human_handoff!.execute({}, {});
    expect(t.enviados).toHaveLength(1);
  });

  it("colchetes: nome, nome da criança, e o que não tem valor", () => {
    expect(prepararMensagemDePassagem("[nome], isso precisa de atenção agora.", "Juliana Souza", {})).toBe("Juliana, isso precisa de atenção agora.");
    expect(prepararMensagemDePassagem("[nome], isso precisa de atenção agora.", null, {})).toBe("Isso precisa de atenção agora.");
    expect(prepararMensagemDePassagem("Recebi, [nome]! A equipe confere.", null, {})).toBe("Recebi! A equipe confere.");
    expect(prepararMensagemDePassagem("Vou colocar o [nome da criança] na lista.", null, { para_quem: "filha" })).toBe("Vou colocar a sua filha na lista.");
    expect(prepararMensagemDePassagem("Garantimos o dia [data].", null, {})).toBeNull();
  });

  it("o resumo para a equipe cabe no campo da passagem", () => {
    expect(resumoCurtoDaFicha("encantamento", { ...DESCOBERTA_COMPLETA, nome_crianca: "Pedro", motivo_texto: "x".repeat(400) }).length).toBeLessThanOrEqual(200);
  });
});

describe("P0.7: perguntou se é IA", () => {
  it("responde a verdade e oferece uma pessoa, sem passar nem seguir a etapa", () => {
    const d = decidir({}, { intencoes: ["pergunta_se_e_ia"] });
    expect(d.modo).toBe("normal");
    expect(d.passagem).toBeNull();
    expect(d.respostas.map((r) => r.intencao)).toEqual(["pergunta_se_e_ia"]);
    const bloco = renderizarBlocosDef({ roteiro: ROTEIRO, decisao: d, ficha: {}, dentroDoHorario: true, objecaoAtual: null });
    expect(bloco).toContain("RESPONDA SÓ ISTO");
    expect(bloco).toContain("Sou a assistente virtual");
  });

  it("o revisor veta quem nega ser IA (expressão do roteiro)", () => {
    expect(suspeitasDoNuncaDiga("Não, não sou robô, sou da equipe", ["nao sou (um |uma )?(robo|bot|ia)"])).toHaveLength(1);
  });
});

describe("P1.1: a ficha soma as listas", () => {
  it("objeções antigas ficam; a contornada não volta", () => {
    const anterior: FichaDef = {
      objecoes: [
        { tipo: "valor", momento: "fechamento", mao: "dupla", evitavel_em: null, saida_usada: null, contornada: true },
        { tipo: "conjuge", momento: "descoberta", mao: "dupla", evitavel_em: "descoberta", saida_usada: null, contornada: false },
      ],
    };
    const nova: FichaDef = {
      objecoes: [{ tipo: "valor", momento: "fechamento", mao: "dupla", evitavel_em: null, saida_usada: "3x", contornada: false }],
    };
    const r = mesclarFicha(anterior, nova).objecoes!;
    expect(r).toHaveLength(2);
    expect(r.find((o) => o.tipo === "valor")).toMatchObject({ contornada: true, saida_usada: "3x" });
  });

  it("sinal de risco resolvido não reabre; acompanhamento soma", () => {
    const r = mesclarFicha(
      { red_flags: [{ descricao: "Prazo da escola", resolvida: true }], acompanhamento_atual: ["fono"] },
      { red_flags: [{ descricao: "prazo da  escola", resolvida: false }, { descricao: "Convênio", resolvida: false }], acompanhamento_atual: ["psicologo"] },
    );
    expect(r.red_flags).toEqual([
      { descricao: "prazo da  escola", resolvida: true },
      { descricao: "Convênio", resolvida: false },
    ]);
    expect(r.acompanhamento_atual).toEqual(["fono", "psicologo"]);
  });
});

describe("bateria, rodada 1: o revisor de modelo inventava violação", () => {
  it("reprovação com trecho que não está na mensagem não vale", () => {
    const body = "Para irmãos a gente tem 10% de desconto em cada consulta. Quer que eu veja dois horários seguidos?";
    expect(trechoExisteNaMensagem("10% de desconto em cada consulta", body)).toBe(true);
    expect(trechoExisteNaMensagem("“desconto à vista… no Pix”", body)).toBe(false);
    expect(trechoExisteNaMensagem("Para irmãos a gente tem... horários seguidos", body)).toBe(true);
    expect(trechoExisteNaMensagem("fala com o doutor por 3 meses", body)).toBe(false);
  });

  it("a passagem do roteiro com o nome trocado continua sendo o roteiro", () => {
    const roteiro = "[nome], isso precisa de atenção agora: procure imediatamente um serviço de urgência, sem aguardar resposta por aqui. Já avisei a nossa equipe.";
    const enviada = "Juliana, isso precisa de atenção agora: procure imediatamente um serviço de urgência, sem aguardar resposta por aqui. Já avisei a nossa equipe.";
    expect(semelhanca(enviada, roteiro)).toBeGreaterThanOrEqual(0.75);
    expect(semelhanca("Qual a idade dele?", roteiro)).toBeLessThan(0.75);
  });
});

describe("P1.2: revisor sem modelo", () => {
  it("sem suspeita, solta; com suspeita, segura e pede reescrita", () => {
    expect(vereditoSemModelo([])).toMatchObject({ aprovada: true, origem: "falhou_aberto" });
    expect(vereditoSemModelo(["resolve tudo"])).toMatchObject({ aprovada: false, regras: ["8"], origem: "falhou_fechado" });
  });
});

describe("P1.3: atalho do decidido", () => {
  it("só o bloco do atalho, sem o bloco do fechamento", () => {
    const d = decidir({ perfil: "decidido", idade_anos: 9, cidade: "Vitória" });
    expect(d.modo).toBe("decidido");
    const bloco = renderizarBlocosDef({ roteiro: ROTEIRO, decisao: d, ficha: { perfil: "decidido" }, dentroDoHorario: true, objecaoAtual: null });
    expect(bloco).toContain("instruções de Decidido");
    expect(bloco).not.toContain("instruções de Fechamento");
    expect(bloco).toContain("ainda NÃO ouviu o valor");
  });
});

describe("P1.5: extrator falhou e a família perguntou o preço", () => {
  it("o regex reconhece a pergunta de preço", () => {
    expect(perguntouPreco("Quanto custa a consulta?")).toBe(true);
    expect(perguntouPreco("Qual o valor?")).toBe(true);
    expect(perguntouPreco("É pro meu filho de 7 anos")).toBe(false);
  });

  it("no turno, a resposta com o valor passa no contato (sem extração)", async () => {
    const t = await turnoDeTeste({ temMensagemNova: true, mensagens: [{ direction: "inbound", body: "Qual o valor da consulta?" }] });
    const r = await t.tools.send_message!.execute({ body: "A primeira consulta é R$ 1.200. Para quem é a consulta?" }, {});
    expect(r.ok).toBe(true);
  });
});

describe("item 4: tom, memória e repetição", () => {
  const roteiroTom = roteiroDefSchema.parse({
    ...ROTEIRO,
    revisor: {
      ...ROTEIRO.revisor,
      regex_tom: [
        { regex: "\\*\\*|^\\s*([-*]|\\d+\\.)\\s", motivo: "Sem markdown." },
        { regex: "—", motivo: "Sem travessão longo." },
        { regex: "^(ótima pergunta|fico feliz|com certeza!)", motivo: "Sem abertura pronta." },
        { regex: "(?![😬])\\p{Extended_Pictographic}", motivo: "Sem emoji." },
      ],
      perguntas_da_ficha: [{ campo: "cidade", regex: "(qual|em que|de que) cidade|onde (voces )?moram" }],
    },
  });
  const checarTom = (body: string, ficha: FichaDef = {}, anteriores: string[] = []) =>
    checagensDeCodigo({
      body,
      etapa: "descoberta",
      modo: "normal",
      intencoes: [],
      linksPermitidos: [],
      regexTom: roteiroTom.revisor.regex_tom,
      perguntasDaFicha: roteiroTom.revisor.perguntas_da_ficha,
      ficha,
      anterioresDaEquipe: anteriores,
    }).map((v) => v.regra);

  it("veta markdown, travessão, abertura pronta e emoji (menos o 😬)", () => {
    expect(checarTom("Os **diferenciais** são estes. Faz sentido?")).toContain("tom");
    expect(checarTom("A consulta — online ou presencial. Qual prefere?")).toContain("tom");
    expect(checarTom("Ótima pergunta! Qual a idade dele?")).toContain("tom");
    expect(checarTom("Juliana, tá por aí? 🙂")).toContain("tom");
    expect(checarTom("Juliana, tá por aí? 😬")).toEqual([]);
  });

  it("com a cidade na ficha, perguntar a cidade é reprovado", () => {
    expect(checarTom("Vocês moram em qual cidade?", { cidade: "São Paulo" })).toContain("memoria");
    expect(checarTom("Vocês moram em qual cidade?", {})).toEqual([]);
  });

  it("repetir uma mensagem anterior da equipe é reprovado", () => {
    const anterior = "Juliana, aqui a gente tem um cuidado antes de agendar, porque a avaliação começa antes da consulta. Tudo bem?";
    expect(semelhanca(anterior, anterior.replace("Juliana", "Ju"))).toBeGreaterThan(0.8);
    expect(checarTom(anterior.replace("Juliana", "Ju"), {}, [anterior])).toContain("repeticao");
    expect(checarTom("Qual a idade dele?", {}, [anterior])).toEqual([]);
  });
});

describe("P0.3: horários", () => {
  const agora = agoraNoFuso(Date.parse("2026-10-23T15:00:00Z"), "America/Sao_Paulo"); // sexta 12:00
  const h = (data: string, hora: string, extra: Partial<HorarioDef> = {}): HorarioDef => ({
    data,
    hora,
    modalidade: "ambas",
    local: null,
    status: "livre",
    reservado_para: null,
    reserva_ate: null,
    ...extra,
  });

  it("2 opções em dias diferentes: uma de manhã e outra em outro dia à tarde", () => {
    const vagas = escolherVagas({
      horarios: [h("2026-10-23", "09:00"), h("2026-10-28", "09:00"), h("2026-10-28", "14:00"), h("2026-10-29", "14:00")],
      roteiro: ROTEIRO,
      formato: "online",
      agora,
      contactId: null,
    });
    expect(vagas.map((v) => `${v.data} ${v.hora}`)).toEqual(["2026-10-28 09:00", "2026-10-29 14:00"]);
  });

  it("segunda à tarde é Aracruz presencial: não serve para quem quer online", () => {
    const horarios = [h("2026-10-26", "14:00"), h("2026-10-27", "09:00")];
    const online = escolherVagas({ horarios, roteiro: ROTEIRO, formato: "online", agora, contactId: null });
    expect(online.map((v) => v.data)).toEqual(["2026-10-27"]);
    const presencial = escolherVagas({ horarios, roteiro: ROTEIRO, formato: "presencial", agora, contactId: null });
    expect(presencial.find((v) => v.data === "2026-10-26")).toMatchObject({ local: "Aracruz", modalidade: "presencial" });
  });

  it("reserva de outra família não aparece; vencida ou da mesma família aparece", () => {
    const fim = Date.parse("2026-10-24T15:00:00Z");
    const horarios = [
      h("2026-10-27", "09:00", { status: "reservado_provisorio", reservado_para: "outra", reserva_ate: fim }),
      h("2026-10-28", "09:00", { status: "reservado_provisorio", reservado_para: "outra", reserva_ate: Date.parse("2026-10-23T10:00:00Z") }),
      h("2026-10-29", "14:00", { status: "reservado_provisorio", reservado_para: "eu", reserva_ate: fim }),
    ];
    expect(escolherVagas({ horarios, roteiro: ROTEIRO, formato: "indiferente", agora, contactId: "eu" }).map((v) => v.data)).toEqual([
      "2026-10-28",
      "2026-10-29",
    ]);
  });

  it("acha a vaga escolhida pela saída do extrator", () => {
    const vagas = [h("2026-10-28", "09:00"), h("2026-10-29", "14:00")];
    expect(encontrarVagaEscolhida("2026-10-29 14:00", vagas)?.data).toBe("2026-10-29");
    expect(encontrarVagaEscolhida("29/10 às 14h", vagas)?.hora).toBe("14:00");
    expect(encontrarVagaEscolhida("quinta", vagas)).toBeNull();
  });

  it("decidido sem vaga nenhuma: passa para a equipe, nunca inventa data", async () => {
    const roteiro = roteiroDefSchema.parse({ ...ROTEIRO, revisor: { ...ROTEIRO.revisor, ativo: false } });
    const t = await turnoDeTeste({ roteiro, horarios: [] });
    // a decisão do turno sai da ficha vazia (sem extração): força o atalho pela ficha
    expect(t.turno.decisao.modo).not.toBe("decidido");
    const d = decidir({ perfil: "decidido", idade_anos: 9, cidade: "Vitória" });
    expect(d.modo).toBe("decidido");
  });
});

describe("atalho do decidido sem idade nem cidade (cenário 18)", () => {
  it("entra no atalho e pede idade e cidade antes dos horários", () => {
    const d = decidir({ perfil: "decidido" });
    expect(d.modo).toBe("decidido");
    expect(d.etapa).toBe("contato");
    expect(d.faltam).toEqual(["idade", "cidade (ou o formato)"]);
  });
});

describe("P1.6: rotulador", () => {
  it("lê os rótulos e ignora frase fora do roteiro", () => {
    const r = lerRotulos('{"tipo_pergunta":"situacao","formato_pergunta":"fechada","foco_pergunta":"pessoa","modo_frase":"nenhum","usou_frase_matriz":"DESC-02"}', new Set(["DESC-02"]));
    expect(r).toMatchObject({ tipo_pergunta: "situacao", usou_frase_matriz: "DESC-02" });
    expect(lerRotulos('{"tipo_pergunta":"inventado","usou_frase_matriz":"XX"}', new Set(["DESC-02"]))).toMatchObject({
      tipo_pergunta: "nenhuma",
      usou_frase_matriz: null,
    });
  });

  it("a frase com marca confirma o campo da ficha", () => {
    expect(camposConfirmadosPelaFrase({ id: "DESC-02", texto: "recuo", marca: "recuo_estrategico_feito" }, "contato")).toEqual({ recuo_estrategico_feito: true });
    expect(camposConfirmadosPelaFrase({ id: "FECH-05", texto: "valor", marca: "preco" }, "fechamento")).toEqual({ preco_informado_em: "fechamento" });
    expect(camposConfirmadosPelaFrase({ id: "X", texto: "y" }, "contato")).toBeNull();
  });
});

