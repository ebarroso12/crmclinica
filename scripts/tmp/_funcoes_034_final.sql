CREATE OR REPLACE FUNCTION public.current_app_role()
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT COALESCE(NULLIF((current_setting('request.jwt.claims',true)::jsonb->>'app_role'),''),
                 'deny')
$function$;

CREATE OR REPLACE FUNCTION public.current_usuario_id()
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select u.id
  from public.usuarios u
  where lower(u.email) = lower(coalesce((select auth.jwt() ->> 'email'), ''))
    and u.ativo = true
  limit 1
$function$;

CREATE OR REPLACE FUNCTION public.is_backend()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT public.current_app_role()='backend' $function$;

CREATE OR REPLACE FUNCTION public.is_gestor_or_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT public.current_app_role() IN ('gestor','admin') $function$;

CREATE OR REPLACE FUNCTION public.is_atendente()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT public.current_app_role()='atendente' $function$;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT public.current_app_role()='admin' $function$;

CREATE OR REPLACE FUNCTION public.can_access_conversa(p_id bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT p_id IS NOT NULL AND (
   public.is_backend() OR public.is_gestor_or_admin() OR EXISTS(
     SELECT 1 FROM public.conversas c WHERE c.id=p_id
     AND (c.atribuido_a IS NULL OR c.atribuido_a=public.current_usuario_id())))
$function$;

CREATE OR REPLACE FUNCTION public.can_access_agendamento(p_prof bigint, p_conv bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT public.is_backend() OR public.is_gestor_or_admin() OR
 (public.is_atendente() AND (
   public.can_access_conversa(p_conv) OR EXISTS(
     SELECT 1 FROM public.profissionais p
     WHERE p.id=p_prof AND p.usuario_id=public.current_usuario_id())))
$function$;

CREATE OR REPLACE FUNCTION public.is_admin_master()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.usuarios u
    where u.id = (select public.current_usuario_id())
      and u.ativo = true
      and (
        u.master = true
        or u.papel in ('admin', 'gestor')
      )
  )
$function$;

CREATE OR REPLACE FUNCTION public.is_colaborador()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.usuarios u
    where u.id = (select public.current_usuario_id())
      and u.ativo = true
      and u.papel in ('atendente', 'colaborador')
  )
$function$;

