-- Schéma Supabase — BTC Trading Bot (semi-auto, multi-exchange)
-- Région à créer impérativement en EU (eu-central-1 ou eu-west-1) pour conformité RGPD.
-- IMPORTANT : ce schéma ne contient AUCUNE clé API d'exchange.
-- Les clés Binance/Coinbase vivent exclusivement dans les secrets des Edge Functions
-- (supabase secrets set BINANCE_API_KEY=...), jamais dans une table, jamais côté client.

create extension if not exists "uuid-ossp";

-- Historique de prix BTC (rempli par la fonction fetch-prices, sert au calcul des indicateurs)
create table price_history (
  id uuid primary key default uuid_generate_v4(),
  exchange text not null check (exchange in ('binance', 'coinbase')),
  symbol text not null default 'BTCUSDT',
  price numeric not null,
  volume numeric,
  recorded_at timestamptz not null default now()
);
create index idx_price_history_exchange_time on price_history (exchange, recorded_at desc);

-- Signaux générés par le moteur d'indicateurs (une proposition d'ordre, PAS encore exécutée)
create table signals (
  id uuid primary key default uuid_generate_v4(),
  exchange text not null check (exchange in ('binance', 'coinbase')),
  symbol text not null default 'BTCUSDT',
  action text not null check (action in ('BUY', 'SELL', 'HOLD')),
  confidence numeric not null check (confidence between 0 and 1),
  reasons jsonb not null default '[]',
  indicators jsonb not null default '{}',
  suggested_amount numeric, -- montant suggéré en USDT/EUR, calculé côté serveur
  status text not null default 'pending' check (status in ('pending', 'validated', 'rejected', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes')
);
create index idx_signals_status on signals (status, created_at desc);

-- Ordres réellement exécutés (après validation manuelle de Bruno)
create table executions (
  id uuid primary key default uuid_generate_v4(),
  signal_id uuid references signals(id),
  exchange text not null check (exchange in ('binance', 'coinbase')),
  symbol text not null default 'BTCUSDT',
  side text not null check (side in ('BUY', 'SELL')),
  amount numeric not null,
  price numeric,
  exchange_order_id text, -- id retourné par l'exchange
  status text not null default 'submitted' check (status in ('submitted', 'filled', 'failed', 'cancelled')),
  error_message text,
  auto_executed boolean not null default false, -- true = déclenché par le mode auto (confiance >= seuil), false = validation manuelle
  created_at timestamptz not null default now()
);
create index idx_executions_created on executions (created_at desc);

-- Réglages du bot (ligne unique, id=1) — pilote le mode auto depuis le dashboard,
-- sans avoir à redéployer les Edge Functions.
create table bot_settings (
  id int primary key default 1 check (id = 1),
  auto_mode_enabled boolean not null default false,
  auto_mode_threshold numeric not null default 0.8 check (auto_mode_threshold between 0 and 1),
  max_auto_trades_per_day int not null default 3,
  updated_at timestamptz not null default now()
);
insert into bot_settings (id) values (1);

-- Row Level Security : lecture/écriture réservées au rôle authenticated (toi, via login Supabase Auth)
-- Aucune policy "anon" n'est créée — conforme à ta règle de sécurité.
alter table price_history enable row level security;
alter table signals enable row level security;
alter table executions enable row level security;

create policy "authenticated_read_price_history" on price_history
  for select to authenticated using (true);

create policy "authenticated_read_signals" on signals
  for select to authenticated using (true);

create policy "authenticated_update_signals" on signals
  for update to authenticated using (true);

create policy "authenticated_read_executions" on executions
  for select to authenticated using (true);

alter table bot_settings enable row level security;

create policy "authenticated_read_settings" on bot_settings
  for select to authenticated using (true);

create policy "authenticated_update_settings" on bot_settings
  for update to authenticated using (true);

-- Les INSERT sur price_history / signals / executions passent uniquement par les
-- Edge Functions avec la service_role key (jamais par le client React).
