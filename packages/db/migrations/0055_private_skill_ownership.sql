-- MC-022：团队技能显式归属；ID 不再作为授权凭据。只追加迁移，历史 ID/正文/安装/事件均保留。
-- 旧团队行只认唯一且一致的真实 draft 事件归属；无证据、歧义或失配行隔离，禁止猜前缀回填。
ALTER TABLE skills ADD COLUMN owner_tenant_id TEXT REFERENCES tenants(id);
ALTER TABLE skills ADD COLUMN owner_workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE skills ADD COLUMN ownership_state TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE skills ADD COLUMN ownership_reason TEXT;

WITH claims AS (
  SELECT s.id, e.tenant_id, e.workspace_id,
         bool_and(coalesce(e.tenant_id ~ '[^[:space:]]' AND e.workspace_id ~ '[^[:space:]]'
              AND e.payload->'context'->>'tenant_id' = e.tenant_id
              AND e.payload->'context'->>'workspace_id' = e.workspace_id
              AND e.payload->'object'->>'id' = s.id
              AND e.payload->'object'->>'type' = 'skill'
              AND w.tenant_id = e.tenant_id,false)) AS valid
  FROM skills s JOIN biz_events e ON e.payload->'decision'->'after'->>'skillId' = s.id
  LEFT JOIN workspaces w ON w.id = e.workspace_id
  WHERE s.level='team' AND e.payload->'decision'->>'action'='skill.draft.created'
  GROUP BY s.id, e.tenant_id, e.workspace_id
), proof AS (
  SELECT s.id, count(c.id) AS owners, bool_and(coalesce(c.valid,false)) AS valid,
         min(c.tenant_id) AS tenant_id, min(c.workspace_id) AS workspace_id
  FROM skills s LEFT JOIN claims c ON c.id=s.id WHERE s.level='team' GROUP BY s.id
)
UPDATE skills s SET
  owner_tenant_id=CASE WHEN p.owners=1 AND p.valid THEN p.tenant_id END,
  owner_workspace_id=CASE WHEN p.owners=1 AND p.valid THEN p.workspace_id END,
  ownership_state=CASE WHEN p.owners=1 AND p.valid THEN 'owned' ELSE 'quarantined' END,
  ownership_reason=CASE WHEN p.owners=0 THEN 'no_authoritative_draft'
                        WHEN p.owners>1 THEN 'ambiguous_draft_owners'
                        WHEN NOT p.valid THEN 'draft_scope_mismatch'
                        ELSE 'unique_authoritative_draft' END
FROM proof p WHERE s.id=p.id;

ALTER TABLE skills ADD CONSTRAINT skills_ownership_shape CHECK (
  (level='team' AND ownership_state='owned' AND owner_tenant_id IS NOT NULL AND owner_workspace_id IS NOT NULL)
  OR (level='team' AND ownership_state='quarantined' AND owner_tenant_id IS NULL AND owner_workspace_id IS NULL
      AND ownership_reason IS NOT NULL)
  OR (level<>'team' AND ownership_state='shared'
      AND ((owner_tenant_id IS NULL AND owner_workspace_id IS NULL)
           OR (owner_tenant_id IS NOT NULL AND owner_workspace_id IS NOT NULL)))
);
CREATE INDEX idx_skills_owner ON skills(owner_tenant_id,owner_workspace_id,id) WHERE level='team';

-- 上架复核锁定实际正文；旧单缺快照不得凭“已批准”直接共享现有私有正文。
ALTER TABLE skill_publish_reviews ADD COLUMN reviewed_version TEXT;
ALTER TABLE skill_publish_reviews ADD COLUMN reviewed_body TEXT;
ALTER TABLE skill_publish_reviews ADD COLUMN reviewed_description TEXT;
ALTER TABLE skill_publish_reviews ADD COLUMN reviewed_name TEXT;
ALTER TABLE skill_publish_reviews ADD COLUMN reviewed_fence_bindings JSONB;
ALTER TABLE skill_dist_snapshots ADD COLUMN loaded_version TEXT;

