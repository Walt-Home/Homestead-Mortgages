-- A member is removed by somebody, and the row says who.
--
-- `disabled_at` has been on the row since the team existed and nothing
-- wrote it. Removing a member from the portal's Team page, or from the
-- console's Servicers page, is what does: the row stays — it is the record
-- that the person was once on the team — and this names who took them off,
-- a console staff id or `member:<id>`, the same two shapes `invited_by`
-- holds. Recorded, never trusted for anything. See docs/decisions.md,
-- "A servicer's team has a portal of its own".
ALTER TABLE "servicer_users" ADD COLUMN "disabled_by" TEXT;
