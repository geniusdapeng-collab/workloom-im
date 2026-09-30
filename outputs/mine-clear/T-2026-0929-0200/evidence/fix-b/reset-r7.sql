-- fix_b_fence：把 R7 还原为「出厂基线」态，供反复复跑 m1-fence-rule-change.mjs 断言。
-- 口径与 bundles/hotel/fences/hotel-baseline.yml 的 R7 行一致（level=auto / is_baseline=true / active）。
DELETE FROM fence_rules WHERE workspace_id = 'ws-yunqi' AND rule_id = 'R7';
INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, is_baseline, status, created_by)
VALUES (
  'fr-r7-v1-ws-yunqi', 'R7', 'hotel-baseline/v1', 'ws-yunqi', '例行对账自动执行', 'auto',
  '{"object_types":["order"],"actions":["order.reconcile"],"when":"params.guarantee_anomaly != true"}'::jsonb,
  '{"result":"pass","note":"无担保异常的例行对账自动执行；异常走 R5 熔断，未知写动作仍按 default_level 保守处理"}'::jsonb,
  true, 'active', 'system:seed'
);
