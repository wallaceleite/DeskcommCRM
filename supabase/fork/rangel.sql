-- ============================================================================
-- FORK wallaceleite/DeskcommCRM — schema próprio do fork (Método DEF).
--
-- Aplicado pelo `hostgator-setup-kit/update.sh` DEPOIS do `baseline.sql`, com a
-- mesma função (`reaplicar_baseline`). Fica fora de `supabase/migrations/` e do
-- baseline de propósito: o upstream acrescenta migrations e blocos no fim do
-- baseline a cada versão, e um bloco nosso ali colidiria em todo merge.
--
-- Idempotente e só ACRESCENTA: reaplicar não muda nada; voltar ao upstream deixa
-- estas tabelas inertes.
-- ============================================================================

-- O roteiro de vendas de um agente: etapas, frases, passagens e regras do revisor.
create table if not exists public.def_roteiros (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  ativo boolean not null default true,
  conteudo jsonb not null,
  revisao integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid null,
  primary key (organization_id, agent_id)
);

-- A ficha DEF de cada contato: o que o extrator já sabe e a etapa em que ele está.
create table if not exists public.def_fichas (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  agent_id uuid null references public.ai_agents(id) on delete set null,
  etapa text not null default 'contato',
  ficha jsonb not null default '{}'::jsonb,
  provas jsonb not null default '{}'::jsonb,
  atualizada_em timestamptz not null default now(),
  primary key (organization_id, contact_id)
);

-- Um evento por fato medido: extração, mensagem enviada, veto do revisor, troca
-- de etapa, passagem. É a base dos KPIs. Não guarda texto do cliente.
create table if not exists public.def_eventos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid null references public.contacts(id) on delete cascade,
  agent_id uuid null,
  message_id uuid null,
  tipo text not null,
  etapa text null,
  dados jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists def_eventos_org_criado_idx
  on public.def_eventos (organization_id, created_at desc);
create index if not exists def_eventos_contato_idx
  on public.def_eventos (organization_id, contact_id, created_at desc);

-- As vagas da consulta que o agente pode oferecer (P0.3). As secretárias mantêm
-- pela API (`PUT /api/v1/def/horarios`); o agente segura a escolhida por algumas
-- horas (`reservado_provisorio`). Data e hora no fuso da organização.
create table if not exists public.def_horarios (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  data date not null,
  hora text not null check (hora ~ '^[0-2][0-9]:[0-5][0-9]$'),
  modalidade text not null default 'ambas' check (modalidade in ('presencial', 'online', 'ambas')),
  local text null,
  status text not null default 'livre' check (status in ('livre', 'reservado_provisorio', 'ocupado')),
  reservado_para uuid null references public.contacts(id) on delete set null,
  reserva_ate timestamptz null,
  updated_at timestamptz not null default now(),
  unique (organization_id, agent_id, data, hora)
);

alter table public.def_roteiros enable row level security;
alter table public.def_fichas enable row level security;
alter table public.def_eventos enable row level security;
alter table public.def_horarios enable row level security;

drop policy if exists tenant_isolation_def_roteiros_all on public.def_roteiros;
create policy tenant_isolation_def_roteiros_all on public.def_roteiros
  for all to authenticated
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_def_fichas_all on public.def_fichas;
create policy tenant_isolation_def_fichas_all on public.def_fichas
  for all to authenticated
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_def_eventos_all on public.def_eventos;
create policy tenant_isolation_def_eventos_all on public.def_eventos
  for all to authenticated
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_def_horarios_all on public.def_horarios;
create policy tenant_isolation_def_horarios_all on public.def_horarios
  for all to authenticated
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

-- A anon key vai para o navegador: nenhuma destas tabelas é dela.
revoke all on public.def_roteiros, public.def_fichas, public.def_eventos, public.def_horarios from anon;

-- LGPD (art. 11: dado de saúde). Quando o contato é anonimizado — pela cascata
-- de redact ou pela anonimização direta —, a ficha DEF (diagnóstico,
-- acompanhamento, motivo) e os eventos dele somem, e a vaga que ele segurava
-- volta a ser livre. É o mesmo gancho que o núcleo oferece aos módulos
-- (`after update of is_anonymized`), sem editar a cascata do upstream. Trigger
-- não faz HTTP: só apaga linhas do próprio fork.
create or replace function public.fn_def_esquecer_contato()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.def_fichas where organization_id = new.organization_id and contact_id = new.id;
  delete from public.def_eventos where organization_id = new.organization_id and contact_id = new.id;
  update public.def_horarios
     set status = 'livre', reservado_para = null, reserva_ate = null, updated_at = now()
   where organization_id = new.organization_id and reservado_para = new.id and status = 'reservado_provisorio';
  return new;
end;
$$;
revoke execute on function public.fn_def_esquecer_contato() from public, anon, authenticated;

drop trigger if exists trg_def_esquecer_contato on public.contacts;
create trigger trg_def_esquecer_contato
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized and not old.is_anonymized)
  execute function public.fn_def_esquecer_contato();

-- Retenção: ficha sem atividade há N meses (12 no pacote) perde o conteúdo. A
-- etapa fica, sem dado pessoal, para o histórico do funil. Sem seletor de linha:
-- o único critério é a idade.
create or replace function public.fn_def_reter_fichas(p_meses integer default 12)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.def_fichas
     set ficha = '{}'::jsonb, provas = '{}'::jsonb
   where atualizada_em < now() - make_interval(months => greatest(p_meses, 6))
     and ficha <> '{}'::jsonb;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.fn_def_reter_fichas(integer) from public, anon, authenticated;
grant execute on function public.fn_def_reter_fichas(integer) to service_role;