-- 旧公共分发快照只有唯一、一致的装载回执才获得回滚版本证据；原正文/快照/事件均不改。
WITH claims AS (
  SELECT s.id,e.payload->'decision'->'after'->>'version' AS version,
         bool_and(coalesce(e.tenant_id ~ '[^[:space:]]' AND e.workspace_id ~ '[^[:space:]]'
           AND e.workspace_id=s.workspace_id
           AND e.payload->'context'->>'workspace_id'=e.workspace_id
           AND e.payload->'context'->>'tenant_id'=e.tenant_id AND w.tenant_id=e.tenant_id
           AND e.payload->'decision'->'after'->>'skillId'=s.skill_id
           AND coalesce(e.payload->'decision'->'after'->>'version','')<>'',false)) AS valid
  FROM skill_dist_snapshots s JOIN biz_events e ON e.payload->'decision'->'after'->>'snapshotId'=s.id
  LEFT JOIN workspaces w ON w.id=s.workspace_id
  WHERE e.payload->'decision'->>'action' IN ('skill.dist.loaded','skill.dist.approved_loaded')
  GROUP BY s.id,e.payload->'decision'->'after'->>'version'
), proof AS (
  SELECT id,count(*) AS versions,bool_and(valid) AS valid,min(version) AS version FROM claims GROUP BY id
)
UPDATE skill_dist_snapshots s SET loaded_version=p.version FROM proof p
WHERE s.id=p.id AND p.versions=1 AND p.valid;

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY skills_read ON skills FOR SELECT USING (
  ownership_state='shared'
  OR (ownership_state='owned' AND coalesce(current_setting('app.tenant_id',true),'') ~ '[^[:space:]]'
      AND coalesce(current_setting('app.workspace_id',true),'') ~ '[^[:space:]]'
      AND owner_tenant_id=current_setting('app.tenant_id',true)
      AND owner_workspace_id=current_setting('app.workspace_id',true)
      AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id=owner_workspace_id AND w.tenant_id=owner_tenant_id))
);
CREATE POLICY skills_insert ON skills FOR INSERT WITH CHECK (
  (ownership_state='shared' AND owner_tenant_id IS NULL AND owner_workspace_id IS NULL)
  OR (ownership_state='owned' AND coalesce(current_setting('app.tenant_id',true),'') ~ '[^[:space:]]'
      AND coalesce(current_setting('app.workspace_id',true),'') ~ '[^[:space:]]'
      AND owner_tenant_id=current_setting('app.tenant_id',true)
      AND owner_workspace_id=current_setting('app.workspace_id',true)
      AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id=owner_workspace_id AND w.tenant_id=owner_tenant_id))
);
CREATE POLICY skills_update ON skills FOR UPDATE USING (
  (ownership_state='shared' AND owner_tenant_id IS NULL AND owner_workspace_id IS NULL)
  OR (ownership_state IN ('owned','shared') AND coalesce(current_setting('app.tenant_id',true),'') ~ '[^[:space:]]'
      AND coalesce(current_setting('app.workspace_id',true),'') ~ '[^[:space:]]'
      AND owner_tenant_id=current_setting('app.tenant_id',true)
      AND owner_workspace_id=current_setting('app.workspace_id',true)
      AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id=owner_workspace_id AND w.tenant_id=owner_tenant_id))
) WITH CHECK (
  (ownership_state='shared' AND owner_tenant_id IS NULL AND owner_workspace_id IS NULL)
  OR (ownership_state IN ('owned','shared') AND coalesce(current_setting('app.tenant_id',true),'') ~ '[^[:space:]]'
      AND coalesce(current_setting('app.workspace_id',true),'') ~ '[^[:space:]]'
      AND owner_tenant_id=current_setting('app.tenant_id',true)
      AND owner_workspace_id=current_setting('app.workspace_id',true)
      AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id=owner_workspace_id AND w.tenant_id=owner_tenant_id))
);
CREATE POLICY skills_delete ON skills FOR DELETE USING (
  (ownership_state='shared' AND owner_tenant_id IS NULL AND owner_workspace_id IS NULL)
  OR (ownership_state IN ('owned','shared') AND coalesce(current_setting('app.tenant_id',true),'') ~ '[^[:space:]]'
      AND coalesce(current_setting('app.workspace_id',true),'') ~ '[^[:space:]]'
      AND owner_tenant_id=current_setting('app.tenant_id',true)
      AND owner_workspace_id=current_setting('app.workspace_id',true)
      AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id=owner_workspace_id AND w.tenant_id=owner_tenant_id))
);

