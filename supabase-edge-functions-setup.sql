-- Configuração mínima para a Edge Function admin-config.
-- Execute este script uma única vez no SQL Editor do projeto Supabase.
-- NÃO cole service_role, secret key ou qualquer senha neste arquivo.

create schema if not exists gestao_patrimonial;

create table if not exists gestao_patrimonial.admin_config (
    config_id boolean primary key default true check (config_id = true),
    profile_name text not null default 'Produção',
    project_url text not null,
    db_schema text not null default 'gestao_patrimonial',
    service_role_ciphertext text,
    service_role_iv text,
    updated_by uuid,
    updated_at timestamptz not null default now(),
    constraint admin_config_project_url_check
        check (project_url ~* '^https://[a-z0-9-]+\.supabase\.co/?$'),
    constraint admin_config_schema_check
        check (db_schema ~ '^[a-z_][a-z0-9_]{0,62}$')
);

alter table gestao_patrimonial.admin_config enable row level security;

-- A tabela não pode ser acessada diretamente pelo frontend.
revoke all privileges on table gestao_patrimonial.admin_config from anon, authenticated;

-- Somente a Edge Function, executada com secret server-side, acessa a tabela.
grant usage on schema gestao_patrimonial to service_role;
grant all privileges on table gestao_patrimonial.admin_config to service_role;
