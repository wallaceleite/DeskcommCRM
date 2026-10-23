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

alter table public.def_roteiros enable row level security;
alter table public.def_fichas enable row level security;
alter table public.def_eventos enable row level security;

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

-- A anon key vai para o navegador: nenhuma destas tabelas é dela.
revoke all on public.def_roteiros, public.def_fichas, public.def_eventos from anon;