CREATE FUNCTION workloom_skill_owner_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'pg_catalog','public','pg_temp' AS $$
BEGIN
  IF current_user NOT IN ('workloom_app','workloom_gateway') THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' AND starts_with(NEW.id,'skill-t-') AND NEW.level<>'team' THEN
    RAISE EXCEPTION 'private skill namespace is reserved' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_tenant_id IS DISTINCT FROM OLD.owner_tenant_id
       OR NEW.owner_workspace_id IS DISTINCT FROM OLD.owner_workspace_id
       OR (OLD.ownership_state='quarantined') THEN
      RAISE EXCEPTION 'private skill ownership is immutable' USING ERRCODE='42501';
    END IF;
    IF OLD.ownership_state='shared' AND OLD.owner_tenant_id IS NOT NULL
       AND (NEW.body IS DISTINCT FROM OLD.body OR NEW.name IS DISTINCT FROM OLD.name
         OR NEW.description IS DISTINCT FROM OLD.description OR NEW.version IS DISTINCT FROM OLD.version
         OR NEW.fence_bindings IS DISTINCT FROM OLD.fence_bindings OR NEW.desensitized IS DISTINCT FROM OLD.desensitized
         OR NEW.bundle IS DISTINCT FROM OLD.bundle OR NEW.dist_meta IS DISTINCT FROM OLD.dist_meta) THEN
      RAISE EXCEPTION 'published private skill content is immutable after review' USING ERRCODE='42501';
    END IF;
    IF OLD.level='team' AND NEW.level IS DISTINCT FROM OLD.level THEN
      IF NEW.level<>'industry' OR NEW.ownership_state<>'shared' OR NOT NEW.desensitized
         OR NOT EXISTS (
           SELECT 1 FROM skill_publish_reviews r WHERE r.skill_id=OLD.id
             AND r.from_workspace_id=OLD.owner_workspace_id AND r.status='approved'
             AND r.required_approvals>=2 AND r.reviewed_version=OLD.version
             AND NEW.version=OLD.version AND NEW.body=OLD.body AND NEW.description=OLD.description
             AND NEW.name=OLD.name AND NEW.fence_bindings=OLD.fence_bindings
             AND r.reviewed_body=NEW.body AND r.reviewed_description=NEW.description
             AND r.reviewed_name=NEW.name AND r.reviewed_fence_bindings=NEW.fence_bindings
             AND (SELECT count(DISTINCT a->>'member_no') FROM jsonb_array_elements(r.approvals) a
                  WHERE a->>'gesture'='approve' AND a->>'member_no'<>r.proposed_by)>=r.required_approvals
         ) THEN
        RAISE EXCEPTION 'private skill publication requires its reviewed content and two reviewers' USING ERRCODE='42501';
      END IF;
    ELSIF NEW.ownership_state IS DISTINCT FROM OLD.ownership_state OR NEW.level IS DISTINCT FROM OLD.level THEN
      RAISE EXCEPTION 'skill namespace cannot be reassigned' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_skill_owner_guard BEFORE INSERT OR UPDATE ON skills
  FOR EACH ROW EXECUTE FUNCTION workloom_skill_owner_guard();

-- 既有工作区策略继续生效，加 restrictive 双重属主护栏；不能只设别人的 workspace GUC。
DO $$ DECLARE t TEXT; col TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['skill_installs','skill_publish_reviews','skill_dist_staging',
    'skill_dist_snapshots','skill_dist_policy','skill_dist_state','skill_reflux_outbox'] LOOP
    col:=CASE WHEN t='skill_publish_reviews' THEN 'from_workspace_id' ELSE 'workspace_id' END;
    EXECUTE format('CREATE POLICY skill_scope_owner ON %I AS RESTRICTIVE USING (
      coalesce(current_setting(''app.tenant_id'',true),'''') ~ ''[^[:space:]]''
      AND coalesce(current_setting(''app.workspace_id'',true),'''') ~ ''[^[:space:]]''
      AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id=%I AND w.id=current_setting(''app.workspace_id'',true)
              AND w.tenant_id=current_setting(''app.tenant_id'',true))) WITH CHECK (
      coalesce(current_setting(''app.tenant_id'',true),'''') ~ ''[^[:space:]]''
      AND coalesce(current_setting(''app.workspace_id'',true),'''') ~ ''[^[:space:]]''
      AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id=%I AND w.id=current_setting(''app.workspace_id'',true)
              AND w.tenant_id=current_setting(''app.tenant_id'',true)))',t,col,col);
  END LOOP;
