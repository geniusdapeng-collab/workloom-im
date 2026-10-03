-- MC-023 / MC-123: raw SQL must not trust a workspace GUC without its tenant.
-- Historical migrations/policies and immutable event bytes remain unchanged.
-- A restrictive policy is ANDed with every existing permissive policy.
-- Legal nonempty synthetic event scopes from 0051 remain supported.

-- This is an ownership predicate, never a workspace-to-tenant resolver. Exact
-- arguments must equal BOTH caller GUCs; it returns only allowed/denied. The
-- workspaces table owner reads the anchor without recursively entering its RLS.
CREATE OR REPLACE FUNCTION public.workloom_workspace_scope_allowed(
  p_workspace_id TEXT, p_tenant_id TEXT, p_allow_ownerless BOOLEAN DEFAULT FALSE
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_owner TEXT;
BEGIN
  IF coalesce(p_workspace_id,'') !~ '[^[:space:]]' OR coalesce(p_tenant_id,'') !~ '[^[:space:]]'
     OR current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace_id
     OR current_setting('app.tenant_id',true) IS DISTINCT FROM p_tenant_id THEN
    RETURN FALSE;
  END IF;
  SELECT w.tenant_id INTO v_owner FROM public.workspaces w WHERE w.id=p_workspace_id;
  IF FOUND THEN RETURN v_owner=p_tenant_id; END IF;
  RETURN coalesce(p_allow_ownerless,FALSE);
END;
$$;
DO $$ DECLARE v_owner TEXT; BEGIN
  SELECT pg_get_userbyid(relowner) INTO v_owner FROM pg_class WHERE oid='public.workspaces'::regclass;
  EXECUTE format('ALTER FUNCTION public.workloom_workspace_scope_allowed(TEXT,TEXT,BOOLEAN) OWNER TO %I',v_owner);
END $$;
REVOKE ALL ON FUNCTION public.workloom_workspace_scope_allowed(TEXT,TEXT,BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workloom_workspace_scope_allowed(TEXT,TEXT,BOOLEAN) TO workloom_app,workloom_gateway;

-- Narrow tenant metadata enumeration for permission-protected multi-workspace
-- screens. Ordinary workspaces RLS still exposes only the exact active scope.
-- The caller's verified Bundle permission is checked by its API middleware;
-- current member/tenant facts and explicit deny precedence are checked here.
-- This function never accepts a target tenant/workspace and returns no PII.
CREATE OR REPLACE FUNCTION public.workloom_authorized_tenant_workspaces(
  p_member_id TEXT, p_member_no TEXT, p_navigation_permission TEXT
) RETURNS TABLE(id TEXT,name TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant TEXT:=current_setting('app.tenant_id',true);
  v_workspace TEXT:=current_setting('app.workspace_id',true);
  v_role TEXT;
  v_permissions JSONB;
BEGIN
  IF coalesce(p_member_id,'') !~ '[^[:space:]]'
     OR coalesce(p_member_no,'') !~ '[^[:space:]]' OR p_member_no='GUEST'
     OR coalesce(p_navigation_permission,'') !~ '[^[:space:]]'
     OR NOT public.workloom_workspace_scope_allowed(v_workspace,v_tenant,FALSE) THEN
    RETURN;
  END IF;
  SELECT m.role,m.permissions INTO v_role,v_permissions
    FROM public.members m JOIN public.workspaces w ON w.id=m.workspace_id
    JOIN public.tenants t ON t.id=w.tenant_id
   WHERE m.id=p_member_id AND m.member_no=p_member_no AND m.workspace_id=v_workspace
     AND w.tenant_id=v_tenant AND m.status='active' AND t.status='active';
  IF NOT FOUND THEN RETURN; END IF;
  IF coalesce(v_permissions->p_navigation_permission='false'::jsonb,FALSE)
     OR (jsonb_typeof(v_permissions->'deny')='array'
         AND (v_permissions->'deny') ? p_navigation_permission) THEN
    RETURN;
  END IF;
  IF v_role NOT IN ('owner','manager')
     AND NOT (coalesce(v_permissions->p_navigation_permission='true'::jsonb,FALSE)
       OR coalesce(jsonb_typeof(v_permissions->'allow')='array'
                   AND (v_permissions->'allow') ? p_navigation_permission,FALSE)) THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT w.id,w.name FROM public.workspaces w
    WHERE w.tenant_id=v_tenant ORDER BY w.created_at,w.id;
END;
$$;
DO $$ DECLARE v_owner TEXT; BEGIN
  SELECT pg_get_userbyid(relowner) INTO v_owner FROM pg_class WHERE oid='public.workspaces'::regclass;
  EXECUTE format('ALTER FUNCTION public.workloom_authorized_tenant_workspaces(TEXT,TEXT,TEXT) OWNER TO %I',v_owner);
END $$;
REVOKE ALL ON FUNCTION public.workloom_authorized_tenant_workspaces(TEXT,TEXT,TEXT) FROM PUBLIC,workloom_gateway;
GRANT EXECUTE ON FUNCTION public.workloom_authorized_tenant_workspaces(TEXT,TEXT,TEXT) TO workloom_app;

-- New claims explicitly carry tenant attribution. ADD without a default first
-- prevents the migration connection's GUC from attributing historical rows.
ALTER TABLE public.im_inbound_dedupe ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE public.im_inbound_dedupe ALTER COLUMN tenant_id
  SET DEFAULT nullif(current_setting('app.tenant_id',true),'');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.im_inbound_dedupe'::regclass
                 AND conname='im_inbound_dedupe_tenant_nonempty') THEN
    ALTER TABLE public.im_inbound_dedupe ADD CONSTRAINT im_inbound_dedupe_tenant_nonempty
      CHECK (tenant_id IS NULL OR tenant_id ~ '[^[:space:]]');
  END IF;
END $$;

-- Existing/new administrator-imported legacy claims use only stored proof. No
-- event or receipt is deleted; unproven rows retain NULL and remain invisible.
-- A raw PII provider key cannot be guessed from a masked event key: if there is
-- no registered owner or exact canonical proof, attribution remains unknown.
CREATE OR REPLACE FUNCTION public.workloom_im_claim_attribution()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_tenant TEXT; v_count BIGINT;
BEGIN
  IF NEW.tenant_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT w.tenant_id INTO v_tenant FROM public.workspaces w WHERE w.id=NEW.workspace_id
    AND w.id ~ '[^[:space:]]' AND w.tenant_id ~ '[^[:space:]]';
  IF FOUND THEN NEW.tenant_id:=v_tenant; RETURN NEW; END IF;
  SELECT count(*),min(e.tenant_id) INTO v_count,v_tenant
    FROM public.biz_events e
   WHERE e.workspace_id=NEW.workspace_id AND e.tenant_id ~ '[^[:space:]]' AND e.workspace_id ~ '[^[:space:]]'
     AND e.payload->'context'->>'tenant_id'=e.tenant_id
     AND e.payload->'context'->>'workspace_id'=e.workspace_id
     AND e.payload->'decision'->>'action'='im.message'
     AND e.payload->'context'->>'channel'=NEW.channel
     AND e.payload->'decision'->'after'->>'channel_msg_id'=NEW.channel_msg_id
     AND (NEW.event_id='' OR e.event_id=NEW.event_id);
  IF v_count=1 THEN NEW.tenant_id:=v_tenant; END IF;
  RETURN NEW;
END;
$$;
DO $$ DECLARE v_owner TEXT; BEGIN
  SELECT pg_get_userbyid(relowner) INTO v_owner FROM pg_class WHERE oid='public.workspaces'::regclass;
  EXECUTE format('ALTER FUNCTION public.workloom_im_claim_attribution() OWNER TO %I',v_owner);
END $$;
REVOKE ALL ON FUNCTION public.workloom_im_claim_attribution() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_im_claim_attribution ON public.im_inbound_dedupe;
CREATE TRIGGER trg_im_claim_attribution BEFORE INSERT OR UPDATE ON public.im_inbound_dedupe
  FOR EACH ROW EXECUTE FUNCTION public.workloom_im_claim_attribution();

UPDATE public.im_inbound_dedupe d SET tenant_id=w.tenant_id
  FROM public.workspaces w WHERE d.workspace_id=w.id AND d.tenant_id IS NULL
    AND w.id ~ '[^[:space:]]' AND w.tenant_id ~ '[^[:space:]]';
WITH proof AS (
  SELECT d.workspace_id,d.channel,d.channel_msg_id,count(*) AS matches,min(e.tenant_id) AS tenant_id
    FROM public.im_inbound_dedupe d JOIN public.biz_events e
      ON e.workspace_id=d.workspace_id AND e.tenant_id ~ '[^[:space:]]' AND e.workspace_id ~ '[^[:space:]]'
     AND e.payload->'context'->>'tenant_id'=e.tenant_id
     AND e.payload->'context'->>'workspace_id'=e.workspace_id
     AND e.payload->'decision'->>'action'='im.message'
     AND e.payload->'context'->>'channel'=d.channel
     AND e.payload->'decision'->'after'->>'channel_msg_id'=d.channel_msg_id
     AND (d.event_id='' OR e.event_id=d.event_id)
   WHERE d.tenant_id IS NULL GROUP BY d.workspace_id,d.channel,d.channel_msg_id
)
UPDATE public.im_inbound_dedupe d SET tenant_id=p.tenant_id
  FROM proof p WHERE d.workspace_id=p.workspace_id AND d.channel=p.channel
   AND d.channel_msg_id=p.channel_msg_id AND d.tenant_id IS NULL AND p.matches=1;
CREATE INDEX IF NOT EXISTS idx_im_inbound_dedupe_tenant_workspace
  ON public.im_inbound_dedupe(tenant_id,workspace_id);
COMMENT ON COLUMN public.im_inbound_dedupe.tenant_id IS
  'MC023: nonempty GUC attribution or authoritative stored proof; NULL legacy is retained and default denied';

-- Inventory-driven guards cover every historical workspace/from_workspace RLS
-- table, including service, memory, captain, eval, dev, accounts and skill ops.
-- Auth bootstrap tables with no RLS keep their original least-privilege ACLs.
-- owner_workspace-only skills retains its independent 0055 private/shared rules.
DO $$
DECLARE r RECORD; v_col TEXT; v_guard TEXT; v_tenant BOOLEAN;
BEGIN
  FOR r IN SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity
      AND (c.relname='workspaces' OR EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND NOT a.attisdropped
          AND a.attname IN ('workspace_id','from_workspace_id')))
    ORDER BY c.relname LOOP
    v_col:=CASE WHEN r.relname='workspaces' THEN 'id'
      WHEN EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=r.oid AND NOT attisdropped AND attname='workspace_id')
      THEN 'workspace_id' ELSE 'from_workspace_id' END;
    SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=r.oid AND NOT attisdropped AND attname='tenant_id') INTO v_tenant;
    IF r.relname='workspaces' THEN
      v_guard:='id=current_setting(''app.workspace_id'',true)
        AND tenant_id=current_setting(''app.tenant_id'',true)
        AND coalesce(current_setting(''app.workspace_id'',true),'''') ~ ''[^[:space:]]''
        AND coalesce(current_setting(''app.tenant_id'',true),'''') ~ ''[^[:space:]]''';
    ELSIF v_tenant THEN
      -- Tenant-carrying rows can prove their own legal synthetic attribution;
      -- the boolean still rejects a conflicting registered workspace owner.
      -- An uncorrelated subquery evaluates anchor ownership once per statement.
      v_guard:=format('%I=current_setting(''app.workspace_id'',true)
        AND tenant_id=current_setting(''app.tenant_id'',true)
        AND (SELECT public.workloom_workspace_scope_allowed(
          current_setting(''app.workspace_id'',true),current_setting(''app.tenant_id'',true),TRUE))',v_col);
    ELSE
      v_guard:=format('%I=current_setting(''app.workspace_id'',true)
        AND (SELECT public.workloom_workspace_scope_allowed(
          current_setting(''app.workspace_id'',true),current_setting(''app.tenant_id'',true),FALSE))',v_col);
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS mc_workspace_scope ON public.%I',r.relname);
    IF r.relname='fence_rules' THEN
      -- Shared baselines are safe public READs. Separate write policies are
      -- essential: DELETE does not have a WITH CHECK clause.
      EXECUTE 'DROP POLICY IF EXISTS mc_workspace_scope_read ON public.fence_rules';
      EXECUTE 'DROP POLICY IF EXISTS mc_workspace_scope_insert ON public.fence_rules';
      EXECUTE 'DROP POLICY IF EXISTS mc_workspace_scope_update ON public.fence_rules';
      EXECUTE 'DROP POLICY IF EXISTS mc_workspace_scope_delete ON public.fence_rules';
      EXECUTE format('CREATE POLICY mc_workspace_scope_read ON public.fence_rules AS RESTRICTIVE FOR SELECT
        USING (workspace_id=''*'' OR (%s))',v_guard);
      EXECUTE format('CREATE POLICY mc_workspace_scope_insert ON public.fence_rules AS RESTRICTIVE FOR INSERT WITH CHECK (%s)',v_guard);
      EXECUTE format('CREATE POLICY mc_workspace_scope_update ON public.fence_rules AS RESTRICTIVE FOR UPDATE USING (%s) WITH CHECK (%s)',v_guard,v_guard);
      EXECUTE format('CREATE POLICY mc_workspace_scope_delete ON public.fence_rules AS RESTRICTIVE FOR DELETE USING (%s)',v_guard);
    ELSE
      EXECUTE format('CREATE POLICY mc_workspace_scope ON public.%I AS RESTRICTIVE USING (%s) WITH CHECK (%s)',r.relname,v_guard,v_guard);
    END IF;
  END LOOP;
END;
$$;

-- Same function/owner/signature/idempotency/hash-chain semantics as 0051, with
-- nonempty dual context, payload context equality and the non-resolving anchor
-- guard checked before acquiring locks or touching immutable history.
CREATE OR REPLACE FUNCTION public.append_event_insert(
  p_event_id TEXT,p_tenant_id TEXT,p_workspace_id TEXT,p_session_id TEXT,
  p_payload JSONB,p_prev_hash TEXT,p_hash TEXT,p_created_at TIMESTAMPTZ
) RETURNS TABLE(seq BIGINT,inserted BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_tail_hash TEXT; v_seq BIGINT; v_existing public.biz_events%ROWTYPE;
BEGIN
  IF current_setting('app.tenant_id',true) IS DISTINCT FROM p_tenant_id
     OR current_setting('app.workspace_id',true) IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'append_event_insert: 上下文与事件归属不一致（租户/工作区双 GUC）'
      USING ERRCODE='42501';
  END IF;
  IF coalesce(p_tenant_id,'') !~ '[^[:space:]]' OR coalesce(p_workspace_id,'') !~ '[^[:space:]]'
     OR p_payload->'context'->>'tenant_id' IS DISTINCT FROM p_tenant_id
     OR p_payload->'context'->>'workspace_id' IS DISTINCT FROM p_workspace_id
     OR NOT public.workloom_workspace_scope_allowed(p_workspace_id,p_tenant_id,TRUE) THEN
    RAISE EXCEPTION 'append_event_insert: nonempty tenant/workspace and payload must match the authorized scope'
      USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('event-chain:' || p_tenant_id || ':' || p_workspace_id));
  SELECT * INTO v_existing FROM public.biz_events e
    WHERE e.tenant_id=p_tenant_id AND e.event_id=p_event_id;
  IF FOUND THEN
    IF md5(v_existing.payload::text) IS DISTINCT FROM md5(p_payload::text) THEN
      RAISE EXCEPTION 'append_event_insert: event_id % conflict with different payload (P0-3)',p_event_id;
    END IF;
    RETURN QUERY SELECT NULL::BIGINT,FALSE; RETURN;
  END IF;
  SELECT e.hash INTO v_tail_hash FROM public.biz_events e
    WHERE e.tenant_id=p_tenant_id AND e.workspace_id=p_workspace_id ORDER BY e.seq DESC LIMIT 1;
  IF p_prev_hash IS DISTINCT FROM coalesce(v_tail_hash,'GENESIS') THEN
    RAISE EXCEPTION 'append_event_insert: prev_hash 与链尾不符（断链拒写，D16）';
  END IF;
  INSERT INTO public.biz_events(event_id,tenant_id,workspace_id,session_id,payload,prev_hash,hash,created_at)
    VALUES(p_event_id,p_tenant_id,p_workspace_id,p_session_id,p_payload,p_prev_hash,p_hash,p_created_at)
    ON CONFLICT(tenant_id,event_id) DO NOTHING RETURNING biz_events.seq INTO v_seq;
  RETURN QUERY SELECT v_seq,(v_seq IS NOT NULL);
END;
$$;
ALTER FUNCTION public.append_event_insert(TEXT,TEXT,TEXT,TEXT,JSONB,TEXT,TEXT,TIMESTAMPTZ) OWNER TO workloom_gateway;
REVOKE ALL ON FUNCTION public.append_event_insert(TEXT,TEXT,TEXT,TEXT,JSONB,TEXT,TEXT,TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.append_event_insert(TEXT,TEXT,TEXT,TEXT,JSONB,TEXT,TEXT,TIMESTAMPTZ) TO workloom_app,workloom_gateway;
