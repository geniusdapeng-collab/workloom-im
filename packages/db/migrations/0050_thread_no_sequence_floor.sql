-- 0050 · 号源函数加"现存最大值下限"（GR-02 收口）
--
-- 0048 把号源改成 SEQUENCE 后暴露了一个真实边界：**序列起点可能落后于手写/历史 id**。
-- 实测（干净库跑 suite）：迁移先于种子执行 → 序列只到 100，而种子随后写入 T-101/102/103，
-- 于是第一次派遣拿到 T-102 → duplicate key（J-04 一键派单回链失败）。
--
-- 口径：每次取号返回 `GREATEST(nextval, 现存最大号)`——既保持 nextval 的并发原子性
-- （并发调用各自拿到不同值），又保证不落在已占用号段内；调用方仍按 +1 使用。

CREATE OR REPLACE FUNCTION public.threads_max_t_no()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(
    nextval('public.thread_no_seq'),
    (SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '[^0-9]', '', 'g'), '')::bigint), 100)
       FROM public.threads WHERE id ~ '^T-[0-9]+$')
  )
$$;

CREATE OR REPLACE FUNCTION public.video_projects_max_vid_no()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(
    nextval('public.video_project_no_seq'),
    (SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '[^0-9]', '', 'g'), '')::bigint), 1000)
       FROM public.video_projects WHERE id ~ '^VID-[0-9]+$')
  )
$$;

GRANT EXECUTE ON FUNCTION public.threads_max_t_no() TO workloom_app, workloom_gateway;
GRANT EXECUTE ON FUNCTION public.video_projects_max_vid_no() TO workloom_app, workloom_gateway;
