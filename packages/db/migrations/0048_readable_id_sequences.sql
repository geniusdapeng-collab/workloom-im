-- 0048 · 可读号源序列化（GR-02）
--
-- 背景（2026-09-28 growth 压测 + IM ST-02/P0-2）：
-- 0016 的 `threads_max_t_no()` / `video_projects_max_vid_no()` 是 SECURITY DEFINER 的
-- `SELECT max(...)` 包装——解决了跨工作区撞号（全库最大值），但**并发事务读到同一最大值**
-- 的问题原样保留：12 路并发派遣实测 7/12 失败（duplicate key → 裸 500）。
--
-- 口径：改成真正的 SEQUENCE（原子 nextval，无锁竞争），保留原函数签名（调用方零改动）；
-- 起点用 setval 对齐现网最大值，幂等（重复执行不跳号）。

CREATE SEQUENCE IF NOT EXISTS public.thread_no_seq START WITH 101;
CREATE SEQUENCE IF NOT EXISTS public.video_project_no_seq START WITH 1001;

-- 起点对齐现有数据（幂等：只在序列落后时抬升，不回落）
SELECT setval(
  'public.thread_no_seq',
  GREATEST(
    (SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '[^0-9]', '', 'g'), '')::bigint), 100)
       FROM public.threads WHERE id ~ '^T-[0-9]+$'),
    (SELECT last_value FROM public.thread_no_seq)
  ),
  true
);

SELECT setval(
  'public.video_project_no_seq',
  GREATEST(
    (SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '[^0-9]', '', 'g'), '')::bigint), 1000)
       FROM public.video_projects WHERE id ~ '^VID-[0-9]+$'),
    (SELECT last_value FROM public.video_project_no_seq)
  ),
  true
);

CREATE OR REPLACE FUNCTION public.threads_max_t_no()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$ SELECT nextval('public.thread_no_seq')::bigint $$;

CREATE OR REPLACE FUNCTION public.video_projects_max_vid_no()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$ SELECT nextval('public.video_project_no_seq')::bigint $$;

GRANT USAGE, SELECT ON SEQUENCE public.thread_no_seq TO workloom_app, workloom_gateway;
GRANT USAGE, SELECT ON SEQUENCE public.video_project_no_seq TO workloom_app, workloom_gateway;
