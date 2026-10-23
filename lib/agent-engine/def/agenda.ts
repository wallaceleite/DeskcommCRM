/**
 * [fork wallaceleite] OS HORÁRIOS QUE O AGENTE PODE OFERECER (P0.3).
 *
 * A agenda nativa do CRM marca compromisso de um usuário do CRM; ela não guarda
 * "vagas livres da consulta" que uma IA possa oferecer. Então as vagas moram em
 * `def_horarios`, mantidas pelas secretárias (`PUT /api/v1/def/horarios`), e
 * este módulo decide — em código, sem IA — quais oferecer:
 *
 *  - só vagas futuras, livres (ou com a reserva provisória vencida, ou já
 *    seguradas para esta mesma família);
 *  - na modalidade da família, com as regras de local do roteiro aplicadas
 *    (segunda à tarde é Aracruz, presencial);
 *  - `opcoes` vagas (2 no pacote) em dias diferentes, de preferência uma de
 *    manhã e outra em outro dia à tarde.
 *
 * Sem vaga, o turno passa para a equipe: o agente nunca inventa data.
 *
 * Puro: sem banco e sem relógio (o "agora" chega já no fuso da organização).
 */
import type { FichaDef, RoteiroDef } from './tipos';

export type ModalidadeDaVaga = 'presencial' | 'online' | 'ambas';

export interface HorarioDef {
  data: string; // AAAA-MM-DD, no fuso da organização
  hora: string; // HH:MM
  modalidade: ModalidadeDaVaga;
  local: string | null;
  status: 'livre' | 'reservado_provisorio' | 'ocupado';
  reservado_para: string | null;
  /** epoch ms; null quando não há reserva. */
  reserva_ate: number | null;
}

export interface VagaOferecida extends HorarioDef {
  rotulo: string; // H1, H2…
}

export interface AgoraLocal {
  data: string;
  hora: string;
  epochMs: number;
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** O dia da semana (0 = domingo) de uma data AAAA-MM-DD. */
export function diaDaSemana(data: string): number {
  return new Date(`${data}T12:00:00Z`).getUTCDay();
}

/** "agora" no fuso da organização, para comparar com as vagas. */
export function agoraNoFuso(agora: number, fuso: string): AgoraLocal {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(agora));
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? '00';
  return { data: `${v('year')}-${v('month')}-${v('day')}`, hora: `${v('hour')}:${v('minute')}`, epochMs: agora };
}

/** A regra de local do roteiro (ex.: segunda à tarde = Aracruz, só presencial). */
export function aplicarRegrasDeLocal(h: HorarioDef, roteiro: Pick<RoteiroDef, 'agenda'>): HorarioDef {
  const regra = (roteiro.agenda?.regras_de_local ?? []).find(
    (r) => r.dia === diaDaSemana(h.data) && h.hora >= r.a_partir_de,
  );
  return regra ? { ...h, local: regra.local, modalidade: regra.modalidade } : h;
}

function disponivel(h: HorarioDef, agora: AgoraLocal, contactId: string | null): boolean {
  if (h.data < agora.data || (h.data === agora.data && h.hora <= agora.hora)) return false;
  if (h.status === 'livre') return true;
  if (h.status === 'reservado_provisorio') {
    const vencida = h.reserva_ate === null || h.reserva_ate <= agora.epochMs;
    return vencida || (contactId !== null && h.reservado_para === contactId);
  }
  return false;
}

function serveAFamilia(h: HorarioDef, formato: FichaDef['formato_preferido']): boolean {
  if (formato === 'presencial') return h.modalidade !== 'online';
  if (formato === 'online') return h.modalidade !== 'presencial';
  return true;
}

const manha = (h: HorarioDef) => h.hora < '12:00';

/** Todas as vagas que esta família ainda pode pegar, com as regras de local, em ordem. */
export function vagasDisponiveis(args: {
  horarios: readonly HorarioDef[];
  roteiro: Pick<RoteiroDef, 'agenda'>;
  formato: FichaDef['formato_preferido'];
  agora: AgoraLocal;
  contactId: string | null;
}): HorarioDef[] {
  return args.horarios
    .map((h) => aplicarRegrasDeLocal(h, args.roteiro))
    .filter((h) => disponivel(h, args.agora, args.contactId) && serveAFamilia(h, args.formato))
    .sort((a, b) => (a.data + a.hora).localeCompare(b.data + b.hora));
}

/** As vagas a oferecer agora — vazio quando não há nenhuma que sirva. */
export function escolherVagas(args: {
  horarios: readonly HorarioDef[];
  roteiro: Pick<RoteiroDef, 'agenda'>;
  formato: FichaDef['formato_preferido'];
  agora: AgoraLocal;
  contactId: string | null;
}): VagaOferecida[] {
  const quantas = args.roteiro.agenda?.opcoes ?? 2;
  const vagas = vagasDisponiveis(args);

  const escolhidas: HorarioDef[] = [];
  const diasUsados = new Set<string>();
  const pegar = (h: HorarioDef | undefined) => {
    if (h === undefined || escolhidas.length >= quantas) return;
    escolhidas.push(h);
    diasUsados.add(h.data);
  };
  // Uma de manhã e outra em OUTRO dia à tarde (regra do Dr.)…
  pegar(vagas.find(manha));
  pegar(vagas.find((h) => !manha(h) && !diasUsados.has(h.data)));
  // …e, faltando, as mais cedo em dias ainda não usados.
  for (const h of vagas) {
    if (escolhidas.length >= quantas) break;
    if (!diasUsados.has(h.data)) pegar(h);
  }
  return escolhidas
    .sort((a, b) => (a.data + a.hora).localeCompare(b.data + b.hora))
    .map((h, i) => ({ ...h, rotulo: `H${i + 1}` }));
}

/** "quarta, 05/11, às 14:00 — online ou presencial (Aracruz)" */
export function descreverVaga(h: HorarioDef): string {
  const [, mes, dia] = h.data.split('-');
  const onde =
    h.modalidade === 'online'
      ? 'online'
      : h.modalidade === 'presencial'
        ? `presencial${h.local ? ` em ${h.local}` : ''}`
        : `online ou presencial${h.local ? ` em ${h.local}` : ''}`;
  return `${DIAS[diaDaSemana(h.data)]}, ${dia}/${mes}, às ${h.hora} — ${onde}`;
}

/**
 * Qual vaga a família escolheu? O extrator devolve "AAAA-MM-DD HH:MM"; aceita
 * também "DD/MM HH:MM" e "DD/MM às 14h", porque a saída é de modelo.
 */
export function encontrarVagaEscolhida(texto: string | null | undefined, vagas: readonly HorarioDef[]): HorarioDef | null {
  if (!texto) return null;
  const t = texto.toLowerCase();
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  const br = /\b(\d{1,2})\/(\d{1,2})\b/.exec(t);
  const hora = /\b(\d{1,2})(?::|h)(\d{2})?\b/.exec(t.replace(/\d{4}-\d{2}-\d{2}/, '').replace(/\b\d{1,2}\/\d{1,2}\b/, ''));
  const mesDia = iso ? `${iso[2]}-${iso[3]}` : br ? `${br[2]!.padStart(2, '0')}-${br[1]!.padStart(2, '0')}` : null;
  const hhmm = hora ? `${hora[1]!.padStart(2, '0')}:${hora[2] ?? '00'}` : null;
  if (mesDia === null) return null;
  const candidatas = vagas.filter((v) => v.data.slice(5) === mesDia && (hhmm === null || v.hora === hhmm));
  return candidatas.length === 1 ? candidatas[0]! : null;
}
