-- Operon fork addition (Smart Desk F0b, D1).
--
-- WHAT THIS ADDS
-- A nullable `task.operon_idempotency_key` and a unique constraint on it. Operon's marked
-- service key sends `Idempotency-Key` on a Desk card create; the route stores it here, and a
-- repeat of the same key answers with the task that already carries it instead of filing a
-- second one.
--
-- WHY IT HAS TO BE THE DATABASE
-- The route looks the key up before it creates, so an ordinary repeat runs none of the
-- create's side effects. Two concurrent creates both miss that lookup; the constraint is what
-- lets exactly one insert commit. The loser gets a unique violation, re-reads the winner and
-- answers with it — the same shape 0045, 0046 and 0047 use.
--
-- IT CANNOT FAIL ON EXISTING DATA
-- The column is new and NULL on every existing row, and NULLs never collide under a UNIQUE
-- constraint, so every existing and every human-created task is unaffected.
ALTER TABLE "task" ADD COLUMN "operon_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_operon_idempotency_key_unique" UNIQUE("operon_idempotency_key");
