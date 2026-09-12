-- 保留真实执行来源；旧窗口无证明，不可参与区域仲裁。
-- Preserve actual execution provenance; legacy unproven windows cannot vote.
ALTER TABLE monitor_checkpoints ADD COLUMN executor_id TEXT;
ALTER TABLE monitor_checkpoints ADD COLUMN actual_colo TEXT;

-- 来源修复也必须使现有评估计划失效。 / Provenance repairs invalidate evaluation plans too.
CREATE TRIGGER evaluation_generation_checkpoint_provenance
AFTER UPDATE OF executor_id, actual_colo ON monitor_checkpoints
BEGIN UPDATE evaluation_generation SET generation=generation+1 WHERE singleton_id=1; END;