END $$;
CREATE POLICY skill_install_visibility ON skill_installs AS RESTRICTIVE FOR SELECT USING (
  EXISTS (SELECT 1 FROM skills s WHERE s.id=skill_id)
);
CREATE POLICY skill_install_insert_visibility ON skill_installs AS RESTRICTIVE FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM skills s WHERE s.id=skill_id)
);
CREATE POLICY skill_install_update_visibility ON skill_installs AS RESTRICTIVE FOR UPDATE USING (
  EXISTS (SELECT 1 FROM skills s WHERE s.id=skill_id)
) WITH CHECK (EXISTS (SELECT 1 FROM skills s WHERE s.id=skill_id));

-- 私有命名空间禁止下行分发；旧 staging 草案可能保存私有正文，保留但不再返回。
CREATE POLICY skill_staging_public_content ON skill_dist_staging AS RESTRICTIVE USING (
  NOT starts_with(skill_id,'skill-t-') AND package->>'skillId'=skill_id
) WITH CHECK (
  NOT starts_with(skill_id,'skill-t-') AND package->>'skillId'=skill_id
);
-- 历史回流/回滚缓存可能保存他区私有正文；保留缓存行，但不可绕过新的 skills 可见性。
CREATE POLICY skill_reflux_asset_visibility ON skill_reflux_outbox AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM skills s WHERE s.id=skill_id)
) WITH CHECK (
  EXISTS (SELECT 1 FROM skills s WHERE s.id=skill_id)
  AND payload->'from'->>'tenantId'=current_setting('app.tenant_id',true)
  AND payload->'from'->>'workspaceId'=current_setting('app.workspace_id',true)
  AND payload->>'skillId'=skill_id
);
CREATE POLICY skill_snapshot_public_content ON skill_dist_snapshots AS RESTRICTIVE USING (
  NOT starts_with(skill_id,'skill-t-')
  AND (skill_row IS NULL OR (skill_row->>'level'='official'
    AND coalesce(skill_row->>'ownership_state','shared')='shared'
    AND skill_row->>'owner_tenant_id' IS NULL AND skill_row->>'owner_workspace_id' IS NULL))
) WITH CHECK (
  NOT starts_with(skill_id,'skill-t-')
  AND (skill_row IS NULL OR (skill_row->>'level'='official'
    AND coalesce(skill_row->>'ownership_state','shared')='shared'
    AND skill_row->>'owner_tenant_id' IS NULL AND skill_row->>'owner_workspace_id' IS NULL))
);
CREATE POLICY skill_snapshot_target_visibility ON skill_dist_snapshots AS RESTRICTIVE FOR SELECT USING (
  EXISTS (SELECT 1 FROM skills s WHERE s.id=skill_id AND s.level='official' AND s.ownership_state='shared'
    AND s.owner_tenant_id IS NULL AND s.owner_workspace_id IS NULL)
);

-- 特权吊销入口不能成为跨工作区私有技能的旁路。
CREATE OR REPLACE FUNCTION public.skill_revoke(p_skill_id text,p_reason text,p_by text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public','pg_temp' AS $$
DECLARE v_tenant text:=current_setting('app.tenant_id',true); v_workspace text:=current_setting('app.workspace_id',true);
BEGIN
  IF coalesce(trim(p_reason),'')='' OR coalesce(v_tenant,'') !~ '[^[:space:]]'
     OR coalesce(v_workspace,'') !~ '[^[:space:]]' OR NOT EXISTS (
      SELECT 1 FROM workspaces w WHERE w.id=v_workspace AND w.tenant_id=v_tenant)
     OR NOT EXISTS (SELECT 1 FROM skills s WHERE s.id=p_skill_id
        AND (s.ownership_state='shared' OR (s.ownership_state='owned'
             AND s.owner_tenant_id=v_tenant AND s.owner_workspace_id=v_workspace))) THEN
    RAISE EXCEPTION 'skill revocation outside authorized scope' USING ERRCODE='42501';
  END IF;
  -- 与 install/dry-run 的行锁共用顺序，吊销提交后不再出现基于旧校验的新安装。
  PERFORM 1 FROM public.skills WHERE id=p_skill_id FOR UPDATE;
  INSERT INTO skill_revocations(skill_id,reason,revoked_by) VALUES(p_skill_id,p_reason,p_by)
  ON CONFLICT(skill_id) DO NOTHING;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.skill_revoke(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.skill_revoke(text,text,text) TO workloom_app,workloom_gateway;

COMMENT ON COLUMN skills.ownership_reason IS 'MC022: unique draft proof or retained quarantine reason; never derive authorization from ID';
